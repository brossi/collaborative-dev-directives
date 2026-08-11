import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { DatabaseSync } from 'node:sqlite';

const SOURCE_ONLINE_MS = 15_000;
const CLIENT_PRESENT_MS = 2 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const IDLE_MS = 30 * 60 * 1000;
const ABANDONED_MS = 24 * 60 * 60 * 1000;

function iso(timestamp) {
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function tableExists(db, name) {
  return Boolean(db.prepare(`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?
  `).get(name));
}

function one(db, sql, ...values) {
  return db.prepare(sql).get(...values);
}

function many(db, sql, ...values) {
  return db.prepare(sql).all(...values);
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

function liveness({ status, phase, lastMeaningfulAt, lastClientAt, leaseActive, now }) {
  if (status === 'ended' || phase === 'finished') {
    return { state: 'completed', confidence: 'confirmed', reasonCode: 'session_finished' };
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
  const sessions = many(db, `
    SELECT game_sessions.code, game_sessions.status, game_sessions.created_at,
           game_sessions.updated_at, game_sessions.active_run_id,
           game_runs.state AS run_state, game_runs.updated_at AS run_updated_at,
           game_runs.ended_at AS run_ended_at
    FROM game_sessions
    LEFT JOIN game_runs ON game_runs.id = game_sessions.active_run_id
    WHERE game_sessions.created_at >= ? OR game_sessions.updated_at >= ?
       OR game_runs.updated_at >= ? OR game_runs.ended_at >= ?
    ORDER BY COALESCE(game_runs.updated_at, game_sessions.updated_at) DESC
  `, cutoff, cutoff, cutoff, cutoff);

  return {
    generatedAt: new Date(now).toISOString(),
    applicationVersion,
    catalogVersion,
    historyBoundary: 'current snapshots and transient audio state; chronological history unavailable until Slice 2',
    sessions: sessions.map((row) => {
      const state = parsedState(row.run_state);
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
      const lastClientAt = maximum(member.last_seen_at, guest?.last_seen_at, playerIdentity?.last_seen_at);
      const lastMeaningfulAt = maximum(row.created_at, row.updated_at, row.run_updated_at, row.run_ended_at);
      const leaseActive = Boolean(lease?.expires_at && lease.expires_at > now);
      const sourceOnline = Boolean(lease?.source_last_seen_at && lease.source_last_seen_at > now - SOURCE_ONLINE_MS);
      return {
        lobbyId: row.code,
        runId: row.active_run_id ?? null,
        databaseStatus: row.status,
        phase: typeof state?.phase === 'string' ? state.phase : null,
        round: Number.isInteger(state?.round) ? state.round : null,
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
          leaseId: lease.id,
          sourceId: lease.source_id,
          leaseActive,
          expiresAt: iso(lease.expires_at),
          sourceOnline,
          sourceLastSeenAt: iso(lease.source_last_seen_at),
          playbackStatus: lease.playback_status,
          errorCategory: lease.lease_error || lease.source_error ? 'managed_source_error' : null,
          latestCommand: command ? {
            kind: command.kind,
            requestedAt: iso(command.created_at),
            delivered: Boolean(command.delivered_at),
            completed: Boolean(command.completed_at),
            errorCategory: command.error ? 'command_failed' : null,
          } : null,
        } : { leaseActive: false, sourceOnline: false, state: 'not_leased' },
        liveness: liveness({
          status: row.status,
          phase: state?.phase,
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
    lines.push(
      `${session.lobbyId} run=${session.runId ?? '-'} phase=${session.phase ?? 'unknown'} round=${session.round ?? '-'} liveness=${session.liveness.state}/${session.liveness.confidence}`,
      `  seats=${session.gameplaySeats.count} clients=${session.clientPresence.accountMembers + session.clientPresence.activeGuests} lastMeaningful=${session.lastMeaningfulAt ?? 'unknown'} lastSeen=${session.clientPresence.lastSeenAt ?? 'unknown'}`,
      `  audio=${session.audio.playbackStatus ?? session.audio.state} leaseActive=${session.audio.leaseActive} sourceOnline=${session.audio.sourceOnline} history=current-state-only`,
    );
  }
  return lines.join('\n');
}
