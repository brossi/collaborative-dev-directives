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

export class E5BrowserSession {
  constructor({ streamUrl, client, dependencies, onStatus = () => {} }) {
    if (typeof streamUrl !== 'string' || !streamUrl || !client || !dependencies
      || typeof dependencies.now !== 'function' || typeof dependencies.uuid !== 'function'
      || typeof dependencies.fetch !== 'function'
      || typeof dependencies.createAbortController !== 'function'
      || typeof dependencies.createAudioContext !== 'function'
      || typeof dependencies.createWorkletNode !== 'function'
      || typeof dependencies.scheduleTimeout !== 'function'
      || typeof dependencies.cancelTimeout !== 'function'
      || typeof onStatus !== 'function') throw new E5LifecycleError('session_invalid');
    this.streamUrl = streamUrl;
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
    this.retryResolve = null;
    this.longTaskEntries = [];
    this.longTaskOverflow = false;
    this.observer = null;
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
      this.context = this.scope.ownContext(await this.dependencies.createAudioContext());
      await this.context.resume();
      await this.context.audioWorklet.addModule('/s2e-e4-worklet.js');
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

  async #run() {
    while (this.active) {
      const reconnect = this.lifecycle.everDeliveredPcm;
      this.lifecycle.beginAttempt();
      const attemptAt = this.#now();
      if (this.projector) {
        this.projector.setTerminalCategory('open', attemptAt);
        if (reconnect) this.projector.recordReconnect(attemptAt);
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
      const reader = this.scope.ownReader(response.body.getReader());
      let terminal = 'stream_ended';
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
        try {
          const cancellation = reader.cancel();
          cancellation?.catch?.(() => {});
        } catch {
          // The finite stream outcome is retained; session cleanup continues.
        }
      }
      if (!this.active) return;
      this.scope.releaseReader(reader);
      this.#releaseAbortController(controller);
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
    await this.#rotate('stop');
    this.lifecycle.rotateInstance(this.dependencies.uuid());
    this.format = null;
    this.projector = null;
    await this.#configure(nextFormat);
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

  async #rotate(operation) {
    if (this.rotationPromise) await this.rotationPromise;
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
      } catch {
        this.observer = null;
      }
    }
  }

  #workletState(state) {
    if (!this.active || this.lifecycle.attempt?.terminalCategory !== 'open') return;
    if (state.state === 'stopped') return;
    try {
      this.lifecycle.playbackState(state.state);
      if (state.state === 'playing') this.#setStatus('playing');
      else if (state.state === 'buffering' || state.state === 'underrun') {
        this.#setStatus('buffering');
      }
    } catch {
      void this.#terminate('error', 'unknown');
    }
  }

  #recordLongTasks(entries) {
    if (!this.active || !Array.isArray(entries)) return;
    for (const entry of entries) {
      if (this.longTaskEntries.length === MAX_LONG_TASKS) {
        this.longTaskOverflow = true;
        break;
      }
      this.longTaskEntries.push({ startTime: entry.startTime, duration: entry.duration });
    }
  }

  #drainLongTasks() {
    if (this.observer) this.#recordLongTasks(this.observer.takeRecords());
    const entries = this.longTaskOverflow ? [{}] : this.longTaskEntries;
    this.longTaskEntries = [];
    this.longTaskOverflow = false;
    return entries;
  }

  #observeCurrentBrowserState(atMs) {
    const contextState = this.#contextState();
    if (contextState === 'running' || contextState === 'suspended') {
      this.lifecycle.contextState(contextState);
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
      longTaskStatus: this.observer ? 'observed'
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
    this.terminationPromise = this.scope.close().then((result) => {
      this.cleanupResult = result;
      this.#setStatus(status);
      return result;
    });
    return this.terminationPromise;
  }
}

export const E5_SESSION_LIMITS = frozen({ RETRY_MS, WINDOW_MS, MAX_LONG_TASKS });
