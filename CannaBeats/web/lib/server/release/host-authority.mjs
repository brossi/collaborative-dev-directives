import { createPublicKey, verify as verifySignature } from 'node:crypto';

import {
  SHA256_PATTERN, UUID_PATTERN, assertTimestamp, assertUuid, canonicalJson, parseCanonicalJson, sha256,
} from './canonical.mjs';

export const HOST_LIMITS = Object.freeze({
  enrollmentTtl: 15 * 60 * 1_000,
  challengeTtl: 2 * 60 * 1_000,
  applicationSessionTtl: 30 * 24 * 60 * 60 * 1_000,
  webTicketTtl: 60 * 1_000,
  webSessionTtl: 12 * 60 * 60 * 1_000,
  devices: 8,
  enrollments: 8,
  challengesPerDevice: 4,
  applicationSessionsPerDevice: 8,
  ticketsPerSession: 4,
  ordinaryReceipts: 3_840,
  reservedReceipts: 256,
});

const BEARER = /^[A-Za-z0-9_-]{22,128}$/u;
const LABEL = /^.{1,80}$/u;
const OPERATIONS = new Set([
  'issue_enrollment', 'redeem_enrollment', 'issue_challenge', 'prove_challenge',
  'issue_web_ticket', 'revoke_device',
]);

function parseCanonical(text) {
  try {
    return parseCanonicalJson(text);
  } catch {
    throw new Error('database_corrupt');
  }
}

export function bearerHash(value) {
  if (typeof value !== 'string' || !BEARER.test(value)) throw new Error('invalid_request');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length < 16 || bytes.toString('base64url') !== value) throw new Error('invalid_request');
  return sha256(value);
}

export function normalizedDeviceLabel(value) {
  if (typeof value !== 'string' || value !== value.trim() || !LABEL.test(value)) {
    throw new Error('invalid_request');
  }
  return value;
}

export function p256PublicKey(value, code = 'invalid_request') {
  try {
    if (typeof value !== 'string' || value.length > 512
        || Buffer.from(value, 'base64').toString('base64') !== value) throw new Error(code);
    const supplied = Buffer.from(value, 'base64');
    const key = createPublicKey({ key: supplied, format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec'
        || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1'
        || !key.export({ format: 'der', type: 'spki' }).equals(supplied)) throw new Error(code);
    return key;
  } catch {
    throw new Error(code);
  }
}

export function hostProofBytes({ challenge, deviceId, origin }) {
  return Buffer.from(canonicalJson({
    audience: 'cannabeats-host-proof', challenge, deviceId, origin, version: 1,
  }));
}

function signatureBytes(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error('invalid_request');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('invalid_request');
  return bytes;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function assertConcurrentLimit(intervals, maximum) {
  const events = intervals.filter(([start, end]) => end > start)
    .flatMap(([start, end]) => [[start, 1], [end, -1]])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let live = 0;
  for (const [, delta] of events) {
    live += delta;
    if (live > maximum || live < 0) throw new Error('database_corrupt');
  }
}

function activeSession(database, token, now, requiredKind = 'application') {
  const sessionHash = bearerHash(token);
  const session = database.prepare(`SELECT session_hash,device_id,kind,parent_session_hash,
    issued_at,expires_at,revoked_at FROM host_sessions WHERE session_hash=?`).get(sessionHash);
  if (!session || session.kind !== requiredKind || session.revoked_at !== null
      || now >= session.expires_at) throw new Error('unauthorized');
  const device = database.prepare(`SELECT revoked_at FROM host_devices WHERE device_id=?`)
    .get(session.device_id);
  if (!device || device.revoked_at !== null) throw new Error('unauthorized');
  if (requiredKind === 'web') {
    const parent = database.prepare(`SELECT device_id,kind,expires_at,revoked_at
      FROM host_sessions WHERE session_hash=?`).get(session.parent_session_hash);
    if (!parent || parent.kind !== 'application' || parent.device_id !== session.device_id
        || parent.revoked_at !== null || now >= parent.expires_at) throw new Error('unauthorized');
  }
  return session;
}

function retainedSession(database, token, requiredKind = 'application') {
  const sessionHash = bearerHash(token);
  const session = database.prepare(`SELECT session_hash,device_id,kind,parent_session_hash,
    issued_at,expires_at,revoked_at FROM host_sessions WHERE session_hash=?`).get(sessionHash);
  if (!session || session.kind !== requiredKind) throw new Error('unauthorized');
  return session;
}

function receipt(database, identity) {
  return database.prepare(`SELECT operation,request_hash,result FROM host_action_receipts
    WHERE actor_type=? AND actor_id=? AND request_id=?`).get(
    identity.actorType, identity.actorId, identity.requestId,
  );
}

function replay(database, identity, operation, requestHash) {
  const prior = receipt(database, identity);
  if (!prior) return null;
  if (prior.operation !== operation || prior.request_hash !== requestHash) {
    throw new Error('request_conflict');
  }
  return parseCanonical(prior.result);
}

export function hostReceiptCapacityAllows({ total, ordinary }, authorityReducing = false) {
  return Number.isSafeInteger(total) && Number.isSafeInteger(ordinary)
    && total >= 0 && ordinary >= 0 && ordinary <= total
    && total < HOST_LIMITS.ordinaryReceipts + HOST_LIMITS.reservedReceipts
    && (authorityReducing || ordinary < HOST_LIMITS.ordinaryReceipts);
}

function ensureReceiptCapacity(database, authorityReducing = false) {
  const counts = database.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(CASE WHEN operation<>'revoke_device' THEN 1 ELSE 0 END),0) AS ordinary
    FROM host_action_receipts`).get();
  if (!hostReceiptCapacityAllows(counts, authorityReducing)) {
    throw new Error('capacity_reached');
  }
}

function storeReceipt(database, identity, operation, requestText, result, now) {
  database.prepare(`INSERT INTO host_action_receipts
    (actor_type,actor_id,request_id,operation,request,request_hash,result,accepted_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    identity.actorType, identity.actorId, identity.requestId, operation,
    requestText, sha256(requestText), canonicalJson(result), now,
  );
}

function canonicalRequest(value) {
  return canonicalJson(value);
}

function countLive(database, sql, values) {
  return database.prepare(sql).get(...values).count;
}

export function createHostAuthority(database, {
  transaction, validate, origin = 'https://play.cannabeats.social',
} = {}) {
  function accepted(work) {
    try {
      return transaction(work);
    } catch (error) {
      if (typeof error?.message === 'string') throw error;
      throw new Error('database_unavailable');
    }
  }

  return Object.freeze({
    issueEnrollment({
      enrollmentCode, requestId, now, applicationSessionToken = null,
    }) {
      assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      const enrollmentHash = bearerHash(enrollmentCode);
      let actorType = 'operator';
      let actorId = 'operator';
      let issuerDeviceId = null;
      if (applicationSessionToken !== null) {
        const session = retainedSession(database, applicationSessionToken);
        actorType = 'device';
        actorId = session.device_id;
        issuerDeviceId = session.device_id;
      }
      const operation = 'issue_enrollment';
      const identity = { actorType, actorId, requestId };
      const requestText = canonicalRequest({
        enrollmentHash, issuerDeviceId, operation, requestId,
      });
      return accepted(() => {
        const prior = replay(database, identity, operation, sha256(requestText));
        if (prior) return prior;
        if (applicationSessionToken !== null) activeSession(database, applicationSessionToken, now);
        ensureReceiptCapacity(database);
        if (database.prepare('SELECT 1 FROM host_enrollments WHERE enrollment_hash=?')
          .get(enrollmentHash)) throw new Error('request_conflict');
        const active = countLive(database, `SELECT COUNT(*) AS count FROM host_enrollments
          WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at>?`, [now]);
        if (active >= HOST_LIMITS.enrollments) throw new Error('capacity_reached');
        const expiresAt = now + HOST_LIMITS.enrollmentTtl;
        database.prepare(`INSERT INTO host_enrollments
          (enrollment_hash,issued_by_device_id,issued_at,expires_at) VALUES (?,?,?,?)`).run(
          enrollmentHash, issuerDeviceId, now, expiresAt,
        );
        const result = { code: 'enrollment_issued', expiresAt };
        storeReceipt(database, identity, operation, requestText, result, now);
        validate();
        return Object.freeze(result);
      });
    },

    redeemEnrollment({ enrollmentCode, requestId, deviceId, publicKey, label, now }) {
      assertUuid(requestId, 'invalid_request');
      assertUuid(deviceId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      const enrollmentHash = bearerHash(enrollmentCode);
      p256PublicKey(publicKey);
      const deviceLabel = normalizedDeviceLabel(label);
      const operation = 'redeem_enrollment';
      const identity = { actorType: 'enrollment', actorId: enrollmentHash, requestId };
      const requestText = canonicalRequest({
        deviceId, enrollmentHash, label: deviceLabel, operation,
        publicKeyHash: sha256(publicKey), requestId,
      });
      return accepted(() => {
        const prior = replay(database, identity, operation, sha256(requestText));
        if (prior) return prior;
        ensureReceiptCapacity(database);
        const enrollment = database.prepare(`SELECT expires_at,revoked_at,redeemed_at,redeemed_device_id
          FROM host_enrollments WHERE enrollment_hash=?`).get(enrollmentHash);
        if (!enrollment || enrollment.revoked_at !== null) throw new Error('unauthorized');
        if (enrollment.redeemed_at !== null) throw new Error('already_used');
        if (now >= enrollment.expires_at) throw new Error('expired');
        const liveDevices = countLive(database,
          'SELECT COUNT(*) AS count FROM host_devices WHERE revoked_at IS NULL', []);
        if (liveDevices >= HOST_LIMITS.devices) throw new Error('capacity_reached');
        if (database.prepare('SELECT 1 FROM host_devices WHERE device_id=? OR public_key=?')
          .get(deviceId, publicKey)) throw new Error('request_conflict');
        database.prepare(`INSERT INTO host_devices
          (device_id,public_key,label,authorized_at) VALUES (?,?,?,?)`).run(
          deviceId, publicKey, deviceLabel, now,
        );
        database.prepare(`UPDATE host_enrollments SET redeemed_at=?,redeemed_device_id=?
          WHERE enrollment_hash=? AND redeemed_at IS NULL`).run(now, deviceId, enrollmentHash);
        const result = { authorizedAt: now, code: 'device_enrolled', deviceId, label: deviceLabel };
        storeReceipt(database, identity, operation, requestText, result, now);
        validate();
        return Object.freeze(result);
      });
    },

    issueChallenge({ deviceId, challenge, requestId, now }) {
      assertUuid(deviceId, 'invalid_request');
      assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      const challengeHash = bearerHash(challenge);
      const operation = 'issue_challenge';
      const identity = { actorType: 'device', actorId: deviceId, requestId };
      const requestText = canonicalRequest({ challengeHash, deviceId, operation, requestId });
      return accepted(() => {
        const prior = replay(database, identity, operation, sha256(requestText));
        if (prior) return prior;
        ensureReceiptCapacity(database);
        const device = database.prepare('SELECT revoked_at FROM host_devices WHERE device_id=?')
          .get(deviceId);
        if (!device || device.revoked_at !== null) throw new Error('unauthorized');
        const active = countLive(database, `SELECT COUNT(*) AS count FROM host_challenges
          WHERE device_id=? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>?`,
        [deviceId, now]);
        if (active >= HOST_LIMITS.challengesPerDevice) throw new Error('capacity_reached');
        if (database.prepare('SELECT 1 FROM host_challenges WHERE challenge_hash=?').get(challengeHash)) {
          throw new Error('request_conflict');
        }
        const expiresAt = now + HOST_LIMITS.challengeTtl;
        database.prepare(`INSERT INTO host_challenges
          (challenge_hash,device_id,issued_at,expires_at) VALUES (?,?,?,?)`).run(
          challengeHash, deviceId, now, expiresAt,
        );
        const result = { code: 'challenge_issued', expiresAt };
        storeReceipt(database, identity, operation, requestText, result, now);
        validate();
        return Object.freeze(result);
      });
    },

    proveChallenge({ deviceId, challenge, signature, sessionToken, requestId, now }) {
      assertUuid(deviceId, 'invalid_request');
      assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      const challengeHash = bearerHash(challenge);
      const sessionHash = bearerHash(sessionToken);
      if (typeof signature !== 'string' || signature.length < 1 || signature.length > 512) {
        throw new Error('invalid_request');
      }
      const signatureHash = sha256(signature);
      const operation = 'prove_challenge';
      const identity = { actorType: 'device', actorId: deviceId, requestId };
      const requestText = canonicalRequest({
        challengeHash, deviceId, operation, requestId, sessionHash, signatureHash,
      });
      return accepted(() => {
        const prior = replay(database, identity, operation, sha256(requestText));
        if (prior) return prior;
        ensureReceiptCapacity(database);
        const device = database.prepare(`SELECT public_key,revoked_at FROM host_devices
          WHERE device_id=?`).get(deviceId);
        if (!device || device.revoked_at !== null) throw new Error('unauthorized');
        const pending = database.prepare(`SELECT expires_at,revoked_at,consumed_at FROM host_challenges
          WHERE challenge_hash=? AND device_id=?`).get(challengeHash, deviceId);
        if (!pending || pending.revoked_at !== null || pending.consumed_at !== null) {
          throw new Error('already_used');
        }
        if (now >= pending.expires_at) throw new Error('expired');
        if (database.prepare('SELECT 1 FROM host_sessions WHERE session_hash=?').get(sessionHash)) {
          throw new Error('request_conflict');
        }
        let verified = false;
        try {
          const signatureData = signatureBytes(signature);
          verified = verifySignature(
            'sha256', hostProofBytes({ challenge, deviceId, origin }),
            p256PublicKey(device.public_key, 'database_corrupt'), signatureData,
          );
        } catch (error) {
          if (error?.message === 'database_corrupt') throw error;
        }
        if (!verified) {
          database.prepare(`UPDATE host_challenges SET consumed_at=?,outcome='rejected'
            WHERE challenge_hash=?`).run(now, challengeHash);
          const result = { code: 'proof_rejected' };
          storeReceipt(database, identity, operation, requestText, result, now);
          validate();
          return Object.freeze(result);
        }
        const active = countLive(database, `SELECT COUNT(*) AS count FROM host_sessions
          WHERE device_id=? AND kind='application' AND revoked_at IS NULL AND expires_at>?`,
        [deviceId, now]);
        if (active >= HOST_LIMITS.applicationSessionsPerDevice) {
          throw new Error('capacity_reached');
        }
        const expiresAt = now + HOST_LIMITS.applicationSessionTtl;
        database.prepare(`INSERT INTO host_sessions
          (session_hash,device_id,kind,issued_at,expires_at)
          VALUES (?,?,'application',?,?)`).run(sessionHash, deviceId, now, expiresAt);
        database.prepare(`UPDATE host_challenges SET consumed_at=?,outcome='accepted'
          WHERE challenge_hash=?`).run(now, challengeHash);
        database.prepare('UPDATE host_devices SET last_proved_at=? WHERE device_id=?')
          .run(now, deviceId);
        const result = { code: 'session_created', deviceId, expiresAt };
        storeReceipt(database, identity, operation, requestText, result, now);
        validate();
        return Object.freeze(result);
      });
    },

    issueWebTicket({ applicationSessionToken, ticket, requestId, now }) {
      assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      const ticketHash = bearerHash(ticket);
      const session = retainedSession(database, applicationSessionToken);
      const operation = 'issue_web_ticket';
      const identity = { actorType: 'session', actorId: session.session_hash, requestId };
      const requestText = canonicalRequest({
        applicationSessionHash: session.session_hash, operation, requestId, ticketHash,
      });
      return accepted(() => {
        const prior = replay(database, identity, operation, sha256(requestText));
        if (prior) return prior;
        const current = activeSession(database, applicationSessionToken, now);
        ensureReceiptCapacity(database);
        const active = countLive(database, `SELECT COUNT(*) AS count FROM host_web_tickets
          WHERE application_session_hash=? AND consumed_at IS NULL AND revoked_at IS NULL
          AND expires_at>?`, [current.session_hash, now]);
        if (active >= HOST_LIMITS.ticketsPerSession) throw new Error('capacity_reached');
        if (database.prepare('SELECT 1 FROM host_web_tickets WHERE ticket_hash=?').get(ticketHash)
            || database.prepare('SELECT 1 FROM host_sessions WHERE session_hash=?').get(ticketHash)) {
          throw new Error('request_conflict');
        }
        const expiresAt = Math.min(now + HOST_LIMITS.webTicketTtl, current.expires_at);
        if (expiresAt <= now) throw new Error('expired');
        database.prepare(`INSERT INTO host_web_tickets
          (ticket_hash,device_id,application_session_hash,issued_at,expires_at)
          VALUES (?,?,?,?,?)`).run(
          ticketHash, current.device_id, current.session_hash, now, expiresAt,
        );
        const result = { code: 'ticket_issued', expiresAt };
        storeReceipt(database, identity, operation, requestText, result, now);
        validate();
        return Object.freeze(result);
      });
    },

    exchangeWebTicket({ ticket, now }) {
      assertTimestamp(now, 'invalid_request');
      const ticketHash = bearerHash(ticket);
      return accepted(() => {
        const pending = database.prepare(`SELECT device_id,application_session_hash,expires_at,
          revoked_at,consumed_at FROM host_web_tickets WHERE ticket_hash=?`).get(ticketHash);
        if (!pending || pending.revoked_at !== null) throw new Error('unauthorized');
        if (pending.consumed_at !== null) throw new Error('already_used');
        if (now >= pending.expires_at) throw new Error('expired');
        const parent = database.prepare(`SELECT device_id,kind,expires_at,revoked_at
          FROM host_sessions WHERE session_hash=?`).get(pending.application_session_hash);
        if (!parent || parent.kind !== 'application' || parent.device_id !== pending.device_id
            || parent.revoked_at !== null || now >= parent.expires_at) throw new Error('unauthorized');
        const expiresAt = Math.min(now + HOST_LIMITS.webSessionTtl, parent.expires_at);
        database.prepare(`INSERT INTO host_sessions
          (session_hash,device_id,kind,parent_session_hash,issued_at,expires_at)
          VALUES (?,?,'web',?,?,?)`).run(
          ticketHash, pending.device_id, pending.application_session_hash, now, expiresAt,
        );
        database.prepare(`UPDATE host_web_tickets SET consumed_at=?,web_session_hash=?
          WHERE ticket_hash=? AND consumed_at IS NULL`).run(now, ticketHash, ticketHash);
        validate();
        return Object.freeze({ code: 'ticket_exchanged', deviceId: pending.device_id, expiresAt });
      });
    },

    revokeDevice({ applicationSessionToken, targetDeviceId, requestId, now }) {
      assertUuid(targetDeviceId, 'invalid_request');
      assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      const issuer = retainedSession(database, applicationSessionToken);
      const operation = 'revoke_device';
      const identity = { actorType: 'device', actorId: issuer.device_id, requestId };
      const requestText = canonicalRequest({ operation, requestId, targetDeviceId });
      return accepted(() => {
        const prior = replay(database, identity, operation, sha256(requestText));
        if (prior) return prior;
        activeSession(database, applicationSessionToken, now);
        ensureReceiptCapacity(database, true);
        const target = database.prepare('SELECT revoked_at FROM host_devices WHERE device_id=?')
          .get(targetDeviceId);
        if (!target) throw new Error('unauthorized');
        if (target.revoked_at !== null) throw new Error('already_used');
        database.prepare('UPDATE host_devices SET revoked_at=? WHERE device_id=?')
          .run(now, targetDeviceId);
        database.prepare(`UPDATE host_sessions SET revoked_at=?
          WHERE device_id=? AND revoked_at IS NULL`).run(now, targetDeviceId);
        database.prepare(`UPDATE host_challenges SET revoked_at=?
          WHERE device_id=? AND revoked_at IS NULL`).run(now, targetDeviceId);
        database.prepare(`UPDATE host_web_tickets SET revoked_at=?
          WHERE device_id=? AND revoked_at IS NULL`).run(now, targetDeviceId);
        database.prepare(`UPDATE host_enrollments SET revoked_at=?
          WHERE issued_by_device_id=? AND revoked_at IS NULL AND redeemed_at IS NULL`).run(
          now, targetDeviceId,
        );
        const result = { code: 'device_revoked', deviceId: targetDeviceId, revokedAt: now };
        storeReceipt(database, identity, operation, requestText, result, now);
        validate();
        return Object.freeze(result);
      });
    },

    authorizeSession({ token, now, kind = 'application' }) {
      assertTimestamp(now, 'invalid_request');
      const session = activeSession(database, token, now, kind);
      return Object.freeze({ deviceId: session.device_id, kind: session.kind });
    },

    retainedApplicationSession({ token }) {
      const session = retainedSession(database, token);
      return Object.freeze({ deviceId: session.device_id, kind: session.kind });
    },

    retainedSession({ token, kind = 'application' }) {
      if (!['application', 'web'].includes(kind)) throw new Error('unauthorized');
      const session = retainedSession(database, token, kind);
      return Object.freeze({ deviceId: session.device_id, kind: session.kind });
    },

    listDevices({ applicationSessionToken, now }) {
      assertTimestamp(now, 'invalid_request');
      activeSession(database, applicationSessionToken, now);
      return database.prepare(`SELECT device_id,label,authorized_at,last_proved_at,revoked_at
        FROM host_devices ORDER BY authorized_at,device_id`).all().map((row) => Object.freeze({
        deviceId: row.device_id, label: row.label, authorizedAt: row.authorized_at,
        lastProvedAt: row.last_proved_at, revokedAt: row.revoked_at,
      }));
    },
  });
}

export function validateHostAuthority(database) {
  const devices = database.prepare(`SELECT device_id,public_key,label,authorized_at,last_proved_at,
    revoked_at FROM host_devices ORDER BY device_id`).all();
  const deviceMap = new Map();
  for (const row of devices) {
    if (!UUID_PATTERN.test(row.device_id) || normalizedDeviceLabel(row.label) !== row.label
        || !Number.isSafeInteger(row.authorized_at) || row.authorized_at <= 0
        || (row.last_proved_at !== null && (!Number.isSafeInteger(row.last_proved_at)
          || row.last_proved_at < row.authorized_at))
        || (row.revoked_at !== null && (!Number.isSafeInteger(row.revoked_at)
          || row.revoked_at < row.authorized_at))) throw new Error('database_corrupt');
    p256PublicKey(row.public_key, 'database_corrupt');
    deviceMap.set(row.device_id, row);
  }

  const receipts = database.prepare(`SELECT actor_type,actor_id,request_id,operation,request,
    request_hash,result,accepted_at FROM host_action_receipts
    ORDER BY accepted_at,actor_type,actor_id,request_id`).all();
  if (receipts.length > HOST_LIMITS.ordinaryReceipts + HOST_LIMITS.reservedReceipts) {
    throw new Error('database_corrupt');
  }
  if (receipts.filter(({ operation }) => operation !== 'revoke_device').length
      > HOST_LIMITS.ordinaryReceipts) throw new Error('database_corrupt');
  const receiptIndex = new Map();
  for (const row of receipts) {
    if (!['operator', 'device', 'enrollment', 'session'].includes(row.actor_type)
        || !UUID_PATTERN.test(row.request_id) || !OPERATIONS.has(row.operation)
        || !SHA256_PATTERN.test(row.request_hash) || sha256(row.request) !== row.request_hash
        || !Number.isSafeInteger(row.accepted_at) || row.accepted_at <= 0) {
      throw new Error('database_corrupt');
    }
    const request = parseCanonical(row.request);
    const result = parseCanonical(row.result);
    if (request.operation !== row.operation || request.requestId !== row.request_id) {
      throw new Error('database_corrupt');
    }
    receiptIndex.set(`${row.operation}\0${row.actor_type}\0${row.actor_id}\0${row.request_id}`, {
      ...row, request, result,
    });
  }
  const parsedReceipts = [...receiptIndex.values()];

  const enrollments = database.prepare(`SELECT enrollment_hash,issued_by_device_id,issued_at,
    expires_at,revoked_at,redeemed_at,redeemed_device_id FROM host_enrollments
    ORDER BY enrollment_hash`).all();
  for (const row of enrollments) {
    if (!SHA256_PATTERN.test(row.enrollment_hash)
        || row.expires_at - row.issued_at !== HOST_LIMITS.enrollmentTtl
        || (row.issued_by_device_id !== null && !deviceMap.has(row.issued_by_device_id))
        || ((row.redeemed_at === null) !== (row.redeemed_device_id === null))
        || (row.redeemed_device_id !== null && !deviceMap.has(row.redeemed_device_id))
        || (row.revoked_at !== null && row.revoked_at < row.issued_at)
        || (row.redeemed_at !== null && (row.redeemed_at < row.issued_at
          || row.redeemed_at >= row.expires_at || row.revoked_at !== null))) {
      throw new Error('database_corrupt');
    }
    const issuerType = row.issued_by_device_id === null ? 'operator' : 'device';
    const issuerId = row.issued_by_device_id ?? 'operator';
    const issue = parsedReceipts.find(({ operation, actor_type: type, actor_id: id, request, result }) =>
      operation === 'issue_enrollment' && type === issuerType && id === issuerId
      && request.enrollmentHash === row.enrollment_hash && result.expiresAt === row.expires_at);
    if (!issue) throw new Error('database_corrupt');
    if (row.redeemed_at !== null) {
      const redeemed = parsedReceipts.find(({ operation, actor_type: type, actor_id: id, request, result }) =>
        operation === 'redeem_enrollment' && type === 'enrollment' && id === row.enrollment_hash
        && request.deviceId === row.redeemed_device_id && result.authorizedAt === row.redeemed_at);
      if (!redeemed) throw new Error('database_corrupt');
    }
    const issuer = row.issued_by_device_id === null ? null : deviceMap.get(row.issued_by_device_id);
    const expectedRevocation = issuer && row.redeemed_at === null ? issuer.revoked_at : null;
    if (row.revoked_at !== expectedRevocation) throw new Error('database_corrupt');
  }
  for (const device of devices) {
    if (!enrollments.some(({ redeemed_device_id: id }) => id === device.device_id)) {
      throw new Error('database_corrupt');
    }
  }
  assertConcurrentLimit(devices.map((row) => [
    row.authorized_at, row.revoked_at ?? Number.MAX_SAFE_INTEGER,
  ]), HOST_LIMITS.devices);
  assertConcurrentLimit(enrollments.map((row) => [
    row.issued_at,
    Math.min(row.expires_at, row.revoked_at ?? Number.MAX_SAFE_INTEGER,
      row.redeemed_at ?? Number.MAX_SAFE_INTEGER),
  ]), HOST_LIMITS.enrollments);

  const challenges = database.prepare(`SELECT challenge_hash,device_id,issued_at,expires_at,
    revoked_at,consumed_at,outcome FROM host_challenges ORDER BY challenge_hash`).all();
  for (const row of challenges) {
    if (!SHA256_PATTERN.test(row.challenge_hash) || !deviceMap.has(row.device_id)
        || row.expires_at - row.issued_at !== HOST_LIMITS.challengeTtl
        || ((row.consumed_at === null) !== (row.outcome === null))
        || (row.consumed_at !== null && (row.consumed_at < row.issued_at
          || row.consumed_at >= row.expires_at))) {
      throw new Error('database_corrupt');
    }
    const issued = parsedReceipts.find(({ operation, actor_id: id, request, result }) =>
      operation === 'issue_challenge' && id === row.device_id
      && request.challengeHash === row.challenge_hash && result.expiresAt === row.expires_at);
    if (!issued) throw new Error('database_corrupt');
    if (row.consumed_at !== null && row.revoked_at === null) {
      const proof = parsedReceipts.find(({ operation, actor_id: id, request, result, accepted_at: at }) =>
        operation === 'prove_challenge' && id === row.device_id
        && request.challengeHash === row.challenge_hash && at === row.consumed_at
        && ((row.outcome === 'accepted' && result.code === 'session_created')
          || (row.outcome === 'rejected' && result.code === 'proof_rejected')));
      if (!proof) throw new Error('database_corrupt');
    }
    const device = deviceMap.get(row.device_id);
    if (row.revoked_at !== device.revoked_at) {
      throw new Error('database_corrupt');
    }
  }
  for (const deviceId of deviceMap.keys()) {
    assertConcurrentLimit(challenges.filter(({ device_id: id }) => id === deviceId).map((row) => [
      row.issued_at,
      Math.min(row.expires_at, row.revoked_at ?? Number.MAX_SAFE_INTEGER,
        row.consumed_at ?? Number.MAX_SAFE_INTEGER),
    ]), HOST_LIMITS.challengesPerDevice);
  }

  const sessions = database.prepare(`SELECT session_hash,device_id,kind,parent_session_hash,
    issued_at,expires_at,revoked_at FROM host_sessions ORDER BY session_hash`).all();
  const sessionMap = new Map(sessions.map((row) => [row.session_hash, row]));
  for (const row of sessions) {
    if (!SHA256_PATTERN.test(row.session_hash) || !deviceMap.has(row.device_id)
        || !['application', 'web'].includes(row.kind)
        || (row.revoked_at !== null && row.revoked_at < row.issued_at)) {
      throw new Error('database_corrupt');
    }
    if (row.kind === 'application') {
      if (row.parent_session_hash !== null
          || row.expires_at - row.issued_at !== HOST_LIMITS.applicationSessionTtl) {
        throw new Error('database_corrupt');
      }
      const proof = parsedReceipts.find(({ operation, actor_id: id, request, result, accepted_at: at }) =>
        operation === 'prove_challenge' && id === row.device_id
        && request.sessionHash === row.session_hash && result.code === 'session_created'
        && result.expiresAt === row.expires_at && at === row.issued_at);
      if (!proof) throw new Error('database_corrupt');
    } else {
      const parent = sessionMap.get(row.parent_session_hash);
      if (!parent || parent.kind !== 'application' || parent.device_id !== row.device_id
          || row.expires_at > parent.expires_at
          || row.expires_at - row.issued_at > HOST_LIMITS.webSessionTtl) {
        throw new Error('database_corrupt');
      }
      const ticket = database.prepare(`SELECT consumed_at FROM host_web_tickets
        WHERE ticket_hash=? AND web_session_hash=?`).get(row.session_hash, row.session_hash);
      if (!ticket || ticket.consumed_at !== row.issued_at) throw new Error('database_corrupt');
    }
    const device = deviceMap.get(row.device_id);
    if (row.revoked_at !== device.revoked_at) {
      throw new Error('database_corrupt');
    }
  }
  for (const deviceId of deviceMap.keys()) {
    assertConcurrentLimit(sessions.filter(({ device_id: id, kind }) =>
      id === deviceId && kind === 'application').map((row) => [
      row.issued_at, Math.min(row.expires_at, row.revoked_at ?? Number.MAX_SAFE_INTEGER),
    ]), HOST_LIMITS.applicationSessionsPerDevice);
  }
  for (const device of devices) {
    const provedAt = sessions.filter(({ device_id: id, kind }) =>
      id === device.device_id && kind === 'application')
      .reduce((latest, row) => Math.max(latest, row.issued_at), 0);
    if ((device.last_proved_at ?? 0) !== provedAt) throw new Error('database_corrupt');
    if (device.revoked_at !== null) {
      const revocation = parsedReceipts.find(({ operation, request, result, accepted_at: at }) =>
        operation === 'revoke_device' && request.targetDeviceId === device.device_id
        && result.deviceId === device.device_id && result.revokedAt === device.revoked_at
        && at === device.revoked_at);
      if (!revocation) throw new Error('database_corrupt');
    }
  }

  const tickets = database.prepare(`SELECT ticket_hash,device_id,application_session_hash,
    issued_at,expires_at,revoked_at,consumed_at,web_session_hash FROM host_web_tickets
    ORDER BY ticket_hash`).all();
  for (const row of tickets) {
    const parent = sessionMap.get(row.application_session_hash);
    if (!SHA256_PATTERN.test(row.ticket_hash) || !parent || parent.kind !== 'application'
        || parent.device_id !== row.device_id
        || row.expires_at - row.issued_at > HOST_LIMITS.webTicketTtl
        || row.expires_at > parent.expires_at
        || ((row.consumed_at === null) !== (row.web_session_hash === null))
        || (row.consumed_at !== null && (row.consumed_at < row.issued_at
          || row.consumed_at >= row.expires_at))) {
      throw new Error('database_corrupt');
    }
    const issued = parsedReceipts.find(({ operation, actor_id: id, request, result }) =>
      operation === 'issue_web_ticket' && id === row.application_session_hash
      && request.ticketHash === row.ticket_hash && result.expiresAt === row.expires_at);
    if (!issued) throw new Error('database_corrupt');
    if (row.web_session_hash !== null) {
      const web = sessionMap.get(row.web_session_hash);
      if (!web || web.kind !== 'web' || web.session_hash !== row.ticket_hash
          || web.parent_session_hash !== row.application_session_hash
          || web.issued_at !== row.consumed_at) throw new Error('database_corrupt');
    }
    const device = deviceMap.get(row.device_id);
    if (row.revoked_at !== device.revoked_at) {
      throw new Error('database_corrupt');
    }
  }
  for (const session of sessions.filter(({ kind }) => kind === 'application')) {
    assertConcurrentLimit(tickets.filter(({ application_session_hash: hash }) =>
      hash === session.session_hash).map((row) => [
      row.issued_at,
      Math.min(row.expires_at, row.revoked_at ?? Number.MAX_SAFE_INTEGER,
        row.consumed_at ?? Number.MAX_SAFE_INTEGER),
    ]), HOST_LIMITS.ticketsPerSession);
  }

  for (const row of receipts) {
    const { request, result } = parseCanonical(row.request) && receiptIndex.get(
      `${row.operation}\0${row.actor_type}\0${row.actor_id}\0${row.request_id}`,
    );
    if (!request || !result) throw new Error('database_corrupt');
    const recognized = row.operation === 'issue_enrollment'
      ? exactKeys(request, ['enrollmentHash', 'issuerDeviceId', 'operation', 'requestId'])
        && exactKeys(result, ['code', 'expiresAt']) && result.code === 'enrollment_issued'
      : row.operation === 'redeem_enrollment'
        ? exactKeys(request, ['deviceId', 'enrollmentHash', 'label', 'operation', 'publicKeyHash', 'requestId'])
          && exactKeys(result, ['authorizedAt', 'code', 'deviceId', 'label'])
          && result.code === 'device_enrolled'
        : row.operation === 'issue_challenge'
          ? exactKeys(request, ['challengeHash', 'deviceId', 'operation', 'requestId'])
            && exactKeys(result, ['code', 'expiresAt']) && result.code === 'challenge_issued'
          : row.operation === 'prove_challenge'
            ? exactKeys(request, [
              'challengeHash', 'deviceId', 'operation', 'requestId', 'sessionHash', 'signatureHash',
            ]) && SHA256_PATTERN.test(request.signatureHash)
              && (result.code === 'proof_rejected'
                ? exactKeys(result, ['code'])
                : exactKeys(result, ['code', 'deviceId', 'expiresAt'])
                  && result.code === 'session_created')
            : row.operation === 'issue_web_ticket'
              ? exactKeys(request, ['applicationSessionHash', 'operation', 'requestId', 'ticketHash'])
                && exactKeys(result, ['code', 'expiresAt']) && result.code === 'ticket_issued'
              : row.operation === 'revoke_device'
                ? exactKeys(request, ['operation', 'requestId', 'targetDeviceId'])
                  && exactKeys(result, ['code', 'deviceId', 'revokedAt'])
                  && result.code === 'device_revoked'
                : false;
    if (!recognized) throw new Error('database_corrupt');
    let effect = false;
    if (row.operation === 'issue_enrollment') {
      const enrollment = enrollments.find(({ enrollment_hash: hash }) =>
        hash === request.enrollmentHash);
      const expectedType = enrollment?.issued_by_device_id === null ? 'operator' : 'device';
      const expectedId = enrollment?.issued_by_device_id ?? 'operator';
      effect = Boolean(enrollment && row.actor_type === expectedType && row.actor_id === expectedId
        && request.issuerDeviceId === enrollment.issued_by_device_id
        && enrollment.issued_at === row.accepted_at && enrollment.expires_at === result.expiresAt);
    } else if (row.operation === 'redeem_enrollment') {
      const enrollment = enrollments.find(({ enrollment_hash: hash }) =>
        hash === request.enrollmentHash);
      const device = deviceMap.get(request.deviceId);
      effect = row.actor_type === 'enrollment' && row.actor_id === request.enrollmentHash
        && Boolean(enrollment && device && enrollment.redeemed_device_id === request.deviceId
          && enrollment.redeemed_at === row.accepted_at && device.authorized_at === row.accepted_at
          && device.label === request.label && sha256(device.public_key) === request.publicKeyHash
          && result.deviceId === request.deviceId && result.label === request.label);
    } else if (row.operation === 'issue_challenge') {
      const challenge = challenges.find(({ challenge_hash: hash }) => hash === request.challengeHash);
      effect = row.actor_type === 'device' && row.actor_id === request.deviceId
        && Boolean(challenge && challenge.device_id === request.deviceId
          && challenge.issued_at === row.accepted_at && challenge.expires_at === result.expiresAt);
    } else if (row.operation === 'prove_challenge') {
      const challenge = challenges.find(({ challenge_hash: hash }) => hash === request.challengeHash);
      const session = sessionMap.get(request.sessionHash);
      effect = row.actor_type === 'device' && row.actor_id === request.deviceId
        && Boolean(challenge && challenge.device_id === request.deviceId
          && challenge.consumed_at === row.accepted_at
          && (result.code === 'proof_rejected'
            ? challenge.outcome === 'rejected' && !session
            : challenge.outcome === 'accepted' && session?.kind === 'application'
              && session.device_id === request.deviceId && session.issued_at === row.accepted_at
              && session.expires_at === result.expiresAt
              && result.deviceId === request.deviceId));
    } else if (row.operation === 'issue_web_ticket') {
      const ticket = tickets.find(({ ticket_hash: hash }) => hash === request.ticketHash);
      effect = row.actor_type === 'session' && row.actor_id === request.applicationSessionHash
        && Boolean(ticket && ticket.application_session_hash === request.applicationSessionHash
          && ticket.issued_at === row.accepted_at && ticket.expires_at === result.expiresAt);
    } else if (row.operation === 'revoke_device') {
      const device = deviceMap.get(request.targetDeviceId);
      const issuerSession = sessions.find(({ device_id: id, kind, issued_at: issued,
        expires_at: expires, revoked_at: revoked }) => id === row.actor_id && kind === 'application'
        && issued <= row.accepted_at && row.accepted_at < expires
        && (revoked === null || row.accepted_at <= revoked));
      effect = row.actor_type === 'device' && UUID_PATTERN.test(row.actor_id)
        && Boolean(issuerSession && device && device.revoked_at === row.accepted_at
          && result.deviceId === request.targetDeviceId && result.revokedAt === row.accepted_at);
    }
    if (!effect) throw new Error('database_corrupt');
  }

  return Object.freeze({ devices: devices.length, receipts: receipts.length });
}
