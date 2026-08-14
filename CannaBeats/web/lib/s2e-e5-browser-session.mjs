import { E5BrowserResourceScope } from './s2e-e5-browser-resources.mjs';
import {
  E5LifecycleError, E5ListenerLifecycle, E5PcmChunker,
  E5WindowProjector, E5WorkletPort,
} from './s2e-e5-lifecycle.mjs';

const RETRY_MS = 1500;
const WINDOW_MS = 9000;
const MAX_LONG_TASKS = 128;

function frozen(value) {
  return Object.freeze(value);
}

function formatFrom(response) {
  const sampleRate = Number(response?.headers?.get?.('x-audio-rate'));
  const channels = Number(response?.headers?.get?.('x-audio-channels'));
  const encoding = response?.headers?.get?.('x-audio-encoding');
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000
    || ![1, 2].includes(channels) || encoding !== 's16le') return null;
  return frozen({ sourceSampleRate: sampleRate, sourceChannels: channels });
}

function sameFormat(left, right) {
  return left?.sourceSampleRate === right.sourceSampleRate
    && left?.sourceChannels === right.sourceChannels;
}

function canonicalUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

export class E5BrowserSession {
  constructor({ streamUrl, workletUrl = '/s2e-e4-worklet.js', client, dependencies, onStatus = (_status) => {} }) {
    if (typeof streamUrl !== 'string' || !streamUrl
      || typeof workletUrl !== 'string' || !workletUrl.startsWith('/')
      || !client || !dependencies
      || typeof dependencies.now !== 'function' || typeof dependencies.uuid !== 'function'
      || typeof dependencies.fetch !== 'function'
      || typeof dependencies.createAbortController !== 'function'
      || typeof dependencies.createAudioContext !== 'function'
      || typeof dependencies.createWorkletNode !== 'function'
      || typeof dependencies.scheduleTimeout !== 'function'
      || typeof dependencies.cancelTimeout !== 'function'
      || typeof onStatus !== 'function') throw new E5LifecycleError('session_invalid');
    this.streamUrl = streamUrl;
    this.workletUrl = workletUrl;
    this.clientTemplate = client;
    this.dependencies = dependencies;
    this.onStatus = onStatus;
    this.status = 'idle';
    this.active = false;
    this.scope = null;
    this.context = null;
    this.node = null;
    this.port = null;
    this.lifecycle = null;
    this.projector = null;
    this.format = null;
    this.rotationPromise = null;
    this.controlTail = Promise.resolve();
    this.retryResolve = null;
    this.longTaskEntries = [];
    this.longTaskOverflow = false;
    this.observer = null;
    this.observerHealthy = false;
    this.runPromise = null;
    this.terminationPromise = null;
    this.cleanupResult = null;
  }

  async start() {
    if (this.active || this.runPromise) throw new E5LifecycleError('session_invalid');
    this.active = true;
    this.scope = new E5BrowserResourceScope({
      scheduleTimeout: this.dependencies.scheduleTimeout,
      cancelTimeout: this.dependencies.cancelTimeout,
    });
    this.lifecycle = new E5ListenerLifecycle({
      instanceId: this.dependencies.uuid(), now: this.dependencies.now,
    });
    try {
      const context = await this.dependencies.createAudioContext();
      if (!this.active) {
        this.#closeLateContext(context);
        throw new E5LifecycleError('initialization_aborted');
      }
      this.context = this.scope.ownContext(context);
      await this.context.resume();
      this.#requireActiveInitialization();
      await this.context.audioWorklet.addModule(this.workletUrl);
      this.#requireActiveInitialization();
      this.node = this.scope.ownNode(this.dependencies.createWorkletNode(this.context));
      this.node.connect(this.context.destination);
      this.port = this.scope.ownPort(new E5WorkletPort({
        port: this.node.port,
        scheduleTimeout: this.dependencies.scheduleTimeout,
        cancelTimeout: this.dependencies.cancelTimeout,
        onState: (state) => this.#workletState(state),
      }));
      this.#installBrowserObservers();
      this.runPromise = this.#run().catch(() => this.#terminate('error', 'unknown'));
      return this;
    } catch {
      await this.#terminate('error', 'unknown');
      throw new E5LifecycleError('initialization_failed');
    }
  }

  stop(reason = 'requested') {
    return this.#terminate('stopped', reason);
  }

  async resetDiagnostics() {
    if (!this.active || !this.projector || !this.port
      || this.port.lifecycle !== 'configured') throw new E5LifecycleError('reset_invalid');
    const nextInstanceId = this.dependencies.uuid();
    if (!canonicalUuid(nextInstanceId) || nextInstanceId === this.lifecycle.instanceId) {
      throw new E5LifecycleError('reset_invalid');
    }
    return this.#enqueueControl(async () => {
      if (!this.active || !this.projector || this.port.lifecycle !== 'configured') {
        throw new E5LifecycleError('reset_invalid');
      }
      await this.#rotateNow('snapshot');
      if (!this.active) throw new E5LifecycleError('reset_invalid');
      this.lifecycle.rotateInstance(nextInstanceId);
      return frozen({ status: 'reset', instanceId: this.lifecycle.instanceId });
    });
  }

  async #run() {
    while (this.active) {
      const reconnect = this.lifecycle.everDeliveredPcm;
      this.lifecycle.beginAttempt();
      const attemptAt = this.#now();
      if (this.projector) {
        this.projector.setTerminalCategory('open', attemptAt);
        if (reconnect) this.projector.recordReconnect(attemptAt);
        this.#observeCurrentBrowserState(attemptAt);
      }
      this.#setStatus('connecting');
      const controller = this.scope.ownAbortController(
        this.dependencies.createAbortController(),
      );
      let response;
      try {
        response = await this.dependencies.fetch(this.streamUrl, {
          cache: 'no-store', signal: controller.signal,
        });
      } catch {
        if (!this.active) return;
        this.#releaseAbortController(controller);
        this.lifecycle.endAttempt('no_response');
        if (this.projector) this.projector.setTerminalCategory('no_response', this.#now());
        this.#setStatus('waiting');
        await this.#waitRetry();
        continue;
      }
      if (!this.active) return;
      if (response.status === 503) {
        this.#releaseAbortController(controller, true);
        this.lifecycle.endAttempt('rejected');
        if (this.projector) this.projector.setTerminalCategory('rejected', this.#now());
        this.#setStatus('waiting');
        await this.#waitRetry();
        continue;
      }
      if (!response.ok || !response.body) {
        this.#releaseAbortController(controller, true);
        this.lifecycle.endAttempt('rejected');
        await this.#terminate('error', 'unknown');
        return;
      }
      this.lifecycle.responseHeaders();
      const nextFormat = formatFrom(response);
      if (!nextFormat) {
        this.#releaseAbortController(controller, true);
        this.lifecycle.endAttempt('unsupported_format');
        await this.#terminate('error', 'unknown');
        return;
      }
      try {
        await this.#acceptFormat(nextFormat);
      } catch {
        this.#releaseAbortController(controller, true);
        await this.#terminate('error', 'unknown');
        return;
      }
      const chunker = new E5PcmChunker(nextFormat.sourceChannels);
      let reader;
      try {
        reader = this.scope.ownReader(response.body.getReader());
      } catch {
        this.#releaseAbortController(controller, true);
        this.lifecycle.endAttempt('stream_error');
        this.projector.setTerminalCategory('stream_error', this.#now());
        await this.#terminate('error', 'unknown');
        return;
      }
      let terminal = 'stream_ended';
      let retiredAfterFailure = false;
      try {
        while (this.active) {
          const { done, value } = await reader.read();
          if (done) break;
          const delivery = chunker.consume(value);
          if (delivery.receivedFrames === 0) continue;
          const observedAt = this.#now();
          const pendingRotation = this.rotationPromise;
          if (!this.port.sendPcm(delivery.buffer)) throw new E5LifecycleError('stream_error');
          if (pendingRotation) await pendingRotation;
          this.projector.recordChunk({ frames: delivery.receivedFrames, atMs: observedAt });
          this.lifecycle.pcmDelivered({
            bytes: delivery.receivedBytes, frames: delivery.receivedFrames,
          });
        }
        if (!chunker.finish()) terminal = 'stream_error';
      } catch {
        if (!this.active) return;
        terminal = 'stream_error';
        retiredAfterFailure = await this.scope.retireFailedAttempt(reader, controller);
        if (!this.active) return;
        if (!retiredAfterFailure) {
          await this.#terminate('error', 'unknown');
          return;
        }
      }
      if (!this.active) return;
      if (!retiredAfterFailure) {
        this.scope.releaseReader(reader);
        this.#releaseAbortController(controller);
      }
      this.lifecycle.endAttempt(terminal);
      this.projector.setTerminalCategory(terminal, this.#now());
      try {
        await this.#rotate('reset');
      } catch {
        await this.#terminate('error', 'unknown');
        return;
      }
      this.#setStatus('waiting');
      await this.#waitRetry();
    }
  }

  async #acceptFormat(nextFormat) {
    if (this.port.lifecycle === 'unconfigured') {
      await this.#configure(nextFormat);
      return;
    }
    if (sameFormat(this.format, nextFormat)) return;
    const nextInstanceId = this.dependencies.uuid();
    if (!canonicalUuid(nextInstanceId) || nextInstanceId === this.lifecycle.instanceId) {
      throw new E5LifecycleError('instance_invalid');
    }
    await this.#enqueueControl(async () => {
      if (!this.active || this.port.lifecycle !== 'configured') {
        throw new E5LifecycleError('invalid_state');
      }
      await this.#rotateNow('stop');
      this.lifecycle.rotateInstance(nextInstanceId);
      this.format = null;
      this.projector = null;
      await this.#configure(nextFormat);
    });
  }

  async #configure(nextFormat) {
    const dispatchMs = this.#now();
    await this.port.configure({
      sampleRate: nextFormat.sourceSampleRate, channels: nextFormat.sourceChannels,
    });
    const replyMs = this.#now();
    this.format = frozen({
      ...nextFormat, outputSampleRate: this.context.sampleRate,
    });
    this.projector = new E5WindowProjector({
      lifecycle: this.lifecycle,
      format: this.format,
      client: this.#client(),
      startBoundary: { dispatchMs, replyMs },
    });
    this.#observeCurrentBrowserState(replyMs);
    this.#scheduleWindow();
    this.#setStatus('buffering');
  }

  #rotate(operation) {
    return this.#enqueueControl(() => this.#rotateNow(operation));
  }

  #enqueueControl(operation) {
    const queued = this.controlTail.catch(() => {}).then(async () => {
      // Let readers waiting on the previous rotation record their staged chunk
      // before the next transaction can establish another E4 boundary.
      await Promise.resolve();
      if (!this.active) throw new E5LifecycleError('session_closed');
      return operation();
    });
    this.controlTail = queued;
    return queued.catch(async (error) => {
      await this.#terminate('error', 'unknown');
      throw error;
    });
  }

  async #rotateNow(operation) {
    this.scope.cancel('window');
    const rotation = this.#performRotation(operation);
    this.rotationPromise = rotation;
    try {
      return await rotation;
    } finally {
      if (this.rotationPromise === rotation) this.rotationPromise = null;
    }
  }

  async #performRotation(operation) {
    const before = this.#drainLongTasks();
    const dispatchMs = this.#now();
    const reply = await this.port.rotate(operation);
    const replyMs = this.#now();
    const entries = [...before, ...this.#drainLongTasks()];
    const result = this.projector.finalize({
      snapshot: reply.snapshot,
      endBoundary: { dispatchMs, replyMs },
      longTaskEntries: entries,
    });
    if (operation !== 'stop' && this.active) this.#scheduleWindow();
    return result;
  }

  #scheduleWindow() {
    if (!this.active || !this.projector || this.scope.timers.has('window')) return;
    this.scope.schedule('window', () => {
      void this.#rotate('snapshot').catch(() => this.#terminate('error', 'unknown'));
    }, WINDOW_MS);
  }

  #waitRetry() {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve) => {
      this.retryResolve = resolve;
      this.scope.schedule('retry', () => {
        this.retryResolve = null;
        resolve();
      }, RETRY_MS);
    });
  }

  #installBrowserObservers() {
    const visibility = this.dependencies.visibilityTarget;
    if (visibility) {
      this.scope.ownListener(visibility, 'visibilitychange', () => {
        this.#observeSafely(() => {
          if (this.projector) {
            this.projector.setVisibilityState(this.#visibility(), this.#now());
          }
        });
      });
    }
    if (typeof this.context.addEventListener === 'function') {
      this.scope.ownListener(this.context, 'statechange', () => {
        this.#observeSafely(() => {
          if (this.projector) {
            const prior = this.lifecycle.contextStateValue;
            const current = this.#contextState();
            if (current === 'running' || current === 'suspended') {
              this.lifecycle.contextState(current);
            }
            this.projector.setAudioContextState(current, this.#now());
            if (prior === 'running' && current === 'suspended') {
              this.projector.recordSuspension(this.#now());
            }
          }
        });
      });
    }
    if (typeof this.dependencies.createLongTaskObserver === 'function') {
      try {
        this.observer = this.scope.ownObserver(
          this.dependencies.createLongTaskObserver((entries) => this.#recordLongTasks(entries)),
        );
        this.observer.observe?.({ entryTypes: ['longtask'] });
        this.observerHealthy = true;
      } catch {
        this.observerHealthy = false;
      }
    }
  }

  #workletState(state) {
    if (!this.active) return;
    if (state.state === 'stopped') return;
    try {
      const attemptOpen = this.lifecycle.attempt?.terminalCategory === 'open';
      this.lifecycle.playbackState(state.state);
      if (!attemptOpen) return;
      if (state.state === 'playing') this.#setStatus('playing');
      else if (state.state === 'buffering' || state.state === 'underrun') {
        this.#setStatus('buffering');
      }
    } catch {
      void this.#terminate('error', 'unknown');
    }
  }

  #recordLongTasks(entries) {
    if (!this.active || !this.observerHealthy) return;
    let normalized = entries;
    try {
      if (!Array.isArray(normalized) && typeof normalized?.getEntries === 'function') {
        normalized = normalized.getEntries();
      }
    } catch {
      this.#degradeLongTasks();
      return;
    }
    if (!Array.isArray(normalized)) {
      this.#degradeLongTasks();
      return;
    }
    for (const entry of normalized) {
      if (this.longTaskEntries.length === MAX_LONG_TASKS) {
        this.longTaskOverflow = true;
        break;
      }
      this.longTaskEntries.push({ startTime: entry.startTime, duration: entry.duration });
    }
  }

  #drainLongTasks() {
    if (this.observer && this.observerHealthy) {
      try {
        this.#recordLongTasks(this.observer.takeRecords());
      } catch {
        this.#degradeLongTasks();
      }
    }
    const entries = this.longTaskOverflow ? [{}] : this.longTaskEntries;
    this.longTaskEntries = [];
    this.longTaskOverflow = false;
    return entries;
  }

  #observeCurrentBrowserState(atMs) {
    const contextState = this.#contextState();
    if (contextState === 'running' || contextState === 'suspended') {
      const prior = this.lifecycle.contextStateValue;
      this.lifecycle.contextState(contextState);
      if (prior === 'running' && contextState === 'suspended') {
        this.projector.recordSuspension(atMs);
      }
    }
    this.projector.setAudioContextState(contextState, atMs);
    this.projector.setVisibilityState(this.#visibility(), atMs);
  }

  #contextState() {
    return ['running', 'suspended', 'closed', 'interrupted'].includes(this.context?.state)
      ? this.context.state : 'unknown';
  }

  #visibility() {
    const value = this.dependencies.visibilityTarget?.visibilityState;
    return ['visible', 'hidden'].includes(value) ? value : 'unknown';
  }

  #client() {
    return {
      ...this.clientTemplate,
      longTaskStatus: this.observerHealthy ? 'observed'
        : (this.dependencies.createLongTaskObserver ? 'unknown' : 'unsupported'),
    };
  }

  #setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    try {
      this.onStatus(status);
    } catch {
      // UI observation cannot affect stream authority or cleanup.
    }
  }

  #releaseAbortController(controller, abort = false) {
    if (abort) {
      try {
        controller.abort();
      } catch {
        // Releasing the completed attempt remains safe and bounded.
      }
    }
    this.scope.releaseAbortController(controller);
  }

  #observeSafely(callback) {
    try {
      callback();
    } catch {
      try {
        this.lifecycle.recordGap('projection_invalid', 0);
      } catch {
        // A diagnostic observation can be dropped without affecting audio.
      }
    }
  }

  #degradeLongTasks() {
    this.observerHealthy = false;
    this.longTaskEntries = [];
    this.longTaskOverflow = false;
    try {
      this.projector?.setLongTaskStatus('unknown');
    } catch {
      // Optional scheduling evidence remains absent without affecting audio.
    }
  }

  #requireActiveInitialization() {
    if (!this.active) throw new E5LifecycleError('initialization_aborted');
  }

  #closeLateContext(context) {
    try {
      const closing = context?.close?.();
      closing?.catch?.(() => {});
    } catch {
      // A late resource is never published; cleanup remains best-effort and finite.
    }
  }

  #now() {
    const value = this.dependencies.now();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new E5LifecycleError('clock_invalid');
    }
    return value;
  }

  #terminate(status, reason) {
    if (this.terminationPromise) return this.terminationPromise;
    this.active = false;
    if (this.retryResolve) {
      this.retryResolve();
      this.retryResolve = null;
    }
    try {
      this.lifecycle?.stopListener(reason);
    } catch {
      // Cleanup remains authoritative even when local diagnostic projection fails.
    }
    const closing = this.scope?.close?.() ?? Promise.resolve(frozen({
      status: 'closed', cleanupFailures: frozen([]),
    }));
    this.terminationPromise = closing.then((result) => {
      this.cleanupResult = result;
      this.#setStatus(status);
      return result;
    });
    return this.terminationPromise;
  }
}

export const E5_SESSION_LIMITS = frozen({ RETRY_MS, WINDOW_MS, MAX_LONG_TASKS });
