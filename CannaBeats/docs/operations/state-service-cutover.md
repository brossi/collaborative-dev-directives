# State-service cutover and migration strategy

Status: development procedure; not approved for production execution.

This procedure separates identity/access data from game-night state without a
dual-write interval. It assumes the refactor is operator-controlled and no live
game must survive the cutover.

## Authority model

- The monolithic database remains authoritative until activation.
- The migration container may write the state volume only while `app`, `game`,
  and `state` are stopped. It mounts the monolith read-only.
- A migrated state database starts as `candidate`. Runtime mutation endpoints
  reject commands in that state.
- Activation changes the durable authority record to `active`.
- Creation of the first post-cutover lobby records `first_admitted_at`. Before
  that timestamp, rollback restores the untouched monolith and prior complete
  release. After it, rollback is limited to state-service/client generations
  compatible with the active state generation.
- At runtime, only the `state` container mounts `cannabeats_state_data` RW.

## Phase 0: build and verify the artifact

Required evidence before touching a rehearsal host:

1. The state-service unit/API/migration suites pass.
2. The state image is built and pinned by digest.
3. Compose configuration proves that no application, game, retention, source,
   or reporting service mounts the state volume RW.
4. Release metadata names the state image digest, schema generation, protocol
   version, and compatible client range as one release unit.

Local Docker verification now proves the state image builds on Linux/arm64, runs
as the unprivileged `node` user with a read-only root filesystem, mounts only the
state volume RW, rejects candidate mutations, persists activation/first admission
across restart, and passes its container health check. Digest pinning, the full
migration profile, multi-container caller topology, and items 3-4 still require
the remaining local rehearsal; production-shaped systemd/host proof remains S2-F.

## Phase 1: drain and preserve the rollback artifact

1. Disable new lobby admission.
2. Prove zero non-ended sessions, zero managed-source leases, and zero commands
   in `queued`, `claimed`, `executing`, or `outcome_unknown`.
3. Run the existing encrypted online backup and verify its manifest, decryption,
   SQLite integrity, and foreign keys.
4. Record the monolith backup identity and current release image digests.
5. Stop `app`, `game`, `history`, managed-source controller, and any CLI writer.
6. Re-run the drain query against the stopped monolith. A mismatch aborts.

## Phase 2: create the candidate

With only the migration profile active:

```sh
docker compose --profile state-migration run --rm state-migrate
```

The migrator:

- opens the monolith read-only and never changes it;
- derives source identity from a canonical schema-and-content snapshot rather
  than from the SQLite main file alone (which could omit WAL content);
- refuses active sessions, live leases, or unresolved commands;
- builds a uniquely named candidate database;
- copies state-owned rows in one transaction;
- checks foreign keys and records counts/content digests; and
- publishes the candidate filename only after validation succeeds.

Failure removes the unpublished candidate. Repeating the same migration against
an already-published candidate verifies the manifest and returns a replay.

## Phase 3: prove equivalence without granting authority

Start the state service against the candidate and verify `/ready` reports:

- `schemaGeneration: 1`;
- `protocolVersion: 2`; and
- `authority.status: candidate`.

Runtime mutations must return a candidate-state rejection. Perform destructive
synthetic probes only on a copy of the candidate, then discard that copy. The
probe set must cover lobby creation/replay/conflict, room mutation and revision
CAS, action receipts, managed-command claim/begin/result/unknown reconciliation,
history terminal/seal/purge, privacy projection, restart, and backup/restore.

Compare canonical read projections between the stopped monolith and candidate.
Raw table equality is not sufficient where migration intentionally normalizes
legacy values; every normalization must appear in the manifest.

## Phase 4: joint client cutover and activation

This phase remains blocked until access, game, source, administrative, reporting,
backup, and retention clients all use the state-service API or a defined
read-only snapshot. No direct SQLite writer may remain.

Once that gate passes:

1. Start the pinned state-service image and the jointly compatible clients.
2. Verify readiness and execute read-only comparisons again.
3. Send one idempotent authenticated activation command to
   `POST /v1/admin/activate`.
4. Verify the durable authority record is `active` with
   `first_admitted_at = null`.
5. Run non-admitting mutation/replay health probes defined by the release
   contract.
6. Enable admission. The first lobby atomically records `first_admitted_at`.

The activation request and every state mutation carry stable request identity.
Protocol version and managed-command claim generation come from the state
service; caller payloads cannot request legacy authority.

## Rollback decisions

Before `first_admitted_at`:

1. Disable admission and stop the new release.
2. Restore the complete prior release and untouched monolith.
3. Do not merge candidate state back into the monolith.

After `first_admitted_at`:

- Never restore the pre-cutover monolith as live authority.
- Select only an image set whose state schema/protocol/client ranges include the
  recorded generation.
- Restore state and access backups as a coordinated recovery point only when
  their manifests identify the same release epoch.

## Remaining development gates

- Implement all game/run/receipt/history/lease operations behind the owner API.
- Replace direct game, access, source, CLI, report, backup, and retention DB use.
- Add read-only projection export and coordinated backup manifests.
- Extend release and rollback scripts with state image and compatibility gates.
- Build the image and execute the full procedure on disposable rehearsal hosts.
- Run a fresh independent adversarial audit before calling the cutover verified.
