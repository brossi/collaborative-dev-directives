import assert from 'node:assert/strict';
import test from 'node:test';

import { disposeDiagnosticVolume } from '../scripts/dispose-volume.mjs';

const environment = Object.freeze({
  CANNABEATS_DIAGNOSTICS_DATA_VOLUME: 'cannabeats_audit_diagnostics',
  CANNABEATS_DATA_VOLUME: 'cannabeats_audit_access',
  CANNABEATS_STATE_DATA_VOLUME: 'cannabeats_audit_state',
});

function dockerFixture({
  labels = {
    'com.docker.compose.project': 'cannabeats-audit',
    'com.docker.compose.volume': 'cannabeats_diagnostics_data',
  },
  attached = '',
} = {}) {
  const calls = [];
  const runDocker = (args) => {
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') {
      return JSON.stringify({ Labels: labels });
    }
    if (args[0] === 'ps') return attached;
    if (args[0] === 'volume' && args[1] === 'rm') return args[2];
    throw new Error('unexpected docker call');
  };
  return { calls, runDocker };
}

test('targeted disposal removes only the distinct exact-labeled diagnostics volume', () => {
  const fixture = dockerFixture();
  assert.deepEqual(disposeDiagnosticVolume({
    project: 'cannabeats-audit',
    volume: 'cannabeats_audit_diagnostics',
    environment,
    runDocker: fixture.runDocker,
  }), { status: 'disposed' });
  assert.deepEqual(fixture.calls.at(-1), [
    'volume', 'rm', 'cannabeats_audit_diagnostics',
  ]);
});

test('targeted disposal refuses aliases labels and attached volumes before removal', () => {
  const cases = [
    {
      environment: { ...environment, CANNABEATS_DATA_VOLUME: 'cannabeats_audit_diagnostics' },
      expected: 'volume_identity_conflict',
    },
    {
      environment,
      labels: {
        'com.docker.compose.project': 'another-project',
        'com.docker.compose.volume': 'cannabeats_diagnostics_data',
      },
      expected: 'volume_disposal_refused',
    },
    {
      environment,
      labels: {
        'com.docker.compose.project': 'cannabeats-audit',
        'com.docker.compose.volume': 'cannabeats_state_data',
      },
      expected: 'volume_disposal_refused',
    },
    { environment, attached: 'container-id\n', expected: 'volume_in_use' },
  ];

  for (const entry of cases) {
    const fixture = dockerFixture(entry);
    assert.throws(() => disposeDiagnosticVolume({
      project: 'cannabeats-audit',
      volume: 'cannabeats_audit_diagnostics',
      environment: entry.environment,
      runDocker: fixture.runDocker,
    }), (error) => error.code === entry.expected);
    assert.equal(fixture.calls.some((args) => args[0] === 'volume' && args[1] === 'rm'), false);
  }
});
