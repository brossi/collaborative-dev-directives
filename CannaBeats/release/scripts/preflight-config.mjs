#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RELEASE_CONFIG = Object.freeze({
  CANNABEATS_PUBLIC_ORIGIN: 'https://play.cannabeats.social',
  CANNABEATS_COMPOSE_PROJECT: 'cannabeats',
  CANNABEATS_APP_BUNDLE_ID: 'social.cannabeats.host',
  CANNABEATS_APPLE_TEAM_ID: '6Z9D2757FY',
  CANNABEATS_MIN_MACOS: '14.2',
  CANNABEATS_MAX_ACTIVE_GAMES: '1',
  CANNABEATS_MAX_PARTICIPANTS: '8',
  CANNABEATS_DIAGNOSTIC_RETENTION_DAYS: '7',
  CANNABEATS_SQLITE_BACKUP_RETENTION_DAYS: '14',
  CANNABEATS_RELEASES_DIR: '/opt/cannabeats/releases',
  CANNABEATS_CURRENT_DIR: '/opt/cannabeats/current',
  CANNABEATS_DATA_DIR: '/var/lib/cannabeats',
  CANNABEATS_DATABASE_PATH: '/var/lib/cannabeats/cannabeats.sqlite3',
  CANNABEATS_BACKUP_DIR: '/var/backups/cannabeats/sqlite',
  CANNABEATS_SECRETS_DIR: '/etc/cannabeats/secrets',
  CANNABEATS_RELAY_INGEST_TOKEN_HOST_FILE:
    '/etc/cannabeats/secrets/relay-ingest-token',
  CANNABEATS_RELAY_LISTEN_TOKEN_HOST_FILE:
    '/etc/cannabeats/secrets/relay-listen-token',
  CANNABEATS_RELAY_ORIGIN: 'http://relay:8080',
});

const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function issue(code, name, line) {
  return Object.freeze({ code, ...(name ? { name } : {}), ...(line ? { line } : {}) });
}

export function parseReleaseConfig(text) {
  const values = Object.create(null);
  const issues = [];
  const lines = String(text).split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator < 1) {
      issues.push(issue('malformed', undefined, index + 1));
      continue;
    }

    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!NAME_PATTERN.test(name)) {
      issues.push(issue('malformed', undefined, index + 1));
      continue;
    }
    if (!Object.hasOwn(RELEASE_CONFIG, name)) {
      issues.push(issue('unknown', name, index + 1));
      continue;
    }
    if (Object.hasOwn(values, name)) {
      issues.push(issue('duplicate', name, index + 1));
      continue;
    }
    values[name] = value;
  }

  return Object.freeze({ values: Object.freeze(values), issues: Object.freeze(issues) });
}

export function validateReleaseConfig(text) {
  const parsed = parseReleaseConfig(text);
  const issues = [...parsed.issues];

  for (const [name, expected] of Object.entries(RELEASE_CONFIG)) {
    if (!Object.hasOwn(parsed.values, name) || parsed.values[name] === '') {
      issues.push(issue('missing', name));
    } else if (parsed.values[name] !== expected) {
      issues.push(issue('invalid', name));
    }
  }

  return Object.freeze({
    status: issues.length === 0 ? 'valid' : 'invalid',
    variableCount: Object.keys(RELEASE_CONFIG).length,
    issues: Object.freeze(issues),
  });
}

export function formatIssues(issues) {
  return issues.map(({ code, name, line }) => {
    const location = line ? ` at line ${line}` : '';
    const field = name ? `: ${name}` : '';
    return `- ${code}${field}${location}`;
  }).join('\n');
}

function readArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--env-file' || !argv[1]) {
    return Object.freeze({ status: 'invalid' });
  }
  return Object.freeze({ status: 'valid', path: argv[1] });
}

export function runPreflight(argv = process.argv.slice(2), read = readFileSync) {
  const argumentsResult = readArguments(argv);
  if (argumentsResult.status !== 'valid') {
    return Object.freeze({ status: 'invalid_arguments' });
  }

  let text;
  try {
    text = read(argumentsResult.path, 'utf8');
  } catch {
    return Object.freeze({ status: 'unreadable' });
  }
  return validateReleaseConfig(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runPreflight();
  if (result.status === 'valid') {
    process.stdout.write(`release_configuration_valid (${result.variableCount} variables)\n`);
  } else if (result.status === 'invalid') {
    process.stderr.write(`release_configuration_invalid\n${formatIssues(result.issues)}\n`);
    process.exitCode = 1;
  } else {
    process.stderr.write(`release_configuration_${result.status}\n`);
    process.exitCode = 1;
  }
}
