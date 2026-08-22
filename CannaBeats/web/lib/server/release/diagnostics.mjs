import { UUID_PATTERN, assertTimestamp, assertUuid } from './canonical.mjs';

export const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_DIAGNOSTICS_PER_GAME = 256;
export const MAX_EXPORTED_GAME_EVENTS = 4_096;
export const MAX_EXPORTED_PLAYBACK_TRANSITIONS = 4_096;
export const MAX_EXPORTED_AUDIO_TRANSITIONS = 8_192;

const CODES_BY_KIND = Object.freeze({
  host: new Set(['readiness_blocked', 'export_created']),
  game: new Set(['playback_failed', 'playback_outcome_unknown']),
  audio: new Set(['audio_interrupted', 'audio_recovered', 'buffer_dropped']),
});

function reject(code) { throw new Error(code); }

function exactDiagnostic({ kind, code, metricValue }) {
  if (!Object.hasOwn(CODES_BY_KIND, kind) || !CODES_BY_KIND[kind].has(code)
      || !Number.isSafeInteger(metricValue) || metricValue < 0 || metricValue > 1_000_000_000) {
    reject('invalid_request');
  }
  return { kind, code, metricValue };
}

function projection(row) {
  return Object.freeze({
    recordId: row.record_id,
    gameId: row.game_id,
    kind: row.kind,
    code: row.code,
    metricValue: row.metric_value,
    occurredAt: row.occurred_at,
    expiresAt: row.expires_at,
  });
}

function gameForHost(database, gameId, deviceId) {
  const game = database.prepare(`SELECT game_id,host_device_id,lifecycle,revision
    FROM games WHERE game_id=?`).get(gameId);
  if (!game || game.host_device_id !== deviceId) reject('unauthorized');
  return game;
}

function boundedRows(database, sql, gameId, maximum) {
  const rows = database.prepare(sql).all(gameId);
  if (rows.length > maximum) reject('diagnostic_capacity');
  return rows;
}

export function purgeExpiredDiagnostics(database, now) {
  assertTimestamp(now, 'invalid_request');
  return database.prepare(`DELETE FROM diagnostic_records WHERE expires_at<=?`).run(now).changes;
}

export function createDiagnostics(database, {
  transaction, validate, authorizeHost, retainHost,
}) {
  return Object.freeze({
    purge({ now }) {
      assertTimestamp(now, 'invalid_request');
      return transaction(() => {
        validate();
        database.prepare('DELETE FROM diagnostic_records').run();
        validate();
        return Object.freeze({ code: 'diagnostics_purged' });
      });
    },

    record({ applicationSessionToken, gameId, recordId, kind, code, metricValue, now }) {
      assertUuid(gameId, 'invalid_request');
      assertUuid(recordId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      if (now > Number.MAX_SAFE_INTEGER - DIAGNOSTIC_RETENTION_MS) reject('invalid_request');
      const finite = exactDiagnostic({ kind, code, metricValue });
      const retained = retainHost({ token: applicationSessionToken, kind: 'application' });
      return transaction(() => {
        const prior = database.prepare(`SELECT record_id,game_id,kind,code,metric_value,
          occurred_at,expires_at FROM diagnostic_records WHERE record_id=?`).get(recordId);
        if (prior && prior.expires_at > now) {
          if (prior.game_id !== gameId || prior.kind !== finite.kind
              || prior.code !== finite.code || prior.metric_value !== finite.metricValue) {
            reject('request_conflict');
          }
          gameForHost(database, gameId, retained.deviceId);
          validate();
          return Object.freeze({ code: 'diagnostic_recorded', record: projection(prior) });
        }
        authorizeHost({ token: applicationSessionToken, kind: 'application', now });
        gameForHost(database, gameId, retained.deviceId);
        purgeExpiredDiagnostics(database, now);
        const count = database.prepare(`SELECT COUNT(*) AS count FROM diagnostic_records
          WHERE game_id=?`).get(gameId).count;
        if (count >= MAX_DIAGNOSTICS_PER_GAME) reject('diagnostic_capacity');
        database.prepare(`INSERT INTO diagnostic_records
          (record_id,game_id,kind,code,metric_value,occurred_at,expires_at)
          VALUES (?,?,?,?,?,?,?)`).run(
          recordId, gameId, finite.kind, finite.code, finite.metricValue,
          now, now + DIAGNOSTIC_RETENTION_MS,
        );
        validate();
        return Object.freeze({ code: 'diagnostic_recorded', record: projection(
          database.prepare(`SELECT record_id,game_id,kind,code,metric_value,
            occurred_at,expires_at FROM diagnostic_records WHERE record_id=?`).get(recordId),
        ) });
      });
    },

    exportDiagnostics({ applicationSessionToken, gameId, now }) {
      assertUuid(gameId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      const host = authorizeHost({ token: applicationSessionToken, kind: 'application', now });
      validate();
      const game = gameForHost(database, gameId, host.deviceId);
      const gameEvents = boundedRows(database, `SELECT sequence,revision,event_type AS type,
        outcome,occurred_at AS occurredAt FROM game_events WHERE game_id=? ORDER BY sequence`,
      gameId, MAX_EXPORTED_GAME_EVENTS);
      const playback = boundedRows(database, `SELECT
        DENSE_RANK() OVER (ORDER BY command.created_at,command.command_id) AS commandOrdinal,
        transition.sequence,transition.to_state AS state,
        transition.reason_code AS reasonCode,transition.occurred_at AS occurredAt
        FROM playback_commands command JOIN playback_command_transitions transition
          ON transition.command_id=command.command_id
        WHERE command.game_id=? ORDER BY commandOrdinal,transition.sequence`,
      gameId, MAX_EXPORTED_PLAYBACK_TRANSITIONS);
      const audio = boundedRows(database, `SELECT session.generation,
        transition.sequence,transition.to_state AS state,
        transition.reason_code AS reasonCode,transition.occurred_at AS occurredAt
        FROM audio_sessions session JOIN audio_session_transitions transition
          ON transition.audio_session_id=session.audio_session_id
        WHERE session.game_id=? ORDER BY session.generation,transition.sequence`,
      gameId, MAX_EXPORTED_AUDIO_TRANSITIONS);
      const diagnostics = database.prepare(`SELECT kind,code,metric_value AS metricValue,
        occurred_at AS occurredAt,expires_at AS expiresAt FROM diagnostic_records
        WHERE game_id=? AND expires_at>? ORDER BY occurred_at,record_id`).all(gameId, now);
      if (diagnostics.length > MAX_DIAGNOSTICS_PER_GAME) reject('diagnostic_capacity');
      return Object.freeze({
        code: 'diagnostic_export',
        generatedAt: now,
        game: Object.freeze({ lifecycle: game.lifecycle, revision: game.revision }),
        gameEvents: Object.freeze(gameEvents.map((row) => Object.freeze({ ...row }))),
        playback: Object.freeze(playback.map((row) => Object.freeze({ ...row }))),
        audio: Object.freeze(audio.map((row) => Object.freeze({ ...row }))),
        diagnostics: Object.freeze(diagnostics.map((row) => Object.freeze({ ...row }))),
      });
    },
  });
}

export function validateDiagnostics(database) {
  const rows = database.prepare(`SELECT record_id,game_id,kind,code,metric_value,
    occurred_at,expires_at FROM diagnostic_records ORDER BY game_id,occurred_at,record_id`).all();
  const counts = new Map();
  for (const row of rows) {
    if (!UUID_PATTERN.test(row.record_id) || !UUID_PATTERN.test(row.game_id)) {
      reject('database_corrupt');
    }
    try { exactDiagnostic({
      kind: row.kind, code: row.code, metricValue: row.metric_value,
    }); } catch { reject('database_corrupt'); }
    if (!Number.isSafeInteger(row.occurred_at) || row.occurred_at <= 0
        || !Number.isSafeInteger(row.expires_at)
        || row.expires_at !== row.occurred_at + DIAGNOSTIC_RETENTION_MS) {
      reject('database_corrupt');
    }
    counts.set(row.game_id, (counts.get(row.game_id) ?? 0) + 1);
    if (counts.get(row.game_id) > MAX_DIAGNOSTICS_PER_GAME) reject('database_corrupt');
  }
  return Object.freeze({ records: rows.length });
}
