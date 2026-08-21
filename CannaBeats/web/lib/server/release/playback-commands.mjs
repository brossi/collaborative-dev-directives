import { createHash } from 'node:crypto';

import {
  SHA256_PATTERN, UUID_PATTERN, assertTimestamp, assertUuid, canonicalJson,
  parseCanonicalJson, sha256,
} from './canonical.mjs';

export const MAX_PLAYBACK_COMMANDS_PER_GAME = 512;
export const MAX_PLAYBACK_TRANSITIONS_PER_COMMAND = 8;

const OPEN_STATES = new Set(['queued', 'claimed', 'executing', 'outcome_unknown']);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);
const TARGET_STATES = new Set([
  'claimed', 'executing', 'completed', 'failed', 'outcome_unknown',
]);
const FAILURE_REASONS = new Set([
  'spotify_missing', 'spotify_not_running', 'spotify_signed_out',
  'automation_denied', 'command_timeout', 'unexpected_track', 'response_lost',
  'unrecognized',
]);
const UNKNOWN_REASONS = new Set(['command_timeout', 'response_lost', 'unrecognized']);

function reject(code) { throw new Error(code); }

function uuidFromText(text) {
  const bytes = Buffer.from(createHash('sha256').update(text).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function playbackCommandId(gameId, requestId, ordinal = 0) {
  assertUuid(gameId, 'invalid_request');
  assertUuid(requestId, 'invalid_request');
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) reject('invalid_request');
  return uuidFromText(canonicalJson({ gameId, ordinal, requestId, type: 'playback_command' }));
}

function commandProjection(row) {
  return {
    claimGeneration: row.claim_generation,
    commandId: row.command_id,
    executionAmbiguous: row.execution_ambiguous === 1,
    gameId: row.game_id,
    kind: row.kind,
    state: row.state,
    trackUri: row.track_uri,
    updatedAt: row.updated_at,
  };
}

function transitionResult(command, transition) {
  return Object.freeze({
    code: 'accepted', command: commandProjection(command),
    reconcileRequired: transition.to_state === 'claimed' && transition.from_state !== 'queued',
    transition: {
      claimGeneration: transition.claim_generation,
      fromState: transition.from_state,
      outcome: transition.outcome === null ? null : parseCanonicalJson(transition.outcome),
      outcomeHash: transition.outcome_hash,
      reasonCode: transition.reason_code,
      sequence: transition.sequence,
      toState: transition.to_state,
    },
  });
}

function appendTransition(database, {
  command, toState, claimGeneration, outcome = null, outcomeHash = null,
  reasonCode = null, now,
}) {
  const sequence = database.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence
    FROM playback_command_transitions WHERE command_id=?`).get(command.command_id).sequence;
  if (sequence > MAX_PLAYBACK_TRANSITIONS_PER_COMMAND) reject('transition_capacity');
  database.prepare(`INSERT INTO playback_command_transitions
    (command_id,sequence,from_state,to_state,claim_generation,outcome,outcome_hash,reason_code,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    command.command_id, sequence, command.state, toState, claimGeneration,
    outcome, outcomeHash, reasonCode, now,
  );
  const executionAmbiguous = command.execution_ambiguous === 1
    || ['executing', 'outcome_unknown'].includes(toState) ? 1 : 0;
  const updated = database.prepare(`UPDATE playback_commands
    SET state=?,claim_generation=?,execution_ambiguous=?,updated_at=?
    WHERE command_id=? AND state=? AND claim_generation IS ?`).run(
    toState, claimGeneration, executionAmbiguous, now,
    command.command_id, command.state, command.claim_generation,
  );
  if (updated.changes !== 1) reject('stale_claim');
  return database.prepare(`SELECT command_id,game_id,kind,track_uri,state,claim_generation,
    execution_ambiguous,updated_at
    FROM playback_commands WHERE command_id=?`).get(command.command_id);
}

export function cancelOpenPlaybackCommands(database, gameId, now, reasonCode) {
  assertUuid(gameId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
  if (!['game_ended', 'superseded'].includes(reasonCode)) reject('invalid_request');
  const open = database.prepare(`SELECT command_id,game_id,kind,track_uri,state,
    claim_generation,execution_ambiguous,updated_at FROM playback_commands WHERE game_id=?
    AND state IN ('queued','claimed','executing','outcome_unknown') ORDER BY created_at`).all(gameId);
  for (const command of open) appendTransition(database, {
    command, toState: 'cancelled', claimGeneration: command.claim_generation,
    reasonCode, now,
  });
  return open.length;
}

export function appendTrackPlaybackCommand(database, {
  gameId, requestId, trackUri, now, ordinal = 0,
}) {
  assertUuid(gameId, 'invalid_request'); assertUuid(requestId, 'invalid_request');
  assertTimestamp(now, 'invalid_request');
  if (!/^spotify:track:[0-9A-Za-z]{22}$/u.test(trackUri)) reject('invalid_request');
  const ambiguous = database.prepare(`SELECT 1 FROM playback_commands WHERE game_id=?
    AND state IN ('claimed','executing','outcome_unknown') AND execution_ambiguous=1
    LIMIT 1`).get(gameId);
  if (ambiguous) reject('operation_rejected');
  const count = database.prepare(`SELECT COUNT(*) AS count FROM playback_commands
    WHERE game_id=?`).get(gameId).count;
  if (count >= MAX_PLAYBACK_COMMANDS_PER_GAME) reject('playback_capacity');
  cancelOpenPlaybackCommands(database, gameId, now, 'superseded');
  const commandId = playbackCommandId(gameId, requestId, ordinal);
  database.prepare(`INSERT INTO playback_commands
    (command_id,game_id,request_id,kind,track_uri,state,created_at,updated_at)
    VALUES (?,?,?,'play_track',?,'queued',?,?)`).run(
    commandId, gameId, requestId, trackUri, now, now,
  );
  database.prepare(`INSERT INTO playback_command_transitions
    (command_id,sequence,from_state,to_state,occurred_at)
    VALUES (?,1,NULL,'queued',?)`).run(commandId, now);
  return commandId;
}

function normalizedOutcome(command, outcome, outcomeHash) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
      || Object.keys(outcome).sort().join('\0')
        !== ['playerState', 'positionMilliseconds', 'trackUri'].join('\0')
      || !['playing', 'paused', 'stopped'].includes(outcome.playerState)
      || !Number.isSafeInteger(outcome.positionMilliseconds)
      || outcome.positionMilliseconds < 0
      || (outcome.trackUri !== null
        && !/^spotify:track:[0-9A-Za-z]{22}$/u.test(outcome.trackUri))) reject('invalid_request');
  const holds = command.kind === 'play_track'
    ? outcome.playerState === 'playing' && outcome.trackUri === command.track_uri
    : command.kind === 'play' ? outcome.playerState === 'playing'
      : outcome.playerState === 'paused';
  if (!holds) reject('invalid_request');
  const text = canonicalJson(outcome);
  if (!SHA256_PATTERN.test(outcomeHash) || sha256(text) !== outcomeHash) reject('invalid_request');
  return text;
}

function validateTransitionInput({ targetState, claimGeneration, outcome, outcomeHash, reasonCode }) {
  if (!TARGET_STATES.has(targetState) || !UUID_PATTERN.test(claimGeneration)) reject('invalid_request');
  if (targetState === 'completed') {
    if (outcome === null || reasonCode !== null) reject('invalid_request');
  } else if (targetState === 'failed') {
    if (outcome !== null || outcomeHash !== null || !FAILURE_REASONS.has(reasonCode)) reject('invalid_request');
  } else if (targetState === 'outcome_unknown') {
    if (outcome !== null || outcomeHash !== null || !UNKNOWN_REASONS.has(reasonCode)) reject('invalid_request');
  } else if (outcome !== null || outcomeHash !== null || reasonCode !== null) reject('invalid_request');
}

export function createPlaybackCommands(database, {
  transaction, validate, retainHost, authorizeHost, audioReady = () => true,
}) {
  function retainedIdentity(token) {
    return retainHost({ token, kind: 'application' });
  }
  return Object.freeze({
    next({ applicationSessionToken, gameId, now }) {
      assertUuid(gameId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const host = authorizeHost({ token: applicationSessionToken, kind: 'application', now });
      validate();
      const game = database.prepare(`SELECT host_device_id,lifecycle FROM games WHERE game_id=?`).get(gameId);
      if (!game || game.host_device_id !== host.deviceId) reject('unauthorized');
      if (['completed', 'abandoned'].includes(game.lifecycle)) return Object.freeze({ code: 'idle' });
      const command = database.prepare(`SELECT command_id,game_id,kind,track_uri,state,
        claim_generation,execution_ambiguous,updated_at FROM playback_commands WHERE game_id=?
        AND state IN ('queued','claimed','executing','outcome_unknown') ORDER BY created_at LIMIT 1`).get(gameId);
      return Object.freeze(command ? { code: 'command', command: commandProjection(command) } : { code: 'idle' });
    },

    transition({
      applicationSessionToken, gameId, commandId, claimGeneration,
      targetState, outcome = null, outcomeHash = null, reasonCode = null, now,
    }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(commandId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      validateTransitionInput({ targetState, claimGeneration, outcome, outcomeHash, reasonCode });
      const retained = retainedIdentity(applicationSessionToken);
      return transaction(() => {
        const command = database.prepare(`SELECT command_id,game_id,kind,track_uri,state,
          claim_generation,execution_ambiguous,updated_at
          FROM playback_commands WHERE command_id=? AND game_id=?`).get(
          commandId, gameId,
        );
        if (!command) reject('command_not_found');
        const game = database.prepare(`SELECT host_device_id,lifecycle FROM games WHERE game_id=?`).get(gameId);
        if (!game || game.host_device_id !== retained.deviceId) reject('unauthorized');
        const prior = database.prepare(`SELECT command_id,sequence,from_state,to_state,
          claim_generation,outcome,outcome_hash,reason_code,occurred_at
          FROM playback_command_transitions WHERE command_id=? AND to_state=?
          AND claim_generation=? ORDER BY sequence`).all(commandId, targetState, claimGeneration);
        if (prior.length) {
          let outcomeText = null;
          try { outcomeText = outcome === null ? null : canonicalJson(outcome); } catch { reject('invalid_request'); }
          const exact = prior.find((row) => row.outcome === outcomeText
            && row.outcome_hash === outcomeHash
            && row.reason_code === reasonCode);
          if (!exact || prior.length !== 1) reject('request_conflict');
          validate();
          const executionAmbiguous = database.prepare(`SELECT EXISTS(
            SELECT 1 FROM playback_command_transitions WHERE command_id=? AND sequence<=?
            AND to_state IN ('executing','outcome_unknown')) AS value`).get(
            commandId, exact.sequence,
          ).value;
          return transitionResult({ ...command, state: exact.to_state,
            claim_generation: exact.claim_generation, execution_ambiguous: executionAmbiguous,
            updated_at: exact.occurred_at }, exact);
        }
        validate();
        authorizeHost({ token: applicationSessionToken, kind: 'application', now });
        if (['completed', 'abandoned'].includes(game.lifecycle)) reject('game_ended');
        if (TERMINAL_STATES.has(command.state)) reject('operation_rejected');
        if (((targetState === 'claimed' && command.execution_ambiguous === 0)
            || targetState === 'executing') && !audioReady(gameId)) {
          reject('audio_not_ready');
        }
        let permitted = false;
        if (targetState === 'claimed') permitted = OPEN_STATES.has(command.state);
        else if (command.claim_generation === claimGeneration) {
          permitted = targetState === 'executing' ? command.state === 'claimed'
            : ['completed', 'failed'].includes(targetState)
              ? ['claimed', 'executing', 'outcome_unknown'].includes(command.state)
              : targetState === 'outcome_unknown'
                && ['claimed', 'executing'].includes(command.state);
        }
        if (!permitted) reject(command.claim_generation !== claimGeneration
          ? 'stale_claim' : 'operation_rejected');
        const outcomeText = targetState === 'completed'
          ? normalizedOutcome(command, outcome, outcomeHash) : null;
        const transitionCount = database.prepare(`SELECT COUNT(*) AS count
          FROM playback_command_transitions WHERE command_id=?`).get(commandId).count;
        if (OPEN_STATES.has(targetState)
            && transitionCount >= MAX_PLAYBACK_TRANSITIONS_PER_COMMAND - 1) {
          reject('transition_capacity');
        }
        const next = appendTransition(database, {
          command, toState: targetState, claimGeneration, outcome: outcomeText,
          outcomeHash, reasonCode, now,
        });
        validate();
        const transition = database.prepare(`SELECT command_id,sequence,from_state,to_state,
          claim_generation,outcome,outcome_hash,reason_code,occurred_at
          FROM playback_command_transitions WHERE command_id=? ORDER BY sequence DESC LIMIT 1`).get(
          commandId,
        );
        return transitionResult(next, transition);
      });
    },
  });
}

export function validatePlaybackCommands(database) {
  const games = new Map(database.prepare(`SELECT game_id,lifecycle,terminal_at FROM games`).all()
    .map((game) => [game.game_id, game]));
  const commands = database.prepare(`SELECT command_id,game_id,request_id,kind,track_uri,state,
    claim_generation,execution_ambiguous,created_at,updated_at
    FROM playback_commands ORDER BY game_id,created_at`).all();
  for (const gameId of games.keys()) {
    if (commands.filter(({ game_id: id }) => id === gameId).length > MAX_PLAYBACK_COMMANDS_PER_GAME) {
      reject('database_corrupt');
    }
  }
  for (const command of commands) {
    const game = games.get(command.game_id);
    if (!game || !UUID_PATTERN.test(command.command_id) || !UUID_PATTERN.test(command.request_id)
        || !['play_track', 'play', 'pause'].includes(command.kind)
        || (command.kind === 'play_track') !== (command.track_uri !== null)
        || (command.track_uri !== null && !/^spotify:track:[0-9A-Za-z]{22}$/u.test(command.track_uri))
        || !Number.isSafeInteger(command.created_at) || command.created_at <= 0
        || !Number.isSafeInteger(command.updated_at) || command.updated_at < command.created_at) {
      reject('database_corrupt');
    }
    let commandEventSequence = null;
    if (command.kind === 'play_track') {
      const event = database.prepare(`SELECT detail,occurred_at,sequence FROM game_events
        WHERE game_id=? AND request_id=? AND event_type='track_requested'`).get(
        command.game_id, command.request_id,
      );
      let detail;
      try { detail = JSON.parse(event?.detail); } catch { reject('database_corrupt'); }
      if (!event || detail.trackUri !== command.track_uri || event.occurred_at !== command.created_at
          || command.command_id !== playbackCommandId(command.game_id, command.request_id, 0)) {
        reject('database_corrupt');
      }
      commandEventSequence = event.sequence;
    }
    const transitions = database.prepare(`SELECT sequence,from_state,to_state,claim_generation,
      outcome,outcome_hash,reason_code,occurred_at FROM playback_command_transitions
      WHERE command_id=? ORDER BY sequence`).all(command.command_id);
    if (!transitions.length || transitions.length > MAX_PLAYBACK_TRANSITIONS_PER_COMMAND) {
      reject('database_corrupt');
    }
    let state = null;
    let generation = null;
    let executionAmbiguous = 0;
    let priorTime = 0;
    const identities = new Set();
    for (let index = 0; index < transitions.length; index += 1) {
      const row = transitions[index];
      if (row.sequence !== index + 1 || row.from_state !== state
          || !Number.isSafeInteger(row.occurred_at) || row.occurred_at < priorTime) {
        reject('database_corrupt');
      }
      const identity = [row.to_state, row.claim_generation].join('\0');
      if (identities.has(identity)) reject('database_corrupt');
      identities.add(identity);
      if (index === 0) {
        if (row.to_state !== 'queued' || row.claim_generation !== null
            || row.outcome !== null || row.outcome_hash !== null || row.reason_code !== null
            || row.occurred_at !== command.created_at) reject('database_corrupt');
      } else if (row.to_state === 'claimed') {
        if (!OPEN_STATES.has(state) || !UUID_PATTERN.test(row.claim_generation)
            || row.outcome !== null || row.outcome_hash !== null
            || row.reason_code !== null) reject('database_corrupt');
        generation = row.claim_generation;
      } else if (row.to_state === 'executing') {
        if (state !== 'claimed' || row.claim_generation !== generation
            || row.outcome !== null || row.outcome_hash !== null
            || row.reason_code !== null) reject('database_corrupt');
      } else if (row.to_state === 'completed') {
        let outcome;
        try { outcome = parseCanonicalJson(row.outcome); } catch { reject('database_corrupt'); }
        try { normalizedOutcome(command, outcome, row.outcome_hash); } catch { reject('database_corrupt'); }
        if (!['claimed', 'executing', 'outcome_unknown'].includes(state)
            || row.claim_generation !== generation || row.reason_code !== null) {
          reject('database_corrupt');
        }
      } else if (row.to_state === 'failed') {
        if (!['claimed', 'executing', 'outcome_unknown'].includes(state)
            || row.claim_generation !== generation || row.outcome !== null
            || row.outcome_hash !== null
            || !FAILURE_REASONS.has(row.reason_code)) reject('database_corrupt');
      } else if (row.to_state === 'outcome_unknown') {
        if (!['claimed', 'executing'].includes(state) || row.claim_generation !== generation
            || row.outcome !== null || row.outcome_hash !== null
            || !UNKNOWN_REASONS.has(row.reason_code)) {
          reject('database_corrupt');
        }
      } else if (row.to_state === 'cancelled') {
        if (!OPEN_STATES.has(state) || row.claim_generation !== generation
            || row.outcome !== null || row.outcome_hash !== null
            || !['game_ended', 'superseded'].includes(row.reason_code)) {
          reject('database_corrupt');
        }
        const nextEvent = database.prepare(`SELECT request_id,occurred_at FROM game_events
          WHERE game_id=? AND event_type='track_requested' AND sequence>?
          ORDER BY sequence LIMIT 1`).get(command.game_id, commandEventSequence);
        if (row.reason_code === 'game_ended') {
          if (!['completed', 'abandoned'].includes(game.lifecycle)
              || game.terminal_at !== row.occurred_at || nextEvent) reject('database_corrupt');
        } else {
          const replacement = nextEvent && database.prepare(`SELECT command_id FROM playback_commands
            WHERE game_id=? AND request_id=? AND kind='play_track' AND created_at=?`).get(
            command.game_id, nextEvent.request_id, row.occurred_at,
          );
          if (!nextEvent || nextEvent.occurred_at !== row.occurred_at || !replacement) {
            reject('database_corrupt');
          }
        }
      } else reject('database_corrupt');
      state = row.to_state;
      if (['executing', 'outcome_unknown'].includes(row.to_state)) executionAmbiguous = 1;
      priorTime = row.occurred_at;
    }
    const last = transitions.at(-1);
    if (command.state !== state || command.claim_generation !== generation
        || command.execution_ambiguous !== executionAmbiguous
        || command.updated_at !== last.occurred_at
        || (['completed', 'abandoned'].includes(game.lifecycle) && OPEN_STATES.has(state))) {
      reject('database_corrupt');
    }
  }
  const trackEvents = database.prepare(`SELECT game_id,request_id FROM game_events
    WHERE event_type='track_requested'`).all();
  if (trackEvents.some((event) => !commands.some((command) => command.game_id === event.game_id
    && command.request_id === event.request_id && command.kind === 'play_track'))) {
    reject('database_corrupt');
  }
  if (commands.some(({ kind }) => kind !== 'play_track')) reject('database_corrupt');
  return Object.freeze({ commands: commands.length });
}
