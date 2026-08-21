import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';

import { canonicalJson, sha256 } from '../../web/lib/server/release/canonical.mjs';
import {
  loadCatalogArtifacts, validateCatalogArtifacts,
} from '../../web/lib/server/release/catalog.mjs';
import { normalizeRules } from '../../web/lib/server/release/game-state.mjs';
import { hostProofBytes } from '../../web/lib/server/release/host-authority.mjs';
import { RELEASE_SCHEMA_DIGEST, canonicalSchemaDigest } from '../../web/lib/server/release/schema.mjs';
import {
  MINIMUM_DATABASE_FREE_BYTES, ReleaseStoreError, createReleaseStore,
} from '../../web/lib/server/release/store.mjs';

const roots = [];
const catalog = loadCatalogArtifacts({
  catalogPath: new URL('../../web/data/catalog.json', import.meta.url),
  manifestPath: new URL('../../web/data/catalog-manifest.json', import.meta.url),
});
const testKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const testPublicKey = testKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function temporaryDatabase() {
  const root = mkdtempSync(join(tmpdir(), 'cannabeats-fr1-'));
  roots.push(root);
  return { root, path: join(root, 'cannabeats.sqlite3') };
}

function expectCode(work, code) {
  assert.throws(work, (error) => error instanceof ReleaseStoreError && error.code === code);
}

function firstLine(stream) {
  return new Promise((resolveLine, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error('owner probe timed out')), 10_000);
    stream.on('data', (chunk) => {
      text += chunk;
      const newline = text.indexOf('\n');
      if (newline !== -1) {
        clearTimeout(timeout);
        resolveLine(text.slice(0, newline));
      }
    });
  });
}

function setupHostStore(options = {}) {
  const location = temporaryDatabase();
  const store = createReleaseStore(location.path, { catalog, now: 1_000, ...options });
  const hostDeviceId = randomUUID();
  const enrollmentCode = Buffer.alloc(16, 7).toString('base64url');
  store.issueEnrollment({ enrollmentCode, requestId: randomUUID(), now: 1_000 });
  store.redeemEnrollment({
    enrollmentCode, requestId: randomUUID(), deviceId: hostDeviceId,
    publicKey: testPublicKey, label: 'Test Host', now: 1_001,
  });
  return {
    ...location,
    hostDeviceId,
    store,
  };
}

function hostSession(setup, now = 1_100) {
  const challenge = randomBytes(24).toString('base64url');
  setup.store.issueHostChallenge({
    deviceId: setup.hostDeviceId, challenge, requestId: randomUUID(), now,
  });
  const token = randomBytes(24).toString('base64url');
  setup.store.proveHostChallenge({
    deviceId: setup.hostDeviceId, challenge, sessionToken: token,
    requestId: randomUUID(), now: now + 1,
    signature: sign('sha256', hostProofBytes({
      challenge, deviceId: setup.hostDeviceId, origin: 'https://play.cannabeats.social',
    }), testKeys.privateKey).toString('base64'),
  });
  return token;
}

function createGame(store, hostDeviceId, overrides = {}) {
  return store.createGame({
    gameId: overrides.gameId ?? randomUUID(),
    requestId: overrides.requestId ?? randomUUID(),
    hostDeviceId,
    catalogVersion: overrides.catalogVersion ?? catalog.version,
    rules: overrides.rules ?? { preset: 'family' },
    now: overrides.now ?? 2_000,
  });
}

function hostJourneyAction(setup, gameId, operation, payload = {}, overrides = {}) {
  setup.hostToken ??= hostSession(setup);
  return setup.store.applyHostGameAction({
    applicationSessionToken: setup.hostToken, gameId,
    requestId: overrides.requestId ?? randomUUID(), operation, payload,
    expectedRevision: overrides.expectedRevision
      ?? setup.store.gameSnapshot(gameId).revision,
    now: overrides.now ?? 3_000,
  });
}

function replacementCatalog() {
  const catalogText = JSON.stringify([{
    title: 'Replacement Song', artist: 'Replacement Artist', year: 2001,
    uri: 'spotify:track:1111111111111111111111',
  }]);
  const version = `sha256:${sha256(catalogText)}`;
  return validateCatalogArtifacts(catalogText, JSON.stringify({
    schemaVersion: 1, catalogVersion: version, sourceVersion: version,
    songCount: 1, moduleCount: 1,
  }));
}

test('a clean store records the exact schema and current catalog before readiness', () => {
  const { path } = temporaryDatabase();
  const store = createReleaseStore(path, { catalog, now: 1_000 });
  assert.deepEqual(store.readiness({ minimumFreeBytes: 0 }), {
    ready: true,
    reason: 'ready',
    schemaGeneration: 1,
    catalogVersion: catalog.version,
  });
  store.close();

  const database = new DatabaseSync(path, { readOnly: true });
  assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
  assert.deepEqual({ ...database.prepare(`SELECT catalog_version,artifact_digest,song_count
    FROM catalog_releases`).get() }, {
    catalog_version: catalog.version,
    artifact_digest: catalog.artifactDigest,
    song_count: catalog.songCount,
  });
  database.close();
});

test('a nonempty legacy database is refused without changing its bytes', () => {
  const { path } = temporaryDatabase();
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE legacy_state (value TEXT); INSERT INTO legacy_state VALUES (\'retained\')');
  legacy.close();
  const before = sha256(readFileSync(path));
  expectCode(() => createReleaseStore(path, { catalog }), 'database_incompatible');
  assert.equal(sha256(readFileSync(path)), before);
  const check = new DatabaseSync(path, { readOnly: true });
  assert.equal(check.prepare('SELECT value FROM legacy_state').get().value, 'retained');
  assert.equal(check.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema
    WHERE name='schema_generations'`).get().count, 0);
  check.close();
});

test('path, symbolic-link, and inode aliases cannot obtain a second owner', () => {
  const { root, path } = temporaryDatabase();
  const store = createReleaseStore(path, { catalog });
  expectCode(() => createReleaseStore(path, { catalog }), 'database_unavailable');
  const symbolic = join(root, 'symbolic.sqlite3');
  symlinkSync(path, symbolic);
  expectCode(() => createReleaseStore(symbolic, { catalog }), 'database_unavailable');
  const hard = join(root, 'hard.sqlite3');
  linkSync(path, hard);
  expectCode(() => createReleaseStore(hard, { catalog }), 'database_unavailable');
  store.close();
});

test('a child-process owner excludes a concurrent second process', async () => {
  const { path } = temporaryDatabase();
  const initialized = createReleaseStore(path, { catalog });
  initialized.close();
  const worker = fileURLToPath(new URL('./fixtures/fr1-owner-probe.mjs', import.meta.url));
  const args = [
    worker, path,
    fileURLToPath(new URL('../../web/data/catalog.json', import.meta.url)),
    fileURLToPath(new URL('../../web/data/catalog-manifest.json', import.meta.url)),
  ];
  const owner = spawn(process.execPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  assert.equal(await firstLine(owner.stdout), 'owned');
  const contender = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(await firstLine(contender.stdout), 'failed:database_unavailable');
  owner.stdin.write('close\n');
  await Promise.all([owner, contender].map((child) => child.exitCode === null
    ? new Promise((resolveExit) => child.once('exit', resolveExit)) : undefined));
});

test('create replay is original, conflict is first, and another active game is bounded', () => {
  const setup = setupHostStore();
  const identity = { gameId: randomUUID(), requestId: randomUUID(), now: 2_000 };
  const first = createGame(setup.store, setup.hostDeviceId, identity);
  assert.equal(first.code, 'created');
  assert.deepEqual(createGame(setup.store, setup.hostDeviceId, identity), first);
  expectCode(() => createGame(setup.store, setup.hostDeviceId, {
    ...identity, rules: { preset: 'modern' }, now: 2_001,
  }), 'request_conflict');
  assert.deepEqual(createGame(setup.store, setup.hostDeviceId, {
    gameId: randomUUID(), requestId: randomUUID(), now: 2_001,
  }), { code: 'active_game_exists', gameId: identity.gameId });
  setup.store.close();
});

test('create replay retains its explicit catalog identity after catalog rotation', () => {
  const setup = setupHostStore();
  const identity = {
    gameId: randomUUID(), requestId: randomUUID(), catalogVersion: catalog.version, now: 2_000,
  };
  const created = createGame(setup.store, setup.hostDeviceId, identity);
  setup.store.close();
  const nextCatalog = replacementCatalog();
  const reopened = createReleaseStore(setup.path, { catalog: nextCatalog, now: 3_000 });
  assert.deepEqual(createGame(reopened, setup.hostDeviceId, identity), created);
  expectCode(() => createGame(reopened, setup.hostDeviceId, {
    ...identity, catalogVersion: nextCatalog.version,
  }), 'request_conflict');
  reopened.close();

  const database = new DatabaseSync(setup.path);
  const trigger = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='catalog_entries_immutable_update'`).get().sql;
  const oldEntry = database.prepare(`SELECT uri,song FROM catalog_entries
    WHERE catalog_version=? ORDER BY uri LIMIT 1`).get(catalog.version);
  const altered = { ...JSON.parse(oldEntry.song), title: 'Canonical but forged title' };
  database.exec('DROP TRIGGER catalog_entries_immutable_update');
  database.prepare(`UPDATE catalog_entries SET song=?
    WHERE catalog_version=? AND uri=?`).run(canonicalJson(altered), catalog.version, oldEntry.uri);
  database.exec(trigger);
  assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog: nextCatalog }), 'database_corrupt');
});

test('reducers cannot retain a syntactically valid song absent from the bound catalog', () => {
  const setup = setupHostStore();
  const game = createGame(setup.store, setup.hostDeviceId);
  const inventedSong = {
    title: 'Invented', artist: 'Nobody', year: 2000,
    uri: 'spotify:track:2222222222222222222222',
  };
  expectCode(() => setup.store.mutateGame({
    gameId: game.gameId,
    actorType: 'host', actorId: setup.hostDeviceId, requestId: randomUUID(),
    operation: 'start_game', payload: {}, expectedRevision: 0, now: 3_000,
    reducer: (state) => {
      const playerId = randomUUID();
      return {
        lifecycle: 'active',
        state: {
          ...state, phase: 'ready', round: 1, currentSong: inventedSong,
          usedUris: [inventedSong.uri], activePlayerId: playerId,
          players: [{ id: playerId, name: 'Host', control: 'host', timeline: [] }],
        },
        events: [{ type: 'game_started', outcome: 'accepted', detail: {} }],
      };
    },
  }), 'operation_rejected');
  expectCode(() => setup.store.mutateGame({
    gameId: game.gameId,
    actorType: 'host', actorId: setup.hostDeviceId, requestId: randomUUID(),
    operation: 'retain_used_uri', payload: {}, expectedRevision: 0, now: 3_001,
    reducer: (state) => ({
      state: { ...state, usedUris: [inventedSong.uri] },
      events: [{ type: 'game_configured', outcome: 'accepted', detail: {} }],
    }),
  }), 'operation_rejected');
  assert.equal(setup.store.gameSnapshot(game.gameId).revision, 0);
  setup.store.close();
});

test('mutation response loss replays before authority and stale-state checks after restart', () => {
  const setup = setupHostStore();
  const applicationSessionToken = hostSession(setup);
  const created = createGame(setup.store, setup.hostDeviceId);
  const action = {
    applicationSessionToken,
    gameId: created.gameId,
    requestId: randomUUID(),
    operation: 'configure_game',
    payload: { rules: normalizeRules({ preset: 'modern', minYear: 1980 }) },
    expectedRevision: 0,
    now: 3_000,
  };
  const accepted = setup.store.applyHostGameAction(action);
  setup.store.revokeHostDevice({
    applicationSessionToken, targetDeviceId: setup.hostDeviceId,
    requestId: randomUUID(), now: 3_001,
  });
  setup.store.close();
  const reopened = createReleaseStore(setup.path, { catalog });
  assert.deepEqual(reopened.applyHostGameAction(action), accepted);
  expectCode(() => reopened.applyHostGameAction({
    ...action, payload: { rules: normalizeRules({ preset: 'younger' }) }, expectedRevision: 999,
  }), 'request_conflict');
  expectCode(() => reopened.applyHostGameAction({
    ...action, requestId: randomUUID(), expectedRevision: 0, now: 3_002,
  }), 'unauthorized');
  reopened.close();
});

test('terminal abandonment releases only the removable one-active-game policy', () => {
  const setup = setupHostStore();
  const applicationSessionToken = hostSession(setup);
  const first = createGame(setup.store, setup.hostDeviceId);
  const abandoned = setup.store.terminateGame({
    applicationSessionToken, gameId: first.gameId, requestId: randomUUID(),
    expectedRevision: 0, now: 3_000,
  });
  assert.equal(abandoned.revision, 1);
  const second = createGame(setup.store, setup.hostDeviceId, { now: 3_001 });
  assert.equal(second.code, 'created');
  assert.notEqual(second.gameId, first.gameId);
  setup.store.close();
});

test('database reserve handles max-minus-one, equality, and max-plus-one deterministically', () => {
  let available = MINIMUM_DATABASE_FREE_BYTES - 1;
  const statfs = () => ({ bavail: BigInt(available), bsize: 1n });
  const { store } = setupHostStore({ statfs });
  assert.deepEqual(store.readiness(), { ready: false, reason: 'database_capacity' });
  available = MINIMUM_DATABASE_FREE_BYTES;
  assert.equal(store.readiness().ready, true);
  available = MINIMUM_DATABASE_FREE_BYTES + 1;
  assert.equal(store.readiness().ready, true);
  store.close();
});

test('state relationship and canonical-byte corruption fail on restart', () => {
  for (const mutate of [
    (database, gameId) => {
      const row = database.prepare('SELECT state FROM games WHERE game_id=?').get(gameId);
      const state = JSON.parse(row.state);
      state.catalogVersion = `sha256:${'0'.repeat(64)}`;
      database.prepare('UPDATE games SET state=? WHERE game_id=?').run(canonicalJson(state), gameId);
    },
    (database, gameId) => {
      const row = database.prepare('SELECT state FROM games WHERE game_id=?').get(gameId);
      database.prepare('UPDATE games SET state=? WHERE game_id=?').run(` ${row.state}`, gameId);
    },
  ]) {
    const setup = setupHostStore();
    const game = createGame(setup.store, setup.hostDeviceId);
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    mutate(database, game.gameId);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  }
});

test('an event gap remains detectable after restoring the immutable trigger', () => {
  const setup = setupHostStore();
  const game = createGame(setup.store, setup.hostDeviceId);
  hostJourneyAction(setup, game.gameId, 'configure_game', {
    rules: normalizeRules({ preset: 'modern' }),
  });
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const trigger = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='game_events_immutable_delete'`).get().sql;
  database.exec('DROP TRIGGER game_events_immutable_delete');
  database.prepare('DELETE FROM game_events WHERE game_id=? AND sequence=2').run(game.gameId);
  database.exec(trigger);
  assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
});

test('restart rejects every unlinked event and a coherently forged creation actor', () => {
  {
    const setup = setupHostStore();
    const game = createGame(setup.store, setup.hostDeviceId);
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    const original = database.prepare(`SELECT * FROM action_receipts
      WHERE game_id=? AND revision=0`).get(game.gameId);
    const requestId = randomUUID();
    const request = { ...JSON.parse(original.request), requestId };
    const requestText = canonicalJson(request);
    const result = { ...JSON.parse(original.result), events: [] };
    database.prepare(`INSERT INTO action_receipts
      (game_id,actor_type,actor_id,request_id,operation,request,request_hash,result,revision,accepted_at)
      VALUES (?,?,?,?,?,?,?,?,0,?)`).run(
      game.gameId, 'host', setup.hostDeviceId, requestId, 'create_game', requestText,
      sha256(requestText), canonicalJson(result), original.accepted_at,
    );
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  }

  {
    const setup = setupHostStore();
    const game = createGame(setup.store, setup.hostDeviceId);
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    assert.throws(() => database.prepare(`INSERT INTO game_events
      (game_id,sequence,revision,event_type,outcome,actor_type,actor_id,request_id,detail,occurred_at)
      VALUES (?,2,0,'game_configured','accepted','system',?,?,'{}',?)`).run(
      game.gameId, randomUUID(), randomUUID(), 2_001,
    ), /FOREIGN KEY constraint failed/u);
    database.close();
    const reopened = createReleaseStore(setup.path, { catalog });
    assert.equal(reopened.readiness({ minimumFreeBytes: 0 }).ready, true);
    reopened.close();
  }

  {
    const setup = setupHostStore();
    const game = createGame(setup.store, setup.hostDeviceId);
    setup.store.close();
    const forgedActor = randomUUID();
    const forgedRequestId = randomUUID();
    const database = new DatabaseSync(setup.path);
    const receiptTrigger = database.prepare(`SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='action_receipts_immutable_update'`).get().sql;
    const eventTrigger = database.prepare(`SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='game_events_immutable_update'`).get().sql;
    const receipt = database.prepare(`SELECT request,result FROM action_receipts
      WHERE game_id=? AND revision=0`).get(game.gameId);
    const request = {
      ...JSON.parse(receipt.request), actorId: forgedActor, requestId: forgedRequestId,
    };
    const requestText = canonicalJson(request);
    database.exec(`DROP TRIGGER action_receipts_immutable_update;
      DROP TRIGGER game_events_immutable_update; BEGIN`);
    database.prepare(`UPDATE action_receipts SET actor_id=?,request_id=?,request=?,request_hash=?
      WHERE game_id=? AND revision=0`).run(
      forgedActor, forgedRequestId, requestText, sha256(requestText), game.gameId,
    );
    database.prepare(`UPDATE game_events SET actor_id=?,request_id=?
      WHERE game_id=? AND sequence=1`).run(forgedActor, forgedRequestId, game.gameId);
    database.exec(`COMMIT; ${receiptTrigger}; ${eventTrigger};`);
    assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  }

  {
    const setup = setupHostStore();
    const game = createGame(setup.store, setup.hostDeviceId);
    hostJourneyAction(setup, game.gameId, 'configure_game', {
      rules: normalizeRules({ preset: 'modern' }),
    });
    setup.store.close();
    const forgedActor = randomUUID();
    const database = new DatabaseSync(setup.path);
    const receiptTrigger = database.prepare(`SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='action_receipts_immutable_update'`).get().sql;
    const eventTrigger = database.prepare(`SELECT sql FROM sqlite_schema
      WHERE type='trigger' AND name='game_events_immutable_update'`).get().sql;
    const receipt = database.prepare(`SELECT request FROM action_receipts
      WHERE game_id=? AND revision=1`).get(game.gameId);
    const request = { ...JSON.parse(receipt.request), actorId: forgedActor };
    const requestText = canonicalJson(request);
    database.exec(`DROP TRIGGER action_receipts_immutable_update;
      DROP TRIGGER game_events_immutable_update; BEGIN`);
    database.prepare(`UPDATE action_receipts SET actor_id=?,request=?,request_hash=?
      WHERE game_id=? AND revision=1`).run(
      forgedActor, requestText, sha256(requestText), game.gameId,
    );
    database.prepare(`UPDATE game_events SET actor_id=?
      WHERE game_id=? AND revision=1`).run(forgedActor, game.gameId);
    database.exec(`COMMIT; ${receiptTrigger}; ${eventTrigger};`);
    assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  }
});

test('later-checkpoint rows remain inert until their shared owner exists', () => {
  const setup = setupHostStore();
  const game = createGame(setup.store, setup.hostDeviceId);
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  database.prepare(`INSERT INTO audio_sessions
    (audio_session_id,game_id,generation,state,started_at,updated_at)
    VALUES (?,?,1,'active',?,?)`).run(randomUUID(), game.gameId, 3_000, 3_000);
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
});

test('generic reducers cannot fabricate terminal state outside the fixed journey owner', () => {
  const setup = setupHostStore();
  const game = createGame(setup.store, setup.hostDeviceId);
  expectCode(() => setup.store.mutateGame({
    gameId: game.gameId,
    actorType: 'host', actorId: setup.hostDeviceId, requestId: randomUUID(),
    operation: 'complete_game', payload: {}, expectedRevision: 0, now: 4_000,
    reducer: (state) => ({
      lifecycle: 'completed',
      state,
      events: [{ type: 'game_completed', outcome: 'completed', detail: {} }],
    }),
  }), 'operation_rejected');
  assert.equal(setup.store.gameSnapshot(game.gameId).revision, 0);
  setup.store.close();
});

test('catalog artifact and registration drift fail with finite results', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../../web/data/catalog-manifest.json', import.meta.url), 'utf8',
  ));
  manifest.songCount += 1;
  assert.throws(() => loadCatalogArtifacts({
    catalogPath: new URL('../../web/data/catalog.json', import.meta.url),
    manifestPath: 'ignored',
    read: (path) => String(path).endsWith('catalog.json')
      ? readFileSync(new URL('../../web/data/catalog.json', import.meta.url), 'utf8')
      : JSON.stringify(manifest),
  }), /catalog_incompatible/u);

  const { path } = temporaryDatabase();
  const store = createReleaseStore(path, { catalog });
  store.close();
  const database = new DatabaseSync(path);
  const trigger = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='catalog_releases_immutable_update'`).get().sql;
  database.exec('DROP TRIGGER catalog_releases_immutable_update');
  database.prepare(`UPDATE catalog_releases SET artifact_digest=?`).run('0'.repeat(64));
  database.exec(trigger);
  database.close();
  expectCode(() => createReleaseStore(path, { catalog }), 'database_corrupt');
});

test('valid-looking head, event, and request mutations preserve schema but fail validation', () => {
  const corruptions = [
    (database, gameId) => {
      const row = database.prepare('SELECT state FROM games WHERE game_id=?').get(gameId);
      const state = JSON.parse(row.state);
      state.rules = normalizeRules({ preset: 'younger' });
      database.prepare('UPDATE games SET state=? WHERE game_id=?').run(canonicalJson(state), gameId);
    },
    (database, gameId) => {
      const trigger = database.prepare(`SELECT sql FROM sqlite_schema
        WHERE type='trigger' AND name='game_events_immutable_update'`).get().sql;
      database.exec('DROP TRIGGER game_events_immutable_update');
      database.prepare(`UPDATE game_events SET detail=? WHERE game_id=? AND sequence=2`).run(
        canonicalJson({ altered: true }), gameId,
      );
      database.exec(trigger);
    },
    (database, gameId) => {
      const trigger = database.prepare(`SELECT sql FROM sqlite_schema
        WHERE type='trigger' AND name='action_receipts_immutable_update'`).get().sql;
      const row = database.prepare(`SELECT actor_type,actor_id,request_id,request
        FROM action_receipts WHERE game_id=? AND revision=1`).get(gameId);
      const request = { ...JSON.parse(row.request), unexpected: 'still canonical' };
      const requestText = canonicalJson(request);
      database.exec('DROP TRIGGER action_receipts_immutable_update');
      database.prepare(`UPDATE action_receipts SET request=?,request_hash=?
        WHERE game_id=? AND actor_type=? AND actor_id=? AND request_id=?`).run(
        requestText, sha256(requestText), gameId,
        row.actor_type, row.actor_id, row.request_id,
      );
      database.exec(trigger);
    },
  ];
  for (const corrupt of corruptions) {
    const setup = setupHostStore();
    const game = createGame(setup.store, setup.hostDeviceId);
    hostJourneyAction(setup, game.gameId, 'configure_game', {
      rules: normalizeRules({ preset: 'modern' }),
    });
    setup.store.close();
    const database = new DatabaseSync(setup.path);
    corrupt(database, game.gameId);
    assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
    database.close();
    expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
  }
});

test('event chronology cannot be reordered while counts and revisions stay unchanged', () => {
  const setup = setupHostStore();
  const game = createGame(setup.store, setup.hostDeviceId);
  hostJourneyAction(setup, game.gameId, 'configure_game', {
    rules: normalizeRules({ preset: 'modern' }),
  });
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  const trigger = database.prepare(`SELECT sql FROM sqlite_schema
    WHERE type='trigger' AND name='game_events_immutable_update'`).get().sql;
  database.exec('DROP TRIGGER game_events_immutable_update');
  database.prepare('UPDATE game_events SET occurred_at=? WHERE game_id=? AND sequence=1')
    .run(3_001, game.gameId);
  database.exec(trigger);
  assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
});

test('game head timestamps remain reconstructible from the immutable receipt chain', () => {
  const setup = setupHostStore();
  const game = createGame(setup.store, setup.hostDeviceId);
  hostJourneyAction(setup, game.gameId, 'configure_game', {
    rules: normalizeRules({ preset: 'modern' }),
  });
  setup.store.close();
  const database = new DatabaseSync(setup.path);
  database.prepare('UPDATE games SET updated_at=updated_at+1 WHERE game_id=?').run(game.gameId);
  assert.equal(canonicalSchemaDigest(database), RELEASE_SCHEMA_DIGEST);
  database.close();
  expectCode(() => createReleaseStore(setup.path, { catalog }), 'database_corrupt');
});

test('invalid callers and malformed reducer output stay inside the finite result taxonomy', () => {
  const setup = setupHostStore();
  expectCode(() => setup.store.createGame({
    gameId: 'caller supplied native SQL path',
    requestId: randomUUID(), hostDeviceId: setup.hostDeviceId, rules: {}, now: 2_000,
  }), 'invalid_request');
  const game = createGame(setup.store, setup.hostDeviceId);
  expectCode(() => setup.store.gameSnapshot('not-a-uuid'), 'invalid_request');
  expectCode(() => setup.store.mutateGame({
    gameId: game.gameId,
    actorType: 'host', actorId: setup.hostDeviceId, requestId: randomUUID(),
    operation: 'bad_result', payload: {}, expectedRevision: 0, now: 3_000,
    reducer: (state) => ({
      state,
      value: Number.NaN,
      events: [{ type: 'game_configured', outcome: 'accepted', detail: {} }],
    }),
  }), 'operation_rejected');
  setup.store.close();
});
