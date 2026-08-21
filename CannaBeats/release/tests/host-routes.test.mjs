import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  HOST_COOKIE, challengeIssueRoute, enrollmentIssueRoute, webTicketExchangeRoute,
} from '../../web/lib/server/release/host-routes.mjs';
import { ReleaseStoreError } from '../../web/lib/server/release/store.mjs';

function bearer() {
  return randomBytes(24).toString('base64url');
}

function request(value, { token, headers = {} } = {}) {
  return new Request('https://play.cannabeats.social/api/host/test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(value),
  });
}

test('authorized enrollment issuance forwards only the fixed bounded request', async () => {
  const token = bearer();
  const enrollmentCode = bearer();
  const requestId = randomUUID();
  let received;
  const response = await enrollmentIssueRoute(request({ enrollmentCode, requestId }, { token }), {
    issueEnrollment(input) {
      received = input;
      return { code: 'enrollment_issued', expiresAt: 901_000 };
    },
  }, 1_000);
  assert.equal(response.status, 201);
  assert.deepEqual(received, {
    enrollmentCode, requestId, applicationSessionToken: token, now: 1_000,
  });
  assert.deepEqual(await response.json(), { code: 'enrollment_issued', expiresAt: 901_000 });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('ticket exchange sets the exact host-only cookie without a Domain attribute', async () => {
  const ticket = bearer();
  const response = await webTicketExchangeRoute(request({ ticket }), {
    exchangeHostWebTicket: () => ({
      code: 'ticket_exchanged', deviceId: randomUUID(), expiresAt: 44_001_000,
    }),
  }, 1_000);
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, new RegExp(`^${HOST_COOKIE}=${ticket}; Path=/; Max-Age=44000;`));
  assert.match(cookie, /; Secure; HttpOnly; SameSite=Strict$/u);
  assert.doesNotMatch(cookie, /Domain=/iu);
});

test('route failures are finite and never reflect supplied or native content', async () => {
  const secret = bearer();
  const malformed = await challengeIssueRoute(request({
    challenge: secret, deviceId: randomUUID(), requestId: randomUUID(), extra: secret,
  }), {});
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { ok: false, code: 'invalid_request' });

  const unauthorized = await enrollmentIssueRoute(request({
    enrollmentCode: secret, requestId: randomUUID(),
  }), { issueEnrollment: () => assert.fail('must authenticate first') });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { ok: false, code: 'unauthorized' });

  const failed = await challengeIssueRoute(request({
    challenge: secret, deviceId: randomUUID(), requestId: randomUUID(),
  }), () => { throw new Error(`SQLite at /secret/${secret}`); });
  assert.equal(failed.status, 503);
  const text = await failed.text();
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes('SQLite'), false);

  const finite = await challengeIssueRoute(request({
    challenge: secret, deviceId: randomUUID(), requestId: randomUUID(),
  }), () => { throw new ReleaseStoreError('capacity_reached'); });
  assert.equal(finite.status, 429);
  assert.deepEqual(await finite.json(), { ok: false, code: 'capacity_reached' });
});
