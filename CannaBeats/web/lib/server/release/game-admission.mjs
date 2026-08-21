import {
  CATALOG_VERSION_PATTERN, SHA256_PATTERN, UUID_PATTERN, assertTimestamp, assertUuid, canonicalJson,
  parseCanonicalJson, sha256,
} from './canonical.mjs';
import { MAX_GAME_PLAYERS, normalizePlayerName, normalizeRules } from './game-state.mjs';
import { projectGameState } from './game-journey.mjs';
import { bearerHash } from './host-authority.mjs';

export const ADMISSION_LIMITS = Object.freeze({
  invitationTtl: 6 * 60 * 60 * 1_000,
  participants: 8,
});

const OPERATIONS = new Set([
  'issue_invitation', 'revoke_invitation', 'join_participant',
  'remove_participant', 'terminate_game',
]);

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function parsed(text) {
  try { return parseCanonicalJson(text); } catch { throw new Error('database_corrupt'); }
}

export function normalizeParticipantName(value) {
  const displayName = normalizePlayerName(value);
  return Object.freeze({ displayName, normalizedName: displayName.toLocaleLowerCase('en-US') });
}

function gameRow(database, gameId) {
  const game = database.prepare(`SELECT game_id,host_device_id,lifecycle,state,revision
    FROM games WHERE game_id=?`).get(gameId);
  if (!game) throw new Error('unauthorized');
  return game;
}

function receipt(database, { gameId, actorType, actorId, requestId }) {
  return database.prepare(`SELECT operation,request_hash,result FROM action_receipts
    WHERE game_id=? AND actor_type=? AND actor_id=? AND request_id=?`).get(
    gameId, actorType, actorId, requestId,
  );
}

function replay(database, identity, operation, requestHash) {
  const prior = receipt(database, identity);
  if (!prior) return null;
  if (prior.operation !== operation || prior.request_hash !== requestHash) {
    throw new Error('request_conflict');
  }
  return parsed(prior.result);
}

function activeParticipantSession(database, token, gameId = null) {
  const sessionHash = bearerHash(token);
  const row = database.prepare(`SELECT s.session_hash,s.game_id,s.participant_id,
    s.revoked_at,p.removed_at,g.lifecycle FROM participant_sessions s JOIN participants p
    ON p.game_id=s.game_id AND p.participant_id=s.participant_id JOIN games g
    ON g.game_id=s.game_id WHERE s.session_hash=?`).get(
    sessionHash,
  );
  if (!row || row.revoked_at !== null || row.removed_at !== null
      || ['completed', 'abandoned'].includes(row.lifecycle)
      || (gameId !== null && row.game_id !== gameId)) throw new Error('unauthorized');
  return row;
}

function retainedParticipantSession(database, token, gameId = null) {
  const sessionHash = bearerHash(token);
  const row = database.prepare(`SELECT session_hash,game_id,participant_id,revoked_at
    FROM participant_sessions WHERE session_hash=?`).get(sessionHash);
  if (!row || (gameId !== null && row.game_id !== gameId)) throw new Error('unauthorized');
  return row;
}

function invitation(database, inviteToken, gameId) {
  const inviteHash = bearerHash(inviteToken);
  return { inviteHash, row: database.prepare(`SELECT invite_hash,game_id,capacity,expires_at,closed_at
    FROM game_invites WHERE invite_hash=? AND game_id=?`).get(inviteHash, gameId) };
}

function event(database, gameId, revision, actorType, actorId, requestId, type, detail, now) {
  const sequence = database.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS sequence
    FROM game_events WHERE game_id=?`).get(gameId).sequence;
  database.prepare(`INSERT INTO game_events
    (game_id,sequence,revision,event_type,outcome,actor_type,actor_id,request_id,detail,occurred_at)
    VALUES (?,?,?,?, 'accepted',?,?,?,?,?)`).run(
    gameId, sequence, revision, type, actorType, actorId, requestId, canonicalJson(detail), now,
  );
}

function accept(database, {
  game, identity, operation, requestText, nextState, lifecycle = game.lifecycle,
  events, value, now, effect,
}) {
  const revision = game.revision + 1;
  const state = { ...nextState, revision };
  effect?.({ revision, state });
  const terminalAt = ['completed', 'abandoned'].includes(lifecycle) ? now : null;
  database.prepare(`UPDATE games SET lifecycle=?,state=?,revision=?,updated_at=?,terminal_at=?
    WHERE game_id=? AND revision=?`).run(
    lifecycle, canonicalJson(state), revision, now, terminalAt, game.game_id, game.revision,
  );
  const projectedEvents = events.map(({ type, detail = {} }) => ({
    detail, outcome: 'accepted', type,
  }));
  const result = {
    code: 'accepted', events: projectedEvents, gameId: game.game_id, revision, state,
    ...(value === undefined ? {} : { value }),
  };
  database.prepare(`INSERT INTO action_receipts
    (game_id,actor_type,actor_id,request_id,operation,request,request_hash,result,revision,accepted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    game.game_id, identity.actorType, identity.actorId, identity.requestId, operation,
    requestText, sha256(requestText), canonicalJson(result), revision, now,
  );
  for (const entry of events) event(
    database, game.game_id, revision, identity.actorType, identity.actorId,
    identity.requestId, entry.type, entry.detail ?? {}, now,
  );
  return Object.freeze(result);
}

function requestText({ identity, operation, expectedRevision, payload }) {
  return canonicalJson({
    actorId: identity.actorId, actorType: identity.actorType, expectedRevision,
    gameId: identity.gameId, operation, payload, requestId: identity.requestId,
  });
}

export function createGameAdmission(database, {
  transaction, validate, authorizeHost, retainHost,
}) {
  function run(work) {
    return transaction(() => {
      validate();
      const result = work();
      validate();
      return result;
    });
  }
  function hostIdentity(hostSessionToken, hostSessionKind, gameId, requestId) {
    const host = retainHost({ token: hostSessionToken, kind: hostSessionKind });
    return { actorId: host.deviceId, actorType: 'host', gameId, requestId };
  }
  return Object.freeze({
    issueInvitation({
      applicationSessionToken, hostSessionToken = applicationSessionToken,
      hostSessionKind = 'application', gameId, inviteToken, requestId, expectedRevision, now,
    }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid_request');
      const inviteHash = bearerHash(inviteToken);
      const identity = hostIdentity(hostSessionToken, hostSessionKind, gameId, requestId);
      const operation = 'issue_invitation';
      const text = requestText({ identity, operation, expectedRevision, payload: { inviteHash } });
      return run(() => {
        const prior = replay(database, identity, operation, sha256(text));
        if (prior) return prior;
        authorizeHost({ token: hostSessionToken, kind: hostSessionKind, now });
        const game = gameRow(database, gameId);
        if (game.host_device_id !== identity.actorId) throw new Error('unauthorized');
        if (game.lifecycle !== 'lobby') throw new Error('game_started');
        if (game.revision !== expectedRevision) throw new Error('stale_state');
        if (parsed(game.state).players.length >= MAX_GAME_PLAYERS) {
          throw new Error('capacity_reached');
        }
        if (database.prepare('SELECT 1 FROM game_invites WHERE invite_hash=?').get(inviteHash)) {
          throw new Error('request_conflict');
        }
        const priorInvite = database.prepare(`SELECT invite_hash FROM game_invites
          WHERE game_id=? AND closed_at IS NULL`).get(gameId);
        const expiresAt = now + ADMISSION_LIMITS.invitationTtl;
        return accept(database, {
          game, identity, operation, requestText: text,
          nextState: parsed(game.state), now,
          events: [
            ...(priorInvite ? [{ type: 'invitation_revoked', detail: {
              inviteHash: priorInvite.invite_hash,
            } }] : []),
            { type: 'invitation_issued', detail: { inviteHash, expiresAt } },
          ],
          value: { code: 'invitation_issued', expiresAt },
          effect: () => {
            if (priorInvite) database.prepare(`UPDATE game_invites
              SET closed_at=?,close_reason='revoked' WHERE invite_hash=?`).run(
              now, priorInvite.invite_hash,
            );
            database.prepare(`INSERT INTO game_invites
              (invite_hash,game_id,issued_by_device_id,capacity,issued_at,expires_at)
              VALUES (?,?,?,8,?,?)`).run(inviteHash, gameId, identity.actorId, now, expiresAt);
          },
        });
      });
    },

    revokeInvitation({
      applicationSessionToken, hostSessionToken = applicationSessionToken,
      hostSessionKind = 'application', gameId, requestId, expectedRevision, now,
    }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid_request');
      const identity = hostIdentity(hostSessionToken, hostSessionKind, gameId, requestId);
      const operation = 'revoke_invitation';
      const text = requestText({ identity, operation, expectedRevision, payload: {} });
      return run(() => {
        const prior = replay(database, identity, operation, sha256(text));
        if (prior) return prior;
        authorizeHost({ token: hostSessionToken, kind: hostSessionKind, now });
        const game = gameRow(database, gameId);
        if (game.host_device_id !== identity.actorId) throw new Error('unauthorized');
        if (game.lifecycle !== 'lobby') throw new Error('game_started');
        if (game.revision !== expectedRevision) throw new Error('stale_state');
        const open = database.prepare(`SELECT invite_hash FROM game_invites
          WHERE game_id=? AND closed_at IS NULL`).get(gameId);
        if (!open) throw new Error('already_used');
        return accept(database, {
          game, identity, operation, requestText: text, nextState: parsed(game.state), now,
          events: [{ type: 'invitation_revoked', detail: { inviteHash: open.invite_hash } }],
          value: { code: 'invitation_revoked' },
          effect: () => database.prepare(`UPDATE game_invites SET closed_at=?,close_reason='revoked'
            WHERE invite_hash=?`).run(now, open.invite_hash),
        });
      });
    },

    admitParticipant({
      gameId, inviteToken, participantId, sessionToken, displayName, requestId,
      now,
    }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(participantId, 'invalid_request');
      assertUuid(requestId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const names = normalizeParticipantName(displayName);
      const { inviteHash } = invitation(database, inviteToken, gameId);
      const sessionHash = bearerHash(sessionToken);
      const identity = { actorId: participantId, actorType: 'participant', gameId, requestId };
      const operation = 'join_participant';
      const text = requestText({ identity, operation, expectedRevision: null, payload: {
        displayName: names.displayName, inviteHash, normalizedName: names.normalizedName,
        participantId, sessionHash,
      } });
      return run(() => {
        const prior = replay(database, identity, operation, sha256(text));
        if (prior) return prior;
        if (database.prepare('SELECT 1 FROM participants WHERE participant_id=?').get(participantId)
            || database.prepare('SELECT 1 FROM participant_sessions WHERE session_hash=?')
              .get(sessionHash)) throw new Error('request_conflict');
        const game = gameRow(database, gameId);
        if (game.lifecycle !== 'lobby') throw new Error('game_started');
        const currentInvite = database.prepare(`SELECT expires_at,closed_at,close_reason,capacity FROM game_invites
          WHERE invite_hash=? AND game_id=?`).get(inviteHash, gameId);
        if (!currentInvite) throw new Error('unauthorized');
        if (currentInvite.closed_at !== null) {
          throw new Error(currentInvite.close_reason === 'capacity' ? 'capacity_reached' : 'unauthorized');
        }
        if (now >= currentInvite.expires_at) throw new Error('expired');
        const state = parsed(game.state);
        if (state.players.some(({ name }) =>
          normalizePlayerName(name).toLocaleLowerCase('en-US') === names.normalizedName)) {
          throw new Error('duplicate_name');
        }
        const active = database.prepare(`SELECT join_order FROM participants
          WHERE game_id=? AND removed_at IS NULL ORDER BY join_order`).all(gameId);
        if (active.length >= ADMISSION_LIMITS.participants
            || state.players.length >= MAX_GAME_PLAYERS) throw new Error('capacity_reached');
        const used = new Set(active.map(({ join_order: order }) => order));
        const joinOrder = Array.from({ length: ADMISSION_LIMITS.participants }, (_, index) => index + 1)
          .find((order) => !used.has(order));
        const players = [...state.players, {
          control: 'phone', id: participantId, name: names.displayName, timeline: [],
        }].sort((left, right) => {
          const leftOrder = left.id === participantId ? joinOrder
            : database.prepare(`SELECT join_order FROM participants
              WHERE game_id=? AND participant_id=?`).get(gameId, left.id)?.join_order ?? 0;
          const rightOrder = right.id === participantId ? joinOrder
            : database.prepare(`SELECT join_order FROM participants
              WHERE game_id=? AND participant_id=?`).get(gameId, right.id)?.join_order ?? 0;
          return leftOrder - rightOrder;
        });
        const closes = state.players.length + 1 === MAX_GAME_PLAYERS;
        return accept(database, {
          game, identity, operation, requestText: text, nextState: { ...state, players }, now,
          events: [
            { type: 'participant_joined', detail: { joinOrder, participantId } },
            ...(closes ? [{ type: 'invitation_closed', detail: { inviteHash } }] : []),
          ],
          value: { code: 'participant_admitted', participantId },
          effect: () => {
            database.prepare(`INSERT INTO participants
              (participant_id,game_id,admitted_invite_hash,display_name,normalized_name,
                join_order,joined_at) VALUES (?,?,?,?,?,?,?)`).run(
              participantId, gameId, inviteHash, names.displayName, names.normalizedName,
              joinOrder, now,
            );
            database.prepare(`INSERT INTO participant_sessions
              (session_hash,game_id,participant_id,issued_at) VALUES (?,?,?,?)`).run(
              sessionHash, gameId, participantId, now,
            );
            if (closes) database.prepare(`UPDATE game_invites
              SET closed_at=?,close_reason='capacity' WHERE invite_hash=?`).run(now, inviteHash);
          },
        });
      });
    },

    removeParticipant({
      applicationSessionToken, hostSessionToken = applicationSessionToken,
      hostSessionKind = 'application', gameId, targetParticipantId, requestId,
      expectedRevision, now,
    }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(targetParticipantId, 'invalid_request');
      assertUuid(requestId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid_request');
      const identity = hostIdentity(hostSessionToken, hostSessionKind, gameId, requestId);
      const operation = 'remove_participant';
      const text = requestText({ identity, operation, expectedRevision,
        payload: { targetParticipantId } });
      return run(() => {
        const prior = replay(database, identity, operation, sha256(text));
        if (prior) return prior;
        authorizeHost({ token: hostSessionToken, kind: hostSessionKind, now });
        const game = gameRow(database, gameId);
        if (game.host_device_id !== identity.actorId) throw new Error('unauthorized');
        if (game.lifecycle !== 'lobby') throw new Error('game_started');
        if (game.revision !== expectedRevision) throw new Error('stale_state');
        const participant = database.prepare(`SELECT removed_at FROM participants
          WHERE game_id=? AND participant_id=?`).get(gameId, targetParticipantId);
        if (!participant) throw new Error('unauthorized');
        if (participant.removed_at !== null) throw new Error('already_used');
        const state = parsed(game.state);
        return accept(database, {
          game, identity, operation, requestText: text,
          nextState: { ...state, players: state.players.filter(({ id }) => id !== targetParticipantId) },
          now, events: [{ type: 'participant_removed', detail: { participantId: targetParticipantId } }],
          value: { code: 'participant_removed', participantId: targetParticipantId },
          effect: () => {
            database.prepare('UPDATE participants SET removed_at=? WHERE participant_id=?')
              .run(now, targetParticipantId);
            database.prepare(`UPDATE participant_sessions SET revoked_at=?
              WHERE game_id=? AND participant_id=? AND revoked_at IS NULL`).run(
              now, gameId, targetParticipantId,
            );
          },
        });
      });
    },

    terminateGame({
      applicationSessionToken, hostSessionToken = applicationSessionToken,
      hostSessionKind = 'application', gameId, requestId, expectedRevision, now,
    }) {
      assertUuid(gameId, 'invalid_request'); assertUuid(requestId, 'invalid_request');
      assertTimestamp(now, 'invalid_request');
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('invalid_request');
      const identity = hostIdentity(hostSessionToken, hostSessionKind, gameId, requestId);
      const operation = 'terminate_game';
      const text = requestText({ identity, operation, expectedRevision, payload: {} });
      return run(() => {
        const prior = replay(database, identity, operation, sha256(text));
        if (prior) return prior;
        authorizeHost({ token: hostSessionToken, kind: hostSessionKind, now });
        const game = gameRow(database, gameId);
        if (game.host_device_id !== identity.actorId) throw new Error('unauthorized');
        if (['completed', 'abandoned'].includes(game.lifecycle)) throw new Error('game_ended');
        if (game.revision !== expectedRevision) throw new Error('stale_state');
        const state = parsed(game.state);
        return accept(database, {
          game, identity, operation, requestText: text, nextState: state,
          lifecycle: 'abandoned', now, events: [{ type: 'game_abandoned', detail: {} }],
          value: { code: 'game_terminated' },
          effect: () => database.prepare(`UPDATE game_invites
            SET closed_at=?,close_reason='revoked' WHERE game_id=? AND closed_at IS NULL`).run(
            now, gameId,
          ),
        });
      });
    },

    authorizeParticipant({ token, now, gameId = null }) {
      assertTimestamp(now, 'invalid_request');
      const row = activeParticipantSession(database, token, gameId);
      validate();
      return Object.freeze({ gameId: row.game_id, participantId: row.participant_id });
    },

    retainedParticipant({ token, gameId = null }) {
      const row = retainedParticipantSession(database, token, gameId);
      return Object.freeze({
        gameId: row.game_id, participantId: row.participant_id,
        revoked: row.revoked_at !== null,
      });
    },

    participantSnapshot({ token, gameId, now }) {
      assertUuid(gameId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const authority = activeParticipantSession(database, token, gameId);
      validate();
      const game = gameRow(database, gameId);
      const state = parsed(game.state);
      return Object.freeze({
        code: 'snapshot', gameId, lifecycle: game.lifecycle,
        participantId: authority.participant_id, revision: game.revision,
        state: projectGameState(state, 'participant'),
      });
    },

    hostSnapshot({
      applicationSessionToken, hostSessionToken = applicationSessionToken,
      hostSessionKind = 'application', gameId, now,
    }) {
      assertUuid(gameId, 'invalid_request'); assertTimestamp(now, 'invalid_request');
      const host = authorizeHost({ token: hostSessionToken, kind: hostSessionKind, now });
      validate();
      const game = gameRow(database, gameId);
      if (game.host_device_id !== host.deviceId) throw new Error('unauthorized');
      return Object.freeze({
        code: 'snapshot', gameId, lifecycle: game.lifecycle, revision: game.revision,
        state: parsed(game.state),
      });
    },

    hostRecovery({
      applicationSessionToken, hostSessionToken = applicationSessionToken,
      hostSessionKind = 'application', now,
    }) {
      const host = authorizeHost({ token: hostSessionToken, kind: hostSessionKind, now });
      validate();
      const game = database.prepare(`SELECT game_id,lifecycle,revision,state FROM games
        WHERE host_device_id=? AND lifecycle IN ('lobby','active') ORDER BY created_at DESC LIMIT 1`)
        .get(host.deviceId);
      return Object.freeze({ game: game ? {
        gameId: game.game_id, lifecycle: game.lifecycle, revision: game.revision,
        state: parsed(game.state),
      } : null });
    },
  });
}

export function validateGameAdmission(database) {
  const games = database.prepare(`SELECT game_id,host_device_id,lifecycle,state,revision,
    created_at,terminal_at FROM games`).all();
  const gameMap = new Map(games.map((row) => [row.game_id, row]));
  const createDecisions = database.prepare(`SELECT host_device_id,requested_game_id,request_id,
    target_game_id,request,request_hash,result,accepted_at FROM game_create_decisions
    ORDER BY host_device_id,requested_game_id,request_id`).all();
  for (const row of createDecisions) {
    const target = gameMap.get(row.target_game_id);
    const request = parsed(row.request);
    const result = parsed(row.result);
    const host = database.prepare('SELECT 1 FROM host_devices WHERE device_id=?').get(row.host_device_id);
    const conflictingReceipt = database.prepare(`SELECT 1 FROM action_receipts WHERE game_id=?
      AND actor_type='host' AND actor_id=? AND request_id=?`).get(
      row.requested_game_id, row.host_device_id, row.request_id,
    );
    if (!host || !target || !UUID_PATTERN.test(row.requested_game_id)
        || !UUID_PATTERN.test(row.request_id) || row.target_game_id === row.requested_game_id
        || !SHA256_PATTERN.test(row.request_hash) || sha256(row.request) !== row.request_hash
        || !exactKeys(request, [
          'actorId', 'actorType', 'catalogVersion', 'gameId', 'operation', 'requestId', 'rules',
        ]) || request.actorId !== row.host_device_id || request.actorType !== 'host'
        || request.gameId !== row.requested_game_id || request.requestId !== row.request_id
        || request.operation !== 'create_game'
        || !CATALOG_VERSION_PATTERN.test(request.catalogVersion)
        || canonicalJson(normalizeRules(request.rules)) !== canonicalJson(request.rules)
        || !exactKeys(result, ['code', 'gameId']) || result.code !== 'active_game_exists'
        || result.gameId !== row.target_game_id || row.accepted_at < target.created_at
        || (target.terminal_at !== null && row.accepted_at > target.terminal_at)
        || conflictingReceipt) throw new Error('database_corrupt');
  }
  const receipts = database.prepare(`SELECT game_id,actor_type,actor_id,request_id,operation,
    request,result,revision,accepted_at FROM action_receipts
    WHERE operation IN ('issue_invitation','revoke_invitation','join_participant',
      'remove_participant','terminate_game')`).all().map((row) => ({
    ...row, requestValue: parsed(row.request), resultValue: parsed(row.result),
  }));
  const invites = database.prepare(`SELECT invite_hash,game_id,issued_by_device_id,capacity,
    issued_at,expires_at,closed_at,close_reason FROM game_invites ORDER BY invite_hash`).all();
  const sessions = database.prepare(`SELECT session_hash,game_id,participant_id,issued_at,
    revoked_at FROM participant_sessions ORDER BY session_hash`).all();
  const admissionEvents = database.prepare(`SELECT game_id,sequence,revision,event_type,
    actor_type,actor_id,request_id,detail,occurred_at FROM game_events
    ORDER BY game_id,sequence`).all().map((row) => ({ ...row, detailValue: parsed(row.detail) }));
  const hasEvent = (receiptRow, type, detail) => Array.isArray(receiptRow?.resultValue?.events)
    && receiptRow.resultValue.events.some((entry) => entry.type === type
      && entry.outcome === 'accepted' && canonicalJson(entry.detail) === canonicalJson(detail));
  for (const row of invites) {
    const game = gameMap.get(row.game_id);
    const issued = receipts.filter(({ operation, game_id: id, actor_type: actorType,
      actor_id: actor, requestValue, resultValue,
      accepted_at: at }) => operation === 'issue_invitation' && id === row.game_id
      && actorType === 'host'
      && actor === row.issued_by_device_id && requestValue.payload?.inviteHash === row.invite_hash
      && exactKeys(requestValue.payload, ['inviteHash'])
      && exactKeys(resultValue.value, ['code', 'expiresAt'])
      && resultValue.value.code === 'invitation_issued'
      && resultValue.value.expiresAt === row.expires_at && at === row.issued_at);
    if (!SHA256_PATTERN.test(row.invite_hash) || !game
        || row.issued_by_device_id !== game.host_device_id || row.capacity !== 8
        || row.expires_at - row.issued_at !== ADMISSION_LIMITS.invitationTtl || issued.length !== 1
        || !hasEvent(issued[0], 'invitation_issued', {
          expiresAt: row.expires_at, inviteHash: row.invite_hash,
        })
        || ((row.closed_at === null) !== (row.close_reason === null))
        || (row.closed_at !== null && row.closed_at < row.issued_at)) throw new Error('database_corrupt');
    const issuedEvent = admissionEvents.filter((eventRow) => eventRow.game_id === row.game_id
      && eventRow.event_type === 'invitation_issued'
      && canonicalJson(eventRow.detailValue) === canonicalJson({
        expiresAt: row.expires_at, inviteHash: row.invite_hash,
      }));
    if (issuedEvent.length !== 1) throw new Error('database_corrupt');
    const causes = admissionEvents.flatMap((eventRow) => {
      if (eventRow.game_id !== row.game_id || eventRow.sequence <= issuedEvent[0].sequence) return [];
      const linked = database.prepare(`SELECT operation FROM action_receipts WHERE game_id=?
        AND revision=? AND actor_type=? AND actor_id=? AND request_id=? AND accepted_at=?`).get(
        eventRow.game_id, eventRow.revision, eventRow.actor_type, eventRow.actor_id,
        eventRow.request_id, eventRow.occurred_at,
      );
      if (eventRow.event_type === 'invitation_revoked'
          && canonicalJson(eventRow.detailValue) === canonicalJson({ inviteHash: row.invite_hash })
          && ['issue_invitation', 'revoke_invitation'].includes(linked?.operation)) {
        return [{ at: eventRow.occurred_at, reason: 'revoked', sequence: eventRow.sequence }];
      }
      if (eventRow.event_type === 'invitation_closed'
          && canonicalJson(eventRow.detailValue) === canonicalJson({ inviteHash: row.invite_hash })
          && ['join_participant', 'add_host_player'].includes(linked?.operation)) {
        return [{ at: eventRow.occurred_at, reason: 'capacity', sequence: eventRow.sequence }];
      }
      if (eventRow.event_type === 'game_started') {
        return [{ at: eventRow.occurred_at, reason: 'started', sequence: eventRow.sequence }];
      }
      if (eventRow.event_type === 'game_abandoned') {
        return [{ at: eventRow.occurred_at, reason: 'revoked', sequence: eventRow.sequence }];
      }
      return [];
    }).sort((left, right) => left.sequence - right.sequence);
    const cause = causes[0] ?? null;
    if ((cause === null) !== (row.closed_at === null)
        || (cause && (row.closed_at !== cause.at || row.close_reason !== cause.reason))) {
      throw new Error('database_corrupt');
    }
    const playerCount = parsed(game.state).players.length;
    if ((game.lifecycle !== 'lobby' || playerCount >= MAX_GAME_PLAYERS)
        && row.closed_at === null) throw new Error('database_corrupt');
  }
  const participants = database.prepare(`SELECT participant_id,game_id,admitted_invite_hash,
    display_name,normalized_name,join_order,joined_at,removed_at FROM participants
    ORDER BY game_id,joined_at,participant_id`).all();
  for (const row of participants) {
    const game = gameMap.get(row.game_id);
    const invite = invites.find(({ invite_hash: hash }) => hash === row.admitted_invite_hash);
    let names;
    try { names = normalizeParticipantName(row.display_name); } catch { throw new Error('database_corrupt'); }
    const participantSession = sessions.find(({ participant_id: participant, game_id: gameId }) =>
      participant === row.participant_id && gameId === row.game_id);
    const joined = receipts.filter(({ operation, game_id: id, actor_type: actorType,
      actor_id: actor, requestValue, resultValue,
      accepted_at: at }) => operation === 'join_participant' && id === row.game_id
      && actorType === 'participant'
      && actor === row.participant_id && requestValue.payload?.inviteHash === row.admitted_invite_hash
      && exactKeys(requestValue.payload, [
        'displayName', 'inviteHash', 'normalizedName', 'participantId', 'sessionHash',
      ])
      && requestValue.payload.displayName === row.display_name
      && requestValue.payload.normalizedName === row.normalized_name
      && requestValue.payload.participantId === row.participant_id
      && requestValue.payload.sessionHash === participantSession?.session_hash
      && exactKeys(resultValue.value, ['code', 'participantId'])
      && resultValue.value.code === 'participant_admitted'
      && resultValue.value.participantId === row.participant_id && at === row.joined_at);
    if (!UUID_PATTERN.test(row.participant_id) || !game || !invite || invite.game_id !== row.game_id
        || names.displayName !== row.display_name || names.normalizedName !== row.normalized_name
        || !Number.isSafeInteger(row.join_order) || row.join_order < 1 || row.join_order > 8
        || row.joined_at < invite.issued_at || row.joined_at >= invite.expires_at
        || (invite.closed_at !== null && row.joined_at > invite.closed_at)
        || joined.length !== 1
        || !hasEvent(joined[0], 'participant_joined', {
          joinOrder: row.join_order, participantId: row.participant_id,
        })
        || (row.removed_at !== null && row.removed_at < row.joined_at)) throw new Error('database_corrupt');
    const removals = receipts.filter((candidate) => candidate.operation === 'remove_participant'
      && candidate.game_id === row.game_id
      && candidate.requestValue.payload?.targetParticipantId === row.participant_id);
    if (row.removed_at === null) {
      if (removals.length !== 0) throw new Error('database_corrupt');
    } else if (removals.length !== 1 || removals[0].actor_type !== 'host'
        || removals[0].accepted_at !== row.removed_at
        || !exactKeys(removals[0].requestValue.payload, ['targetParticipantId'])
        || !exactKeys(removals[0].resultValue.value, ['code', 'participantId'])
        || removals[0].resultValue.value.code !== 'participant_removed'
        || removals[0].resultValue.value.participantId !== row.participant_id
        || !hasEvent(removals[0], 'participant_removed', {
          participantId: row.participant_id,
        })) throw new Error('database_corrupt');
  }
  for (const row of sessions) {
    const participant = participants.find(({ participant_id: id, game_id: gameId }) =>
      id === row.participant_id && gameId === row.game_id);
    if (!SHA256_PATTERN.test(row.session_hash) || !participant
        || row.issued_at !== participant.joined_at
        || row.revoked_at !== participant.removed_at) throw new Error('database_corrupt');
  }
  for (const game of games) {
    const state = parsed(game.state);
    const active = participants.filter(({ game_id: id, removed_at: removed }) =>
      id === game.game_id && removed === null).sort((left, right) => left.join_order - right.join_order);
    const projected = active.map(({ participant_id: id, display_name: name }) => {
      const player = state.players.find(({ id: playerId }) => playerId === id);
      return player && player.control === 'phone' && player.name === name ? player : null;
    });
    const phonePlayers = state.players.filter(({ control }) => control === 'phone');
    if (active.length > 8 || projected.some((player) => !player)
        || phonePlayers.length !== active.length
        || phonePlayers.some((player, index) => player.id !== active[index].participant_id)
        || new Set(active.map(({ normalized_name: name }) => name)).size !== active.length
        || new Set(active.map(({ join_order: order }) => order)).size !== active.length) {
      throw new Error('database_corrupt');
    }
  }
  for (const row of receipts) {
    if (!OPERATIONS.has(row.operation) || !exactKeys(row.requestValue, [
      'actorId', 'actorType', 'expectedRevision', 'gameId', 'operation', 'payload', 'requestId',
    ]) || row.requestValue.operation !== row.operation || row.requestValue.gameId !== row.game_id
      || row.requestValue.actorId !== row.actor_id || row.requestValue.requestId !== row.request_id
      || row.requestValue.actorType !== row.actor_type
      || (row.operation === 'join_participant'
        ? row.requestValue.expectedRevision !== null
        : row.revision !== row.requestValue.expectedRevision + 1)
      || row.resultValue.revision !== row.revision) throw new Error('database_corrupt');
    if (row.operation === 'revoke_invitation'
        && (!exactKeys(row.requestValue.payload, [])
          || !exactKeys(row.resultValue.value, ['code'])
          || row.resultValue.value.code !== 'invitation_revoked')) throw new Error('database_corrupt');
    if (row.operation === 'terminate_game') {
      const game = gameMap.get(row.game_id);
      if (!exactKeys(row.requestValue.payload, [])
          || !exactKeys(row.resultValue.value, ['code'])
          || row.resultValue.value.code !== 'game_terminated'
          || game?.lifecycle !== 'abandoned' || game.terminal_at !== row.accepted_at
          || row.revision !== game.revision || !hasEvent(row, 'game_abandoned', {})) {
        throw new Error('database_corrupt');
      }
    }
  }
  return Object.freeze({ invites: invites.length, participants: participants.length, sessions: sessions.length });
}
