# Baseline protection runbook

- Scope: CannaBeats access, game, catalog, shared SQLite data, and managed audio source
- Status: implementation baseline; production values must be validated before first deployment
- Related plan: [Slice 1: Baseline protection](../slice-1-baseline-protection.md)

This runbook deliberately operates only the CannaBeats Compose project. Release and rollback commands use `--no-deps app game`; they do not restart, replace, or migrate sibling `vw-services` workloads.

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

SQLite WAL state is included safely because the backup command uses SQLite's online backup API rather than copying database files. The encrypted envelope records the application version, catalog version, database digest, schema version, and table list. It contains no application secret files or managed browser profile.

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

The backup container has no network, mounts the database volume read-only, and writes only to the configured backup directory. Use a destination that survives loss of the application host, such as a separately mounted protected volume or encrypted off-host filesystem. A directory on the root disk is acceptable only for a local rehearsal.

1. Create a random passphrase without writing it to shell history and install it as `backup-passphrase` in the site-local secret directory. It must be at least 20 bytes. Keep an independent recovery copy in the operator password manager. The host directory is root-owned mode `0700`; individually mounted container secret files are root-owned mode `0444` inside that non-traversable directory so the unprivileged container account can read only its explicitly mounted files.
2. Set `CANNABEATS_BACKUP_DIR` in the site `.env` to the mounted recovery destination. Create that directory mode `0700` and owned by the container's numeric node UID/GID (1000 in the checked-in image) so the network-disabled backup container can write it.
3. Install the scheduler:

   ```sh
   sudo install -o root -g root -m 0755 deploy/run-backup.sh /usr/local/sbin/cannabeats-backup
   sudo install -o root -g root -m 0644 deploy/cannabeats-backup.service deploy/cannabeats-backup.timer /etc/systemd/system/
   sudo install -o root -g root -m 0600 deploy/backup.env.example /etc/cannabeats/backup.env
   sudo systemctl daemon-reload
   sudo systemctl enable --now cannabeats-backup.timer
   sudo systemctl start cannabeats-backup.service
   sudo systemctl status cannabeats-backup.service --no-pager
   ```

4. Verify that the destination contains a `cannabeats-YYYY-MM-DDTHHMMSSZ.cbbackup` file with mode `0600`. The `run` command verifies the newly created backup before pruning recognized older backup files. Retention refuses fewer than 2 or more than 365 copies and ignores unrelated files.

Inspect scheduling and bounded logs:

```sh
systemctl list-timers cannabeats-backup.timer
journalctl -u cannabeats-backup.service --since today
docker inspect --format '{{json .HostConfig.LogConfig}}' cannabeats-access-poc cannabeats-game
```

Application containers retain three 10 MiB `json-file` segments each. Do not treat these short-lived logs as a backup or game history.

## Restore rehearsal

Rehearse at least quarterly and after backup-format, schema, or deployment changes. Never target the live database path.

```sh
mkdir -m 0700 /var/tmp/cannabeats-restore-rehearsal
docker compose --profile operations run --rm backup verify \
  --backup /backups/BACKUP_FILE \
  --passphrase-file /run/secrets/cannabeats/backup-passphrase
docker compose --profile operations run --rm backup restore \
  --backup /backups/BACKUP_FILE \
  --output /tmp/cannabeats-restored.sqlite \
  --passphrase-file /run/secrets/cannabeats/backup-passphrase
```

Because the hardened backup container's `/tmp` is disposable, copy a rehearsal restore out only when deeper inspection is required, or invoke `operations/backup.mjs restore` on a restricted operator machine with Node 22.16 or newer. The command refuses an existing output, authenticates the envelope, compares its SHA-256 digest, then runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`.

For a full disposable smoke test, mount the restored file as `/data/cannabeats-poc.sqlite` in an isolated Compose project with different loopback ports. Confirm:

- expected account, capability, authorization, lobby, run, and audit row counts;
- `GET /api/ready` and `GET /game/api/ready` return success;
- operator summary opens the database read-only;
- the catalog version in the release override matches `web/data/catalog-manifest.json`;
- no invitation, session, source, or relay token appears in logs or the report.

Record the source backup timestamp (the recovery point), application/catalog versions, backup and restore duration, table/count comparison, integrity result, omissions, and operator. Delete the disposable plaintext restore after the rehearsal using a narrowly scoped path.

The automated fixture rehearsal for this slice uses a clean SQLite target, restores a known account, validates integrity and foreign keys, proves the encrypted file does not contain the account display name, rejects a wrong passphrase/tampering, and proves overwrite protection. Production recovery point and timings remain a deployment gate, not a claim made by local tests.

## Release and rollback

The release identity is an immutable Git commit or equivalent 7–80 character artifact identifier. The catalog identity is read from the checked-in manifest:

```sh
npm --prefix ../../../web run catalog:check
node -p "require('../../../web/data/catalog-manifest.json').catalogVersion"
sudo CANNABEATS_COMPOSE_DIR=/opt/cannabeats/access-spotify-poc \
  deploy/release.sh APPLICATION_VERSION CATALOG_SHA256
```

`release.sh` performs an encrypted, verified backup before deployment, validates Compose, builds the access and game images, replaces only those two containers, and requires both readiness endpoints. A failed check restores the previous recorded application containers. On success it atomically advances `current-compose.yaml` and retains the previous override.

Rollback only CannaBeats:

```sh
sudo CANNABEATS_COMPOSE_DIR=/opt/cannabeats/access-spotify-poc deploy/rollback-release.sh
```

The rollback deploys the recorded previous images/catalog with `--no-deps app game`, checks readiness, and only then swaps the current/previous records. Current schema changes are additive; any future destructive migration requires a separate forward/rollback compatibility rehearsal before this script may be used.

Catalog builds reject malformed modules, year-pack convention errors, invalid provider identifiers, one identity mapped to multiple tracks, one track mapped to incompatible metadata, known reviewed wrong-track mappings, unreviewed artist variants, empty playable modules, and source/deployed drift. `catalog/release-overrides.json` is reviewed source, not a deployed hot patch. Restore a catalog by rolling back the entire named application release.

## Health and operator diagnostics

| Audience | Command | Meaning |
| --- | --- | --- |
| Public liveness | `curl -fsS https://ORIGIN/api/health` and `/game/api/health` | Process can answer; no topology or version detail |
| Deployment readiness | `curl -fsS http://127.0.0.1:3002/api/ready` and port 3003 `/game/api/ready` | Required config/catalog and bounded database query succeeded |
| Authorized component status | `docker compose exec app node cli.mjs operator-status` | Access, game, database integrity/volume, relay, source heartbeat, and certificate are independently classified |
| Authorized session summary | `docker compose exec app node cli.mjs operator-summary --since-hours 24` | Current/recent snapshots, counts, safe presence facts, audio lease/command state, and conservative liveness; no writes or names |
| Source-node capacity | `sudo /opt/cannabeats-managed-source/health_check.py` | Core services, loopback endpoints, relay publisher state, disk, and memory; transfer usage remains an explicit provider check |

An inactive relay publisher is normal without a lease. An offline managed source is degraded, not game-service unready, because local playback remains available. Check provider transfer usage in the hosting control plane; the source report labels it `unknown` rather than inventing a local estimate.

All HTTP responses carry `X-CannaBeats-Correlation-ID`. JSON error responses also carry a stable `code` and `correlationId`. A family tester may share that UUID; it grants no authority. Operational failures are newline-delimited JSON with release identity and allowlisted context. Successful high-frequency polling is not logged.

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
3. Copy the named release of `spikes/managed-audio-source-poc`, run `sudo infra/install-runtime.sh`, and install the separately built `btaudio-learning` runtime at `/opt/btaudio-venv`.
4. Register a new source with `node cli.mjs managed-source register --name NAME`. Transfer the once-shown source token and relay ingest token out of band. Install them with the owners and modes described in the source README.
5. Copy `source.env.example` to `/etc/cannabeats-managed-source/source.env`, record the same application/catalog release identity, and restart the source agent/controller.
6. Join Tailscale, verify private SSH from the operator device, then remove the temporary public SSH firewall exception.
7. Run `health_check.py`. Forward loopback VNC over SSH, connect Spotify using the dedicated Premium account, approve the configured browser-PKCE application, verify the account, and start the browser player.
8. Exercise one lease through play, pause, resume, and release. Confirm game status, source heartbeat, SDK state, non-silent relay PCM, and that the relay publisher stops on release.
9. Destroy the lost node only after access is revoked and replacement verification succeeds. Never transfer the old Chrome profile as a shortcut.

The more detailed topology and VNC commands remain in [the managed-source README](../../spikes/managed-audio-source-poc/README.md).
