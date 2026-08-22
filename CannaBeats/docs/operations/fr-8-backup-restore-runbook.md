# FR-8 backup, restore, and operator runbook

This is the fixed first-release procedure for one CannaBeats Droplet. Commands
run from the immutable operator tree at `/opt/cannabeats/operator`; FR-10 owns
installing that tree and enabling the checked-in systemd units.

The application backup directory is root-only plaintext. That is intentional:
it is a local recovery artifact protected by host permissions and DigitalOcean
volume backups, not another passphrase ceremony. It contains the SQLite
database, both relay credentials, and exact release metadata. The independently
generated operator token is not portable authority and is regenerated on a
replacement host.

## Routine checks and backup

Run the redacted service/database status and active-game summary:

```sh
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs status
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs active-game
```

The CLI reads `/etc/cannabeats/secrets/operator-token` itself. Never copy that
file or pass its value in a command.

`cannabeats-backup.timer` runs one verified daily online backup at 05:00 UTC,
with a persistent timer and up to 20 minutes of randomized delay. An ordinary
on-demand backup uses the same daily identity:

```sh
sudo node /opt/cannabeats/operator/release/scripts/backup.mjs daily
```

List available payloads newest first, then verify the selected payload before
any restore:

```sh
sudo node /opt/cannabeats/operator/release/scripts/backup.mjs list
sudo node /opt/cannabeats/operator/release/scripts/backup.mjs verify --backup-id BACKUP_ID
```

The list contains only backup ID, creation time, reason, and release ID. It
contains no path, token, participant/Host identity, game ID, or track metadata.
Retention keeps the newest 14 routine daily/manual payloads and one separately
reserved newest pre-release/pre-rollback payload. A manual backup can displace
only the oldest routine payload, never the pre-change reserve. Historical
backup and sequenced redundant restore receipts remain so an exact retry cannot
create another effect or reuse an old request identity.

## Restore an existing host

Restore deliberately replaces the live database and both relay credentials
with the selected backup. Finish or explicitly abandon any game state that
should not be discarded, list and verify the backup, then retain one nonsecret
request ID for the complete attempt:

```sh
restore_request_id="sha256:$(openssl rand -hex 32)"
sudo node /opt/cannabeats/operator/release/scripts/restore.mjs restore \
  --backup-id BACKUP_ID --request-id "$restore_request_id"
```

Do not mint a new request ID after response loss. Repeat the exact command; it
returns the original receipt. Restore validates the bundle while service is
available, stages files, records its journal, stops the exact release, verifies
again, installs and proves the backed release, publishes release authority,
and only then removes rollback files.

If the command is interrupted or reports a rollback failure, preserve the
backup and journal and run:

```sh
sudo node /opt/cannabeats/operator/release/scripts/restore.mjs reconcile
sudo node /opt/cannabeats/operator/release/scripts/release-operations.mjs reconcile
```

Run them in that order. The checked-in boot reconciliation unit does the same
before daily backup after a host restart. Do not delete `.restore-journal.json`
or any `.restore-old-*`/`.restore-new-*` file manually.

After success, require all of the following:

```sh
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs status
sudo node /opt/cannabeats/operator/release/scripts/backup.mjs verify --backup-id BACKUP_ID
curl --fail --silent --show-error https://play.cannabeats.social/api/ready
```

The status must be ready, reconciliation must have no pending operation, and
the selected backup must still verify.

## Bootstrap and authority-reducing commands

For first-device or all-devices-lost recovery, create a random URL-safe code in
the operator's password generator, keep it only long enough to enter it on the
Mac, and pass it through standard input:

```sh
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs \
  bootstrap-enrollment --request-id UUIDv4 --code-fd 0
```

The command waits for the code on standard input and prints only the finite
result and expiry. It never prints the code or operator token.

Revoke a known lost-device UUID or purge only disposable diagnostic rows:

```sh
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs \
  revoke-device --request-id UUIDv4 --device-id UUIDv4
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs purge-diagnostics
```

Device revocation is permanent. If that device owns an unfinished game, the
same transaction abandons the game and releases the single-game slot. Complete
the game first if its current state should remain playable. Diagnostic purge
does not alter game, playback, audio, result, or authority evidence.

## Blank replacement host

FR-10 must rehearse these steps on a disposable replacement Droplet before the
first release:

1. Provision the documented Linux/Node/Docker inputs and install the exact
   operator tree and systemd units from the backed release's source revision.
2. Run `initialize-host.sh`. This creates fixed directories and a new
   server-local operator token; its placeholder relay tokens will be replaced
   by restore.
3. Recover `/var/backups/cannabeats/sqlite` from the protected Droplet backup
   source with root ownership and no symlinks or extra files.
4. Run `backup.mjs list` and `verify` for the selected backup.
5. Run `restore.mjs restore` with one retained request ID. The backed release
   record is registered from the bundle even when the release owner starts
   blank.
6. Run restore reconciliation, release reconciliation, redacted status,
   public readiness, Host bootstrap enrollment, and one browser/Host smoke
   journey before changing DNS or destroying the recovery source.

DigitalOcean automated-backup enablement and the destructive rehearsal are
external FR-10 evidence. Their absence must not be represented as an FR-8 local
test pass.
