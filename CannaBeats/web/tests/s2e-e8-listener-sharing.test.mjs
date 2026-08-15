import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  E8ListenerSharingController,
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
  return { calls,controller,grantId,instanceId,lifecycle,setFail: (value) => { failReport = value; } };
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
