import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  E8ListenerSharingController,E8_SHARING_DISCLOSURE,
} from '../lib/s2e-e8-listener-sharing.mjs';

function report(instanceId,sequence) {
  return { kind: 'listener_transition',instanceId,sequence };
}

function fixture() {
  let now = 100;
  const instanceId = randomUUID();
  const lifecycle = { instanceId,nextSequence: 2,windows: [],transitions: [
    report(instanceId,0),report(instanceId,1),
  ] };
  const calls = [];
  const timers = [];
  let failReport = false;
  const grantId = randomUUID();
  const traceId = randomUUID();
  const sampleId = randomUUID();
  const controller = new E8ListenerSharingController({
    readLifecycle: () => lifecycle,
    now: () => now++,
    uuid: () => randomUUID(),
    scheduleInterval: (callback) => { timers.push(callback); return timers.length; },
    cancelInterval: () => {},
    onChange: () => {},
    request: async (path,body) => {
      calls.push([path,structuredClone(body)]);
      if (body.action === 'opt_in') return {
        status: 'enabled',grantId,traceId,listenerInstanceId: instanceId,
        generation: 1,expiresAtMs: 10000,
      };
      if (body.action === 'synchronize') return {
        status: 'accepted',grantId,sampleId,timebaseId: traceId,instanceId,
        serverReceiveMs: 101,serverSendMs: 102,
      };
      if (body.action === 'stop') return { status: 'revoked',grantId,generation: 2 };
      if (path.endsWith('listener-report')) {
        if (failReport) throw Object.assign(new Error('lost'),{ code: 'diagnostic_unavailable' });
        return { status: 'accepted',receivedAt: 105 };
      }
      throw new Error('unexpected');
    },
  });
  return {
    calls,controller,grantId,instanceId,lifecycle,
    setFail: (value) => { failReport = value; },setNow: (value) => { now = value; },
  };
}

test('opt-in starts at the next sequence and never backfills retained local reports', async () => {
  const f = fixture();
  assert.equal(await f.controller.optIn(randomUUID()),true);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0][1].firstAllowedSequence,2);
  await f.controller.flush();
  assert.equal(f.calls.length,1);
  f.lifecycle.transitions.push(report(f.instanceId,2));
  assert.equal(await f.controller.flush(),true);
  assert.deepEqual(f.calls.map((entry) => entry[0]),[
    '/api/diagnostics/listener','/api/diagnostics/listener',
    '/api/diagnostics/listener-report',
  ]);
  assert.equal(f.calls[2][1].measurementCore.sequence,2);
});

test('report response loss retains one exact report and synchronization observation', async () => {
  const f = fixture();
  await f.controller.optIn(randomUUID());
  f.lifecycle.transitions.push(report(f.instanceId,2),report(f.instanceId,3));
  f.setFail(true);
  assert.equal(await f.controller.flush(),false);
  const firstReport = f.calls.at(-1)[1];
  f.setFail(false);
  assert.equal(await f.controller.flush(),true);
  const secondReport = f.calls.at(-1)[1];
  assert.deepEqual(secondReport,firstReport);
  assert.equal(f.calls.filter(([path]) => path.endsWith('listener-report')).length,2);
  assert.equal(f.calls.filter(([,body]) => body.action === 'synchronize').length,1);
});

test('opt-in acknowledgement advances the floor past reports created while consent was pending', async () => {
  const f = fixture();
  const original = f.controller.request;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  f.controller.request = async (path,body) => {
    if (body.action === 'opt_in') await held;
    return original(path,body);
  };
  const optingIn = f.controller.optIn(randomUUID());
  f.lifecycle.transitions.push(report(f.instanceId,2));
  f.lifecycle.nextSequence = 3;
  release();
  assert.equal(await optingIn,true);
  f.lifecycle.transitions.push(report(f.instanceId,3));
  f.lifecycle.nextSequence = 4;
  assert.equal(await f.controller.flush(),true);
  const uploaded = f.calls.find(([path]) => path.endsWith('listener-report'))[1];
  assert.equal(uploaded.measurementCore.sequence,3);
});

test('lost synchronization response uses a fresh sample exchange on retry', async () => {
  const f = fixture();
  await f.controller.optIn(randomUUID());
  f.lifecycle.transitions.push(report(f.instanceId,2));
  f.lifecycle.nextSequence = 3;
  const original = f.controller.request;
  let failed = false;
  f.controller.request = async (path,body) => {
    if (body.action === 'synchronize' && !failed) {
      failed = true;
      f.calls.push([path,structuredClone(body)]);
      throw Object.assign(new Error('lost'),{ code: 'diagnostic_unavailable' });
    }
    return original(path,body);
  };
  assert.equal(await f.controller.flush(),false);
  assert.equal(await f.controller.flush(),true);
  const syncs = f.calls.filter(([,body]) => body.action === 'synchronize');
  assert.equal(syncs.length,2);
  assert.notEqual(syncs[0][1].requestId,syncs[1][1].requestId);
});

test('an overlong synchronization exchange is discarded before report upload', async () => {
  const f = fixture();
  await f.controller.optIn(randomUUID());
  f.lifecycle.transitions.push(report(f.instanceId,2));
  f.lifecycle.nextSequence = 3;
  const original = f.controller.request;
  let delayed = false;
  f.controller.request = async (path,body) => {
    const result = await original(path,body);
    if (body.action === 'synchronize' && !delayed) {
      delayed = true;
      f.setNow(3_000);
    }
    return result;
  };
  assert.equal(await f.controller.flush(),false);
  assert.equal(f.calls.some(([path]) => path.endsWith('listener-report')),false);
  assert.equal(await f.controller.flush(),true);
  const syncs = f.calls.filter(([,body]) => body.action === 'synchronize');
  assert.notEqual(syncs[0][1].requestId,syncs[1][1].requestId);
});

test('stop becomes sticky while uncertain and exact retry performs no new upload', async () => {
  const f = fixture();
  await f.controller.optIn(randomUUID());
  let stopCalls = 0;
  const original = f.controller.request;
  f.controller.request = async (path,body) => {
    if (body.action === 'stop' && stopCalls++ === 0) {
      throw Object.assign(new Error('lost'),{ code: 'diagnostic_unavailable' });
    }
    return original(path,body);
  };
  assert.equal(await f.controller.stop(),false);
  assert.equal(f.controller.state.status,'stopping');
  f.lifecycle.transitions.push(report(f.instanceId,2));
  assert.equal(await f.controller.flush(),false);
  assert.equal(await f.controller.stop(),true);
  const stops = f.calls.filter(([,body]) => body.action === 'stop');
  assert.equal(stops.length,1);
  assert.equal(f.controller.state.status,'disabled');
});

test('stop fences uploads synchronously without waiting for the diagnostics response', async () => {
  const f = fixture();
  await f.controller.optIn(randomUUID());
  f.lifecycle.transitions.push(report(f.instanceId,2));
  f.lifecycle.nextSequence = 3;
  const original = f.controller.request;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  f.controller.request = async (path,body) => {
    if (body.action === 'stop') await held;
    return original(path,body);
  };
  const stopping = f.controller.stop();
  assert.equal(f.controller.state.status,'stopping');
  assert.equal(await f.controller.flush(),false);
  release();
  assert.equal(await stopping,true);
});

test('opt-in and stop are single-flight while their dependency response is pending', async () => {
  const f = fixture();
  const original = f.controller.request;
  let releaseOptIn;
  const heldOptIn = new Promise((resolve) => { releaseOptIn = resolve; });
  f.controller.request = async (path,body) => {
    if (body.action === 'opt_in') await heldOptIn;
    return original(path,body);
  };
  const firstOptIn = f.controller.optIn(randomUUID());
  assert.equal(await f.controller.optIn(randomUUID()),false);
  releaseOptIn();
  assert.equal(await firstOptIn,true);
  assert.equal(f.controller.state.status,'enabled');

  let releaseStop;
  const heldStop = new Promise((resolve) => { releaseStop = resolve; });
  f.controller.request = async (path,body) => {
    if (body.action === 'stop') await heldStop;
    return original(path,body);
  };
  const firstStop = f.controller.stop();
  assert.equal(await f.controller.stop(),false);
  releaseStop();
  assert.equal(await firstStop,true);
  assert.equal(f.controller.state.status,'disabled');
});

test('terminal report outcomes reduce authority instead of poisoning the pending slot', async () => {
  const f = fixture();
  await f.controller.optIn(randomUUID());
  f.lifecycle.transitions.push(report(f.instanceId,2));
  f.lifecycle.nextSequence = 3;
  const original = f.controller.request;
  f.controller.request = async (path,body) => path.endsWith('listener-report')
    ? { status: 'sharing_disabled' } : original(path,body);
  assert.equal(await f.controller.flush(),false);
  assert.equal(f.controller.state.status,'disabled');
  assert.equal(f.controller.pendingReport,null);
});

test('disposed opt-in completion cannot install a grant or schedule uploads', async () => {
  const f = fixture();
  const original = f.controller.request;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  f.controller.request = async (path,body) => {
    if (body.action === 'opt_in') await held;
    return original(path,body);
  };
  const pending = f.controller.optIn(randomUUID());
  f.controller.dispose();
  release();
  assert.equal(await pending,false);
  assert.equal(f.controller.grant,null);
  assert.equal(f.controller.timer,null);
});

test('a stale rejected upload cannot interfere with a concurrent stop', async () => {
  const f = fixture();
  await f.controller.optIn(randomUUID());
  f.lifecycle.transitions.push(report(f.instanceId,2));
  f.lifecycle.nextSequence = 3;
  const original = f.controller.request;
  let rejectSync;
  let releaseStop;
  const heldSync = new Promise((_,reject) => { rejectSync = reject; });
  const heldStop = new Promise((resolve) => { releaseStop = resolve; });
  f.controller.request = async (path,body) => {
    if (body.action === 'synchronize') return heldSync;
    if (body.action === 'stop') {
      await heldStop;
      return original(path,body);
    }
    return original(path,body);
  };
  const flushing = f.controller.flush();
  await Promise.resolve();
  const stopping = f.controller.stop();
  rejectSync(Object.assign(new Error('stale'),{ code: 'diagnostic_not_found' }));
  assert.equal(await flushing,false);
  releaseStop();
  assert.equal(await stopping,true);
  assert.equal(f.controller.state.status,'disabled');
  assert.equal(f.controller.grant,null);
});

test('opt-in completion cannot install a grant for a rotated listener instance', async () => {
  const f = fixture();
  const original = f.controller.request;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  f.controller.request = async (path,body) => {
    if (body.action === 'opt_in') await held;
    return original(path,body);
  };
  const pending = f.controller.optIn(randomUUID());
  f.lifecycle.instanceId = randomUUID();
  f.lifecycle.windows = [];
  f.lifecycle.transitions = [];
  f.lifecycle.nextSequence = 0;
  release();
  assert.equal(await pending,false);
  assert.equal(f.controller.grant,null);
  assert.equal(f.controller.optInIntent,null);
  assert.equal(f.controller.state.notice,'grant_lost');
});

test('an overlong server synchronization interval is rejected before upload', async () => {
  const f = fixture();
  await f.controller.optIn(randomUUID());
  f.lifecycle.transitions.push(report(f.instanceId,2));
  f.lifecycle.nextSequence = 3;
  const original = f.controller.request;
  f.controller.request = async (path,body) => body.action === 'synchronize'
    ? {
        status: 'accepted',grantId: f.grantId,sampleId: randomUUID(),
        timebaseId: f.controller.grant.traceId,instanceId: f.instanceId,
        serverReceiveMs: 0,serverSendMs: 2_001,
      }
    : original(path,body);
  assert.equal(await f.controller.flush(),false);
  assert.equal(f.calls.filter(([path]) => path.endsWith('listener-report')).length,0);
  assert.equal(f.controller.pendingReport.sampleObservation,null);
});

test('grant-lost clears the old intent so a fresh opt-in uses a new request', async () => {
  const f = fixture();
  const original = f.controller.request;
  let first = true;
  f.controller.request = async (path,body) => {
    if (body.action === 'opt_in' && first) {
      first = false;
      f.calls.push([path,structuredClone(body)]);
      throw Object.assign(new Error('lost'),{ code: 'grant_lost' });
    }
    return original(path,body);
  };
  const runId = randomUUID();
  assert.equal(await f.controller.optIn(runId),false);
  assert.equal(await f.controller.optIn(runId),true);
  const optIns = f.calls.filter(([,body]) => body.action === 'opt_in');
  assert.notEqual(optIns[0][1].requestId,optIns[1][1].requestId);
});

test('pre-opt-in disclosure names uploaded categories attribution retention and stop semantics', () => {
  for (const phrase of [
    'random diagnostic ID','browser and operating-system category','local timing',
    'buffer and stream behavior','categorical signal state','pseudonymous, not anonymous',
    'host may recognize','purged or expires under retention',
    'stopping sharing does not delete',
  ]) assert.match(E8_SHARING_DISCLOSURE,new RegExp(phrase));
});

test('production audio start detaches optional diagnostic retirement before initialization', async () => {
  const source = await readFile(
    new URL('../lib/use-managed-audio-stream.ts',import.meta.url),'utf8',
  );
  const start = source.slice(
    source.indexOf('const start = useCallback'),source.indexOf('const diagnostics = useCallback'),
  );
  assert.match(start,/void retireSharing\(\);/);
  assert.doesNotMatch(start,/await retireSharing\(\);/);
  assert.ok(start.indexOf('void retireSharing();') < start.indexOf('new E5BrowserSession'));
  const reset = source.slice(
    source.indexOf('const resetDiagnostics = useCallback'),
    source.indexOf('const sharingController = useCallback'),
  );
  assert.match(reset,/sharingBlockedRef\.current = true;[\s\S]*await retireSharing\(\);[\s\S]*await session\.resetDiagnostics\(\);[\s\S]*sharingBlockedRef\.current = false;/);
  assert.match(source,/sharingBlockedRef\.current \? false : sharingController\(\)\.optIn\(runId\)/);
});
