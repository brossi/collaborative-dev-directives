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
  for (const unit of [backup, operations]) {
    assert.match(unit, /^OnFailure=cannabeats-operations-alert@%n\.service$/m);
    assert.match(unit, /^TimeoutStartSec=\d+/m);
    assert.match(unit, /^RuntimeMaxSec=\d+/m);
  }
  assert.match(timer, /^OnUnitInactiveSec=15m$/m);
  const backupScript = readFileSync(resolve('deploy/run-backup.sh'), 'utf8');
  const operationsScript = readFileSync(resolve('deploy/run-operations-check.sh'), 'utf8');
  assert.match(backupScript, /CANNABEATS_BACKUP_TIMEOUT_SECONDS/);
  assert.match(backupScript, /exec "\$timeout_command" --foreground --kill-after=/);
  assert.match(operationsScript, /CANNABEATS_OPERATIONS_TIMEOUT_SECONDS/);
  assert.match(operationsScript, /exec "\$timeout_command" --foreground --kill-after=/);
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
        CANNABEATS_TIMEOUT_COMMAND: fakeTimeout,
      },
    }),
    (error) => error.code === 124,
  );
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
