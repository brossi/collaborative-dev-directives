import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateDiagnosticCredentialFiles,
} from '../deploy/validate-diagnostic-credentials.mjs';

const paths = {
  DIAGNOSTICS_GAME_TOKEN_HOST_FILE: '/game',
  DIAGNOSTICS_RELAY_TOKEN_HOST_FILE: '/relay',
  DIAGNOSTICS_MAINTENANCE_TOKEN_HOST_FILE: '/maintenance',
};
const values = {
  '/game': 'game-token-000000000000000000000000',
  '/relay': 'relay-token-00000000000000000000000',
  '/maintenance': 'maintenance-token-0000000000000000',
};

test('diagnostic credential preflight accepts exactly three pairwise-distinct files', () => {
  assert.deepEqual(validateDiagnosticCredentialFiles(paths,(path) => `${values[path]}\n`),{
    status: 'valid',
  });
});

test('diagnostic credential preflight rejects each pairwise collision without exposing values', () => {
  for (const [left,right] of [
    ['/game','/relay'],['/game','/maintenance'],['/relay','/maintenance'],
  ]) {
    const collision = { ...values,[right]: values[left] };
    assert.throws(() => validateDiagnosticCredentialFiles(paths,(path) => collision[path]),
      (error) => error.message === 'diagnostic_credential_collision'
        && !error.message.includes(values[left]));
  }
});

test('diagnostic credential preflight rejects missing unreadable and malformed files finitely', () => {
  assert.throws(() => validateDiagnosticCredentialFiles({},() => ''),
    /diagnostic_credential_configuration_invalid/);
  assert.throws(() => validateDiagnosticCredentialFiles(paths,() => { throw new Error('secret'); }),
    (error) => error.message === 'diagnostic_credential_configuration_invalid');
  assert.throws(() => validateDiagnosticCredentialFiles(paths,() => 'short'),
    /diagnostic_credential_configuration_invalid/);
});
