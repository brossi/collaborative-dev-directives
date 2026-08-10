#!/usr/bin/env node
import { resolve } from 'node:path';
import { createInvitation, openDatabase } from './db.mjs';
import { createHostOnboarding, renderHostOnboardingEmail } from './onboarding.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const command = process.argv[2];
if (!['invite', 'host-onboarding'].includes(command)) {
  console.error('Usage:');
  console.error('  node cli.mjs invite [--role host|player] [--hours 168] [--note "name"]');
  console.error('  node cli.mjs host-onboarding --name "Name" [--hours 48] [--downloads 5] [--format text|json]');
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
  } else {
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
    else if (format === 'text') console.log(renderHostOnboardingEmail(onboarding));
    else throw new Error('Format must be text or json');
  }
} finally {
  db.close();
}
