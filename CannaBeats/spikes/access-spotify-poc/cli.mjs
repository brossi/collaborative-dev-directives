#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  createInvitation,
  grantUserCapability,
  MANAGE_HOST_INVITATIONS,
  openDatabase,
  revokeUserCapability,
  userCapabilities,
  writeAuditEvent,
} from './db.mjs';
import { createHostOnboarding, renderHostOnboardingEmail } from './onboarding.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const command = process.argv[2];
if (!['invite', 'host-onboarding', 'admin-access'].includes(command)) {
  console.error('Usage:');
  console.error('  node cli.mjs invite [--role host|player] [--hours 168] [--note "name"]');
  console.error('  node cli.mjs host-onboarding --name "Name" [--hours 48] [--downloads 5] [--format text|json]');
  console.error('  node cli.mjs admin-access list');
  console.error('  node cli.mjs admin-access grant|revoke --user-id UUID');
  process.exit(1);
}

const databasePath = resolve(process.env.DATABASE_PATH || './data/cannabeats-poc.sqlite');
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
      ttlHours: Number(argument('hours', 48)),
      maxDownloads: Number(argument('downloads', 5)),
    });
    const format = argument('format', 'text');
    if (format === 'json') console.log(JSON.stringify(onboarding, null, 2));
    else if (format === 'text') console.log(renderHostOnboardingEmail(onboarding, {
      senderName: argument('sender', process.env.CANNABEATS_INVITATION_SENDER || 'CannaBeats'),
    }));
    else throw new Error('Format must be text or json');
  } else {
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
  }
} finally {
  db.close();
}
