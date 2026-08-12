import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { DatabaseSync } from 'node:sqlite';

const SOURCE_ONLINE_MS = 15_000;
const CLIENT_PRESENT_MS = 2 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const ABANDONED_MS = 24 * 60 * 60 * 1000;
const PRIVACY_CONTRACT = JSON.parse(readFileSync(
  existsSync(new URL('../contracts/privacy-projection.json', import.meta.url))
    ? new URL('../contracts/privacy-projection.json', import.meta.url)
    : new URL('../../../web/contracts/privacy-projection.json', import.meta.url), 'utf8',
));
const EVENT_REASON_CODES = new Set(PRIVACY_CONTRACT.eventReasons);
const SESSION_STATUSES = new Set(PRIVACY_CONTRACT.sessionStatuses);
const GAME_PHASES = new Set(PRIVACY_CONTRACT.gamePhases);
const EVENT_TYPES = new Set(PRIVACY_CONTRACT.eventTypes);
const EVENT_OUTCOMES = new Set(PRIVACY_CONTRACT.eventOutcomes);
const EVENT_ACTORS = new Set(PRIVACY_CONTRACT.eventActors);
const EVENT_DETAILS = new Set(PRIVACY_CONTRACT.eventDetails);
const PLAYBACK_STATUSES = new Set(PRIVACY_CONTRACT.playbackStatuses);
const COMMAND_KINDS = new Set(PRIVACY_CONTRACT.commandKinds);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function iso(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  try { return new Date(timestamp).toISOString(); } catch { return null; }
}

function validTimestamp(value) {
  return iso(value) === null ? null : value;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(name));
}

function one(db, sql, ...values) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return normalizedRow(statement.get(...values));
}

function many(db, sql, ...values) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.all(...values).map(normalizedRow);
}

function normalizedRow(row) {
  if (!row) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    typeof value === 'bigint' && value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER
      ? Number(value)
      : value,
  ]));
}

function parsedState(serialized) {
  if (!serialized) return null;
  try {
    const state = JSON.parse(serialized);
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

function maximum(...values) {
  const available = values.filter((value) => Number.isFinite(value));
  return available.length ? Math.max(...available) : null;
}

function eventReason(value) {
  if (value === null || value === undefined) return null;
  return EVENT_REASON_CODES.has(value) ? value : 'unrecognized_reason';
}

function reviewed(value, allowed, fallback) {
  if (value === null || value === undefined) return null;
  return allowed.has(value) ? value : fallback;
}

function terminalAssessment({
  status, phase, endedAt, terminalEvents, terminalOutcome, historyAvailable, coverage, eventCount = 0,
}) {
  const reviewedStatus = reviewed(status, SESSION_STATUSES, null);
  const reviewedPhase = reviewed(phase, GAME_PHASES, null);
  const reviewedOutcome = terminalOutcome === 'completed' || terminalOutcome === 'abandoned'
    ? terminalOutcome
    : null;
  const eventOutcomes = terminalEvents.map((event) => event.event_type === 'game_completed'
    ? (event.outcome === 'completed' ? 'completed' : null)
    : event.event_type === 'game_abandoned' && event.outcome === 'abandoned' ? 'abandoned' : null);
  const retainedHistory = Boolean(coverage?.purged_at);
  const fullHistoryExpected = historyAvailable && coverage && !retainedHistory;
  const coverageComplete = !fullHistoryExpected || (
    nonnegativeInteger(coverage?.last_recorded_revision) !== null
    && nonnegativeInteger(coverage?.current_revision) !== null
    && coverage.last_recorded_revision === coverage.current_revision
    && coverage.lifecycle_state === 'sealed'
  );
  const impossibleRetainedEvents = Boolean(retainedHistory && eventCount > 0);
  const resolved = reviewedOutcome ?? eventOutcomes.find(Boolean) ?? null;
  const phaseMatches = resolved === 'completed'
    ? reviewedPhase === 'finished'
    : resolved === 'abandoned' && reviewedPhase !== null && reviewedPhase !== 'finished';
  const eventsMatch = eventOutcomes.every((outcome) => outcome === resolved)
    && (!fullHistoryExpected || (eventOutcomes.length === 1 && eventOutcomes[0] === resolved))
    && (!historyAvailable || Boolean(coverage));
  const consistent = resolved
    ? Boolean(
      reviewedOutcome === resolved
      && reviewedStatus === 'ended'
      && validTimestamp(endedAt) !== null
      && phaseMatches
      && eventsMatch
      && coverageComplete
      && !impossibleRetainedEvents
    )
    : Boolean(
      reviewedStatus && reviewedStatus !== 'ended'
      && reviewedPhase && reviewedPhase !== 'finished'
      && endedAt === null
      && eventOutcomes.length === 0
      && !impossibleRetainedEvents
    );
  return { consistent, resolved };
}

function liveness({
  status, phase, endedAt, terminalEvents, terminalOutcome, historyAvailable, coverage,
  lastMeaningfulAt, lastClientAt, leaseActive, now, eventCount,
}) {
  const terminal = terminalAssessment({
    status, phase, endedAt, terminalEvents, terminalOutcome, historyAvailable, coverage, eventCount,
  });
  if (!terminal.consistent) {
    return { state: 'unknown', confidence: 'unavailable', reasonCode: 'terminal_evidence_inconsistent' };
  }
  if (terminal.resolved === 'abandoned') {
    return { state: 'abandoned', confidence: 'confirmed', reasonCode: 'explicit_host_abandonment' };
  }
  if (terminal.resolved === 'completed') {
    return { state: 'completed', confidence: 'confirmed', reasonCode: 'game_completed' };
  }
  if (phase === 'finished') {
    return { state: 'completed', confidence: 'confirmed', reasonCode: 'session_finished' };
  }
  if (status === 'ended') {
    return { state: 'unknown', confidence: 'unavailable', reasonCode: 'terminal_outcome_unavailable' };
  }
  if (!lastMeaningfulAt) {
    return { state: 'unknown', confidence: 'unavailable', reasonCode: 'meaningful_history_unavailable' };
  }
  const meaningfulAge = now - lastMeaningfulAt;
  const clientPresent = Boolean(lastClientAt && now - lastClientAt <= CLIENT_PRESENT_MS);
  if (meaningfulAge <= ACTIVE_MS && (clientPresent || leaseActive)) {
    return { state: 'active', confidence: 'inferred', reasonCode: clientPresent ? 'recent_action_and_client' : 'recent_action_and_lease' };
  }
  if (clientPresent || leaseActive || meaningfulAge <= IDLE_MS) {
    return { state: 'idle', confidence: 'inferred', reasonCode: clientPresent ? 'client_without_recent_action' : leaseActive ? 'lease_without_recent_action' : 'recent_state_only' };
  }
  if (meaningfulAge <= ABANDONED_MS) {
    return { state: 'stale', confidence: 'inferred', reasonCode: 'no_recent_client_or_lease' };
  }
  return { state: 'abandoned', confidence: 'inferred', reasonCode: 'stale_beyond_abandonment_window' };
}

export function openOperatorDatabase(databasePath) {
  if (!existsSync(databasePath)) throw new Error(`Database was not found: ${databasePath}`);
  const db = new DatabaseSync(databasePath, { readOnly: true });
  db.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON;');
  return db;
}

export function sessionReport(db, {
  now = Date.now(),
  sinceHours = 24,
  applicationVersion = 'unknown',
  catalogVersion = 'unknown',
} = {}) {
  if (!Number.isFinite(sinceHours) || sinceHours < 1 || sinceHours > 24 * 90) {
    throw new Error('sinceHours must be between 1 and 2160');
  }
  const cutoff = now - sinceHours * 60 * 60 * 1000;
  const eventHistoryAvailable = tableExists(db, 'game_events');
  const runColumns = new Set(many(db, 'PRAGMA table_info(game_runs)').map((column) => column.name));
  const coverageColumns = tableExists(db, 'game_event_coverage')
    ? new Set(many(db, 'PRAGMA table_info(game_event_coverage)').map((column) => column.name))
    : new Set();
  const revisionProjection = runColumns.has('revision') ? 'game_runs.revision' : '0';
  const terminalProjection = runColumns.has('terminal_outcome') ? 'game_runs.terminal_outcome' : 'NULL';
  const sessions = many(db, `
    SELECT game_sessions.code, game_sessions.status, game_sessions.created_at,
           game_sessions.updated_at, game_sessions.active_run_id,
           game_runs.state AS run_state, game_runs.updated_at AS run_updated_at,
           game_runs.ended_at AS run_ended_at, ${revisionProjection} AS run_revision,
           ${terminalProjection} AS run_terminal_outcome
    FROM game_sessions
    LEFT JOIN game_runs ON game_runs.id = game_sessions.active_run_id
    WHERE game_sessions.created_at >= ? OR game_sessions.updated_at >= ?
       OR game_runs.updated_at >= ? OR game_runs.ended_at >= ?
       ${eventHistoryAvailable ? `OR EXISTS (
         SELECT 1 FROM game_events
         WHERE game_events.run_id = game_runs.id AND game_events.occurred_at >= ${Number(cutoff)}
       )` : ''}
    ORDER BY COALESCE(game_runs.updated_at, game_sessions.updated_at) DESC
  `, cutoff, cutoff, cutoff, cutoff);

  return {
    generatedAt: new Date(now).toISOString(),
    applicationVersion,
    catalogVersion,
    historyBoundary: 'authoritative current snapshots plus a privacy-bounded, run-scoped significant-event trail',
    sessions: sessions.map((row) => {
      const state = parsedState(row.run_state);
      const projectedStatus = reviewed(row.status, SESSION_STATUSES, null);
      const projectedPhase = reviewed(state?.phase, GAME_PHASES, null);
      const projectedEndedAt = validTimestamp(row.run_ended_at);
      const projectedRunRevision = nonnegativeInteger(row.run_revision);
      const players = Array.isArray(state?.players) ? state.players : [];
      const controls = players.reduce((counts, player) => {
        const control = player?.control === 'phone' ? 'phone' : 'host';
        counts[control] = (counts[control] ?? 0) + 1;
        return counts;
      }, {});
      const member = one(db, `
        SELECT COUNT(*) AS count, MAX(last_seen_at) AS last_seen_at
        FROM game_session_members WHERE session_code = ?
      `, row.code) ?? { count: 0, last_seen_at: null };
      const guest = tableExists(db, 'game_guest_sessions') ? one(db, `
        SELECT COUNT(*) AS count, MAX(last_seen_at) AS last_seen_at
        FROM game_guest_sessions
        WHERE session_code = ? AND revoked_at IS NULL AND expires_at > ?
      `, row.code, now) : undefined;
      const playerIdentity = row.active_run_id && tableExists(db, 'game_run_player_identities')
        ? one(db, `
          SELECT MAX(last_seen_at) AS last_seen_at
          FROM game_run_player_identities WHERE run_id = ?
        `, row.active_run_id)
        : undefined;
      const lease = tableExists(db, 'managed_audio_leases') ? one(db, `
        SELECT managed_audio_leases.id, managed_audio_leases.source_id,
               managed_audio_leases.playback_status, managed_audio_leases.expires_at,
               managed_audio_leases.last_error AS lease_error,
               managed_audio_sources.last_seen_at AS source_last_seen_at,
               managed_audio_sources.last_error AS source_error
        FROM managed_audio_leases
        LEFT JOIN managed_audio_sources ON managed_audio_sources.id = managed_audio_leases.source_id
        WHERE managed_audio_leases.session_code = ?
      `, row.code) : undefined;
      const command = tableExists(db, 'managed_audio_commands') ? one(db, `
        SELECT kind, created_at, delivered_at, completed_at, error
        FROM managed_audio_commands WHERE session_code = ?
        ORDER BY created_at DESC LIMIT 1
      `, row.code) : undefined;
      const lastClientAt = maximum(
        validTimestamp(member.last_seen_at),
        validTimestamp(guest?.last_seen_at),
        validTimestamp(playerIdentity?.last_seen_at),
      );
      const projectedLeaseExpiry = validTimestamp(lease?.expires_at);
      const projectedSourceLastSeen = validTimestamp(lease?.source_last_seen_at);
      const leaseActive = Boolean(projectedLeaseExpiry && projectedLeaseExpiry > now);
      const sourceOnline = Boolean(
        projectedSourceLastSeen && projectedSourceLastSeen > now - SOURCE_ONLINE_MS,
      );
      const eventCount = row.active_run_id && eventHistoryAvailable ? one(db, `
        SELECT COUNT(*) AS count, MAX(occurred_at) AS latest_at
        FROM game_events WHERE run_id = ?
      `, row.active_run_id) : undefined;
      const eventOutcomes = row.active_run_id && eventCount ? many(db, `
        SELECT outcome, COUNT(*) AS count
        FROM game_events WHERE run_id = ? GROUP BY outcome ORDER BY outcome
      `, row.active_run_id) : [];
      const recentEvents = row.active_run_id && eventCount ? many(db, `
        SELECT sequence, event_type, outcome, actor_type, round,
               detail_code, detail_value, reason_code, occurred_at
        FROM game_events WHERE run_id = ? ORDER BY sequence DESC LIMIT 20
      `, row.active_run_id).reverse() : [];
      const terminalEvents = row.active_run_id && eventCount ? many(db, `
        SELECT event_type, outcome, occurred_at FROM game_events
        WHERE run_id = ? AND event_type IN ('game_completed', 'game_abandoned')
        ORDER BY sequence
      `, row.active_run_id) : [];
      const terminalEvent = terminalEvents.at(-1);
      const coverage = row.active_run_id && tableExists(db, 'game_event_coverage') ? one(db, `
        SELECT baseline_revision, last_recorded_revision,
               ${coverageColumns.has('purged_at') ? 'purged_at' : 'NULL AS purged_at'},
               ${coverageColumns.has('lifecycle_state') ? 'lifecycle_state' : "'recording' AS lifecycle_state"}
        FROM game_event_coverage WHERE run_id = ?
      `, row.active_run_id) : undefined;
      const projectedCoverage = coverage ? {
        baseline_revision: nonnegativeInteger(coverage.baseline_revision),
        last_recorded_revision: nonnegativeInteger(coverage.last_recorded_revision),
        current_revision: projectedRunRevision,
        purged_at: validTimestamp(coverage.purged_at),
        lifecycle_state: reviewed(
          coverage.lifecycle_state, new Set(PRIVACY_CONTRACT.historyLifecycle), null,
        ),
      } : undefined;
      const terminal = terminalAssessment({
        status: projectedStatus,
        phase: projectedPhase,
        endedAt: projectedEndedAt,
        terminalEvents,
        terminalOutcome: row.run_terminal_outcome,
        historyAvailable: eventHistoryAvailable,
        coverage: projectedCoverage,
        eventCount: Number(eventCount?.count ?? 0),
      });
      const lastMeaningfulAt = maximum(
        validTimestamp(row.created_at),
        validTimestamp(row.updated_at),
        validTimestamp(row.run_updated_at),
        projectedEndedAt,
        validTimestamp(eventCount?.latest_at),
      );
      return {
        lobbyId: /^[A-Z0-9]{6}$/.test(row.code) ? row.code : 'unrecognized_lobby',
        runId: UUID.test(row.active_run_id ?? '') ? row.active_run_id : null,
        databaseStatus: projectedStatus ?? 'unrecognized_status',
        phase: projectedPhase ?? 'unrecognized_phase',
        round: nonnegativeInteger(state?.round),
        createdAt: iso(row.created_at),
        lastMeaningfulAt: iso(lastMeaningfulAt),
        clientPresence: {
          accountMembers: Number(member.count ?? 0),
          activeGuests: Number(guest?.count ?? 0),
          lastSeenAt: iso(lastClientAt),
          presentNow: Boolean(lastClientAt && now - lastClientAt <= CLIENT_PRESENT_MS),
        },
        gameplaySeats: { count: players.length, controls },
        audio: lease ? {
          leaseId: UUID.test(lease.id ?? '') ? lease.id : null,
          sourceId: UUID.test(lease.source_id ?? '') ? lease.source_id : null,
          leaseActive,
          expiresAt: iso(projectedLeaseExpiry),
          sourceOnline,
          sourceLastSeenAt: iso(projectedSourceLastSeen),
          playbackStatus: reviewed(lease.playback_status, PLAYBACK_STATUSES, 'unrecognized_playback_status'),
          errorCategory: lease.lease_error || lease.source_error ? 'managed_source_error' : null,
          latestCommand: command ? {
            kind: reviewed(command.kind, COMMAND_KINDS, 'unrecognized_command_kind'),
            requestedAt: iso(command.created_at),
            delivered: Boolean(command.delivered_at),
            completed: Boolean(command.completed_at),
            errorCategory: command.error ? 'command_failed' : null,
          } : null,
        } : { leaseActive: false, sourceOnline: false, state: 'not_leased' },
        history: eventCount ? {
          available: true,
          eventCount: Number(eventCount.count),
          latestAt: iso(eventCount.latest_at),
          outcomes: eventOutcomes.reduce((counts, outcome) => {
            const key = reviewed(outcome.outcome, EVENT_OUTCOMES, 'unrecognized_outcome');
            counts[key] = (counts[key] ?? 0) + Number(outcome.count);
            return counts;
          }, {}),
          terminal: terminalEvent ? {
            type: reviewed(terminalEvent.event_type, EVENT_TYPES, 'unrecognized_event_type'),
            outcome: reviewed(terminalEvent.outcome, EVENT_OUTCOMES, 'unrecognized_outcome'),
            occurredAt: iso(terminalEvent.occurred_at),
            consistent: terminal.consistent,
          } : null,
          coverage: projectedCoverage ? {
            complete: projectedCoverage.last_recorded_revision !== null
              && projectedCoverage.current_revision !== null
              && projectedCoverage.last_recorded_revision === projectedCoverage.current_revision,
            baselineRevision: projectedCoverage.baseline_revision,
            lastRecordedRevision: projectedCoverage.last_recorded_revision,
            currentRevision: projectedCoverage.current_revision,
            lifecycle: projectedCoverage.lifecycle_state,
          } : {
            complete: false,
            reasonCode: 'coverage_marker_unavailable',
          },
          retention: projectedCoverage?.purged_at ? {
            state: 'purged',
            purgedAt: iso(projectedCoverage.purged_at),
          } : { state: 'full-history', purgedAt: null },
          recentEvents: recentEvents.map((event) => ({
            sequence: nonnegativeInteger(event.sequence),
            type: reviewed(event.event_type, EVENT_TYPES, 'unrecognized_event_type'),
            outcome: reviewed(event.outcome, EVENT_OUTCOMES, 'unrecognized_outcome'),
            actorType: reviewed(event.actor_type, EVENT_ACTORS, 'unrecognized_actor_type'),
            round: event.round === null ? null : nonnegativeInteger(event.round),
            detailCode: reviewed(event.detail_code, EVENT_DETAILS, 'unrecognized_detail_code'),
            detailValue: event.detail_value === null ? null : nonnegativeInteger(event.detail_value),
            reasonCode: eventReason(event.reason_code),
            occurredAt: iso(event.occurred_at),
          })),
          truncated: Number(eventCount.count) > recentEvents.length,
        } : {
          available: false,
          reasonCode: 'significant_event_history_unavailable',
        },
        liveness: liveness({
          status: projectedStatus,
          phase: projectedPhase,
          endedAt: projectedEndedAt,
          terminalEvents,
          terminalOutcome: row.run_terminal_outcome,
          historyAvailable: eventHistoryAvailable,
          coverage: projectedCoverage,
          eventCount: Number(eventCount?.count ?? 0),
          lastMeaningfulAt,
          lastClientAt,
          leaseActive,
          now,
        }),
      };
    }),
  };
}

async function readinessContract(response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) return false;
  const body = await response.text();
  if (body.length > 2_048) return false;
  try {
    return JSON.parse(body)?.ready === true;
  } catch {
    return false;
  }
}

function relayContract(response) {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const encoding = response.headers.get('x-audio-encoding')?.toLowerCase();
  const rate = Number(response.headers.get('x-audio-rate'));
  const channels = Number(response.headers.get('x-audio-channels'));
  return (contentType.startsWith('audio/l16') || contentType.startsWith('application/octet-stream'))
    && encoding === 's16le'
    && Number.isInteger(rate) && rate >= 8_000 && rate <= 192_000
    && Number.isInteger(channels) && channels >= 1 && channels <= 2;
}

async function fetchHealth(fetchImpl, url, timeoutMs, headers, validate, invalidReasonCode) {
  if (!url) return { status: 'unknown', reasonCode: 'origin_not_configured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal, headers });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status === 503 ? 'degraded' : 'unavailable', reasonCode: `http_${response.status}` };
    }
    if (validate && !await validate(response)) {
      await response.body?.cancel().catch(() => {});
      return { status: 'degraded', reasonCode: invalidReasonCode };
    }
    await response.body?.cancel().catch(() => {});
    return { status: 'healthy', reasonCode: 'ready' };
  } catch (error) {
    return { status: 'unavailable', reasonCode: error?.name === 'AbortError' ? 'timeout' : 'connection_failed' };
  } finally {
    clearTimeout(timer);
  }
}

function certificateHealth(origin, timeoutMs = 3_000) {
  if (!origin) return Promise.resolve({ status: 'unknown', reasonCode: 'origin_not_configured' });
  const url = new URL(origin);
  if (url.protocol !== 'https:') return Promise.resolve({ status: 'unknown', reasonCode: 'https_not_configured' });
  return new Promise((resolveResult) => {
    const socket = tlsConnect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname });
    const timer = setTimeout(() => {
      socket.destroy();
      resolveResult({ status: 'unavailable', reasonCode: 'timeout' });
    }, timeoutMs);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const certificate = socket.getPeerCertificate();
      socket.end();
      const expiresAt = Date.parse(certificate.valid_to);
      const daysRemaining = Number.isFinite(expiresAt) ? Math.floor((expiresAt - Date.now()) / 86_400_000) : null;
      resolveResult({
        status: daysRemaining === null ? 'unknown' : daysRemaining < 7 ? 'degraded' : 'healthy',
        reasonCode: daysRemaining === null ? 'expiry_unavailable' : daysRemaining < 7 ? 'certificate_expiring' : 'certificate_valid',
        daysRemaining,
      });
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolveResult({ status: 'unavailable', reasonCode: 'tls_connection_failed' });
    });
  });
}

export async function componentReport({
  db,
  databasePath,
  accessOrigin,
  gameOrigin,
  relayOrigin,
  relayListenToken,
  fetchImpl = fetch,
  now = Date.now(),
  dependencyTimeoutMs = 3_000,
  statfsImpl = statfsSync,
  certificateCheck = certificateHealth,
}) {
  if (!Number.isFinite(dependencyTimeoutMs) || dependencyTimeoutMs < 1 || dependencyTimeoutMs > 30_000) {
    throw new Error('dependencyTimeoutMs must be between 1 and 30000');
  }
  let database = { status: 'healthy', reasonCode: 'readable' };
  try {
    const result = db.prepare('PRAGMA integrity_check').get();
    if (result.integrity_check !== 'ok') database = { status: 'unavailable', reasonCode: 'integrity_check_failed' };
  } catch {
    database = { status: 'unavailable', reasonCode: 'read_failed' };
  }
  let volume = { status: 'unknown', reasonCode: 'capacity_unavailable' };
  try {
    const stats = statfsImpl(dirname(databasePath), { bigint: true });
    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    const percentAvailable = total > 0n ? Number((available * 10_000n) / total) / 100 : 0;
    volume = {
      status: percentAvailable < 10 ? 'degraded' : 'healthy',
      reasonCode: percentAvailable < 10 ? 'capacity_low' : 'capacity_available',
      percentAvailable,
    };
  } catch {}
  let source;
  try {
    source = tableExists(db, 'managed_audio_sources') ? one(db, `
      SELECT COUNT(*) AS enabled,
             SUM(CASE WHEN enabled = 1 AND last_seen_at > ? THEN 1 ELSE 0 END) AS online,
             SUM(CASE WHEN enabled = 1
                       AND last_error IS NOT NULL AND TRIM(last_error) <> '' THEN 1 ELSE 0 END) AS reporting_errors
      FROM managed_audio_sources WHERE enabled = 1
    `, now - SOURCE_ONLINE_MS) : undefined;
  } catch {}
  const managedSource = !source
    ? { status: 'unknown', reasonCode: 'source_state_unavailable' }
    : Number(source.reporting_errors) > 0
      ? {
        status: 'degraded', reasonCode: 'source_reported_error',
        enabled: Number(source.enabled), online: Number(source.online),
      }
      : Number(source.online) > 0
      ? { status: 'healthy', reasonCode: 'source_online', enabled: Number(source.enabled), online: Number(source.online) }
      : { status: 'degraded', reasonCode: 'source_offline', enabled: Number(source.enabled), online: 0 };

  const relayHeaders = relayListenToken ? { authorization: `Bearer ${relayListenToken}` } : undefined;
  const relay = relayOrigin && relayListenToken
    ? await fetchHealth(
      fetchImpl, new URL('/stream.pcm', relayOrigin), dependencyTimeoutMs,
      relayHeaders, relayContract, 'stream_contract_invalid',
    )
    : { status: 'unknown', reasonCode: 'relay_not_configured' };
  return {
    checkedAt: new Date(now).toISOString(),
    components: {
      access: await fetchHealth(
        fetchImpl, accessOrigin ? new URL('/api/ready', accessOrigin) : '', dependencyTimeoutMs,
        undefined, readinessContract, 'readiness_contract_invalid',
      ),
      game: await fetchHealth(
        fetchImpl, gameOrigin ? new URL('/game/api/ready', gameOrigin) : '', dependencyTimeoutMs,
        undefined, readinessContract, 'readiness_contract_invalid',
      ),
      database,
      databaseVolume: volume,
      relay,
      managedSource,
      certificate: await certificateCheck(accessOrigin, dependencyTimeoutMs),
    },
  };
}

export function readSecret(path) {
  if (!path) return '';
  return readFileSync(path, 'utf8').trim();
}

export function componentReportExitCode(report, failOn = 'unavailable') {
  if (!['unavailable', 'degraded'].includes(failOn)) {
    throw new Error('fail-on must be unavailable or degraded');
  }
  const statuses = Object.values(report?.components ?? {}).map((component) => component?.status);
  const failed = statuses.some((status) => status === 'unavailable'
    || (failOn === 'degraded' && status === 'degraded'));
  return failed ? 2 : 0;
}

export function formatSessionReport(report) {
  const lines = [
    `CannaBeats sessions at ${report.generatedAt}`,
    `versions application=${report.applicationVersion} catalog=${report.catalogVersion}`,
  ];
  if (!report.sessions.length) return [...lines, 'No current or recent sessions.'].join('\n');
  for (const session of report.sessions) {
    const coverage = session.history.coverage;
    const coverageText = coverage?.complete
      ? `complete baseline=${coverage.baselineRevision} current=${coverage.currentRevision}`
      : `incomplete baseline=${coverage?.baselineRevision ?? '-'} current=${coverage?.currentRevision ?? '-'}`;
    const retentionText = session.history.retention?.state ?? 'unknown';
    const terminalText = session.history.terminal
      ? `${session.history.terminal.type}/${session.history.terminal.consistent ? 'consistent' : 'inconsistent'}`
      : 'none';
    lines.push(
      `${session.lobbyId} run=${session.runId ?? '-'} phase=${session.phase ?? 'unknown'} round=${session.round ?? '-'} liveness=${session.liveness.state}/${session.liveness.confidence}`,
      `  seats=${session.gameplaySeats.count} clients=${session.clientPresence.accountMembers + session.clientPresence.activeGuests} lastMeaningful=${session.lastMeaningfulAt ?? 'unknown'} lastSeen=${session.clientPresence.lastSeenAt ?? 'unknown'}`,
      `  audio=${session.audio.playbackStatus ?? session.audio.state} leaseActive=${session.audio.leaseActive} sourceOnline=${session.audio.sourceOnline} history=${session.history.available ? `${session.history.eventCount}-events` : 'unavailable'}`,
      `  coverage=${coverageText} retention=${retentionText} terminal=${terminalText} truncated=${Boolean(session.history.truncated)}`,
    );
  }
  return lines.join('\n');
}
