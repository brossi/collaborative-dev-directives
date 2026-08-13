# State-service cutover and migration strategy

Status: locally rehearsed development procedure with a completed bounded
S2-A/S2-B/S2-C cross-contract alignment review; independent adversarial audit
and S2-F host proof remain pending.

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
- State-service databases created by an unpublished development checkpoint are
  not upgrade inputs. Delete the candidate and reconstruct it from the still
  authoritative monolith with the current pinned migrator. Never edit a
  candidate ledger to make an older generation appear compatible.

## Phase 0: build and verify the artifact

Required evidence before touching a rehearsal host:

1. The state-service unit/API/migration suites pass.
2. The state image is built and pinned by digest.
3. Compose configuration proves that no application, game, retention, source,
   or reporting service mounts the state volume RW.
   Both the migrator and runtime must use `CANNABEATS_STATE_LOCK_DIRECTORY`
   pointing at the same directory on that volume; a container-local temporary
   directory is not an acceptable production lock namespace.
4. Release metadata names the state image digest, schema generation, protocol
   version, and compatible client range as one release unit.

The current development contract is state schema generation 2 and managed-source
protocol 3. Earlier unpublished candidate databases must be reconstructed.

Before starting State, create the host authority directory configured by
`CANNABEATS_STATE_AUTHORITY_DIR` with mode `0700` and ownership matching the
State container's unprivileged runtime user (UID/GID 1000 in the checked-in
image). It stores the monotonic rollback-floor record separately from
replaceable database snapshots; restoring an older database must not replace
or delete it.

Local Docker verification now proves the current Access, Game, and State images
build on Linux/arm64. State runs as the unprivileged `node` user with a read-only
root filesystem and is the only runtime State-volume writer. The complete local
rehearsal covers the migration profile, candidate readiness and digest-bound
activation, multi-container caller topology, restart recovery, coordinated
backup/restore, and both rollback boundaries. Production digest publication and
production-shaped systemd/host proof remain S2-F.

## Phase 1: drain and preserve the rollback artifact

1. Disable new lobby admission.
2. Prove zero non-ended sessions, zero managed-source leases, and zero commands
   in `queued`, `claimed`, `executing`, or `outcome_unknown`.
3. Run the existing encrypted online backup and verify its manifest, decryption,
   SQLite integrity, and foreign keys.
4. Record the monolith backup identity and current release image digests.
5. Stop `app`, `game`, `history`, managed-source controller, and any CLI writer.
6. Checkpoint the stopped monolith with `PRAGMA wal_checkpoint(TRUNCATE)` and
   prove that no non-empty `-wal` sidecar remains. The migrator rejects an
   uncheckpointed source rather than ignoring frames or requiring a writable
   source mount.
7. Re-run the drain query against the stopped monolith. A mismatch aborts.

## Phase 2: create the candidate

With only the migration profile active:

```sh
docker compose --profile state-migration run --rm state-migrate
```

The migrator:

- opens the monolith read-only and never changes it;
- requires the source WAL to be fully checkpointed, opens the main database as
  immutable through its read-only mount, and derives source identity from a
  canonical schema-and-content snapshot rather than raw file bytes;
- refuses active sessions, live leases, or unresolved commands;
- builds a uniquely named candidate database;
- copies state-owned rows in one transaction;
- checks foreign keys and records public-equivalence plus private-authority
  digests (including source token hashes and retained command payloads); and
- publishes the candidate filename only after validation succeeds.

Failure removes the unpublished candidate. Repeating the same migration against
an already-published candidate verifies the manifest and returns a replay.

## Phase 3: prove equivalence without granting authority

Start the state service against the candidate and verify `/ready` reports:

- `schemaGeneration: 2`;
- `protocolVersion: 3`; and
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
   Access and game gateways must hold distinct scoped bearer credentials and
   issue an HMAC-bound principal assertion; user-supplied principal or signature
   headers are discarded at the external boundary.
2. Verify readiness and execute read-only comparisons again.
3. Send one idempotent authenticated activation command to
   `POST /v1/admin/activate`. Its body must bind the operator-observed
   `expectedSourceDigest`, `expectedCandidateDigest`, `expectedSchemaGeneration`,
   `expectedProtocolVersion`, and immutable release epoch in addition to the
   command UUID. Activation rejects any mismatch and any command journal entry
   created while authority is still a candidate. The accepted source digest,
   candidate digest, schema generation, protocol version, and release epoch are
   persisted on the authority row for recovery and audit.
4. Verify the durable authority record is `active` with
   `first_admitted_at = null`.
5. Run non-admitting mutation/replay health probes defined by the release
   contract.
6. Enable admission. The first lobby atomically records `first_admitted_at`.

The activation request and every state mutation carry stable request identity.
The state service fixes the protocol version. The source controller durably
creates the claim generation before requesting authority, and the state service
validates and binds that exact generation through every later transition;
callers cannot request legacy protocol authority.

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

## Local executable rehearsal

With Docker Desktop running, execute the complete disposable local topology:

```sh
cd spikes/access-spotify-poc
node deploy/rehearse-state-cutover.mjs
```

The runner requires the production loopback ports for the release-script phase,
chooses unused ports for its separately booted restore topology, and uses unique
Compose project/volume names. It
creates all credentials in a mode-`0700` temporary directory, and removes only
those exact containers, volumes, and files after completion. Set
`CANNABEATS_KEEP_REHEARSAL=1` only while diagnosing a failed run; the printed
project and temporary path must then be removed explicitly. A successful run
replaces `docs/evidence/state-cutover-local.json` with the step-by-step pass
record. That record contains digests and generated rehearsal identities, not
credential material or backup contents.

## Verification status and remaining gates

Completed local development evidence:

- HTTP contract version 1 publishes schema, protocol, projections, typed game
  commands, caller scopes, and stable safe failure codes.
- Access, game, source, CLI, report, retention, and backup callers use the State
  contract; only the State runtime owns the State volume read-write.
- Admission-fenced export and coordinated encrypted Access/State backup manifests
  bind both encrypted artifacts to one authenticated recovery-set UUID and one
  release epoch. Authenticated rollback-floor authority is recovered from the
  newest valid set in that epoch even when an older database set is selected.
  Restore publishes a complete Access/State/floor generation through one atomic
  selector, and restored State starts with admission closed.
- Release and rollback records gate the State image, schema generation, protocol,
  HTTP contract, client set, recovery epoch, and first-admission boundary.
- `deploy/rehearse-state-cutover.mjs` executes the full local procedure and writes
  [machine-readable evidence](../evidence/state-cutover-local.json). The recorded
  pass includes immutable-source migration, activation, the real pre-admission
  rollback script, gameplay plus a protocol-faithful source simulator, sealed
  history, encrypted backup/restore, a separately booted restored topology,
  exact completed and abandoned reconstruction, physically completed purge,
  restart recovery, and
  post-admission rollback refusal.

Remaining before the foundation is called verified:

- complete the follow-on independent audit of this remediated cutover unit and
  repeat any affected validation;
- execute the production-shaped disposable-host, systemd scheduling, alerting,
  reboot, and digest-pinned rehearsal assigned to S2-F.
