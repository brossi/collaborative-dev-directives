# Slice 1 local rehearsal evidence — 2026-08-11

This evidence covers the disposable local implementation gate. It does not assert that the durable family host, off-host destination, Caddy state, or managed-source provider control plane has been exercised. Those checks remain mandatory before deployment under the [baseline protection runbook](baseline-protection.md).

## Backup and restore

| Item | Result |
| --- | --- |
| Recovery point in authenticated backup manifest | `2026-08-11T12:00:00.000Z` |
| Application/catalog fixture identity | `git-test` / `catalog-test` |
| Clean-target backup/create/verify/restore test | Passed in 148.879 ms on the local development machine |
| Restored protected state | Account, administrative capability, desktop authorization, lobby, active game run, and managed-source registration |
| Database verification | SHA-256 matched; SQLite integrity check `ok`; foreign-key check empty; authenticated schema/table manifest matched restored database |
| Confidentiality checks | Account display name absent from encrypted backup serialization; wrong passphrase and modified ciphertext rejected |
| Safety checks | Existing backup and restore targets rejected; retention touched only recognized backup filenames |
| Intentional omissions | Secret files, host installer artifact, Caddy state, and managed Spotify browser profile |

Command: `node --test test/backup.test.mjs` from `spikes/access-spotify-poc`. Result: 4/4 passed, 455.187 ms total suite duration.

## Release and rollback boundary

A disposable command-harness rehearsal ran two named releases and one rollback. It proved that backup occurs before build, all replacement/restore calls end in `up -d --no-deps app game`, readiness is checked before release-record advancement, current/previous release metadata swaps only after successful rollback checks, and no `vw-services` target is present.

Command: `npm test` from `spikes/access-spotify-poc`. Result after the final implementation: 26/26 passed. This is an orchestration rehearsal with fake Docker/readiness commands; a host-level container rehearsal remains a deployment gate because Docker is not installed in the local workspace environment.

## Catalog release

- Catalog: `sha256:fcf6e2006c70f0a424823c7d4728573b3f2bc6ad5a4030fc95aeaba2af43ea2f`
- Songs: 3,424 unique playable provider URIs
- Source modules: 111
- Source/deployed drift check: passed
- Conflicting-URI fixture: blocked before output
- Reviewed wrong-track reintroduction fixture: blocked before output
- Two incorrect mappings were removed and retained as rejected release mappings; six performer-billing variants are explicitly reviewed.

## Observability and operator surface

- Access backup/operator/server suite: passed, including sentinel redaction, correlation/error envelopes, liveness/readiness distinction, read-only operator connection, conservative liveness classification, independent component states, and absence of names/device/track/provider detail.
- Next production build and TypeScript: passed.
- Web tests: 31/31 passed after updating two stale source-shape assertions to match the already-implemented guest join and managed/local playback UI and adding an unexpected-error secrecy check.
- Web lint: passed.
- Python source agent/controller/health checker: byte-compiled successfully.
- Shell scripts: `bash -n` passed.

## Deployment-only checks still required

- Validate Compose with the host's Docker Compose version and actual non-secret environment.
- Produce a real encrypted backup into the separately mounted/off-host destination and record its wall-clock duration and size.
- Restore that exact artifact to an isolated Compose project and compare live row counts.
- Exercise a failed container release and rollback on the host while observing unrelated workload continuity.
- Run authorized component checks against the real relay, certificate, database volume, and managed-source heartbeat.
- Verify managed-source disk/memory and hosting-provider transfer usage; rehearse replacement/Spotify reauthorization when an approved maintenance window is available.
