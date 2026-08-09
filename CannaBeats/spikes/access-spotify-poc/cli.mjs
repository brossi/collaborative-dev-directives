#!/usr/bin/env node
import { resolve } from 'node:path';
import { createInvitation, openDatabase } from './db.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const command = process.argv[2];
if (command !== 'invite') {
  console.error('Usage: node cli.mjs invite [--role host|player] [--hours 168] [--note "name"]');
  process.exit(1);
}

const databasePath = resolve(process.env.DATABASE_PATH || './data/cannabeats-poc.sqlite');
const db = openDatabase(databasePath);
const invitation = createInvitation(db, {
  role: argument('role', 'host'),
  ttlHours: Number(argument('hours', process.env.INVITATION_TTL_HOURS || 168)),
  note: argument('note', ''),
});

console.log(`Invitation: ${invitation.code}`);
console.log(`Role: ${invitation.role}`);
console.log(`Expires: ${new Date(invitation.expiresAt).toISOString()}`);
console.log('The invitation is shown once; only its SHA-256 digest is stored.');
db.close();
