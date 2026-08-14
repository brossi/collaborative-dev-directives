import assert from 'node:assert/strict';
import test from 'node:test';

import {
  E5BrowserResourceScope, E5ResourceError,
} from '../lib/s2e-e5-browser-resources.mjs';

function timerHarness() {
  let next = 1;
  const callbacks = new Map();
  const cleared = [];
  return {
    schedule(callback) {
      const id = next++;
      callbacks.set(id, callback);
      return id;
    },
    clear(id) {
      callbacks.delete(id);
      cleared.push(id);
    },
    fire(id) {
      const callback = callbacks.get(id);
      callbacks.delete(id);
      callback?.();
    },
    callbacks,
    cleared,
  };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback) { listeners.set(type, callback); },
    removeEventListener(type, callback) {
      if (listeners.get(type) === callback) listeners.delete(type);
    },
    emit(type) { listeners.get(type)?.(); },
    listeners,
  };
}

test('resource scope owns the bounded browser surface and cleans it in order', async () => {
  const calls = [];
  const timers = timerHarness();
  const scope = new E5BrowserResourceScope({
    scheduleTimeout: (callback) => timers.schedule(callback),
    cancelTimeout: (id) => { calls.push(`timer:${id}`); timers.clear(id); },
  });
  const visibility = eventTarget();
  const contextEvents = eventTarget();
  let guardedCalls = 0;
  scope.ownAbortController({ abort() { calls.push('abort'); } });
  scope.ownReader({ async cancel() { calls.push('reader'); } });
  scope.schedule('window', () => { guardedCalls += 1; }, 9000);
  scope.schedule('retry', () => { guardedCalls += 1; }, 1500);
  scope.ownObserver({
    observe() {}, takeRecords: () => [], disconnect() { calls.push('observer'); },
  });
  scope.ownListener(visibility, 'visibilitychange', () => { guardedCalls += 1; });
  scope.ownListener(contextEvents, 'statechange', () => { guardedCalls += 1; });
  scope.ownPort({ close() { calls.push('port'); } });
  scope.ownNode({ disconnect() { calls.push('node'); } });
  scope.ownContext({ async close() { calls.push('context'); } });

  visibility.emit('visibilitychange');
  assert.equal(guardedCalls, 1);
  const first = scope.close();
  const second = scope.close();
  assert.equal(first, second);
  const result = await first;
  assert.deepEqual(result, { status: 'closed', cleanupFailures: [] });
  assert.deepEqual(calls, [
    'abort', 'reader', 'timer:1', 'timer:2', 'observer',
    'port', 'node', 'context', 'timer:3',
  ]);
  assert.equal(visibility.listeners.size, 0);
  assert.equal(contextEvents.listeners.size, 0);
  visibility.emit('visibilitychange');
  for (const id of [...timers.callbacks.keys()]) timers.fire(id);
  assert.equal(guardedCalls, 1);
});

test('cleanup failures are finite and never block later cleanup stages', async () => {
  const reached = [];
  const timers = timerHarness();
  const target = eventTarget();
  target.removeEventListener = () => { throw new Error('private listener detail'); };
  const scope = new E5BrowserResourceScope({
    scheduleTimeout: (callback) => timers.schedule(callback),
    cancelTimeout() { throw new Error('private timer detail'); },
  });
  scope.ownAbortController({ abort() { throw new Error('private abort detail'); } });
  scope.ownReader({ cancel() { throw new Error('private reader detail'); } });
  scope.schedule('window', () => {}, 1);
  scope.ownObserver({
    observe() {}, takeRecords: () => [], disconnect() { throw new Error('private observer'); },
  });
  scope.ownListener(target, 'change', () => {});
  scope.ownPort({ close() { throw new Error('private port'); } });
  scope.ownNode({ disconnect() { reached.push('node'); } });
  scope.ownContext({ async close() { reached.push('context'); } });
  const result = await scope.close();
  assert.deepEqual(result.cleanupFailures, [
    'abort', 'reader_cancel', 'timer_clear', 'observer_disconnect',
    'listener_remove', 'port_close',
  ]);
  assert.deepEqual(reached, ['node', 'context']);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('scope enforces one resource per slot and two named timers/listeners', async () => {
  const timers = timerHarness();
  const scope = new E5BrowserResourceScope({
    scheduleTimeout: (callback) => timers.schedule(callback),
    cancelTimeout: (id) => timers.clear(id),
  });
  scope.ownAbortController({ abort() {} });
  assert.throws(
    () => scope.ownAbortController({ abort() {} }),
    (error) => error instanceof E5ResourceError && error.code === 'abort_invalid',
  );
  scope.schedule('window', () => {}, 1);
  assert.throws(() => scope.schedule('window', () => {}, 1));
  const first = eventTarget();
  const second = eventTarget();
  const third = eventTarget();
  scope.ownListener(first, 'a', () => {});
  scope.ownListener(second, 'b', () => {});
  assert.throws(() => scope.ownListener(third, 'c', () => {}));
  await scope.close();
  assert.throws(
    () => scope.schedule('retry', () => {}, 1),
    (error) => error instanceof E5ResourceError && error.code === 'resources_closed',
  );
});

test('cancelled and fired timers cannot execute twice or after closure', async () => {
  const timers = timerHarness();
  const scope = new E5BrowserResourceScope({
    scheduleTimeout: (callback) => timers.schedule(callback),
    cancelTimeout: (id) => timers.clear(id),
  });
  let calls = 0;
  const windowId = scope.schedule('window', () => { calls += 1; }, 1);
  timers.fire(windowId);
  assert.equal(calls, 1);
  assert.equal(scope.cancel('window'), false);
  const retryId = scope.schedule('retry', () => { calls += 1; }, 1);
  assert.equal(scope.cancel('retry'), true);
  timers.fire(retryId);
  await scope.close();
  assert.equal(calls, 1);
});

test('a pending reader cancellation cannot prevent later cleanup from starting', async () => {
  const timers = timerHarness();
  let releaseReader;
  const readerPending = new Promise((resolve) => { releaseReader = resolve; });
  const reached = [];
  const scope = new E5BrowserResourceScope({
    scheduleTimeout: (callback) => timers.schedule(callback),
    cancelTimeout: (id) => timers.clear(id),
  });
  scope.ownReader({ cancel: () => readerPending });
  scope.ownNode({ disconnect() { reached.push('node'); } });
  scope.ownContext({ close() { reached.push('context'); return Promise.resolve(); } });
  const closing = scope.close();
  await Promise.resolve();
  assert.deepEqual(reached, ['node', 'context']);
  releaseReader();
  assert.deepEqual(await closing, { status: 'closed', cleanupFailures: [] });
});

test('a hung asynchronous cleanup settles at the finite cleanup deadline', async () => {
  const timers = timerHarness();
  const reached = [];
  const scope = new E5BrowserResourceScope({
    scheduleTimeout: (callback) => timers.schedule(callback),
    cancelTimeout: (id) => timers.clear(id),
  });
  scope.ownReader({ cancel: () => new Promise(() => {}) });
  scope.ownNode({ disconnect() { reached.push('node'); } });
  scope.ownContext({ close() { reached.push('context'); return Promise.resolve(); } });
  const closing = scope.close();
  await Promise.resolve();
  assert.deepEqual(reached, ['node', 'context']);
  const deadlineId = [...timers.callbacks.keys()].at(-1);
  timers.fire(deadlineId);
  assert.deepEqual(await closing, {
    status: 'closed', cleanupFailures: ['cleanup_timeout'],
  });
});
