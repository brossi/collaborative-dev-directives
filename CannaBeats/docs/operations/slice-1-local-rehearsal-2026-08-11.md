# Slice 1 local rehearsal evidence — 2026-08-11

This evidence covers the disposable local implementation gate. It does not assert that the durable family host, off-host destination, Caddy state, or managed-source provider control plane has been exercised. Those checks remain mandatory before deployment under the [baseline protection runbook](baseline-protection.md).

## Backup and restore

| Item | Result |
| --- | --- |
| Recovery point in authenticated backup manifest | `2026-08-11T12:00:00.000Z` |
| Application/catalog fixture identity | `git-test` / `catalog-test` |
| Clean-target backup/create/verify/restore test | Passed locally for streaming version 2 and legacy version 1 |
| Restored protected state | Account, administrative capability, desktop authorization, lobby, active game run, and managed-source registration |
| Database verification | SHA-256 matched; SQLite integrity check `ok`; foreign-key check empty; authenticated schema/table manifest matched restored database |
| Confidentiality checks | Account display name absent from encrypted backup serialization; wrong passphrase and modified ciphertext rejected |
| Safety checks | Existing targets rejected; interrupted publication left no artifact; retention authenticated every recognized candidate before deleting any |
| Online/scale checks | WAL writer committed during backup; a 66 MiB database exceeded the former tmpfs limit and restored exactly |
| Intentional omissions | Secret files, host installer artifact, Caddy state, and managed Spotify browser profile |

Command: `node --test test/backup.test.mjs` from `spikes/access-spotify-poc`. Result after P2-A: 9/9 passed, including concurrent-write, atomic-publication/no-overwrite, large-file, corrupt-retention, tamper, and legacy-format coverage.

## Release and rollback boundary

A disposable command-harness rehearsal now covers named releases, duplicate-identity rejection, exact image-ID recording, P1 record adoption, schema compatibility in both directions, exclusive host locking, first-release bootstrap rollback, and explicit rollback. Build, container-start, readiness, forward state-promotion, and rollback state-switch failures are injected independently. The state assertions prove that an interruption exposes the complete prior current/previous/used-version generation and that no `vw-services` target is present.

Command: `node --test test/release-scripts.test.mjs test/schema-compatibility.test.mjs` from `spikes/access-spotify-poc`. Result after P2-B: 21/21 passed. This is an orchestration rehearsal with fake Docker/readiness commands; a host-level container rehearsal remains a deployment gate because Docker is not installed in the local workspace environment.

## Catalog release

- Catalog: `sha256:fcf6e2006c70f0a424823c7d4728573b3f2bc6ad5a4030fc95aeaba2af43ea2f`
- Songs: 3,424 unique playable provider URIs
- Source modules: 111
- Source/deployed and native-bundle drift checks: passed; drift exits nonzero
- Conflicting-URI fixture: blocked before output
- Reviewed wrong-track reintroduction fixture: blocked before output
- Same title/artist mapped to different tracks through a year-only disagreement: blocked before output
- Two incorrect mappings were removed and retained as rejected release mappings; six performer-billing variants are explicitly reviewed.

## Observability and operator surface

- Access backup/operator/server suite: 51/51 passed after P2-B, including streaming backup hardening, schema/version safety, transactional release state, fail-closed operator queries, sentinel redaction, correlation/error envelopes, liveness/readiness distinction, read-only operator connection, conservative liveness classification, independent component states, and absence of names/device/track/provider detail.
- Game integration coverage proves authenticated same-service correlation across the audio membership hop and proves an arbitrary configured origin receives no forwarded cookie or authorization value.
- Next production build and TypeScript: passed.
- Web tests: 37/37 passed, including the new catalog source-of-truth, cross-year conflict, internal-correlation, and credential-forwarding regressions.
- Web lint: passed.
- Python source agent/controller/health checker: byte-compiled successfully.
- Shell scripts: `bash -n` passed.

## Truthful health and managed-source recovery

- Operator diagnostics reject readiness JSON whose `ready` value is not true
  and authenticated relay responses without the documented PCM headers.
- A fresh managed-source heartbeat no longer hides a stored source error.
  Database read failure, volume-capacity failure, certificate degradation,
  relay failure, access/game contract failure, and dependency timeout are
  injected as independent secret-free states.
- The source checker validates the access service's public Spotify
  configuration and the controller's authenticated game-API poll separately
  from Chrome's allowlisted Spotify authorization and SDK player-readiness
  reports. Missing or stale browser evidence remains `unknown`.
- The runtime does not enable VNC before a password exists. A dedicated
  password installer atomically installs a prepared x11vnc file as
  `cannabeats-source` mode `0400` and then enables only the loopback unit.
- Focused commands: `node --test test/operator-report.test.mjs` from the access
  spike and `python3 -m unittest -v test_health_check.py` from the managed-source
  spike. The full access suite passes 54/54 after P2-C; the managed-source suite
  passes 9/9. Real certificate/relay/source-node exercise remains a P2-E gate.

## Deployment-only checks still required

- Validate Compose with the host's Docker Compose version and actual non-secret environment.
- Produce a real encrypted backup into the separately mounted/off-host destination and record its wall-clock duration and size.
- Restore that exact artifact to an isolated Compose project and compare live row counts.
- Exercise a failed container release and rollback on the host while observing unrelated workload continuity.
- Run authorized component checks against the real relay, certificate, database volume, and managed-source configuration/authentication/player states.
- Verify managed-source disk/memory and hosting-provider transfer usage; rehearse replacement/Spotify reauthorization when an approved maintenance window is available.
