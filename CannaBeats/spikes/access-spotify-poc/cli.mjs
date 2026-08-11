#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createInvitation,
  grantUserCapability,
  MANAGE_HOST_INVITATIONS,
  openDatabase,
  revokeUserCapability,
  sha256,
  userCapabilities,
  writeAuditEvent,
} from './db.mjs';
import { createHostOnboarding, renderHostOnboardingEmail } from './onboarding.mjs';
import {
  componentReport,
  formatSessionReport,
  openOperatorDatabase,
  readSecret,
  sessionReport,
} from './operations/operator-report.mjs';
import { readConfig } from './server.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const command = process.argv[2];
if (!['invite', 'host-onboarding', 'admin-access', 'managed-source', 'operator-summary', 'operator-status'].includes(command)) {
  console.error('Usage:');
  console.error('  node cli.mjs invite [--role host|player] [--hours 168] [--note "name"]');
  console.error('  node cli.mjs host-onboarding --name "Name" [--hours 48] [--downloads 5] [--format text|json]');
  console.error('  node cli.mjs admin-access list');
  console.error('  node cli.mjs admin-access grant|revoke --user-id UUID');
  console.error('  node cli.mjs managed-source list|register|rotate|disable [--source-id UUID] [--name "Name"]');
  console.error('  node cli.mjs operator-summary [--since-hours 24] [--format text|json]');
  console.error('  node cli.mjs operator-status [--format json]');
  process.exit(1);
}

const databasePath = resolve(process.env.DATABASE_PATH || './data/cannabeats-poc.sqlite');
if (command === 'operator-summary' || command === 'operator-status') {
  let operatorDb;
  try {
    operatorDb = openOperatorDatabase(databasePath);
    if (command === 'operator-summary') {
      const format = argument('format', 'text');
      const report = sessionReport(operatorDb, {
        sinceHours: Number(argument('since-hours', 24)),
        applicationVersion: process.env.CANNABEATS_APP_VERSION || 'unknown',
        catalogVersion: process.env.CANNABEATS_CATALOG_VERSION || 'unknown',
      });
      if (format === 'json') console.log(JSON.stringify(report, null, 2));
      else if (format === 'text') console.log(formatSessionReport(report));
      else throw new Error('Format must be text or json');
    } else {
      const config = readConfig();
      const report = await componentReport({
        db: operatorDb,
        databasePath,
        accessOrigin: config.origin,
        gameOrigin: config.gameServiceOrigin,
        relayOrigin: config.audioRelayOrigin,
        relayListenToken: config.audioRelayListenToken || readSecret(process.env.AUDIO_RELAY_LISTEN_TOKEN_FILE),
      });
      console.log(JSON.stringify(report, null, 2));
    }
  } catch (error) {
    const correlationId = randomUUID();
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'access-operator-cli',
      environment: process.env.CANNABEATS_ENVIRONMENT || 'development',
      event: 'operator.report_failed',
      message: 'Operator report could not be generated',
      correlationId,
      errorType: error instanceof Error ? error.constructor.name : 'Error',
      applicationVersion: process.env.CANNABEATS_APP_VERSION || 'unknown',
      catalogVersion: process.env.CANNABEATS_CATALOG_VERSION || 'unknown',
    }));
    process.exitCode = 1;
  } finally {
    operatorDb?.close();
  }
} else {
  const db = openDatabase(databasePath);
  try {
  if (command === 'invite') {
    const invitation = createInvitation(db, {
      role: argument('role', 'host'),
      ttlHours: Number(argument('hours', process.env.INVITATION_TTL_HOURS || 168)),
      note: argument('note', ''),
    });
    console.log(`Invitation: ${invitation.code}`);
    console.log(`Role: ${invitation.role}`);
    console.log(`Expires: ${new Date(invitation.expiresAt).toISOString()}`);
    console.log('The invitation is shown once; only its SHA-256 digest is stored.');
  } else if (command === 'host-onboarding') {
    const onboarding = createHostOnboarding(db, {
      recipientName: argument('name', ''),
      origin: process.env.APP_ORIGIN || 'http://localhost:3002',
      releasePath: process.env.HOST_RELEASE_PATH || '',
      releaseName: process.env.HOST_RELEASE_NAME || 'CannaBeats-Host-universal.dmg',
      releaseChannel: process.env.HOST_RELEASE_CHANNEL || 'notarized',
      ttlHours: Number(argument('hours', 48)),
      maxDownloads: Number(argument('downloads', 5)),
    });
    const format = argument('format', 'text');
    if (format === 'json') console.log(JSON.stringify(onboarding, null, 2));
    else if (format === 'text') console.log(renderHostOnboardingEmail(onboarding, {
      senderName: argument('sender', process.env.CANNABEATS_INVITATION_SENDER || 'CannaBeats'),
    }));
    else throw new Error('Format must be text or json');
  } else if (command === 'admin-access') {
    const action = process.argv[3];
    if (action === 'list') {
      for (const user of db.prepare('SELECT id, display_name, role FROM users ORDER BY display_name').all()) {
        console.log(JSON.stringify({
          id: user.id,
          displayName: user.display_name,
          role: user.role,
          capabilities: userCapabilities(db, user.id),
        }));
      }
    } else if (['grant', 'revoke'].includes(action)) {
      const userId = argument('user-id', '');
      if (!userId) throw new Error('--user-id is required');
      if (action === 'grant') {
        const granted = grantUserCapability(db, { userId, capability: MANAGE_HOST_INVITATIONS });
        if (granted) writeAuditEvent(db, userId, 'capability.granted', MANAGE_HOST_INVITATIONS);
        console.log(granted
          ? `Granted ${MANAGE_HOST_INVITATIONS} to ${userId}`
          : `${userId} already has ${MANAGE_HOST_INVITATIONS}`);
      } else {
        const revoked = revokeUserCapability(db, { userId, capability: MANAGE_HOST_INVITATIONS });
        if (!revoked) throw new Error('The user did not have that capability');
        writeAuditEvent(db, userId, 'capability.revoked', MANAGE_HOST_INVITATIONS);
        console.log(`Revoked ${MANAGE_HOST_INVITATIONS} from ${userId}`);
      }
    } else {
      throw new Error('admin-access action must be list, grant, or revoke');
    }
  } else {
    const action = process.argv[3];
    const sourceId = argument('source-id', '');
    if (action === 'list') {
      for (const source of db.prepare(`
        SELECT id, display_name, enabled, created_at, last_seen_at
        FROM managed_audio_sources ORDER BY created_at
      `).all()) {
        console.log(JSON.stringify({
          id: source.id,
          displayName: source.display_name,
          enabled: Boolean(source.enabled),
          createdAt: new Date(source.created_at).toISOString(),
          lastSeenAt: source.last_seen_at ? new Date(source.last_seen_at).toISOString() : null,
        }));
      }
    } else if (['register', 'rotate'].includes(action)) {
      const token = randomBytes(32).toString('base64url');
      if (action === 'register') {
        const displayName = String(argument('name', '')).trim().replace(/\s+/g, ' ');
        if (displayName.length < 1 || displayName.length > 80) throw new Error('--name must be 1-80 characters');
        const id = randomUUID();
        db.prepare(`
          INSERT INTO managed_audio_sources
            (id, display_name, token_hash, enabled, created_at)
          VALUES (?, ?, ?, 1, ?)
        `).run(id, displayName, sha256(token), Date.now());
        console.log(JSON.stringify({ sourceId: id, token, shownOnce: true }));
      } else {
        if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new Error('--source-id must be a UUID');
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('DELETE FROM managed_audio_leases WHERE source_id = ?').run(sourceId);
          const result = db.prepare(`
            UPDATE managed_audio_sources
            SET token_hash = ?, enabled = 1, last_seen_at = NULL, device_id = NULL, last_error = NULL
            WHERE id = ?
          `).run(sha256(token), sourceId);
          if (result.changes !== 1) throw new Error('Managed source was not found');
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        console.log(JSON.stringify({ sourceId, token, shownOnce: true, activeLeaseReleased: true }));
      }
    } else if (action === 'disable') {
      if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new Error('--source-id must be a UUID');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('DELETE FROM managed_audio_leases WHERE source_id = ?').run(sourceId);
        const result = db.prepare(`
          UPDATE managed_audio_sources
          SET enabled = 0, last_seen_at = NULL, device_id = NULL, last_error = NULL
          WHERE id = ?
        `).run(sourceId);
        if (result.changes !== 1) throw new Error('Managed source was not found');
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      console.log(JSON.stringify({ sourceId, disabled: true, activeLeaseReleased: true }));
    } else {
      throw new Error('managed-source action must be list, register, rotate, or disable');
    }
  }
  } finally {
    db.close();
  }
}
