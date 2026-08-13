import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = mkdtempSync(join(tmpdir(), 'cannabeats-scheduler-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('scheduled backup and component checks have layered timeouts and local alerts', () => {
  const backup = readFileSync(resolve('deploy/cannabeats-backup.service'), 'utf8');
  const operations = readFileSync(resolve('deploy/cannabeats-operations-check.service'), 'utf8');
  const timer = readFileSync(resolve('deploy/cannabeats-operations-check.timer'), 'utf8');
  const history = readFileSync(resolve('deploy/cannabeats-history-retention.service'), 'utf8');
  const historyTimer = readFileSync(resolve('deploy/cannabeats-history-retention.timer'), 'utf8');
  for (const unit of [backup, operations, history]) {
    assert.match(unit, /^OnFailure=cannabeats-operations-alert@%n\.service$/m);
    assert.match(unit, /^TimeoutStartSec=\d+/m);
    assert.match(unit, /^RuntimeMaxSec=\d+/m);
  }
  assert.match(timer, /^OnUnitInactiveSec=15m$/m);
  assert.match(historyTimer, /^OnCalendar=\*-\*-\* 04:10:00$/m);
  assert.match(historyTimer, /^Persistent=true$/m);
  assert.match(history, /^Requires=docker\.service cannabeats-backup\.service$/m);
  assert.match(history, /^After=docker\.service cannabeats-backup\.service$/m);
  const backupScript = readFileSync(resolve('deploy/run-backup.sh'), 'utf8');
  const operationsScript = readFileSync(resolve('deploy/run-operations-check.sh'), 'utf8');
  const historyScript = readFileSync(resolve('deploy/run-history-retention.sh'), 'utf8');
  const compose = readFileSync(resolve('compose.yaml'), 'utf8');
  const release = readFileSync(resolve('deploy/release.sh'), 'utf8');
  const stateDockerfile = readFileSync(resolve('../../state-service/Dockerfile'), 'utf8');
  assert.match(backupScript, /CANNABEATS_BACKUP_TIMEOUT_SECONDS/);
  assert.match(backupScript, /exec "\$timeout_command" --foreground --kill-after=/);
  assert.match(operationsScript, /CANNABEATS_OPERATIONS_TIMEOUT_SECONDS/);
  assert.match(operationsScript, /exec "\$timeout_command" --foreground --kill-after=/);
  assert.match(historyScript, /CANNABEATS_GAME_HISTORY_RETENTION_DAYS/);
  assert.match(historyScript, /run --rm --no-deps history[\s\\]+purge --retention-days/);
  assert.match(compose, /history:\s+[\s\S]*CANNABEATS_STATE_IMAGE/);
  assert.match(compose, /history:\s+[\s\S]*CANNABEATS_STATE_SERVICE_ORIGIN/);
  const historyService = compose.slice(compose.indexOf('  history:'),compose.indexOf('  operator:'));
  assert.doesNotMatch(historyService, /cannabeats_poc_data:\/data/);
  assert.match(operationsScript,/operator operator-status --format json --fail-on unavailable/);
  const operatorService = compose.slice(compose.indexOf('  operator:'),compose.indexOf('\nvolumes:'));
  assert.match(operatorService,/cannabeats_poc_data:\/data:ro/);
  assert.doesNotMatch(operatorService,/state-operator-token/);
  assert.doesNotMatch(release, /services:\s+[\s\S]*history:\s+[\s\S]*image:/);
  assert.match(stateDockerfile, /COPY --chown=node:node state-service\/scripts/);
  const runbook = readFileSync(resolve('../../docs/operations/baseline-protection.md'), 'utf8');
  assert.match(runbook, /install -d -o root -g root -m 0750 \/etc\/cannabeats/);
  assert.match(runbook, /systemctl start cannabeats-history-retention\.service/);
  assert.match(runbook, /systemctl show cannabeats-history-retention\.service[^\n]*Result/);
  const slicePlan = readFileSync(resolve('../../docs/slice-2-game-night-resilience.md'), 'utf8');
  assert.match(slicePlan, /retention assets are installable/i);
  assert.match(slicePlan, /Linux systemd\/Docker rehearsal remains\s+an S2-F gate/i);
});

test('a command timeout remains a scheduler failure exit', async () => {
  const composeDirectory = join(root, 'compose');
  const fakeTimeout = join(root, 'timeout');
  mkdirSync(composeDirectory, { recursive: true });
  writeFileSync(join(composeDirectory, 'compose.yaml'), 'services: {}\n');
  writeFileSync(fakeTimeout, '#!/usr/bin/env bash\nexit 124\n');
  chmodSync(fakeTimeout, 0o755);
  await assert.rejects(
    run(resolve('deploy/run-operations-check.sh'), [], {
      env: {
        ...process.env,
        CANNABEATS_COMPOSE_DIR: composeDirectory,
        CANNABEATS_RELEASE_DIR: join(root,'timeout-release-lock'),
        CANNABEATS_TIMEOUT_COMMAND: fakeTimeout,
      },
    }),
    (error) => error.code === 124,
  );
});

test('scheduled backup shares the release and rollback operation fence', async () => {
  const composeDirectory = join(root,'locked-compose');
  const releaseDirectory = join(root,'locked-release');
  mkdirSync(composeDirectory,{ recursive: true });
  mkdirSync(join(releaseDirectory,'operation.lock'),{ recursive: true });
  writeFileSync(join(composeDirectory,'compose.yaml'),'services: {}\n');
  await assert.rejects(run(resolve('deploy/run-backup.sh'),[],{ env: {
    ...process.env,CANNABEATS_COMPOSE_DIR: composeDirectory,
    CANNABEATS_RELEASE_DIR: releaseDirectory,CANNABEATS_TIMEOUT_COMMAND: '/usr/bin/true',
  }}),(error) => /coordinated backup is active/i.test(error.stderr));
});

test('the local failure notifier creates an actionable durable alert without unit output', async () => {
  const alerts = join(root, 'alerts');
  const fakeSystemctl = join(root, 'systemctl');
  writeFileSync(fakeSystemctl, `#!/usr/bin/env bash
case "$*" in
  *ExecMainStatus*) echo 1 ;;
  *ActiveState*) echo failed ;;
  *) echo failed ;;
esac
`);
  chmodSync(fakeSystemctl, 0o755);
  await run(resolve('deploy/local-operations-alert.sh'), ['cannabeats-backup.service'], {
    env: {
      ...process.env,
      CANNABEATS_ALERT_DIRECTORY: alerts,
      CANNABEATS_SYSTEMCTL: fakeSystemctl,
    },
  });
  const alert = readFileSync(join(alerts, 'cannabeats-backup.service.failed'), 'utf8');
  assert.match(alert, /journalctl -u cannabeats-backup\.service/);
  assert.match(alert, /systemctl start cannabeats-backup\.service/);
  assert.doesNotMatch(alert, /environment|token|passphrase/i);
});

test('rendered cutover topology gives only State runtime write authority', async () => {
  const { stdout } = await run(process.execPath,[resolve('deploy/verify-state-cutover.mjs')]);
  const topology = JSON.parse(stdout);
  assert.equal(topology.stateWriter,'state');
  assert.deepEqual(topology.gameDatabaseMounts,[]);
  assert.deepEqual(topology.historyDatabaseMounts,[]);
  assert.equal(topology.migrationSourceReadOnly,true);
});

test('scheduled state-era backup and retention load the coordinated cutover topology', async () => {
  const composeDirectory = join(root,'state-compose');
  const releaseDirectory = join(root,'state-releases');
  const fakeTimeout = join(root,'state-timeout');
  const invocationLog = join(root,'state-timeout.log');
  mkdirSync(composeDirectory,{ recursive: true });
  mkdirSync(releaseDirectory,{ recursive: true });
  writeFileSync(join(composeDirectory,'compose.yaml'),'services: {}\n');
  writeFileSync(join(composeDirectory,'compose.state-cutover.yaml'),'services: {}\n');
  writeFileSync(join(releaseDirectory,'current-compose.yaml'),`x-cannabeats-release:
  state-cutover: true
  release-epoch: epoch-test
services: {}
`);
  writeFileSync(fakeTimeout,`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${invocationLog}"
`);
  chmodSync(fakeTimeout,0o755);
  const environment = {
    ...process.env,CANNABEATS_COMPOSE_DIR: composeDirectory,
    CANNABEATS_RELEASE_OVERRIDE: join(releaseDirectory,'current-compose.yaml'),
    CANNABEATS_RELEASE_DIR: releaseDirectory,
    CANNABEATS_TIMEOUT_COMMAND: fakeTimeout,
  };
  await run(resolve('deploy/run-backup.sh'),[],{ env: environment });
  await run(resolve('deploy/run-history-retention.sh'),[],{ env: environment });
  const invocations = readFileSync(invocationLog,'utf8');
  assert.match(invocations,/compose\.state-cutover\.yaml.*--profile state-cutover --profile operations.*backup run/);
  assert.match(invocations,/compose\.state-cutover\.yaml.*--profile state-cutover --profile operations.*history purge/);
});
