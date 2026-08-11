# Baseline protection runbook

- Scope: CannaBeats access, game, catalog, shared SQLite data, and managed audio source
- Status: implementation and disposable-host rehearsal baseline; production values still require first-deployment validation
- Related plan: [Slice 1: Baseline protection](../slice-1-baseline-protection.md)
- Rehearsal evidence: [P2-E real-environment rehearsal — 2026-08-11](slice-1-p2e-rehearsal-2026-08-11.md)

The current PoC shares a Droplet with unrelated `vw-services` workloads, but
the target durable deployment is a dedicated CannaBeats Droplet. This runbook
deliberately operates only the CannaBeats Compose project during that
transition. Release and rollback commands use `--no-deps app game`; they do not
restart, replace, or migrate sibling workloads while the shared host remains in
service. A recovery or rehearsal target must be a clean dedicated host rather
than a disk clone containing the unrelated projects.

The 2026-08-11 P2-E rehearsal validated this boundary on a fresh private-only
application host and a separate fresh managed-source host. It did not clone the
shared application Droplet or the source browser profile. That rehearsal is not
the durable deployment: its backup destination and hosts are temporary, and
the checked values below remain gates for the dedicated production move.

Provider images may be retained only as sanitized provisioning accelerators.
They are not application-data backups, secret recovery artifacts, or a way to
preserve a configured managed source. Before imaging an application host,
remove plaintext databases, site-local secrets, backup passphrases, encrypted
backups that could be paired with an on-host passphrase, session artifacts, and
temporary rehearsal state. Before imaging a source host, revoke its disposable
registration and remove the entire browser profile, Spotify authorization,
source and relay tokens, VNC password, Tailscale identity, and temporary
network bridges. Power off the sanitized host, create and verify the provider
image, and retain it only if path-based and literal secret checks pass. A host
restored from such an image must receive new credentials, registration,
tailnet identity, browser profile, and interactive Spotify authorization.

Use the checked-in sanitizer before creating a provider image. It is dry-run by
default and refuses execution unless the actual hostname matches the explicit
expected value. Revoke the source registration through the application role
before sanitizing the source host:

```sh
sudo tools/sanitize-rehearsal-host.sh \
  --role application \
  --expected-hostname APPLICATION_HOSTNAME \
  --source-id DISPOSABLE_SOURCE_UUID

sudo tools/sanitize-rehearsal-host.sh \
  --role managed-source \
  --expected-hostname SOURCE_HOSTNAME
```

Review both manifests, then repeat each command with `--execute`. Execution
stops the role's services, overwrites and removes only its fixed sensitive-path
allowlist, clears cloud/SSH identity, and runs filesystem trim. Existing SSH
sessions survive long enough for in-session assertions, but new SSH sessions
are intentionally unavailable after host keys and authorized keys are removed.
Power off through the provider API, snapshot, and prove the result by launching
a private-only disposable restore with a newly injected SSH key. DigitalOcean
private-only restores should set `--droplet-agent=false` unless controlled
public egress is available; otherwise its vendor monitoring-agent download can
hold cloud-init's final stage open. Verify the clone, destroy only the clone,
and retain the sanitized image according to the operator's image-retention
decision.

## Recovery inventory

| Asset | Authoritative location | Protection and recovery |
| --- | --- | --- |
| Accounts, passkeys, capabilities, sessions, invitations, desktop/host authorizations, lobbies, runs, and managed-source registration/state | `cannabeats_poc_data`, `/data/cannabeats-poc.sqlite` | Nightly online SQLite snapshot, AES-256-GCM encrypted and authenticated; 14 copies by default |
| Application and catalog source | Git repository and immutable release commit | Build from a named commit; the checked-in catalog manifest identifies its exact source and output hashes |
| Running application/catalog identity | `/var/lib/cannabeats/releases/current-compose.yaml` | Release script records immutable application and catalog values; previous values remain in `previous-compose.yaml` |
| Compose/Caddy/systemd configuration | Git plus the deployed checkout | Restore the named commit, review the site-local `.env`, and reinstall checked-in units/configuration |
| Host installer artifact | Host path mounted at `/releases` | Preserve in the release artifact store; it is not in SQLite |
| Secret files | Site-local root-owned secret directory and source/relay hosts | Inventory and rotate independently; never commit or print values |
| Managed-source software and units | Git, `spikes/managed-audio-source-poc` | Rebuild on a fresh node with cloud-init and `infra/install-runtime.sh` |
| Managed Spotify authorization | Chrome profile on the dedicated source node | Intentionally excluded from backups and snapshots; authorize interactively on replacement |
| TLS private material | Caddy-managed host state | Let Caddy reacquire after DNS/config recovery; do not copy it into application backups |

SQLite WAL state is included safely because the backup command uses SQLite's online backup API while writers may remain connected rather than copying database files. New artifacts use the streaming version-2 binary envelope; the authenticated header records the application version, catalog version, database digest, schema version, and table list. Verification and restore retain read compatibility with version-1 JSON envelopes. Neither format contains application secret files or the managed browser profile.

Before the first durable deployment, replace the PoC defaults and record the checked values in the private operator record:

- [ ] Compose checkout path and named-volume identity
- [ ] Separately mounted or off-host backup destination with adequate retention capacity
- [ ] Release artifact and host-installer locations
- [ ] Public application, game, and relay origins; WebAuthn RP ID; DNS ownership
- [ ] Caddy state/reacquisition and certificate-renewal behavior
- [ ] Secret owners and modes from the inventory below
- [ ] Managed-source node identity, tailnet access, and provider transfer-usage limit
- [ ] Confirmation that unrelated `vw-services` containers are not in this Compose project

## Backup installation and operation

The backup container has no network, mounts the database volume read-only, writes encrypted artifacts to the configured backup directory, and uses a container-scoped anonymous `/scratch` volume for the temporary plaintext SQLite snapshot. The scratch volume is not the bounded `/tmp` tmpfs and is removed with the one-shot container. Use a backup destination that survives loss of the application host, such as a separately mounted protected volume or encrypted off-host filesystem. A directory on the root disk is acceptable only for a local rehearsal.

1. Create a random passphrase without writing it to shell history and install it as `backup-passphrase` in the site-local secret directory. It must be at least 20 bytes. Keep an independent recovery copy in the operator password manager. The host directory is root-owned mode `0700`; individually mounted container secret files are root-owned mode `0444` inside that non-traversable directory so the unprivileged container account can read only its explicitly mounted files.
2. Set `CANNABEATS_BACKUP_DIR` in the site `.env` to the mounted recovery destination. Create that directory mode `0700` and owned by the container's numeric node UID/GID (1000 in the checked-in image) so the network-disabled backup container can write it.
3. Install the scheduler:

   ```sh
   sudo install -o root -g root -m 0755 deploy/run-backup.sh /usr/local/sbin/cannabeats-backup
   sudo install -o root -g root -m 0755 deploy/run-operations-check.sh /usr/local/sbin/cannabeats-operations-check
   sudo install -o root -g root -m 0755 deploy/local-operations-alert.sh /usr/local/sbin/cannabeats-local-operations-alert
   sudo install -o root -g root -m 0644 \
     deploy/cannabeats-backup.service deploy/cannabeats-backup.timer \
     deploy/cannabeats-operations-check.service deploy/cannabeats-operations-check.timer \
     deploy/cannabeats-operations-alert@.service /etc/systemd/system/
   sudo install -o root -g root -m 0600 deploy/backup.env.example /etc/cannabeats/backup.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now cannabeats-backup.timer cannabeats-operations-check.timer
   sudo systemctl start cannabeats-backup.service
   sudo systemctl start cannabeats-operations-check.service
   sudo systemctl status cannabeats-backup.service --no-pager
   sudo systemctl status cannabeats-operations-check.service --no-pager
   ```

4. Verify that the destination contains a `cannabeats-YYYY-MM-DDTHHMMSSZ.cbbackup` file with mode `0600`. Creation streams encryption to a hidden same-directory file, flushes it, and atomically links the completed artifact into its final name without overwriting an existing file. The `run` command verifies the newly created backup and authenticates every recognized retained artifact before pruning. One corrupt or foreign artifact with a recognized backup filename stops all deletion. Retention refuses fewer than 2 or more than 365 copies and ignores unrelated filenames.

Inspect scheduling and bounded logs:

```sh
systemctl list-timers cannabeats-backup.timer cannabeats-operations-check.timer
journalctl -u cannabeats-backup.service -u cannabeats-operations-check.service --since today
sudo find /var/lib/cannabeats/alerts -maxdepth 1 -type f -name '*.failed' -print
docker inspect --format '{{json .HostConfig.LogConfig}}' cannabeats-access-poc cannabeats-game
```

The backup command has a 25-minute command timeout inside a 30-minute systemd
ceiling. Component checks run every 15 minutes with a 60-second command timeout
inside a 90-second systemd ceiling. The component job exits nonzero only for an
`unavailable` component; degraded optional-source state remains visible without
paging the local scheduler.

Either unit's failure starts `cannabeats-operations-alert@.service`, which
atomically writes a mode-`0600` alert under `/var/lib/cannabeats/alerts`. The
file contains only unit state and exact `journalctl`, retry, and clear commands;
it never copies unit output, environment, tokens, or passphrases. Inspect the
journal, correct the cause, rerun the named service, confirm success, and only
then run the alert file's narrowly scoped `clear` command. This is a durable
local notification path, not an email or hosted-monitoring promise.

Application containers retain three 10 MiB `json-file` segments each. Do not treat these short-lived logs as a backup or game history.

## Restore rehearsal

Rehearse at least quarterly and after backup-format, schema, or deployment changes. Never target the live database path.

```sh
rehearsal_dir="$(mktemp -d /var/tmp/cannabeats-restore-rehearsal.XXXXXX)"
sudo chown 1000:1000 "$rehearsal_dir"
sudo chmod 0700 "$rehearsal_dir"
docker compose --profile operations run --rm backup verify \
  --backup /backups/BACKUP_FILE \
  --passphrase-file /run/secrets/cannabeats/backup-passphrase
docker compose --profile operations run --rm \
  --volume "$rehearsal_dir:/restore" backup restore \
  --backup /backups/BACKUP_FILE \
  --output /restore/cannabeats-poc.sqlite \
  --passphrase-file /run/secrets/cannabeats/backup-passphrase

export CANNABEATS_REHEARSAL_DATA_DIR="$rehearsal_dir"
export CANNABEATS_REHEARSAL_APP_VERSION=APPLICATION_VERSION
export CANNABEATS_REHEARSAL_CATALOG_VERSION=CATALOG_SHA256
export GAME_SERVICE_TOKEN_HOST_FILE=/ABSOLUTE/PATH/TO/game-service-token
rehearsal_project="cannabeats-restore-$(date -u +%Y%m%d%H%M%S)"
docker compose -p "$rehearsal_project" \
  -f deploy/restore-rehearsal.compose.yaml up --build -d
curl -fsS http://127.0.0.1:3102/api/ready
curl -fsS http://127.0.0.1:3103/game/api/ready
docker compose -p "$rehearsal_project" \
  -f deploy/restore-rehearsal.compose.yaml exec app \
  node cli.mjs operator-summary --since-hours 24
docker compose -p "$rehearsal_project" \
  -f deploy/restore-rehearsal.compose.yaml down
```

The standalone rehearsal definition has no fixed container names, uses ports 3102/3103 by default, and bind-mounts only the newly created rehearsal directory. It does not reference the live named volume. The restore command refuses an existing output, authenticates the envelope, compares its SHA-256 digest, then runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.

For a full disposable smoke test, mount the restored file as `/data/cannabeats-poc.sqlite` in an isolated Compose project with different loopback ports. Confirm:

- expected account, capability, authorization, lobby, run, and audit row counts;
- `GET /api/ready` and `GET /game/api/ready` return success;
- operator summary opens the database read-only;
- the catalog version in the release override matches `web/data/catalog-manifest.json`;
- no invitation, session, source, or relay token appears in logs or the report.

Record the source backup timestamp (the recovery point), application/catalog versions, backup and restore duration, table/count comparison, integrity result, omissions, and operator. Delete the disposable plaintext restore after the rehearsal using a narrowly scoped path.

### Installing a rehearsed restore after data loss

Only install the exact plaintext file that passed the isolated rehearsal. This procedure preserves the former volume and changes no sibling service:

```sh
cd /opt/cannabeats/CannaBeats/spikes/access-spotify-poc
test -f "$rehearsal_dir/cannabeats-poc.sqlite"
current=/var/lib/cannabeats/releases/current-compose.yaml
test -f "$current"
configured_volume="$(awk -F= '$1 == "CANNABEATS_DATA_VOLUME" { print $2 }' .env | tail -n 1)"
old_volume="$(docker volume inspect --format '{{.Name}}' "${configured_volume:-cannabeats_poc_data}")"
new_volume="cannabeats_restore_$(date -u +%Y%m%dT%H%M%SZ)"
docker volume create "$new_volume"
app_image="$(docker inspect --format '{{.Image}}' cannabeats-access-poc)"
docker run --rm --user 0 --entrypoint node \
  --volume "$new_volume:/target" \
  --volume "$rehearsal_dir:/source:ro" \
  "$app_image" -e \
  'const fs=require("node:fs"); fs.copyFileSync("/source/cannabeats-poc.sqlite","/target/cannabeats-poc.sqlite"); fs.chownSync("/target/cannabeats-poc.sqlite",1000,1000); fs.chmodSync("/target/cannabeats-poc.sqlite",0o600)'

docker compose -f compose.yaml -f "$current" stop app game
saved_env=".env.before-restore.$(date -u +%Y%m%dT%H%M%SZ)"
sudo cp -p .env "$saved_env"
awk -v volume="$new_volume" '
  BEGIN { replaced=0 }
  /^CANNABEATS_DATA_VOLUME=/ { print "CANNABEATS_DATA_VOLUME=" volume; replaced=1; next }
  { print }
  END { if (!replaced) print "CANNABEATS_DATA_VOLUME=" volume }
' .env > .env.restore-candidate
sudo install -o root -g root -m 0600 .env.restore-candidate .env
rm -- .env.restore-candidate
docker compose -f compose.yaml -f "$current" up -d --no-deps app game
curl -fsS http://127.0.0.1:3002/api/ready
curl -fsS http://127.0.0.1:3003/game/api/ready
```

If either readiness check fails, restore the saved `.env`, start `app game` again with `current-compose.yaml`, and investigate while retaining both volumes. Delete neither `$old_volume` nor the encrypted backup until the restored service has passed the smoke test and an additional verified backup has completed.

The automated fixture rehearsal for this slice uses a clean SQLite target, restores a known account, validates integrity and foreign keys, proves the encrypted file does not contain the account display name, rejects a wrong passphrase/tampering, and proves overwrite protection. Production recovery point and timings remain a deployment gate, not a claim made by local tests.

## Release and rollback

The release identity is an immutable Git commit or equivalent 7–80 character artifact identifier. The catalog identity is read from the checked-in manifest:

```sh
cd /opt/cannabeats/CannaBeats/spikes/access-spotify-poc
npm --prefix ../../web run catalog:check
node -p "require('../../web/data/catalog-manifest.json').catalogVersion"

# Required for the first P2-managed release or adoption of P1 release records.
# The P1 checkpoint has reviewed compatibility 0-1; TARGET is the observed value.
schema_version="$(docker compose --profile operations run --rm --no-deps \
  --entrypoint node backup -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.DATABASE_PATH, { readOnly: true });
    process.stdout.write(String(db.prepare("PRAGMA user_version").get().user_version));
    db.close();
  ')"
sudo env \
  CANNABEATS_COMPOSE_DIR=/opt/cannabeats/CannaBeats/spikes/access-spotify-poc \
  CANNABEATS_BOOTSTRAP_SCHEMA_MIN_VERSION=0 \
  CANNABEATS_BOOTSTRAP_SCHEMA_MAX_VERSION=1 \
  CANNABEATS_BOOTSTRAP_SCHEMA_TARGET_VERSION="$schema_version" \
  deploy/release.sh APPLICATION_VERSION CATALOG_SHA256
```

The bootstrap variables are required only until the atomic P2 state has been initialized. Checked-in [release.env.example](../../spikes/access-spotify-poc/deploy/release.env.example) records the reviewed P1 range but must not replace the live `PRAGMA user_version` observation.

`release.sh` takes an exclusive host-operation lock before inspecting or changing release state. It rejects reused application identities and source/deployed catalog drift, then compares the live database `user_version` with the candidate's checked-in minimum, maximum, and target contract. It also proves that the current image can read the candidate's migration target before deployment, so rollback is possible after startup migrations.

Before the first managed release it records the exact image IDs and release environment of the running access/game containers as the bootstrap rollback target. Existing P1 `current`, `previous`, and used-version files are adopted without losing their identities. The script then performs an encrypted verified backup, validates Compose, builds the access and game images, resolves their exact immutable image IDs, replaces only those two containers, requires both readiness endpoints, and confirms the resulting database version. A failed build, start, readiness check, schema check, or state promotion restores the exact previous images when replacement has begun.

Release metadata is stored in immutable generation directories under `/var/lib/cannabeats/releases/states`. One atomic `active` symlink switch promotes the complete current/previous/used-version set; the familiar `current-compose.yaml`, `previous-compose.yaml`, and `used-application-versions` paths are stable symlinks into that active generation. An interruption therefore exposes either the entire old state or the entire new state, never a mixture. Do not edit generation files manually.

Rollback only CannaBeats:

```sh
sudo CANNABEATS_COMPOSE_DIR=/opt/cannabeats/CannaBeats/spikes/access-spotify-poc deploy/rollback-release.sh
```

The rollback obtains the same exclusive lock, reads the live database version, and refuses to start a previous image whose recorded range cannot read it. It deploys the recorded previous images/catalog with `--no-deps app game`, checks readiness and schema access, and only then atomically switches the current/previous state generation. No automatic down-migration is attempted. A future schema target outside the current image's readable range is rejected during forward release and requires a separately designed expand/contract migration.

The operation lock is removed on ordinary success and failure. If the host or process is killed and `/var/lib/cannabeats/releases/operation.lock` remains, inspect its `owner` file and verify that the recorded PID is absent before removing the empty lock directory with `rmdir`. Never remove the lock while a release or rollback process is alive.

Catalog builds reject malformed modules, year-pack convention errors, invalid provider identifiers, one identity mapped to multiple tracks, one track mapped to incompatible metadata, known reviewed wrong-track mappings, unreviewed artist variants, empty playable modules, and source/deployed drift. `catalog/release-overrides.json` is reviewed source, not a deployed hot patch. Restore a catalog by rolling back the entire named application release.

## Health and operator diagnostics

| Audience | Command | Meaning |
| --- | --- | --- |
| Public liveness | `curl -fsS https://ORIGIN/api/health` and `/game/api/health` | Process can answer; no topology or version detail |
| Deployment readiness | `curl -fsS http://127.0.0.1:3002/api/ready` and port 3003 `/game/api/ready` | Required config/catalog and bounded database query succeeded |
| Authorized component status | `docker compose exec app node cli.mjs operator-status` | Access/game readiness contracts, database integrity/volume, authenticated relay stream contract, source heartbeat/error, and certificate are independently classified |
| Authorized session summary | `docker compose exec app node cli.mjs operator-summary --since-hours 24` | Current/recent snapshots, counts, safe presence facts, audio lease/command state, and conservative liveness; no writes or names |
| Source-node readiness/capacity | `sudo /opt/cannabeats-managed-source/health_check.py` | Core services, public configuration validity, authenticated game-API polling, browser-reported Spotify authorization/player readiness, relay publisher state, disk, and memory; transfer usage remains an explicit provider check |

An inactive relay publisher is normal without a lease. A source heartbeat with a known error is degraded rather than healthy. An offline managed source is degraded, not game-service unready, because local playback remains available. Source browser readiness becomes `unknown` when its bounded report expires; do not infer authorization or player readiness from a running Chrome process. Check provider transfer usage in the hosting control plane; the source report labels it `unknown` rather than inventing a local estimate.

All HTTP responses carry `X-CannaBeats-Correlation-ID`. Every access/game error response is a JSON envelope with a safe `error`, stable `code`, and `correlationId`, including an upstream non-JSON failure. A family tester may share that UUID; it grants no authority. Operational failures are newline-delimited JSON with release identity and strictly allowlisted context. Successful high-frequency polling is not logged. Readiness, source configuration, and polling dependencies emit their first failure/state change and one recovery event while suppressing identical repeated probes.

## Secret inventory and rotation

| Secret/capability | Location | Rotation or revocation |
| --- | --- | --- |
| Backup passphrase | Application host secret directory; recovery copy in operator password manager | Create and verify one backup with the new passphrase, retain the old passphrase until old backups expire, then revoke the old recovery entry |
| Game service token | Shared read-only app/game secret mount | Replace the file atomically, then release/restart only app and game together; verify both readiness endpoints |
| Relay ingest token | Application secret mount and relay/source publisher configuration | Rotate at relay and all publishers in a coordinated maintenance window; verify source publishing before deleting the old value |
| Relay listen token | Application/game secret mount and relay listener configuration | Rotate at relay and app/game together; run component status and an authenticated audio-stream smoke test |
| Managed-source token | Source node file; SHA-256 only in SQLite | Stop the controller, run `node cli.mjs managed-source rotate --source-id UUID`, install the once-shown token as root-owned mode `0400`, restart controller, confirm heartbeat; rotation releases an active lease |
| Managed-source registration | SHA-256 in SQLite | `managed-source disable --source-id UUID` immediately releases its lease and disables authentication; `register --name NAME` creates a new once-shown token |
| Browser/desktop sessions and invitations | Opaque value on client; SHA-256 in SQLite | Use existing UI/API revocation and expiry; never recover the original value from backup output |
| Host application private key | OS credential/key store on the host device | Revoke the Host application from the account, then pair a replacement; only public key material is server-side |
| Spotify managed-source authorization | Dedicated Chrome profile | Disconnect/revoke in Spotify and delete or destroy the source node; authorize a replacement interactively |
| Caddy certificate private key | Caddy state | Revoke/reissue through Caddy/ACME if host compromise is suspected |
| VNC password | `/etc/cannabeats-managed-source/vnc.pass` | Replace locally; VNC remains loopback-only behind SSH/Tailscale |
| Tailnet/node identity | Managed-source host | Revoke the node in Tailscale and remove hosting-provider access when replacing it |

Every secret must be a regular file mounted only into the service that needs it. On the application host, keep individually mounted mode-`0444` files inside a root-owned mode-`0700` directory; this permits the unprivileged container account to read the mounted inode without making the host path traversable. On the source node, own each mode-`0400` file directly by its minimum required Unix service account. Diagnostics must never print file content. Redaction tests use sentinel bearer, cookie, capability, query, track, device, and provider values.

## Managed-source replacement and Spotify reauthorization

Do not image, snapshot, copy, or broadly back up `/var/lib/cannabeats-source/chrome-profile`.

1. Disable the lost source with `managed-source disable --source-id UUID`. Revoke its tailnet and provider access. If compromise is possible, rotate the relay ingest token and revoke the Spotify authorization.
2. Provision a fresh Ubuntu 24.04 node from `infra/cloud-init.yaml`; keep public SSH temporary and restricted to the operator IP. Leave provider backups/snapshots disabled.
3. Copy the named release of `spikes/managed-audio-source-poc`, run `sudo infra/install-runtime.sh`, and install the separately built `btaudio-learning` runtime at `/opt/btaudio-venv`. The runtime installer leaves VNC disabled: create a temporary password file interactively with `x11vnc -storepasswd`, run `sudo /opt/cannabeats-managed-source/install-vnc-password.sh "$HOME/.vnc/passwd"`, then delete the temporary copy.
4. Register a new source with `node cli.mjs managed-source register --name NAME`. Transfer the once-shown source token and relay ingest token out of band. Install them with the owners and modes described in the source README.
5. Copy `source.env.example` to `/etc/cannabeats-managed-source/source.env`, record the same application/catalog release identity, and restart the source agent/controller.
6. Join Tailscale, verify private SSH from the operator device, then remove the temporary public SSH firewall exception.
7. Run `health_check.py` and require `configuration_valid` plus `authenticated_poll_succeeded`; Spotify authorization and player readiness should still be degraded or unknown. Forward loopback VNC over SSH, connect Spotify using the dedicated Premium account, approve the configured browser-PKCE application, verify the account, and start the browser player. Run the check again and require `spotify_authorized` plus `player_ready` before exercising a lease.
8. Exercise one lease through play, pause, resume, and release. Confirm game status, source heartbeat, SDK state, non-silent relay PCM, and that the relay publisher stops on release.
9. Destroy the lost node only after access is revoked and replacement verification succeeds. Never transfer the old Chrome profile as a shortcut.

The more detailed topology and VNC commands remain in [the managed-source README](../../spikes/managed-audio-source-poc/README.md).
