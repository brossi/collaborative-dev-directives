const TIMER_KINDS = new Set(['window', 'retry']);
const CLEANUP_CATEGORIES = new Set([
  'abort', 'reader_cancel', 'timer_clear', 'observer_disconnect',
  'listener_remove', 'port_close', 'node_disconnect', 'context_close',
]);

function frozen(value) {
  return Object.freeze(value);
}

export class E5ResourceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E5ResourceError';
    this.code = code;
  }
}

function fail(code) {
  throw new E5ResourceError(code);
}

function beginAttempt(category, operation, failures, pending) {
  try {
    const result = operation();
    if (result && typeof result.then === 'function') {
      pending.push(Promise.resolve(result).catch(() => failures.push(category)));
    }
  } catch {
    failures.push(category);
  }
}

export class E5BrowserResourceScope {
  constructor({ scheduleTimeout, cancelTimeout }) {
    if (typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function') {
      fail('resources_invalid');
    }
    this.scheduleTimeout = scheduleTimeout;
    this.cancelTimeout = cancelTimeout;
    this.active = true;
    this.abortController = null;
    this.reader = null;
    this.timers = new Map();
    this.observer = null;
    this.listeners = [];
    this.port = null;
    this.node = null;
    this.context = null;
    this.closePromise = null;
  }

  guard(callback) {
    if (typeof callback !== 'function') fail('callback_invalid');
    return (...args) => {
      if (!this.active) return undefined;
      return callback(...args);
    };
  }

  ownAbortController(controller) {
    this.#assertActive();
    if (this.abortController || !controller || typeof controller.abort !== 'function') {
      fail('abort_invalid');
    }
    this.abortController = controller;
    return controller;
  }

  releaseAbortController(controller) {
    if (controller !== this.abortController) fail('abort_invalid');
    this.abortController = null;
  }

  ownReader(reader) {
    this.#assertActive();
    if (this.reader || !reader || typeof reader.cancel !== 'function') fail('reader_invalid');
    this.reader = reader;
    return reader;
  }

  releaseReader(reader) {
    if (reader !== this.reader) fail('reader_invalid');
    this.reader = null;
  }

  schedule(kind, callback, delayMs) {
    this.#assertActive();
    if (!TIMER_KINDS.has(kind) || typeof callback !== 'function'
      || !Number.isSafeInteger(delayMs) || delayMs < 0 || this.timers.has(kind)) {
      fail('timer_invalid');
    }
    let timerId;
    const guarded = this.guard(() => {
      if (this.timers.get(kind) !== timerId) return;
      this.timers.delete(kind);
      callback();
    });
    timerId = this.scheduleTimeout(guarded, delayMs);
    this.timers.set(kind, timerId);
    return timerId;
  }

  cancel(kind) {
    const timerId = this.timers.get(kind);
    if (timerId === undefined) return false;
    this.cancelTimeout(timerId);
    this.timers.delete(kind);
    return true;
  }

  ownObserver(observer) {
    this.#assertActive();
    if (this.observer || !observer || typeof observer.disconnect !== 'function'
      || typeof observer.takeRecords !== 'function') fail('observer_invalid');
    this.observer = observer;
    return observer;
  }

  ownListener(target, type, callback) {
    this.#assertActive();
    if (this.listeners.length >= 2 || !target || typeof type !== 'string' || !type
      || typeof callback !== 'function' || typeof target.addEventListener !== 'function'
      || typeof target.removeEventListener !== 'function') fail('listener_invalid');
    const guarded = this.guard(callback);
    target.addEventListener(type, guarded);
    this.listeners.push(frozen({ target, type, callback: guarded }));
    return guarded;
  }

  ownPort(port) {
    this.#assertActive();
    if (this.port || !port || typeof port.close !== 'function') fail('port_invalid');
    this.port = port;
    return port;
  }

  ownNode(node) {
    this.#assertActive();
    if (this.node || !node || typeof node.disconnect !== 'function') fail('node_invalid');
    this.node = node;
    return node;
  }

  ownContext(context) {
    this.#assertActive();
    if (this.context || !context || typeof context.close !== 'function') fail('context_invalid');
    this.context = context;
    return context;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.active = false;
    this.closePromise = this.#closeOwned();
    return this.closePromise;
  }

  async #closeOwned() {
    const failures = [];
    const pending = [];
    if (this.abortController) {
      beginAttempt('abort', () => this.abortController.abort(), failures, pending);
      this.abortController = null;
    }
    if (this.reader) {
      beginAttempt('reader_cancel', () => this.reader.cancel(), failures, pending);
      this.reader = null;
    }
    for (const timerId of this.timers.values()) {
      beginAttempt('timer_clear', () => this.cancelTimeout(timerId), failures, pending);
    }
    this.timers.clear();
    if (this.observer) {
      beginAttempt(
        'observer_disconnect', () => this.observer.disconnect(), failures, pending,
      );
      this.observer = null;
    }
    for (const { target, type, callback } of this.listeners) {
      beginAttempt(
        'listener_remove', () => target.removeEventListener(type, callback), failures, pending,
      );
    }
    this.listeners.length = 0;
    if (this.port) {
      beginAttempt('port_close', () => this.port.close(), failures, pending);
      this.port = null;
    }
    if (this.node) {
      beginAttempt('node_disconnect', () => this.node.disconnect(), failures, pending);
      this.node = null;
    }
    if (this.context) {
      beginAttempt('context_close', () => this.context.close(), failures, pending);
      this.context = null;
    }
    await Promise.all(pending);
    return frozen({
      status: 'closed',
      cleanupFailures: frozen([...new Set(
        failures.filter((value) => CLEANUP_CATEGORIES.has(value)),
      )]),
    });
  }

  #assertActive() {
    if (!this.active) fail('resources_closed');
  }
}

export const E5_RESOURCE_LIMITS = frozen({
  timerKinds: frozen([...TIMER_KINDS]),
  maximumListeners: 2,
  maximumObservers: 1,
  maximumReaders: 1,
  maximumNodes: 1,
  maximumContexts: 1,
});
