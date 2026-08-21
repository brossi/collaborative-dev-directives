import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootstrapEnrollment, parseHostAdminArguments, renderHostAdminResult,
} from '../scripts/host-admin.mjs';

test('bootstrap CLI requires one exact fixed argument set', () => {
  const values = parseHostAdminArguments([
    'bootstrap-enrollment', '--database', '/db', '--catalog', '/catalog',
    '--manifest', '/manifest', '--request-id', 'request', '--code-fd', '0',
  ]);
  assert.deepEqual({ ...values }, {
    database: '/db', catalog: '/catalog', manifest: '/manifest',
    'request-id': 'request', 'code-fd': '0',
  });
  assert.throws(() => parseHostAdminArguments(['bootstrap-enrollment', '--database', '/db']),
    /invalid_arguments/u);
  assert.throws(() => parseHostAdminArguments([
    'bootstrap-enrollment', '--database', '/db', '--catalog', '/catalog',
    '--manifest', '/manifest', '--request-id', 'request', '--code-fd', '0',
    '--unknown', 'secret',
  ]), /invalid_arguments/u);
});

test('bootstrap passes the code once but renders no secret or path', () => {
  let received;
  const store = {
    issueEnrollment(input) {
      received = input;
      return { code: 'enrollment_issued', expiresAt: 901_000 };
    },
    close() {},
  };
  const values = {
    database: '/private/database', catalog: '/private/catalog', manifest: '/private/manifest',
    'request-id': 'request-id', 'code-fd': '7',
  };
  const result = bootstrapEnrollment(values, {
    now: 1_000,
    readCode: (descriptor) => {
      assert.equal(descriptor, 7);
      return 'secret-enrollment-code\n';
    },
    loadCatalog: (paths) => paths,
    createStore: (_path, options) => {
      assert.equal(options.now, 1_000);
      return store;
    },
  });
  assert.deepEqual(received, {
    enrollmentCode: 'secret-enrollment-code', requestId: 'request-id', now: 1_000,
  });
  const output = renderHostAdminResult(result);
  assert.equal(output, '{"code":"enrollment_issued","expiresAt":901000}');
  assert.doesNotMatch(output, /secret|private/u);
});

test('bootstrap rejects ambiguous or multiline descriptor input', () => {
  const values = {
    database: '/db', catalog: '/catalog', manifest: '/manifest',
    'request-id': 'request-id', 'code-fd': '0',
  };
  for (const code of ['', 'first\nsecond\n']) {
    assert.throws(() => bootstrapEnrollment(values, { readCode: () => code }), /invalid_arguments/u);
  }
  assert.throws(() => bootstrapEnrollment({ ...values, 'code-fd': '-1' }), /invalid_arguments/u);
});
