import assert from 'node:assert/strict';
import {
  generateKeyPairSync, randomBytes, randomUUID, sign,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import { loadCatalogArtifacts } from '../../web/lib/server/release/catalog.mjs';
import {
  HOST_LIMITS, bearerHash, hostProofBytes, hostReceiptCapacityAllows,
} from '../../web/lib/server/release/host-authority.mjs';
import { canonicalJson, sha256 } from '../../web/lib/server/release/canonical.mjs';
import { RELEASE_SCHEMA_DIGEST, canonicalSchemaDigest } from '../../web/lib/server/release/schema.mjs';
import {
  ReleaseStoreError, createReleaseStore,
} from '../../web/lib/server/release/store.mjs';

const roots = [];
const catalog = loadCatalogArtifacts({
  catalogPath: new URL('../../web/data/catalog.json', import.meta.url),
  manifestPath: new URL('../../web/data/catalog-manifest.json', import.meta.url),
});
const origin = 'https://play.cannabeats.social';

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function bearer() {
  return randomBytes(24).toString('base64url');
}

function keyPair() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function location() {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr2-'));
  roots.push(root);
  return { root, path: join(root, 'cannabeats.sqlite3') };
}

function expectCode(work, code) {
  assert.throws(work, (error) => error instanceof ReleaseStoreError && error.code === code);
}

function enrolled(overrides = {}) {
  const place = location();
  const store = createReleaseStore(place.path, { catalog, now: 1_000 });
  const keys = keyPair();
  const enrollmentCode = bearer();
  const deviceId = randomUUID();
  store.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: 2_000 });
  store.redeemEnrollment({
    enrollmentCode, requestId: randomUUID(), deviceId,
    publicKey: keys.publicKey, label: overrides.label ?? 'Family Mac', now: 2_001,
  });
  return { ...place, store, keys, enrollmentCode, deviceId };
}

function createSession(setup, now = 3_000) {
  const challenge = bearer();
  setup.store.issueHostChallenge({
    deviceId: setup.deviceId, challenge, requestId: randomUUID(), now,
  });
  const sessionToken = bearer();
  const signature = sign(
    'sha256', hostProofBytes({ challenge, deviceId: setup.deviceId, origin }),
    setup.keys.privateKey,
  ).toString('base64');
  const action = {
    deviceId: setup.deviceId, challenge, signature, sessionToken,
    requestId: randomUUID(), now: now + 1,
  };
  return { sessionToken, action, result: setup.store.proveHostChallenge(action) };
}

test('bootstrap enrollment stores only hashes and replays before one-use state', () => {
  const place = location();
  const store = createReleaseStore(place.path, { catalog });
  const code = bearer();
  const issue = { enrollmentCode: code, requestId: randomUUID(), now: 1_000 };
  const issued = store.issueEnrollment(issue);
  assert.deepEqual(store.issueEnrollment(issue), issued);
  const keys = keyPair();
  const redeem = {
    enrollmentCode: code, requestId: randomUUID(), deviceId: randomUUID(),
    publicKey: keys.publicKey, label: 'Kitchen Mac', now: 1_001,
  };
  const authorized = store.redeemEnrollment(redeem);
  assert.deepEqual(store.redeemEnrollment(redeem), authorized);
  expectCode(() => store.redeemEnrollment({
    ...redeem, requestId: randomUUID(), deviceId: randomUUID(),
  }), 'already_used');
  expectCode(() => store.redeemEnrollment({ ...redeem, label: 'Altered Mac' }), 'request_conflict');
  store.close();

  const database = new DatabaseSync(place.path, { readOnly: true });
  const serialized = JSON.stringify(database.prepare(`SELECT * FROM host_enrollments
    JOIN host_action_receipts`).all());
  assert.equal(serialized.includes(code), false);
  assert.equal(serialized.includes(keys.publicKey), false);
  assert.ok(serialized.includes(bearerHash(code)));
  database.close();
});

test('enrollment expiry is accepted before and rejected at and after equality', () => {
  for (const offset of [-1, 0, 1]) {
    const place = location();
    const store = createReleaseStore(place.path, { catalog });
    const code = bearer();
    store.issueEnrollment({ enrollmentCode: code, requestId: randomUUID(), now: 1_000 });
    const keys = keyPair();
    const work = () => store.redeemEnrollment({
      enrollmentCode: code, requestId: randomUUID(), deviceId: randomUUID(),
      publicKey: keys.publicKey, label: 'Boundary Mac',
      now: 1_000 + HOST_LIMITS.enrollmentTtl + offset,
    });
    if (offset < 0) assert.equal(work().code, 'device_enrolled');
    else expectCode(work, 'expired');
    store.close();
  }
});

test('P-256 proof creates one restart-valid session and exact response-loss replay', () => {
  const setup = enrolled();
  const session = createSession(setup);
  assert.equal(session.result.code, 'session_created');
  assert.deepEqual(setup.store.proveHostChallenge(session.action), session.result);
  assert.deepEqual(setup.store.authorizeHostSession({
    token: session.sessionToken, now: 4_000,
  }), { deviceId: setup.deviceId, kind: 'application' });
  setup.store.close();
  const reopened = createReleaseStore(setup.path, { catalog });
  assert.deepEqual(reopened.proveHostChallenge(session.action), session.result);
  assert.equal(reopened.authorizeHostSession({ token: session.sessionToken, now: 4_000 }).deviceId,
    setup.deviceId);
  reopened.close();
});

test('a wrong signature consumes its challenge without creating authority', () => {
  const setup = enrolled();
  const challenge = bearer();
  setup.store.issueHostChallenge({
    deviceId: setup.deviceId, challenge, requestId: randomUUID(), now: 3_000,
  });
  const wrong = keyPair();
  const action = {
    deviceId: setup.deviceId, challenge, sessionToken: bearer(), requestId: randomUUID(), now: 3_001,
    signature: sign('sha256', hostProofBytes({ challenge, deviceId: setup.deviceId, origin }),
      wrong.privateKey).toString('base64'),
  };
  assert.deepEqual(setup.store.proveHostChallenge(action), { code: 'proof_rejected' });
  assert.deepEqual(setup.store.proveHostChallenge(action), { code: 'proof_rejected' });
  expectCode(() => setup.store.proveHostChallenge({
    ...action,
    signature: sign('sha256', Buffer.from('altered proof'), wrong.privateKey).toString('base64'),
  }), 'request_conflict');
  expectCode(() => setup.store.proveHostChallenge({
    ...action, requestId: randomUUID(), sessionToken: bearer(),
  }), 'already_used');
  expectCode(() => setup.store.authorizeHostSession({ token: action.sessionToken, now: 3_002 }),
    'unauthorized');
  setup.store.close();
});

test('a bounded malformed signature consumes one proof attempt without native errors', () => {
  const setup = enrolled();
  const challenge = bearer();
  setup.store.issueHostChallenge({
    deviceId: setup.deviceId, challenge, requestId: randomUUID(), now: 3_000,
  });
  const action = {
    deviceId: setup.deviceId, challenge, signature: 'not-DER-or-base64',
    sessionToken: bearer(), requestId: randomUUID(), now: 3_001,
  };
  assert.deepEqual(setup.store.proveHostChallenge(action), { code: 'proof_rejected' });
  expectCode(() => setup.store.proveHostChallenge({
    ...action, requestId: randomUUID(), sessionToken: bearer(),
  }), 'already_used');
  setup.store.close();
});

test('enrollment accepts exactly P-256 and rejects altered or duplicate key identity', () => {
  const place = location();
  const store = createReleaseStore(place.path, { catalog });
  const wrongCurve = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey
    .export({ format: 'der', type: 'spki' }).toString('base64');
  const canonical = keyPair().publicKey;
  const trailingAlias = Buffer.concat([
    Buffer.from(canonical, 'base64'), Buffer.from([0]),
  ]).toString('base64');
  for (const publicKey of [Buffer.from('not der').toString('base64'), wrongCurve, trailingAlias]) {
    const code = bearer();
    store.issueEnrollment({ enrollmentCode: code, requestId: randomUUID(), now: 1_000 });
    expectCode(() => store.redeemEnrollment({
      enrollmentCode: code, requestId: randomUUID(), deviceId: randomUUID(),
      publicKey, label: 'Invalid Key Mac', now: 1_001,
    }), 'invalid_request');
  }
  const shared = keyPair();
  const firstCode = bearer();
  store.issueEnrollment({ enrollmentCode: firstCode, requestId: randomUUID(), now: 2_000 });
  store.redeemEnrollment({
    enrollmentCode: firstCode, requestId: randomUUID(), deviceId: randomUUID(),
    publicKey: shared.publicKey, label: 'First Mac', now: 2_001,
  });
  const secondCode = bearer();
  store.issueEnrollment({ enrollmentCode: secondCode, requestId: randomUUID(), now: 2_002 });
  expectCode(() => store.redeemEnrollment({
    enrollmentCode: secondCode, requestId: randomUUID(), deviceId: randomUUID(),
    publicKey: shared.publicKey, label: 'Copied Key Mac', now: 2_003,
  }), 'request_conflict');
  store.close();
});

test('a colliding session token fails before proof and leaves the challenge usable', () => {
  const setup = enrolled();
  const existing = createSession(setup);
  const challenge = bearer();
  setup.store.issueHostChallenge({
    deviceId: setup.deviceId, challenge, requestId: randomUUID(), now: 4_000,
  });
  const signature = sign('sha256', hostProofBytes({
    challenge, deviceId: setup.deviceId, origin,
  }), setup.keys.privateKey).toString('base64');
  expectCode(() => setup.store.proveHostChallenge({
    deviceId: setup.deviceId, challenge, signature: 'not-DER-or-base64',
    sessionToken: existing.sessionToken, requestId: randomUUID(), now: 4_001,
  }), 'request_conflict');
  assert.equal(setup.store.proveHostChallenge({
    deviceId: setup.deviceId, challenge, signature, sessionToken: bearer(),
    requestId: randomUUID(), now: 4_002,
  }).code, 'session_created');
  setup.store.close();
});

test('a web ticket creates one parent and contract-bounded session identity', () => {
  const setup = enrolled();
  const session = createSession(setup);
  const ticket = bearer();
  const issue = {
    applicationSessionToken: session.sessionToken, ticket,
    requestId: randomUUID(), now: 4_000,
  };
  const issued = setup.store.issueHostWebTicket(issue);
  assert.deepEqual(setup.store.issueHostWebTicket(issue), issued);
  const exchanged = setup.store.exchangeHostWebTicket({ ticket, now: 4_001 });
  assert.equal(exchanged.code, 'ticket_exchanged');
  assert.deepEqual(setup.store.authorizeHostSession({ token: ticket, now: 4_002, kind: 'web' }), {
    deviceId: setup.deviceId, kind: 'web',
  });
  expectCode(() => setup.store.exchangeHostWebTicket({ ticket, now: 4_002 }), 'already_used');
  setup.store.close();

  const database = new DatabaseSync(setup.path);
  const ticketTrigger = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='host_web_tickets_identity_immutable'`).get().sql;
  const receiptTrigger = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='host_action_receipts_immutable_update'`).get().sql;
  database.exec('DROP TRIGGER host_web_tickets_identity_immutable');
  database.exec('DROP TRIGGER host_action_receipts_immutable_update');
  const receipt = database.prepare(`SELECT rowid,request FROM host_action_receipts
    WHERE operation='issue_web_ticket'`).get();
  const oldRequest = { ...JSON.parse(receipt.request), hostContract: '0' };
  const oldText = canonicalJson(oldRequest);
  database.prepare(`UPDATE host_action_receipts SET request=?,request_hash=? WHERE rowid=?`)
    .run(oldText, sha256(oldText), receipt.rowid);
  database.prepare(`UPDATE host_web_tickets SET host_contract='0' WHERE ticket_hash=?`)
    .run(bearerHash(ticket));
  database.exec(ticketTrigger);
  database.exec(receiptTrigger);
  database.close();
  const reopened = createReleaseStore(setup.path, { catalog, now: 4_002 });
  expectCode(() => reopened.authorizeHostSession({ token: ticket, now: 4_003, kind: 'web' }),
    'upgrade_required');
  reopened.close();
});

test('device revocation cascades and exact replay precedes revoked issuer authority', () => {
  const setup = enrolled();
  const session = createSession(setup);
  const ticket = bearer();
  setup.store.issueHostWebTicket({
    applicationSessionToken: session.sessionToken, ticket, requestId: randomUUID(), now: 4_000,
  });
  const action = {
    applicationSessionToken: session.sessionToken, targetDeviceId: setup.deviceId,
    requestId: randomUUID(), now: 5_000,
  };
  const revoked = setup.store.revokeHostDevice(action);
  assert.deepEqual(setup.store.revokeHostDevice(action), revoked);
  expectCode(() => setup.store.authorizeHostSession({ token: session.sessionToken, now: 5_001 }),
    'unauthorized');
  expectCode(() => setup.store.exchangeHostWebTicket({ ticket, now: 5_001 }), 'unauthorized');
  expectCode(() => setup.store.issueHostChallenge({
    deviceId: setup.deviceId, challenge: bearer(), requestId: randomUUID(), now: 5_001,
  }), 'unauthorized');
  setup.store.close();
  const reopened = createReleaseStore(setup.path, { catalog });
  assert.deepEqual(reopened.revokeHostDevice(action), revoked);
  reopened.close();
});

test('authorized issuance is listed and revocation cancels its unredeemed code', () => {
  const setup = enrolled();
  const session = createSession(setup);
  const code = bearer();
  setup.store.issueEnrollment({
    applicationSessionToken: session.sessionToken, enrollmentCode: code,
    requestId: randomUUID(), now: 4_000,
  });
  assert.deepEqual(setup.store.listHostDevices({
    applicationSessionToken: session.sessionToken, now: 4_001,
  }), [{
    deviceId: setup.deviceId, label: 'Family Mac', authorizedAt: 2_001,
    lastProvedAt: 3_001, revokedAt: null,
  }]);
  setup.store.revokeHostDevice({
    applicationSessionToken: session.sessionToken, targetDeviceId: setup.deviceId,
    requestId: randomUUID(), now: 4_002,
  });
  expectCode(() => setup.store.redeemEnrollment({
    enrollmentCode: code, requestId: randomUUID(), deviceId: randomUUID(),
    publicKey: keyPair().publicKey, label: 'Late Mac', now: 4_003,
  }), 'unauthorized');
  setup.store.close();
});

test('device revocation remains available at and after challenge expiry', () => {
  for (const offset of [0, 1]) {
    const setup = enrolled();
    const session = createSession(setup);
    setup.store.issueHostChallenge({
      deviceId: setup.deviceId, challenge: bearer(), requestId: randomUUID(), now: 4_000,
    });
    assert.equal(setup.store.revokeHostDevice({
      applicationSessionToken: session.sessionToken, targetDeviceId: setup.deviceId,
      requestId: randomUUID(), now: 4_000 + HOST_LIMITS.challengeTtl + offset,
    }).code, 'device_revoked');
    setup.store.close();
  }
});

test('challenge and ticket capacity use the advertised final-slot boundary', () => {
  const setup = enrolled();
  for (let index = 0; index < HOST_LIMITS.challengesPerDevice - 1; index += 1) {
    setup.store.issueHostChallenge({
      deviceId: setup.deviceId, challenge: bearer(), requestId: randomUUID(), now: 3_000 + index,
    });
  }
  assert.equal(setup.store.issueHostChallenge({
    deviceId: setup.deviceId, challenge: bearer(), requestId: randomUUID(), now: 3_100,
  }).code, 'challenge_issued');
  expectCode(() => setup.store.issueHostChallenge({
    deviceId: setup.deviceId, challenge: bearer(), requestId: randomUUID(), now: 3_101,
  }), 'capacity_reached');

  setup.store.close();
  const second = enrolled();
  const session = createSession(second);
  for (let index = 0; index < HOST_LIMITS.ticketsPerSession - 1; index += 1) {
    second.store.issueHostWebTicket({
      applicationSessionToken: session.sessionToken, ticket: bearer(),
      requestId: randomUUID(), now: 4_000 + index,
    });
  }
  assert.equal(second.store.issueHostWebTicket({
    applicationSessionToken: session.sessionToken, ticket: bearer(),
    requestId: randomUUID(), now: 4_100,
  }).code, 'ticket_issued');
  expectCode(() => second.store.issueHostWebTicket({
    applicationSessionToken: session.sessionToken, ticket: bearer(),
    requestId: randomUUID(), now: 4_101,
  }), 'capacity_reached');
  second.store.close();
});

test('device and enrollment capacity are fixed at eight live identities', () => {
  const place = location();
  const store = createReleaseStore(place.path, { catalog });
  const codes = Array.from({ length: HOST_LIMITS.enrollments }, () => bearer());
  for (const [index, code] of codes.entries()) {
    store.issueEnrollment({ enrollmentCode: code, requestId: randomUUID(), now: 1_000 + index });
  }
  expectCode(() => store.issueEnrollment({
    enrollmentCode: bearer(), requestId: randomUUID(), now: 1_100,
  }), 'capacity_reached');
  for (const [index, code] of codes.entries()) {
    store.redeemEnrollment({
      enrollmentCode: code, requestId: randomUUID(), deviceId: randomUUID(),
      publicKey: keyPair().publicKey, label: `Family Mac ${index + 1}`, now: 2_000 + index,
    });
  }
  const ninth = bearer();
  store.issueEnrollment({ enrollmentCode: ninth, requestId: randomUUID(), now: 3_000 });
  expectCode(() => store.redeemEnrollment({
    enrollmentCode: ninth, requestId: randomUUID(), deviceId: randomUUID(),
    publicKey: keyPair().publicKey, label: 'Ninth Mac', now: 3_001,
  }), 'capacity_reached');
  store.close();
});

test('application sessions accept the eighth and reject a ninth concurrent session', () => {
  const setup = enrolled();
  const sessions = [];
  for (let index = 0; index < HOST_LIMITS.applicationSessionsPerDevice; index += 1) {
    sessions.push(createSession(setup, 3_000 + (index * 10)));
  }
  assert.equal(sessions.at(-1).result.code, 'session_created');
  const challenge = bearer();
  setup.store.issueHostChallenge({
    deviceId: setup.deviceId, challenge, requestId: randomUUID(), now: 4_000,
  });
  expectCode(() => setup.store.proveHostChallenge({
    deviceId: setup.deviceId, challenge, sessionToken: bearer(), requestId: randomUUID(),
    now: 4_001,
    signature: sign('sha256', hostProofBytes({ challenge, deviceId: setup.deviceId, origin }),
      setup.keys.privateKey).toString('base64'),
  }), 'capacity_reached');
  setup.store.close();
});

test('challenge and ticket expiry are deterministic before, at, and after equality', () => {
  for (const offset of [-1, 0, 1]) {
    const setup = enrolled();
    const challenge = bearer();
    setup.store.issueHostChallenge({
      deviceId: setup.deviceId, challenge, requestId: randomUUID(), now: 3_000,
    });
    const signature = sign('sha256', hostProofBytes({
      challenge, deviceId: setup.deviceId, origin,
    }), setup.keys.privateKey).toString('base64');
    const prove = () => setup.store.proveHostChallenge({
      deviceId: setup.deviceId, challenge, signature, sessionToken: bearer(),
      requestId: randomUUID(), now: 3_000 + HOST_LIMITS.challengeTtl + offset,
    });
    if (offset < 0) assert.equal(prove().code, 'session_created');
    else expectCode(prove, 'expired');
    setup.store.close();

    const ticketSetup = enrolled();
    const session = createSession(ticketSetup, 4_000);
    const ticket = bearer();
    ticketSetup.store.issueHostWebTicket({
      applicationSessionToken: session.sessionToken, ticket,
      requestId: randomUUID(), now: 5_000,
    });
    const exchange = () => ticketSetup.store.exchangeHostWebTicket({
      ticket, now: 5_000 + HOST_LIMITS.webTicketTtl + offset,
    });
    if (offset < 0) assert.equal(exchange().code, 'ticket_exchanged');
    else expectCode(exchange, 'expired');
    ticketSetup.store.close();
  }
});

test('application session authority ends exactly at expiry equality', () => {
  const setup = enrolled();
  const session = createSession(setup, 3_000);
  const expiry = 3_001 + HOST_LIMITS.applicationSessionTtl;
  assert.equal(setup.store.authorizeHostSession({
    token: session.sessionToken, now: expiry - 1,
  }).deviceId, setup.deviceId);
  expectCode(() => setup.store.authorizeHostSession({
    token: session.sessionToken, now: expiry,
  }), 'unauthorized');
  expectCode(() => setup.store.authorizeHostSession({
    token: session.sessionToken, now: expiry + 1,
  }), 'unauthorized');
  setup.store.close();
});

test('Host authority evidence is structurally non-deletable', () => {
  const setup = enrolled();
  const session = createSession(setup);
  setup.store.issueHostWebTicket({
    applicationSessionToken: session.sessionToken, ticket: bearer(),
    requestId: randomUUID(), now: 3_100,
  });
  const database = new DatabaseSync(setup.path);
  for (const table of [
    'host_devices', 'host_enrollments', 'host_challenges', 'host_sessions',
    'host_web_tickets', 'host_action_receipts',
  ]) assert.throws(() => database.exec(`DELETE FROM ${table}`));
  database.close();
  assert.equal(setup.store.authorizeHostSession({
    token: session.sessionToken, now: 4_000,
  }).deviceId, setup.deviceId);
  setup.store.close();
});

test('receipt capacity preserves all 256 authority-reducing reserve slots', () => {
  for (const offset of [-1, 0, 1]) {
    assert.equal(hostReceiptCapacityAllows({
      total: HOST_LIMITS.ordinaryReceipts + offset,
      ordinary: HOST_LIMITS.ordinaryReceipts + offset,
    }), offset < 0);
    assert.equal(hostReceiptCapacityAllows({
      total: HOST_LIMITS.ordinaryReceipts + HOST_LIMITS.reservedReceipts + offset,
      ordinary: HOST_LIMITS.ordinaryReceipts,
    }, true), offset < 0);
  }
  assert.equal(hostReceiptCapacityAllows({
    total: HOST_LIMITS.ordinaryReceipts,
    ordinary: HOST_LIMITS.ordinaryReceipts,
  }, true), true);
});

test('relationship-preserving Host receipt, proof, and web corruption fail on restart', () => {
  for (const corrupt of [
    (database) => {
      const trigger = database.prepare(`SELECT sql FROM sqlite_schema
        WHERE name='host_action_receipts_immutable_update'`).get().sql;
      const row = database.prepare(`SELECT actor_type,actor_id,request_id,result
        FROM host_action_receipts WHERE operation='issue_challenge'`).get();
      const result = { ...JSON.parse(row.result), expiresAt: JSON.parse(row.result).expiresAt + 1 };
      database.exec('DROP TRIGGER host_action_receipts_immutable_update');
      database.prepare(`UPDATE host_action_receipts SET result=?
        WHERE actor_type=? AND actor_id=? AND request_id=?`).run(
        canonicalJson(result), row.actor_type, row.actor_id, row.request_id,
      );
      database.exec(trigger);
    },
    (database) => {
      database.prepare('UPDATE host_devices SET last_proved_at=last_proved_at+1').run();
    },
    (database) => {
      database.prepare(`UPDATE host_sessions SET revoked_at=5000
        WHERE session_hash=(SELECT session_hash FROM host_sessions
          WHERE kind='application' LIMIT 1)`).run();
    },
    (database) => {
      database.prepare(`UPDATE host_challenges SET revoked_at=5000
        WHERE challenge_hash=(SELECT challenge_hash FROM host_challenges
          WHERE revoked_at IS NULL LIMIT 1)`).run();
    },
    (database) => {
      database.prepare(`UPDATE host_web_tickets SET revoked_at=5000
        WHERE ticket_hash=(SELECT ticket_hash FROM host_web_tickets
          WHERE revoked_at IS NULL LIMIT 1)`).run();
    },
    (database) => {
      database.prepare(`UPDATE host_enrollments SET revoked_at=5000
        WHERE enrollment_hash=(SELECT enrollment_hash FROM host_enrollments
          WHERE issued_by_device_id IS NOT NULL LIMIT 1)`).run();
    },
    (database) => {
      database.prepare(`UPDATE host_web_tickets SET consumed_at=NULL,web_session_hash=NULL
        WHERE consumed_at IS NOT NULL`).run();
    },
    (database) => {
      const trigger = database.prepare(`SELECT sql FROM sqlite_schema
        WHERE name='host_action_receipts_immutable_update'`).get().sql;
      const row = database.prepare(`SELECT actor_type,actor_id,request_id,result
        FROM host_action_receipts WHERE operation='prove_challenge'
        AND json_extract(result,'$.code')='session_created' LIMIT 1`).get();
      const result = {
        ...JSON.parse(row.result), deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      };
      database.exec('DROP TRIGGER host_action_receipts_immutable_update');
      database.prepare(`UPDATE host_action_receipts SET result=?
        WHERE actor_type=? AND actor_id=? AND request_id=?`).run(
        canonicalJson(result), row.actor_type, row.actor_id, row.request_id,
      );
      database.exec(trigger);
    },
    (database) => {
      const trigger = database.prepare(`SELECT sql FROM sqlite_schema
        WHERE name='host_sessions_identity_immutable'`).get().sql;
      const web = database.prepare(`SELECT session_hash,parent_session_hash
        FROM host_sessions WHERE kind='web'`).get();
      const other = database.prepare(`SELECT session_hash FROM host_sessions
        WHERE kind='application' AND session_hash<>? LIMIT 1`).get(web.parent_session_hash);
      database.exec('DROP TRIGGER host_sessions_identity_immutable');
      database.prepare('UPDATE host_sessions SET parent_session_hash=? WHERE session_hash=?')
        .run(other.session_hash, web.session_hash);
      database.exec(trigger);
    },
  ]) {
    const setup = enrolled();
    const first = createSession(setup, 3_000);
    createSession(setup, 3_100);
    const ticket = bearer();
    setup.store.issueHostWebTicket({
      applicationSessionToken: first.sessionToken, ticket,
      requestId: randomUUID(), now: 4_000,
    });
    setup.store.exchangeHostWebTicket({ ticket, now: 4_001 });
    setup.store.issueEnrollment({
      applicationSessionToken: first.sessionToken, enrollmentCode: bearer(),
      requestId: randomUUID(), now: 4_002,
    });
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    corrupt(database);
    assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  }
});
