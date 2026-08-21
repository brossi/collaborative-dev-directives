import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, statSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  CATALOG_VERSION_PATTERN, SHA256_PATTERN, UUID_PATTERN, assertTimestamp, assertUuid,
  canonicalJson, parseCanonicalJson, sha256,
} from './canonical.mjs';
import { finiteCatalogSong } from './catalog.mjs';
import {
  GAME_JOURNEY_OPERATIONS, compactGameResult, normalizeGameJourneyCommand, projectGameState,
  reduceGameJourneyCommand,
} from './game-journey.mjs';
import { createInitialGameState, normalizeRules, validateGameState } from './game-state.mjs';
import { createGameAdmission, validateGameAdmission } from './game-admission.mjs';
import { createHostAuthority, validateHostAuthority } from './host-authority.mjs';
import {
  appendTrackPlaybackCommand, cancelOpenPlaybackCommands, createPlaybackCommands,
  validatePlaybackCommands,
} from './playback-commands.mjs';
import {
  RELEASE_SCHEMA_DIGEST, RELEASE_SCHEMA_GENERATION, RELEASE_SCHEMA_SQL,
  canonicalSchemaDigest,
} from './schema.mjs';

export const MINIMUM_DATABASE_FREE_BYTES = 256 * 1024 * 1024;
const ownershipLocks = new WeakMap();
const EVENT_TYPES = new Set([
  'game_created', 'invitation_issued', 'invitation_revoked', 'invitation_closed',
  'participant_joined', 'participant_removed', 'game_configured',
  'game_started', 'track_requested', 'placement_locked', 'placement_retracted',
  'answer_revealed', 'round_advanced', 'track_skipped', 'game_completed',
  'game_abandoned', 'playback_requested', 'playback_claimed', 'playback_completed',
  'playback_failed', 'playback_outcome_unknown', 'audio_started', 'audio_stopped',
  'audio_interrupted', 'audio_recovered',
]);
const EVENT_OUTCOMES = new Set([
  'accepted', 'completed', 'failed', 'abandoned', 'interrupted', 'recovered', 'unknown',
]);

export class ReleaseStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReleaseStoreError';
    this.code = code;
  }
}

function fail(code) {
  throw new ReleaseStoreError(code);
}

function requestValue(work) {
  try {
    return work();
  } catch (error) {
    if (error instanceof ReleaseStoreError) throw error;
    fail('invalid_request');
  }
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function acquireLock(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA busy_timeout=1; BEGIN EXCLUSIVE');
  } catch {
    database.close();
    fail('database_unavailable');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (database.isTransaction) database.exec('ROLLBACK');
    database.close();
  };
}

function acquireOwnership(databasePath, lockDirectory) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const canonicalPath = existsSync(databasePath)
    ? realpathSync(databasePath)
    : resolve(realpathSync(dirname(databasePath)), databasePath.split('/').at(-1));
  mkdirSync(lockDirectory, { recursive: true });
  const releases = [];
  const pathIdentity = createHash('sha256').update(canonicalPath).digest('hex');
  releases.push(acquireLock(resolve(lockDirectory, `${pathIdentity}.owner.sqlite`)));
  const acquireInode = () => {
    if (!existsSync(canonicalPath) || releases.length > 1) return;
    const identity = statSync(canonicalPath);
    try {
      releases.push(acquireLock(resolve(lockDirectory, `${identity.dev}-${identity.ino}.owner.sqlite`)));
    } catch (error) {
      releases.reverse().forEach((release) => release());
      throw error;
    }
  };
  acquireInode();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releases.reverse().forEach((close) => close());
  };
  release.ensureInode = acquireInode;
  return release;
}

function validateSchema(database) {
  let row;
  try {
    row = database.prepare(`SELECT generation,contract_digest FROM schema_generations
      ORDER BY generation DESC LIMIT 1`).get();
  } catch {
    fail('database_incompatible');
  }
  if (row?.generation !== RELEASE_SCHEMA_GENERATION
      || row.contract_digest !== RELEASE_SCHEMA_DIGEST
      || canonicalSchemaDigest(database) !== RELEASE_SCHEMA_DIGEST) {
    fail('database_incompatible');
  }
}

function assertCanonical(text, code = 'database_corrupt') {
  try {
    return parseCanonicalJson(text);
  } catch {
    fail(code);
  }
}

function validateCatalogRows(database, currentCatalog) {
  const rows = database.prepare(`SELECT catalog_version,artifact_digest,entries_digest,source_version,
    song_count,manifest,registered_at FROM catalog_releases ORDER BY catalog_version`).all();
  if (!rows.length) fail('catalog_incompatible');
  const entriesByVersion = new Map();
  for (const row of rows) {
    if (!CATALOG_VERSION_PATTERN.test(row.catalog_version)
        || !SHA256_PATTERN.test(row.artifact_digest)
        || !SHA256_PATTERN.test(row.entries_digest)
        || row.catalog_version !== `sha256:${row.artifact_digest}`
        || !CATALOG_VERSION_PATTERN.test(row.source_version)
        || !Number.isSafeInteger(row.song_count) || row.song_count <= 0
        || !Number.isSafeInteger(row.registered_at) || row.registered_at <= 0) {
      fail('database_corrupt');
    }
    const manifest = assertCanonical(row.manifest);
    if (manifest.catalogVersion !== row.catalog_version
        || manifest.sourceVersion !== row.source_version
        || manifest.songCount !== row.song_count) fail('database_corrupt');
    const entries = database.prepare(`SELECT uri,song FROM catalog_entries
      WHERE catalog_version=? ORDER BY uri`).all(row.catalog_version);
    const songs = new Map();
    if (entries.length !== row.song_count) fail('database_corrupt');
    for (const entry of entries) {
      const song = assertCanonical(entry.song);
      if (!finiteCatalogSong(song) || song.uri !== entry.uri || songs.has(entry.uri)) {
        fail('database_corrupt');
      }
      songs.set(entry.uri, song);
    }
    if (sha256(canonicalJson([...songs.values()])) !== row.entries_digest) {
      fail('database_corrupt');
    }
    entriesByVersion.set(row.catalog_version, songs);
  }
  const current = rows.find(({ catalog_version: version }) => version === currentCatalog.version);
  if (!current || current.artifact_digest !== currentCatalog.artifactDigest
      || current.entries_digest !== currentCatalog.entriesDigest
      || current.source_version !== currentCatalog.sourceVersion
      || current.song_count !== currentCatalog.songCount
      || current.manifest !== currentCatalog.manifest) fail('catalog_incompatible');
  const currentEntries = entriesByVersion.get(currentCatalog.version);
  if (!currentEntries || currentCatalog.songs.some((song) => !currentEntries.has(song.uri)
    || canonicalJson(currentEntries.get(song.uri)) !== canonicalJson(song))) {
    fail('catalog_incompatible');
  }
  return entriesByVersion;
}

function storedCatalogSongs(database, catalogVersion) {
  return new Map(database.prepare(`SELECT uri,song FROM catalog_entries
    WHERE catalog_version=? ORDER BY uri`).all(catalogVersion)
    .map((entry) => [entry.uri, assertCanonical(entry.song)]));
}

const JOURNEY_OPERATIONS = new Set(GAME_JOURNEY_OPERATIONS);

function stateAtRevision(state, revision) {
  return { ...structuredClone(state), revision };
}

function validateStateChain(database, receipts, game, catalogSongs) {
  let priorState = null;
  let finalLifecycle = null;
  for (const receipt of receipts.toSorted((left, right) => left.revision - right.revision)) {
    const request = assertCanonical(receipt.request);
    const result = assertCanonical(receipt.result);
    if (receipt.revision === 0) {
      if (receipt.operation !== 'create_game') fail('database_corrupt');
      const expected = createInitialGameState({
        gameId: game.game_id, catalogVersion: game.catalog_version, rules: request.rules,
      });
      if (canonicalJson(result.state) !== canonicalJson(expected)) fail('database_corrupt');
      priorState = result.state;
      finalLifecycle = 'lobby';
      continue;
    }
    if (!priorState || priorState.revision !== receipt.revision - 1) fail('database_corrupt');
    let expectedState;
    let expectedEvents = null;
    if (JOURNEY_OPERATIONS.has(receipt.operation)) {
      let reduced;
      try {
        reduced = reduceGameJourneyCommand({
          state: structuredClone(priorState), operation: receipt.operation,
          payload: request.payload,
          actor: { id: receipt.actor_id, type: receipt.actor_type },
          catalogSongs, requestId: receipt.request_id,
        });
      } catch {
        fail('database_corrupt');
      }
      expectedState = stateAtRevision(reduced.state, receipt.revision);
      expectedEvents = reduced.events;
      finalLifecycle = reduced.lifecycle;
    } else if (receipt.operation === 'join_participant') {
      const player = {
        control: 'phone', id: request.payload.participantId,
        name: request.payload.displayName, timeline: [],
      };
      expectedState = stateAtRevision({
        ...priorState,
        players: [...priorState.players, player].sort((left, right) => {
          const order = (candidate) => candidate.control === 'host' ? 0
            : database.prepare(`SELECT join_order FROM participants
              WHERE game_id=? AND participant_id=?`).get(game.game_id, candidate.id)?.join_order;
          return order(left) - order(right);
        }),
      }, receipt.revision);
      finalLifecycle = 'lobby';
    } else if (receipt.operation === 'remove_participant') {
      expectedState = stateAtRevision({
        ...priorState,
        players: priorState.players.filter(({ id }) => id !== request.payload.targetParticipantId),
      }, receipt.revision);
      finalLifecycle = 'lobby';
    } else if (['issue_invitation', 'revoke_invitation'].includes(receipt.operation)) {
      expectedState = stateAtRevision(priorState, receipt.revision);
      finalLifecycle = 'lobby';
    } else if (receipt.operation === 'terminate_game') {
      expectedState = stateAtRevision(priorState, receipt.revision);
      finalLifecycle = 'abandoned';
    } else {
      fail('database_corrupt');
    }
    if (canonicalJson(result.state) !== canonicalJson(expectedState)) fail('database_corrupt');
    if (expectedEvents !== null) {
      const actualPrefix = result.events.slice(0, expectedEvents.length);
      const tail = result.events.slice(expectedEvents.length);
      const permittedCapacityClosure = receipt.operation === 'add_host_player'
        && expectedState.players.length === 8 && tail.length === 1
        && tail[0].type === 'invitation_closed' && tail[0].outcome === 'accepted'
        && exactKeys(tail[0].detail, ['inviteHash']) && SHA256_PATTERN.test(tail[0].detail.inviteHash);
      if (canonicalJson(actualPrefix) !== canonicalJson(expectedEvents)
          || (tail.length !== 0 && !permittedCapacityClosure)) fail('database_corrupt');
    }
    priorState = result.state;
  }
  if (!priorState || canonicalJson(priorState) !== game.state
      || finalLifecycle !== game.lifecycle) fail('database_corrupt');
}

function validateEventsAndReceipts(database, game, catalogSongs) {
  const events = database.prepare(`SELECT sequence,revision,event_type,outcome,actor_type,
    actor_id,request_id,detail,occurred_at FROM game_events WHERE game_id=? ORDER BY sequence`).all(
    game.game_id,
  );
  if (!events.length || events[0].sequence !== 1 || events[0].event_type !== 'game_created') {
    fail('database_corrupt');
  }
  const revisions = new Set();
  let priorTime = 0;
  let priorRevision = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.sequence !== index + 1 || !Number.isSafeInteger(event.revision)
        || event.revision < priorRevision || event.revision > game.revision
        || !EVENT_TYPES.has(event.event_type) || !EVENT_OUTCOMES.has(event.outcome)
        || !['host', 'participant', 'system'].includes(event.actor_type)
        || !UUID_PATTERN.test(event.actor_id) || !UUID_PATTERN.test(event.request_id)
        || !Number.isSafeInteger(event.occurred_at) || event.occurred_at < priorTime) {
      fail('database_corrupt');
    }
    assertCanonical(event.detail);
    priorTime = event.occurred_at;
    priorRevision = event.revision;
    revisions.add(event.revision);
  }
  for (let revision = 0; revision <= game.revision; revision += 1) {
    if (!revisions.has(revision)) fail('database_corrupt');
  }
  if (events.at(-1).revision !== game.revision) fail('database_corrupt');

  const receipts = database.prepare(`SELECT actor_type,actor_id,request_id,operation,request,
    request_hash,result,revision,accepted_at FROM action_receipts
    WHERE game_id=? ORDER BY revision`).all(game.game_id);
  if (receipts.length !== game.revision + 1
      || new Set(receipts.map(({ revision }) => revision)).size !== receipts.length) {
    fail('database_corrupt');
  }
  const receiptKeys = new Set(receipts.map((receipt) => [
    receipt.actor_type, receipt.actor_id, receipt.request_id, receipt.revision, receipt.accepted_at,
  ].join('\0')));
  if (events.some((event) => !receiptKeys.has([
    event.actor_type, event.actor_id, event.request_id, event.revision, event.occurred_at,
  ].join('\0')))) fail('database_corrupt');
  if (receipts[0]?.revision !== 0 || receipts[0].accepted_at !== game.created_at
      || receipts.at(-1)?.revision !== game.revision
      || receipts.at(-1).accepted_at !== game.updated_at) fail('database_corrupt');
  let headMatchesState = false;
  for (const receipt of receipts) {
    if (!['host', 'participant', 'system'].includes(receipt.actor_type)
        || !UUID_PATTERN.test(receipt.actor_id) || !UUID_PATTERN.test(receipt.request_id)
        || (receipt.actor_type === 'host' && receipt.actor_id !== game.host_device_id)
        || typeof receipt.operation !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(receipt.operation)
        || !SHA256_PATTERN.test(receipt.request_hash)
        || !Number.isSafeInteger(receipt.revision) || receipt.revision < 0
        || receipt.revision > game.revision || !Number.isSafeInteger(receipt.accepted_at)
        || receipt.accepted_at <= 0) fail('database_corrupt');
    const request = assertCanonical(receipt.request);
    const result = assertCanonical(receipt.result);
    const requestKeys = Object.keys(request).sort();
    const expectedRequestKeys = receipt.operation === 'create_game'
      ? ['actorId', 'actorType', 'catalogVersion', 'gameId', 'operation', 'requestId', 'rules']
      : ['actorId', 'actorType', 'expectedRevision', 'gameId', 'operation', 'payload', 'requestId'];
    const resultKeys = Object.keys(result).sort();
    const expectedResultKeys = result.code === 'created'
      ? ['code', 'events', 'gameId', 'revision', 'state']
      : result.value === undefined
        ? ['code', 'events', 'gameId', 'revision', 'state']
        : ['code', 'events', 'gameId', 'revision', 'state', 'value'];
    if (sha256(receipt.request) !== receipt.request_hash
        || request.gameId !== game.game_id || request.operation !== receipt.operation
        || request.actorType !== receipt.actor_type || request.actorId !== receipt.actor_id
        || request.requestId !== receipt.request_id
        || requestKeys.join('\0') !== expectedRequestKeys.sort().join('\0')
        || !['created', 'accepted'].includes(result.code)
        || (receipt.operation === 'create_game') !== (result.code === 'created')
        || (receipt.operation === 'create_game'
          ? (receipt.revision !== 0 || request.catalogVersion !== game.catalog_version
            || receipt.actor_type !== 'host' || receipt.actor_id !== game.host_device_id
            || canonicalJson(request.rules) !== canonicalJson(result.state?.rules))
          : receipt.operation === 'join_participant'
            ? request.expectedRevision !== null
            : request.expectedRevision !== receipt.revision - 1)
        || resultKeys.join('\0') !== expectedResultKeys.sort().join('\0')
        || result.gameId !== game.game_id || result.revision !== receipt.revision) {
      fail('database_corrupt');
    }
    if (!result.state || result.state.revision !== receipt.revision) fail('database_corrupt');
    try {
      validateGameState(result.state, {
        gameId: game.game_id, catalogVersion: game.catalog_version,
        revision: receipt.revision, catalogSongs,
      });
    } catch {
      fail('database_corrupt');
    }
    const linkedEvents = events.filter((event) => event.revision === receipt.revision
      && event.actor_type === receipt.actor_type && event.actor_id === receipt.actor_id
      && event.request_id === receipt.request_id && event.occurred_at === receipt.accepted_at);
    if (!linkedEvents.length || !Array.isArray(result.events)
        || result.events.length !== linkedEvents.length
        || canonicalJson(result.events) !== canonicalJson(linkedEvents.map((event) => ({
          detail: assertCanonical(event.detail), outcome: event.outcome, type: event.event_type,
        })))) fail('database_corrupt');
    if (receipt.revision === game.revision && canonicalJson(result.state) === game.state) {
      headMatchesState = true;
    }
  }
  const receiptRevisions = new Set(receipts.map(({ revision }) => revision));
  for (let revision = 0; revision <= game.revision; revision += 1) {
    if (!receiptRevisions.has(revision)) fail('database_corrupt');
  }
  if (!headMatchesState) fail('database_corrupt');
  validateStateChain(database, receipts, game, catalogSongs);
}

function validateTerminalProjection(database, game) {
  const result = database.prepare(`SELECT result_id,final_revision,projection,created_at
    FROM game_results WHERE game_id=?`).get(game.game_id);
  if (game.lifecycle === 'completed') {
    if (!result || !UUID_PATTERN.test(result.result_id) || result.result_id !== game.game_id
        || result.final_revision !== game.revision || result.created_at !== game.terminal_at) {
      fail('database_corrupt');
    }
    const projection = assertCanonical(result.projection);
    const state = assertCanonical(game.state);
    if (canonicalJson(projection) !== canonicalJson(compactGameResult(state))) {
      fail('database_corrupt');
    }
  } else if (result) {
    fail('database_corrupt');
  }
  const terminalType = game.lifecycle === 'completed' ? 'game_completed'
    : game.lifecycle === 'abandoned' ? 'game_abandoned' : null;
  if (terminalType) {
    const event = database.prepare(`SELECT occurred_at FROM game_events
      WHERE game_id=? AND revision=? AND event_type=?`).get(
      game.game_id, game.revision, terminalType,
    );
    if (!event || event.occurred_at !== game.terminal_at) fail('database_corrupt');
  }
}

function validateIdentityColumns(database) {
  const checks = [
    ['host_devices', 'device_id'], ['games', 'game_id'], ['participants', 'participant_id'],
    ['playback_commands', 'command_id'], ['audio_sessions', 'audio_session_id'],
    ['game_results', 'result_id'], ['diagnostic_records', 'record_id'],
  ];
  for (const [table, column] of checks) {
    for (const row of database.prepare(`SELECT ${column} AS id FROM ${table}`).all()) {
      if (!UUID_PATTERN.test(row.id)) fail('database_corrupt');
    }
  }
  const hashChecks = [
    ['host_enrollments', 'enrollment_hash'], ['host_challenges', 'challenge_hash'],
    ['host_sessions', 'session_hash'], ['game_invites', 'invite_hash'],
    ['participant_sessions', 'session_hash'],
  ];
  for (const [table, column] of hashChecks) {
    for (const row of database.prepare(`SELECT ${column} AS hash FROM ${table}`).all()) {
      if (!SHA256_PATTERN.test(row.hash)) fail('database_corrupt');
    }
  }
}

function validateDeferredTablesEmpty(database) {
  const tables = ['audio_sessions', 'diagnostic_records'];
  for (const table of tables) {
    if (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count !== 0) {
      fail('database_corrupt');
    }
  }
}

export function validateReleaseDatabase(database, { currentCatalog }) {
  validateSchema(database);
  try {
    if (database.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
        || database.prepare('PRAGMA foreign_key_check').all().length) fail('database_corrupt');
    const catalogs = validateCatalogRows(database, currentCatalog);
    validateIdentityColumns(database);
    validateHostAuthority(database);
    validateGameAdmission(database);
    validateDeferredTablesEmpty(database);
    const games = database.prepare(`SELECT game_id,host_device_id,catalog_version,lifecycle,state,
      revision,participant_capacity,created_at,updated_at,terminal_at FROM games ORDER BY game_id`).all();
    for (const game of games) {
      if (!UUID_PATTERN.test(game.game_id) || !UUID_PATTERN.test(game.host_device_id)
          || !CATALOG_VERSION_PATTERN.test(game.catalog_version)
          || !['lobby', 'active', 'completed', 'abandoned'].includes(game.lifecycle)
          || !Number.isSafeInteger(game.revision) || game.revision < 0
          || game.participant_capacity !== 8 || !Number.isSafeInteger(game.created_at)
          || !Number.isSafeInteger(game.updated_at) || game.updated_at < game.created_at
          || ((game.lifecycle === 'completed' || game.lifecycle === 'abandoned')
            !== (game.terminal_at !== null))) fail('database_corrupt');
      const state = assertCanonical(game.state);
      try {
        validateGameState(state, {
          gameId: game.game_id, catalogVersion: game.catalog_version,
          revision: game.revision, lifecycle: game.lifecycle,
          requireCanonicalText: game.state, catalogSongs: catalogs.get(game.catalog_version),
        });
      } catch {
        fail('database_corrupt');
      }
      const activeParticipants = database.prepare(`SELECT participant_id,join_order
        FROM participants WHERE game_id=? AND removed_at IS NULL ORDER BY join_order`).all(game.game_id);
      if (activeParticipants.length > game.participant_capacity
          || activeParticipants.some((participant) => participant.join_order < 1
            || participant.join_order > game.participant_capacity
            || !UUID_PATTERN.test(participant.participant_id))
          || new Set(activeParticipants.map(({ join_order: order }) => order)).size
            !== activeParticipants.length) {
        fail('database_corrupt');
      }
      validateEventsAndReceipts(database, game, catalogs.get(game.catalog_version));
      validateTerminalProjection(database, game);
    }
    validatePlaybackCommands(database);
    return Object.freeze({ status: 'valid', games: games.length });
  } catch (error) {
    if (error instanceof ReleaseStoreError) throw error;
    fail('database_corrupt');
  }
}

function registerCatalog(database, catalog, now) {
  const existing = database.prepare(`SELECT artifact_digest,entries_digest,source_version,song_count,manifest
    FROM catalog_releases WHERE catalog_version=?`).get(catalog.version);
  if (existing) {
    if (existing.artifact_digest !== catalog.artifactDigest
        || existing.entries_digest !== catalog.entriesDigest
        || existing.source_version !== catalog.sourceVersion
        || existing.song_count !== catalog.songCount || existing.manifest !== catalog.manifest) {
      fail('database_corrupt');
    }
    return;
  }
  database.prepare(`INSERT INTO catalog_releases
    (catalog_version,artifact_digest,entries_digest,source_version,song_count,manifest,registered_at)
    VALUES (?,?,?,?,?,?,?)`).run(
    catalog.version, catalog.artifactDigest, catalog.entriesDigest, catalog.sourceVersion,
    catalog.songCount, catalog.manifest, now,
  );
  const insertEntry = database.prepare(`INSERT INTO catalog_entries
    (catalog_version,uri,song) VALUES (?,?,?)`);
  for (const song of catalog.songs) {
    insertEntry.run(catalog.version, song.uri, canonicalJson(song));
  }
}

function freeBytes(path, provider) {
  const value = provider(path, { bigint: true });
  const available = value.bavail * value.bsize;
  return typeof available === 'bigint' ? available : BigInt(available);
}

export class ReleaseStore {
  #database;
  #catalog;
  #databasePath;
  #statfs;
  #hostAuthority;
  #gameAdmission;
  #playbackCommands;

  constructor(database, { catalog, databasePath, statfs = statfsSync }) {
    this.#database = database;
    this.#catalog = catalog;
    this.#databasePath = databasePath;
    this.#statfs = statfs;
    this.#hostAuthority = createHostAuthority(database, {
      transaction: (work) => this.#transaction(() => {
        try {
          return work();
        } catch (error) {
          fail(error?.message ?? 'database_unavailable');
        }
      }),
      validate: () => validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog }),
    });
    this.#gameAdmission = createGameAdmission(database, {
      transaction: (work) => this.#transaction(() => {
        try { return work(); } catch (error) { fail(error?.message ?? 'database_unavailable'); }
      }),
      validate: () => validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog }),
      authorizeHost: (input) => this.#hostAuthority.authorizeSession(input),
      retainHost: (input) => this.#hostAuthority.retainedSession(input),
      onGameTerminal: ({ gameId, now }) => cancelOpenPlaybackCommands(
        this.#database, gameId, now, 'game_ended',
      ),
    });
    this.#playbackCommands = createPlaybackCommands(database, {
      transaction: (work) => this.#transaction(() => {
        try { return work(); } catch (error) { fail(error?.message ?? 'database_unavailable'); }
      }),
      validate: () => validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog }),
      authorizeHost: (input) => this.#hostAuthority.authorizeSession(input),
      retainHost: (input) => this.#hostAuthority.retainedSession(input),
    });
  }

  close() {
    const release = ownershipLocks.get(this.#database);
    try {
      this.#database.close();
    } finally {
      ownershipLocks.delete(this.#database);
      release?.();
    }
  }

  #transaction(work) {
    try {
      this.#database.exec('BEGIN IMMEDIATE');
    } catch {
      fail('database_unavailable');
    }
    try {
      const result = work();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#database.isTransaction) this.#database.exec('ROLLBACK');
      if (error instanceof ReleaseStoreError) throw error;
      if (error?.message === 'operation_rejected') fail('operation_rejected');
      fail('database_unavailable');
    }
  }

  #receipt({ gameId, actorType, actorId, requestId }) {
    return this.#database.prepare(`SELECT operation,request_hash,result FROM action_receipts
      WHERE game_id=? AND actor_type=? AND actor_id=? AND request_id=?`).get(
      gameId, actorType, actorId, requestId,
    );
  }

  #replayOrConflict(identity, operation, requestHash) {
    const prior = this.#receipt(identity);
    if (!prior) return null;
    if (prior.operation !== operation || prior.request_hash !== requestHash) fail('request_conflict');
    return assertCanonical(prior.result);
  }

  #authorizedHost(deviceId, game = null) {
    const device = this.#database.prepare(`SELECT revoked_at FROM host_devices WHERE device_id=?`).get(deviceId);
    if (!device || device.revoked_at !== null || (game && game.host_device_id !== deviceId)) {
      fail('unauthorized');
    }
  }

  #hostCall(work) {
    try {
      return work();
    } catch (error) {
      if (error instanceof ReleaseStoreError) throw error;
      const code = error?.message;
      if (['invalid_request', 'unauthorized', 'request_conflict', 'expired', 'already_used',
        'capacity_reached', 'proof_rejected', 'database_unavailable', 'database_corrupt']
        .includes(code)) fail(code);
      fail('invalid_request');
    }
  }

  issueEnrollment(input) {
    return this.#hostCall(() => this.#hostAuthority.issueEnrollment(input));
  }

  redeemEnrollment(input) {
    return this.#hostCall(() => this.#hostAuthority.redeemEnrollment(input));
  }

  issueHostChallenge(input) {
    return this.#hostCall(() => this.#hostAuthority.issueChallenge(input));
  }

  proveHostChallenge(input) {
    return this.#hostCall(() => this.#hostAuthority.proveChallenge(input));
  }

  issueHostWebTicket(input) {
    return this.#hostCall(() => this.#hostAuthority.issueWebTicket(input));
  }

  exchangeHostWebTicket(input) {
    return this.#hostCall(() => this.#hostAuthority.exchangeWebTicket(input));
  }

  revokeHostDevice(input) {
    return this.#hostCall(() => this.#hostAuthority.revokeDevice(input));
  }

  authorizeHostSession(input) {
    return this.#hostCall(() => this.#hostAuthority.authorizeSession(input));
  }

  listHostDevices(input) {
    return this.#hostCall(() => this.#hostAuthority.listDevices(input));
  }

  #admissionCall(work) {
    try { return work(); } catch (error) {
      if (error instanceof ReleaseStoreError) throw error;
      const code = error?.message;
      if (['invalid_request', 'unauthorized', 'request_conflict', 'expired', 'already_used',
        'capacity_reached', 'duplicate_name', 'game_started', 'game_ended', 'stale_state',
        'database_unavailable', 'database_corrupt'].includes(code)) fail(code);
      fail('invalid_request');
    }
  }

  createAuthorizedGame({
    applicationSessionToken, hostSessionToken = applicationSessionToken,
    hostSessionKind = 'application', ...input
  }) {
    const authority = this.#hostAuthority.retainedSession({
      token: hostSessionToken, kind: hostSessionKind,
    });
    return this.createGame({
      ...input, hostDeviceId: authority.deviceId,
      _authorize: () => this.authorizeHostSession({
        token: hostSessionToken, kind: hostSessionKind, now: input.now,
      }),
    });
  }

  issueGameInvitation(input) {
    return this.#admissionCall(() => this.#gameAdmission.issueInvitation(input));
  }

  revokeGameInvitation(input) {
    return this.#admissionCall(() => this.#gameAdmission.revokeInvitation(input));
  }

  admitParticipant(input) {
    return this.#admissionCall(() => this.#gameAdmission.admitParticipant(input));
  }

  removeParticipant(input) {
    return this.#admissionCall(() => this.#gameAdmission.removeParticipant(input));
  }

  terminateGame(input) {
    return this.#admissionCall(() => this.#gameAdmission.terminateGame(input));
  }

  nextPlaybackCommand(input) {
    return this.#playbackCall(() => this.#playbackCommands.next(input));
  }

  transitionPlaybackCommand(input) {
    return this.#playbackCall(() => this.#playbackCommands.transition(input));
  }

  authorizeParticipantSession(input) {
    return this.#admissionCall(() => this.#gameAdmission.authorizeParticipant(input));
  }

  retainedParticipantSession(input) {
    return this.#admissionCall(() => this.#gameAdmission.retainedParticipant(input));
  }

  participantSnapshot(input) {
    return this.#admissionCall(() => this.#gameAdmission.participantSnapshot(input));
  }

  hostGameSnapshot(input) {
    return this.#admissionCall(() => this.#gameAdmission.hostSnapshot(input));
  }

  recoverHostGame(input) {
    return this.#admissionCall(() => this.#gameAdmission.hostRecovery(input));
  }

  #journeyCall(work) {
    try { return work(); } catch (error) {
      if (error instanceof ReleaseStoreError) throw error;
      const code = error?.message;
      if (['invalid_request', 'unauthorized', 'request_conflict', 'capacity_reached',
        'duplicate_name', 'game_ended', 'stale_state', 'operation_rejected',
        'catalog_exhausted', 'database_unavailable', 'database_corrupt']
        .includes(code)) fail(code);
      fail('invalid_request');
    }
  }

  #playbackCall(work) {
    try { return work(); } catch (error) {
      if (error instanceof ReleaseStoreError) throw error;
      const code = error?.message;
      if (['invalid_request', 'unauthorized', 'request_conflict', 'game_ended',
        'command_not_found', 'operation_rejected', 'stale_claim', 'playback_capacity',
        'transition_capacity', 'database_unavailable', 'database_corrupt'].includes(code)) fail(code);
      fail('database_unavailable');
    }
  }

  applyHostGameAction({
    applicationSessionToken, hostSessionToken = applicationSessionToken,
    hostSessionKind = 'application', operation, payload, ...input
  }) {
    return this.#journeyCall(() => {
      const authority = this.#hostAuthority.retainedSession({
        token: hostSessionToken, kind: hostSessionKind,
      });
      const command = normalizeGameJourneyCommand(operation, payload);
      const result = this.mutateGame({
        ...input, actorId: authority.deviceId, actorType: 'host',
        operation: command.operation, payload: command.payload,
        _authorize: () => this.#hostAuthority.authorizeSession({
          token: hostSessionToken, kind: hostSessionKind, now: input.now,
        }),
        reducer: (state, normalizedPayload, context) => reduceGameJourneyCommand({
          state, operation: command.operation, payload: normalizedPayload,
          actor: { id: authority.deviceId, type: 'host' },
          catalogSongs: context.catalogSongs, requestId: input.requestId,
        }),
      });
      return Object.freeze({ ...result, state: projectGameState(result.state, 'host') });
    });
  }

  applyParticipantGameAction({ participantSessionToken, operation, payload, ...input }) {
    return this.#journeyCall(() => {
      const authority = this.#gameAdmission.retainedParticipant({
        token: participantSessionToken, gameId: input.gameId,
      });
      const command = normalizeGameJourneyCommand(operation, payload);
      const result = this.mutateGame({
        ...input, actorId: authority.participantId, actorType: 'participant',
        operation: command.operation, payload: command.payload,
        _authorize: () => this.#gameAdmission.authorizeParticipant({
          token: participantSessionToken, gameId: input.gameId, now: input.now,
        }),
        reducer: (state, normalizedPayload, context) => reduceGameJourneyCommand({
          state, operation: command.operation, payload: normalizedPayload,
          actor: { id: authority.participantId, type: 'participant' },
          catalogSongs: context.catalogSongs, requestId: input.requestId,
        }),
      });
      return Object.freeze({
        code: result.code, gameId: result.gameId, revision: result.revision,
        state: projectGameState(result.state, 'participant'),
      });
    });
  }

  createGame({ gameId, requestId, hostDeviceId, catalogVersion, rules, now, _authorize = null }) {
    requestValue(() => {
      assertUuid(gameId, 'invalid_request');
      assertUuid(requestId, 'invalid_request');
      assertUuid(hostDeviceId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      if (!CATALOG_VERSION_PATTERN.test(catalogVersion)) fail('invalid_request');
    });
    const operation = 'create_game';
    const normalizedRules = normalizeRules(rules);
    const request = requestValue(() => canonicalJson({
      actorId: hostDeviceId, actorType: 'host', catalogVersion,
      gameId, operation, requestId, rules: normalizedRules,
    }));
    const requestHash = sha256(request);
    const identity = { gameId, actorType: 'host', actorId: hostDeviceId, requestId };
    return this.#transaction(() => {
      const decision = this.#database.prepare(`SELECT request_hash,result
        FROM game_create_decisions WHERE host_device_id=? AND requested_game_id=? AND request_id=?`)
        .get(hostDeviceId, gameId, requestId);
      if (decision && decision.request_hash !== requestHash) fail('request_conflict');
      const replay = this.#replayOrConflict(identity, operation, requestHash);
      validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog });
      if (decision) return Object.freeze(assertCanonical(decision.result));
      if (replay) return replay;
      _authorize?.();
      if (catalogVersion !== this.#catalog.version) fail('catalog_incompatible');
      this.#authorizedHost(hostDeviceId);
      const existingId = this.#database.prepare('SELECT game_id FROM games WHERE game_id=?').get(gameId);
      if (existingId) fail('request_conflict');
      const active = this.#database.prepare(`SELECT game_id FROM games
        WHERE lifecycle IN ('lobby','active')`).get();
      if (active) {
        const result = { code: 'active_game_exists', gameId: active.game_id };
        this.#database.prepare(`INSERT INTO game_create_decisions
          (host_device_id,requested_game_id,request_id,target_game_id,request,request_hash,result,accepted_at)
          VALUES (?,?,?,?,?,?,?,?)`).run(
          hostDeviceId, gameId, requestId, active.game_id, request, requestHash,
          canonicalJson(result), now,
        );
        validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog });
        return Object.freeze(result);
      }
      const state = createInitialGameState({
        gameId, catalogVersion, rules: normalizedRules,
      });
      const stateText = canonicalJson(state);
      const events = [{
        detail: { catalogVersion },
        outcome: 'accepted',
        type: 'game_created',
      }];
      const result = { code: 'created', events, gameId, revision: 0, state };
      const resultText = canonicalJson(result);
      this.#database.prepare(`INSERT INTO games
        (game_id,host_device_id,catalog_version,lifecycle,state,revision,created_at,updated_at)
        VALUES (?,?,?,'lobby',?,0,?,?)`).run(
        gameId, hostDeviceId, catalogVersion, stateText, now, now,
      );
      this.#database.prepare(`INSERT INTO action_receipts
        (game_id,actor_type,actor_id,request_id,operation,request,request_hash,result,revision,accepted_at)
        VALUES (?,'host',?,?,?,?,?,?,0,?)`).run(
        gameId, hostDeviceId, requestId, operation, request, requestHash, resultText, now,
      );
      this.#database.prepare(`INSERT INTO game_events
        (game_id,sequence,revision,event_type,outcome,actor_type,actor_id,request_id,detail,occurred_at)
        VALUES (?,1,0,'game_created','accepted','host',?,?,?,?)`).run(
        gameId, hostDeviceId, requestId,
        canonicalJson(events[0].detail), now,
      );
      validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog });
      return Object.freeze(result);
    });
  }

  mutateGame({
    gameId, actorType, actorId, requestId, operation, payload = {}, expectedRevision, now, reducer,
    _authorize = null,
  }) {
    requestValue(() => {
      assertUuid(gameId, 'invalid_request');
      assertUuid(actorId, 'invalid_request');
      assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
    });
    if (!['host', 'participant', 'system'].includes(actorType)
        || !/^[a-z][a-z0-9_]{0,63}$/u.test(operation)
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
        || typeof reducer !== 'function') fail('invalid_request');
    if (!JOURNEY_OPERATIONS.has(operation)) fail('operation_rejected');
    const request = requestValue(() => canonicalJson({
      actorId, actorType, expectedRevision, gameId, operation, payload, requestId,
    }));
    const requestHash = sha256(request);
    const identity = { gameId, actorType, actorId, requestId };
    return this.#transaction(() => {
      const replay = this.#replayOrConflict(identity, operation, requestHash);
      if (replay) return replay;
      validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog });
      const game = this.#database.prepare(`SELECT game_id,host_device_id,catalog_version,
        lifecycle,state,revision FROM games WHERE game_id=?`).get(gameId);
      if (!game) fail('game_not_found');
      try { _authorize?.(); } catch (error) {
        if (['unauthorized', 'expired', 'database_corrupt'].includes(error?.message)) {
          fail(error.message === 'expired' ? 'unauthorized' : error.message);
        }
        fail('database_unavailable');
      }
      if (actorType === 'host') this.#authorizedHost(actorId, game);
      if (actorType === 'participant') {
        const participant = this.#database.prepare(`SELECT removed_at FROM participants
          WHERE game_id=? AND participant_id=?`).get(gameId, actorId);
        if (!participant || participant.removed_at !== null) fail('unauthorized');
      }
      if (['completed', 'abandoned'].includes(game.lifecycle)) fail('game_ended');
      if (game.revision !== expectedRevision) fail('stale_state');
      let reduced;
      try {
        reduced = reducer(
          structuredClone(assertCanonical(game.state)), structuredClone(payload),
          { catalogSongs: storedCatalogSongs(this.#database, game.catalog_version) },
        );
      } catch (error) {
        if (['invalid_request', 'unauthorized', 'request_conflict', 'capacity_reached',
          'duplicate_name', 'catalog_exhausted'].includes(error?.message)) fail(error.message);
        fail('operation_rejected');
      }
      if (!reduced || typeof reduced !== 'object' || Array.isArray(reduced)
          || !Array.isArray(reduced.events) || reduced.events.length === 0) {
        fail('operation_rejected');
      }
      const revision = game.revision + 1;
      const lifecycle = reduced.lifecycle ?? game.lifecycle;
      if (!['lobby', 'active', 'completed', 'abandoned'].includes(lifecycle)) {
        fail('operation_rejected');
      }
      const nextState = { ...reduced.state, revision };
      try {
        validateGameState(nextState, {
          gameId, catalogVersion: game.catalog_version, revision, lifecycle,
          catalogSongs: storedCatalogSongs(this.#database, game.catalog_version),
        });
      } catch {
        fail('operation_rejected');
      }
      const terminalAt = ['completed', 'abandoned'].includes(lifecycle) ? now : null;
      const events = reduced.events.map((event) => {
        if (!event || !EVENT_TYPES.has(event.type) || !EVENT_OUTCOMES.has(event.outcome)) {
          fail('operation_rejected');
        }
        let detail;
        try {
          detail = JSON.parse(canonicalJson(event.detail ?? {}));
        } catch {
          fail('operation_rejected');
        }
        return {
          detail,
          outcome: event.outcome,
          type: event.type,
        };
      });
      const result = {
        code: 'accepted', events, gameId, revision, state: nextState,
        ...(reduced.value === undefined ? {} : { value: reduced.value }),
      };
      let resultText;
      try {
        resultText = canonicalJson(result);
      } catch {
        fail('operation_rejected');
      }
      const updated = this.#database.prepare(`UPDATE games SET lifecycle=?,state=?,revision=?,
        updated_at=?,terminal_at=? WHERE game_id=? AND revision=?`).run(
        lifecycle, canonicalJson(nextState), revision, now, terminalAt,
        gameId, game.revision,
      );
      if (updated.changes !== 1) fail('stale_state');
      if (game.lifecycle === 'lobby' && lifecycle !== 'lobby') {
        this.#database.prepare(`UPDATE game_invites SET closed_at=?,close_reason=?
          WHERE game_id=? AND closed_at IS NULL`).run(
          now, lifecycle === 'active' ? 'started' : 'revoked', gameId,
        );
      }
      if (operation === 'add_host_player' && nextState.players.length === 8) {
        const openInvite = this.#database.prepare(`SELECT invite_hash FROM game_invites
          WHERE game_id=? AND closed_at IS NULL`).get(gameId);
        if (openInvite) {
          this.#database.prepare(`UPDATE game_invites SET closed_at=?,close_reason='capacity'
            WHERE invite_hash=?`).run(now, openInvite.invite_hash);
          events.push({
            detail: { inviteHash: openInvite.invite_hash }, outcome: 'accepted',
            type: 'invitation_closed',
          });
          result.events = events;
          resultText = canonicalJson(result);
        }
      }
      if (lifecycle === 'completed') {
        this.#database.prepare(`INSERT INTO game_results
          (result_id,game_id,final_revision,projection,created_at) VALUES (?,?,?,?,?)`).run(
          gameId, gameId, revision, canonicalJson(compactGameResult(nextState)), now,
        );
      }
      this.#database.prepare(`INSERT INTO action_receipts
        (game_id,actor_type,actor_id,request_id,operation,request,request_hash,result,revision,accepted_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        gameId, actorType, actorId, requestId, operation, request,
        requestHash, resultText, revision, now,
      );
      let sequence = this.#database.prepare(`SELECT COALESCE(MAX(sequence),0) AS sequence
        FROM game_events WHERE game_id=?`).get(gameId).sequence;
      for (const event of events) {
        sequence += 1;
        this.#database.prepare(`INSERT INTO game_events
          (game_id,sequence,revision,event_type,outcome,actor_type,actor_id,request_id,detail,occurred_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          gameId, sequence, revision, event.type, event.outcome,
          actorType, actorId, requestId, canonicalJson(event.detail ?? {}), now,
        );
      }
      const trackEvents = events.filter(({ type }) => type === 'track_requested');
      if (trackEvents.length > 1) fail('operation_rejected');
      if (trackEvents.length === 1) {
        appendTrackPlaybackCommand(this.#database, {
          gameId, requestId, trackUri: trackEvents[0].detail.trackUri, now,
        });
      } else if (lifecycle === 'completed') {
        cancelOpenPlaybackCommands(this.#database, gameId, now, 'game_ended');
      }
      validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog });
      return Object.freeze(result);
    });
  }

  gameSnapshot(gameId) {
    requestValue(() => assertUuid(gameId, 'invalid_request'));
    validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog });
    const game = this.#database.prepare(`SELECT lifecycle,state,revision FROM games WHERE game_id=?`).get(gameId);
    if (!game) fail('game_not_found');
    return Object.freeze({
      gameId, lifecycle: game.lifecycle, revision: game.revision,
      state: assertCanonical(game.state),
    });
  }

  readiness({ minimumFreeBytes = MINIMUM_DATABASE_FREE_BYTES } = {}) {
    try {
      validateReleaseDatabase(this.#database, { currentCatalog: this.#catalog });
      if (freeBytes(dirname(this.#databasePath), this.#statfs) < BigInt(minimumFreeBytes)) {
        return Object.freeze({ ready: false, reason: 'database_capacity' });
      }
      return Object.freeze({
        ready: true, reason: 'ready', schemaGeneration: RELEASE_SCHEMA_GENERATION,
        catalogVersion: this.#catalog.version,
      });
    } catch (error) {
      const reason = error instanceof ReleaseStoreError ? error.code : 'database_unavailable';
      return Object.freeze({ ready: false, reason });
    }
  }
}

export function createReleaseStore(path, {
  catalog, now = Date.now(), lockDirectory = resolve(
    dirname(resolve(/* turbopackIgnore: true */ path)), '.owner-locks',
  ),
  statfs = statfsSync,
} = {}) {
  if (!catalog || !CATALOG_VERSION_PATTERN.test(catalog.version)) fail('catalog_incompatible');
  const databasePath = resolve(/* turbopackIgnore: true */ path);
  const releaseOwnership = acquireOwnership(
    databasePath, resolve(/* turbopackIgnore: true */ lockDirectory),
  );
  let database;
  try {
    database = new DatabaseSync(databasePath);
    releaseOwnership.ensureInode?.();
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    const objectCount = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'`).get().count;
    const hasLedger = database.prepare(`SELECT 1 FROM sqlite_schema
      WHERE type='table' AND name='schema_generations'`).get();
    if (!hasLedger && objectCount !== 0) fail('database_incompatible');
    database.exec('PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; BEGIN IMMEDIATE');
    if (!hasLedger) {
      database.exec(RELEASE_SCHEMA_SQL);
      database.prepare(`INSERT INTO schema_generations
        (generation,contract_digest,applied_at) VALUES (?,?,?)`).run(
        RELEASE_SCHEMA_GENERATION, RELEASE_SCHEMA_DIGEST, now,
      );
    }
    validateSchema(database);
    registerCatalog(database, catalog, now);
    validateReleaseDatabase(database, { currentCatalog: catalog });
    database.exec('COMMIT');
    ownershipLocks.set(database, releaseOwnership);
    return new ReleaseStore(database, { catalog, databasePath, statfs });
  } catch (error) {
    if (database?.isTransaction) database.exec('ROLLBACK');
    database?.close();
    releaseOwnership();
    if (error instanceof ReleaseStoreError) throw error;
    fail('database_unavailable');
  }
}
