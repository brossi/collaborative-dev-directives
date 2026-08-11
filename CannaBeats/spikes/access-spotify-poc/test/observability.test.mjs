import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOperationalLogger, createTransitionReporter } from '../observability.mjs';

test('structured records keep only reviewed context and redact secret-shaped values', () => {
  const lines = [];
  const secret = 'configured-relay-token-that-must-never-appear';
  const logger = createOperationalLogger({
    service: 'access',
    environment: 'test',
    applicationVersion: 'app-test',
    catalogVersion: 'catalog-test',
    secrets: [secret],
    now: () => new Date('2026-08-11T12:00:00Z'),
    write: (_level, line) => lines.push(line),
  });
  const record = logger.error(
    'request.failed',
    `Upstream rejected Bearer ${secret} at https://example.test/path?ticket=${secret}`,
    {
      correlationId: '4a551bd5-8f87-42c3-82cc-789f19bbcc18',
      method: 'POST',
      route: '/api/example',
      status: 503,
      authorization: `Bearer ${secret}`,
      cookie: `cb_session=${secret}`,
      body: { token: secret },
      trackUri: 'spotify:track:1234567890123456789012',
      providerPayload: secret,
    },
  );
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], new RegExp(secret));
  assert.equal(record.authorization, undefined);
  assert.equal(record.cookie, undefined);
  assert.equal(record.body, undefined);
  assert.equal(record.trackUri, undefined);
  assert.equal(record.providerPayload, undefined);
  assert.equal(record.status, 503);
  assert.equal(record.applicationVersion, 'app-test');
});

test('capability-like text and pre-reveal track URIs are not emitted', () => {
  const lines = [];
  const logger = createOperationalLogger({
    service: 'access',
    write: (_level, line) => lines.push(line),
  });
  logger.warn(
    'request.rejected',
    'token abcdefghijklmnopqrstuvwxyzABCDEFG123456 and spotify:track:1234567890123456789012',
  );
  assert.doesNotMatch(lines[0], /abcdefghijklmnopqrstuvwxyzABCDEFG123456/);
  assert.doesNotMatch(lines[0], /spotify:track:/);
});

test('a logging sink failure does not escape into request work', () => {
  const logger = createOperationalLogger({
    service: 'access',
    write: () => { throw new Error('test sink unavailable'); },
  });
  assert.doesNotThrow(() => logger.error('request.failed', 'Safe failure'));
});

test('state transitions emit once per change without poll-volume repetition', () => {
  const lines = [];
  const logger = createOperationalLogger({
    service: 'access',
    write: (_level, line) => lines.push(JSON.parse(line)),
  });
  const transitions = createTransitionReporter(logger);
  transitions.report('readiness', 'healthy', {
    event: 'service.readiness_changed', message: 'Access readiness changed', reasonCode: 'ready',
  });
  transitions.report('readiness', 'healthy', {
    event: 'service.readiness_changed', message: 'Access readiness changed', reasonCode: 'ready',
  });
  transitions.report('readiness', 'unavailable', {
    level: 'warn', event: 'service.readiness_changed',
    message: 'Access readiness changed', reasonCode: 'database_unavailable',
  });
  transitions.report('readiness', 'unavailable', {
    level: 'warn', event: 'service.readiness_changed',
    message: 'Access readiness changed', reasonCode: 'database_unavailable',
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.reasonCode), ['ready', 'database_unavailable']);
});
