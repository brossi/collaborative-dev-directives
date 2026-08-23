import { UUID_PATTERN, assertTimestamp, assertUuid } from './canonical.mjs';

export const MAX_AUDIO_SESSIONS_PER_GAME = 512;
export const MAX_AUDIO_TRANSITIONS_PER_SESSION = 16;
export const AUDIO_AUTHORITY_RECHECK_MS = 5_000;

const OPEN_STATES = new Set(['starting', 'connecting', 'active', 'interrupted']);
const INTERRUPTION_REASONS = new Set([
  'relay_unavailable', 'ingest_lost', 'malformed_relay', 'process_restart',
]);
const END_REASONS = new Set([
  'host_stopped', 'host_revoked', 'game_ended', 'recovery_exhausted',
]);

function reject(code) { throw new Error(code); }

function projection(row) {
  return Object.freeze({
    audioSessionId: row.audio_session_id,
    connectionId: row.connection_id,
    gameId: row.game_id,
    generation: row.generation,
    state: row.state,
    updatedAt: row.updated_at,
  });
}

function initialProjection(row) {
  return Object.freeze({
    audioSessionId: row.audio_session_id,
    connectionId: null,
    gameId: row.game_id,
    generation: row.generation,
    state: 'starting',
    updatedAt: row.created_at,
  });
}

function row(database, audioSessionId, gameId = null) {
  return database.prepare(`SELECT audio_session_id,game_id,request_id,generation,state,
    connection_id,created_at,updated_at,ended_at FROM audio_sessions
    WHERE audio_session_id=? AND (? IS NULL OR game_id=?)`).get(
    audioSessionId, gameId, gameId,
  );
}

function transitionCount(database, audioSessionId) {
  return database.prepare(`SELECT COUNT(*) AS count FROM audio_session_transitions
    WHERE audio_session_id=?`).get(audioSessionId).count;
}

function appendTransition(database, session, {
  toState, connectionId = null, requestId = null, reasonCode, now,
}) {
  const sequence = transitionCount(database, session.audio_session_id) + 1;
  if (sequence > MAX_AUDIO_TRANSITIONS_PER_SESSION) reject('transition_capacity');
  database.prepare(`INSERT INTO audio_session_transitions
    (audio_session_id,sequence,from_state,to_state,connection_id,request_id,reason_code,occurred_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    session.audio_session_id, sequence, session.state, toState,
    connectionId, requestId, reasonCode, now,
  );
  const headConnection = ['connecting', 'active'].includes(toState) ? connectionId : null;
  const endedAt = toState === 'ended' ? now : null;
  const updated = database.prepare(`UPDATE audio_sessions
    SET state=?,connection_id=?,updated_at=?,ended_at=?
    WHERE audio_session_id=? AND state=? AND connection_id IS ?`).run(
    toState, headConnection, now, endedAt, session.audio_session_id,
    session.state, session.connection_id,
  );
  if (updated.changes !== 1) reject('stale_generation');
  return row(database, session.audio_session_id);
}

function terminalTransition(database, session, { now, reasonCode, requestId = null }) {
  if (!END_REASONS.has(reasonCode)) reject('invalid_request');
  return appendTransition(database, session, {
    toState: 'ended', connectionId: session.connection_id,
    requestId, reasonCode, now,
  });
}

export function endOpenAudioSession(database, gameId, now, reasonCode = 'game_ended') {
  assertUuid(gameId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
  const session = database.prepare(`SELECT audio_session_id,game_id,request_id,generation,state,
    connection_id,created_at,updated_at,ended_at FROM audio_sessions
    WHERE game_id=? AND state<>'ended'`).get(gameId);
  if (!session) return 0;
  terminalTransition(database, session, { now, reasonCode });
  return 1;
}

export function interruptAudioSessionsOnStartup(database, now) {
  assertTimestamp(now, 'invalid_request');
  const sessions = database.prepare(`SELECT audio_session_id,game_id,request_id,generation,state,
    connection_id,created_at,updated_at,ended_at FROM audio_sessions
    WHERE state IN ('starting','connecting','active') ORDER BY game_id,generation`).all();
  for (const session of sessions) {
    if (transitionCount(database, session.audio_session_id)
        >= MAX_AUDIO_TRANSITIONS_PER_SESSION - 1) {
      terminalTransition(database, session, { now, reasonCode: 'recovery_exhausted' });
    } else {
      appendTransition(database, session, {
        toState: 'interrupted', connectionId: session.connection_id,
        reasonCode: 'process_restart', now,
      });
    }
  }
  return sessions.length;
}

export function createAudioSessions(database, {
  transaction, validate, authorizeHost, retainHost, recheckParticipant,
}) {
  function retainedHost(token) {
    return retainHost({ token, kind: 'application' });
  }
  function gameForHost(gameId, deviceId) {
    const game = database.prepare(`SELECT game_id,host_device_id,lifecycle FROM games
      WHERE game_id=?`).get(gameId);
    if (!game || game.host_device_id !== deviceId) reject('unauthorized');
    return game;
  }
  function current(gameId) {
    return database.prepare(`SELECT audio_session_id,game_id,request_id,generation,state,
      connection_id,created_at,updated_at,ended_at FROM audio_sessions
      WHERE game_id=? AND state<>'ended'`).get(gameId);
  }
  function authorizeHostStream(input, validateDatabase) {
    const {
      applicationSessionToken, gameId, audioSessionId, connectionId = null,
      requireActive = false, now,
    } = input;
    assertUuid(gameId, 'invalid_request'); assertUuid(audioSessionId, 'invalid_request');
    if (connectionId !== null) assertUuid(connectionId, 'invalid_request');
    assertTimestamp(now, 'invalid_request');
    const host = authorizeHost({ token: applicationSessionToken, kind: 'application', now });
    if (validateDatabase) validate();
    const game = gameForHost(gameId, host.deviceId);
    const session = row(database, audioSessionId, gameId);
    if (game.lifecycle !== 'active' || !session || session.state === 'ended'
        || (requireActive && session.state !== 'active')
        || (connectionId !== null && (session.connection_id !== connectionId
          || !['connecting', 'active'].includes(session.state)))) reject('unauthorized');
    return projection(session);
  }
  function authorizeParticipantStream(input, validateDatabase) {
    const { participantSessionToken, gameId, audioSessionId, now } = input;
    assertUuid(gameId, 'invalid_request'); assertUuid(audioSessionId, 'invalid_request');
    assertTimestamp(now, 'invalid_request');
    const participantAuthority = {
      token: participantSessionToken, gameId, now,
    };
    recheckParticipant(participantAuthority);
    if (validateDatabase) validate();
    const session = row(database, audioSessionId, gameId);
    if (!session || session.state !== 'active') reject('unauthorized');
    return projection(session);
  }
  return Object.freeze({
    open({ applicationSessionToken, gameId, audioSessionId, requestId, now }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(audioSessionId, 'invalid_request');
      assertUuid(requestId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const retained = retainedHost(applicationSessionToken);
      return transaction(() => {
        const priorRequest = database.prepare(`SELECT audio_session_id,game_id,request_id,generation,
          state,connection_id,created_at,updated_at,ended_at FROM audio_sessions
          WHERE game_id=? AND request_id=?`).get(gameId, requestId);
        if (priorRequest) {
          if (priorRequest.audio_session_id !== audioSessionId) reject('request_conflict');
          gameForHost(gameId, retained.deviceId);
          validate();
          return Object.freeze({ code: 'audio_session', session: initialProjection(priorRequest) });
        }
        if (row(database, audioSessionId)) reject('request_conflict');
        authorizeHost({ token: applicationSessionToken, kind: 'application', now });
        const game = gameForHost(gameId, retained.deviceId);
        if (game.lifecycle !== 'active') reject('game_inactive');
        if (current(gameId)) reject('audio_session_open');
        const count = database.prepare(`SELECT COUNT(*) AS count FROM audio_sessions
          WHERE game_id=?`).get(gameId).count;
        if (count >= MAX_AUDIO_SESSIONS_PER_GAME) reject('audio_capacity');
        const generation = database.prepare(`SELECT COALESCE(MAX(generation),0)+1 AS generation
          FROM audio_sessions WHERE game_id=?`).get(gameId).generation;
        database.prepare(`INSERT INTO audio_sessions
          (audio_session_id,game_id,request_id,generation,state,created_at,updated_at)
          VALUES (?,?,?,?,'starting',?,?)`).run(
          audioSessionId, gameId, requestId, generation, now, now,
        );
        database.prepare(`INSERT INTO audio_session_transitions
          (audio_session_id,sequence,from_state,to_state,request_id,occurred_at)
          VALUES (?,1,NULL,'starting',?,?)`).run(audioSessionId, requestId, now);
        validate();
        return Object.freeze({ code: 'audio_session', session: projection(
          row(database, audioSessionId),
        ) });
      });
    },

    current({ applicationSessionToken, gameId, now }) {
      assertUuid(gameId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const host = authorizeHost({ token: applicationSessionToken, kind: 'application', now });
      validate();
      gameForHost(gameId, host.deviceId);
      const session = current(gameId);
      return Object.freeze(session
        ? { code: 'audio_session', session: projection(session) }
        : { code: 'idle' });
    },

    claimIngest({ applicationSessionToken, gameId, audioSessionId, connectionId, now }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(audioSessionId, 'invalid_request');
      assertUuid(connectionId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const retained = retainedHost(applicationSessionToken);
      return transaction(() => {
        authorizeHost({ token: applicationSessionToken, kind: 'application', now });
        const game = gameForHost(gameId, retained.deviceId);
        if (game.lifecycle !== 'active') reject('game_inactive');
        const session = row(database, audioSessionId, gameId);
        if (!session || session.state === 'ended') reject('audio_session_not_found');
        if (session.state === 'connecting' && session.connection_id === connectionId) {
          validate();
          return Object.freeze({ code: 'connecting', session: projection(session) });
        }
        if (!['starting', 'interrupted'].includes(session.state)) reject('audio_busy');
        if (transitionCount(database, audioSessionId)
            >= MAX_AUDIO_TRANSITIONS_PER_SESSION - 1) reject('transition_capacity');
        const next = appendTransition(database, session, {
          toState: 'connecting', connectionId, reasonCode: 'connect_requested', now,
        });
        validate();
        return Object.freeze({ code: 'connecting', session: projection(next) });
      });
    },

    activateIngest({ applicationSessionToken, gameId, audioSessionId, connectionId, now }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(audioSessionId, 'invalid_request');
      assertUuid(connectionId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const retained = retainedHost(applicationSessionToken);
      return transaction(() => {
        const session = row(database, audioSessionId, gameId);
        if (!session) reject('audio_session_not_found');
        if (session.state === 'active' && session.connection_id === connectionId) {
          gameForHost(gameId, retained.deviceId);
          validate();
          return Object.freeze({ code: 'active', session: projection(session) });
        }
        authorizeHost({ token: applicationSessionToken, kind: 'application', now });
        const game = gameForHost(gameId, retained.deviceId);
        if (game.lifecycle !== 'active') reject('game_inactive');
        if (session.state !== 'connecting' || session.connection_id !== connectionId) {
          reject('stale_generation');
        }
        const next = appendTransition(database, session, {
          toState: 'active', connectionId, reasonCode: 'relay_connected', now,
        });
        validate();
        return Object.freeze({ code: 'active', session: projection(next) });
      });
    },

    interruptIngest({ gameId, audioSessionId, connectionId, reasonCode, now }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(audioSessionId, 'invalid_request');
      assertUuid(connectionId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      if (!INTERRUPTION_REASONS.has(reasonCode) || reasonCode === 'process_restart') {
        reject('invalid_request');
      }
      return transaction(() => {
        const session = row(database, audioSessionId, gameId);
        if (!session || session.state === 'ended') return Object.freeze({ code: 'stale' });
        if (session.state === 'interrupted') {
          const last = database.prepare(`SELECT connection_id,reason_code
            FROM audio_session_transitions WHERE audio_session_id=?
            ORDER BY sequence DESC LIMIT 1`).get(audioSessionId);
          return Object.freeze(last?.connection_id === connectionId
              && last.reason_code === reasonCode
            ? { code: 'interrupted', session: projection(session) }
            : { code: 'stale' });
        }
        if (!['connecting', 'active'].includes(session.state)
            || session.connection_id !== connectionId) return Object.freeze({ code: 'stale' });
        if (transitionCount(database, audioSessionId)
            >= MAX_AUDIO_TRANSITIONS_PER_SESSION - 1) {
          const ended = terminalTransition(database, session, {
            now, reasonCode: 'recovery_exhausted',
          });
          validate();
          return Object.freeze({ code: 'ended', session: projection(ended) });
        }
        const next = appendTransition(database, session, {
          toState: 'interrupted', connectionId, reasonCode, now,
        });
        validate();
        return Object.freeze({ code: 'interrupted', session: projection(next) });
      });
    },

    end({ applicationSessionToken, gameId, audioSessionId, requestId, now }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(audioSessionId, 'invalid_request');
      assertUuid(requestId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const retained = retainedHost(applicationSessionToken);
      return transaction(() => {
        const session = row(database, audioSessionId, gameId);
        if (!session) reject('audio_session_not_found');
        const prior = database.prepare(`SELECT reason_code FROM audio_session_transitions
          WHERE audio_session_id=? AND request_id=?`).get(audioSessionId, requestId);
        if (prior) {
          if (prior.reason_code !== 'host_stopped') reject('request_conflict');
          gameForHost(gameId, retained.deviceId);
          validate();
          return Object.freeze({ code: 'ended', session: projection(session) });
        }
        authorizeHost({ token: applicationSessionToken, kind: 'application', now });
        gameForHost(gameId, retained.deviceId);
        if (session.state === 'ended') reject('operation_rejected');
        const next = terminalTransition(database, session, {
          now, reasonCode: 'host_stopped', requestId,
        });
        validate();
        return Object.freeze({ code: 'ended', session: projection(next) });
      });
    },

    authorizeHostStream(input) {
      return authorizeHostStream(input, true);
    },

    authorizeParticipantStream(input) {
      return authorizeParticipantStream(input, true);
    },

    recheckHostStream(input) {
      return authorizeHostStream(input, false);
    },

    recheckParticipantStream(input) {
      return authorizeParticipantStream(input, false);
    },
  });
}

export function validateAudioSessions(database) {
  const games = new Map(database.prepare(`SELECT game_id,host_device_id,lifecycle,terminal_at
    FROM games`).all()
    .map((game) => [game.game_id, game]));
  const sessions = database.prepare(`SELECT audio_session_id,game_id,request_id,generation,state,
    connection_id,created_at,updated_at,ended_at FROM audio_sessions
    ORDER BY game_id,generation`).all();
  for (const gameId of games.keys()) {
    const owned = sessions.filter(({ game_id: id }) => id === gameId);
    if (owned.length > MAX_AUDIO_SESSIONS_PER_GAME
        || owned.some((session, index) => session.generation !== index + 1)) {
      reject('database_corrupt');
    }
  }
  for (const session of sessions) {
    const game = games.get(session.game_id);
    if (!game || !UUID_PATTERN.test(session.audio_session_id)
        || !UUID_PATTERN.test(session.request_id)
        || !Number.isSafeInteger(session.generation) || session.generation <= 0
        || !Number.isSafeInteger(session.created_at) || session.created_at <= 0
        || !Number.isSafeInteger(session.updated_at)
        || session.updated_at < session.created_at) reject('database_corrupt');
    const transitions = database.prepare(`SELECT sequence,from_state,to_state,connection_id,
      request_id,reason_code,occurred_at FROM audio_session_transitions
      WHERE audio_session_id=? ORDER BY sequence`).all(session.audio_session_id);
    if (!transitions.length || transitions.length > MAX_AUDIO_TRANSITIONS_PER_SESSION) {
      reject('database_corrupt');
    }
    let state = null;
    let connectionId = null;
    let priorTime = 0;
    for (let index = 0; index < transitions.length; index += 1) {
      const item = transitions[index];
      if (item.sequence !== index + 1 || item.from_state !== state
          || !Number.isSafeInteger(item.occurred_at) || item.occurred_at < priorTime) {
        reject('database_corrupt');
      }
      if (index === 0) {
        if (item.to_state !== 'starting' || item.connection_id !== null
            || item.request_id !== session.request_id || item.reason_code !== null
            || item.occurred_at !== session.created_at) reject('database_corrupt');
      } else if (item.to_state === 'connecting') {
        if (!['starting', 'interrupted'].includes(state)
            || !UUID_PATTERN.test(item.connection_id) || item.request_id !== null
            || item.reason_code !== 'connect_requested') reject('database_corrupt');
        connectionId = item.connection_id;
      } else if (item.to_state === 'active') {
        if (state !== 'connecting' || item.connection_id !== connectionId
            || item.request_id !== null || item.reason_code !== 'relay_connected') {
          reject('database_corrupt');
        }
      } else if (item.to_state === 'interrupted') {
        if (!['starting', 'connecting', 'active'].includes(state)
            || !INTERRUPTION_REASONS.has(item.reason_code) || item.request_id !== null
            || (state === 'starting' ? item.connection_id !== null
              : item.connection_id !== connectionId)) reject('database_corrupt');
        connectionId = null;
      } else if (item.to_state === 'ended') {
        if (!OPEN_STATES.has(state) || !END_REASONS.has(item.reason_code)
            || (['connecting', 'active'].includes(state)
              ? item.connection_id !== connectionId : item.connection_id !== null)
            || ((item.reason_code === 'host_stopped')
              !== (item.request_id !== null && UUID_PATTERN.test(item.request_id)))) {
          reject('database_corrupt');
        }
        if (item.reason_code === 'recovery_exhausted'
            && item.sequence !== MAX_AUDIO_TRANSITIONS_PER_SESSION) {
          reject('database_corrupt');
        }
        connectionId = null;
      } else reject('database_corrupt');
      state = item.to_state;
      priorTime = item.occurred_at;
    }
    const last = transitions.at(-1);
    if (session.state !== state || session.connection_id !== connectionId
        || session.updated_at !== last.occurred_at
        || (state === 'ended') !== (session.ended_at === last.occurred_at)
        || (['completed', 'abandoned'].includes(game.lifecycle) && state !== 'ended')) {
      reject('database_corrupt');
    }
    const gameEnded = transitions.find(({ reason_code: reason }) => reason === 'game_ended');
    if (gameEnded && (!['completed', 'abandoned'].includes(game.lifecycle)
        || gameEnded.occurred_at !== game.terminal_at)) reject('database_corrupt');
    const hostRevoked = transitions.find(({ reason_code: reason }) => reason === 'host_revoked');
    if (hostRevoked) {
      const device = database.prepare(`SELECT revoked_at FROM host_devices WHERE device_id=?`).get(
        game.host_device_id,
      );
      if (!device || hostRevoked.occurred_at !== device.revoked_at) reject('database_corrupt');
    }
  }
  return Object.freeze({ sessions: sessions.length });
}
