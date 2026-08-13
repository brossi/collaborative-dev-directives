# ADR 0002: Resilience protocols are persisted state machines

- Status: Amended; single-writer implementation in progress
- Date: 2026-08-12
- Supersedes: implicit managed-audio and history lifecycle rules in the Slice 2 implementation checkpoint
- Preserves: [ADR 0001](0001-lobby-orchestrates-game-runs.md)

## Context

The Slice 2 proof established durable action receipts, selected game history,
managed-source leases, playback commands, source acknowledgements, and retention.
Successive adversarial reviews nevertheless found new failure schedules after
each local repair. The defects were not independent:

- a lease row, command row, source-controller dictionary, browser variable, and
  event row each made a partial decision about one playback command;
- retention eligibility was inferred separately by application and operator
  scripts from mutable terminal fields;
- schema capability was inferred from fragments of `CREATE TABLE` text; and
- database strings were trusted or sanitized independently by each projection.

These are protocol-design failures. SQLite, the source controller, the browser,
Spotify, systemd, and release rollback cannot participate in one atomic
transaction. Exactly-once external playback is therefore not achievable. The
architecture must instead make ownership, uncertainty, and irreversible
transitions explicit and durable.

## Decision

### 0. One service owns all mutable game-night state

The earlier checkpoint attempted to make application processes, CLI commands,
retention jobs, and legacy images safe co-writers of one SQLite file. That
configuration is rejected. Trigger ordering, `INSERT OR REPLACE`, cascades,
partially upgraded schemas, and independently versioned writers made protocol
authority depend on which connection happened to write.

CannaBeats will use two explicit bounded contexts:

| Context | Durable store | Sole writer | Contents |
| --- | --- | --- | --- |
| identity and access | access SQLite | access service | users, credentials, invitations, sessions, capabilities, audit records |
| game-night state | state SQLite | versioned state service | lobbies, opaque principal membership, runs, receipts, history, leases, and commands |

The access service authenticates a caller and sends a bounded principal claim to
the state service. The claim is input to a state transaction; identity rows and
game mutations need no cross-database transaction. Lobby creation uses an
idempotent state-service request so retries converge without dual writes.

Only the state-service operating-system identity receives write permission to
the state database. Game routes, source controllers, administrative commands,
retention, reports, and backup verification use its command API or a read-only
snapshot/projection. This is an enforced ownership boundary, not a convention.

Within the state database:

- command intent and protocol transitions are durable records independent of a
  transient lease;
- history and lifecycle transitions are append-only until authorized purge;
- current room, command, lease, and history state are projections maintained by
  the owner in the same `BEGIN IMMEDIATE` transaction as each command;
- constraints validate record shape, keys, and uniqueness, while the owner
  validates protocol edges and complete evidence; and
- purge removes privacy-scoped payloads and leaves an immutable tombstone plus
  the final authoritative snapshot.

Triggers may maintain mechanical projections, but are not an authorization,
migration, or compatibility boundary. Correctness may not depend on recursive
trigger behavior or on every future writer remembering a transition rule.

### Controlled migration and rollback floor

There are no active games during this refactor, so migration uses a drained
cutover instead of dual-write compatibility:

1. Stop admission and prove there are no active runs, live leases, or unresolved
   commands.
2. Take and verify the encrypted online backup of the monolithic database.
3. Copy state-owned tables into a new database without altering the source.
4. Validate row counts, foreign keys, canonical projections, privacy rules, and
   a content manifest for both databases.
5. Start the state service and run read comparison plus synthetic
   mutation/replay probes.
6. Switch access, game, and source clients together. Protocol versions are
   issued and persisted by the state service; payloads cannot select legacy
   authority.
7. Record state schema generation, service digest, migration manifest, and
   minimum compatible client generation in release metadata.

The untouched monolithic database and pre-cutover release remain the rollback
artifact until the first post-cutover game is admitted. Before admission,
rollback restores that complete release. After admission, rollback may use only
a state-service image whose declared schema and protocol ranges include the
active generation. Release tooling must reject an older image;
`PRAGMA user_version = 1` alone is not compatibility evidence.

Schema generations are expand-only during their rollback window. A new
generation creates versioned objects or additive columns and never rewrites an
object attested by the prior generation. Contracting a generation requires a
later promotion that explicitly advances the rollback floor.

CannaBeats will represent managed-audio execution, retained history, schema
features, and privacy projection as explicit contracts. Production code may not
infer these contracts from the incidental presence or absence of another row,
an in-memory flag, unvalidated persisted text, or SQL substrings.

### 1. Managed audio uses a durable command state machine

The server owns one durable command record independently of the transient lease
that authorized its creation. A command is bound at creation to source, lobby,
run ID, run generation, requested action, and redacted desired playback state.
Track identity remains only where required to execute a pending `play`; it is not
copied into events, receipts, outcomes, or operator projections.

The authoritative server states are:

```text
queued
  -> claimed
  -> executing
  -> completed | failed | outcome_unknown

queued -> cancelled
claimed -> outcome_unknown
executing -> outcome_unknown
outcome_unknown -> completed | failed
```

Terminal states are `completed`, `failed`, and `cancelled`.
`outcome_unknown` is durable and operationally unresolved; it is not silently
treated as failure, interruption, or permission to execute again.

Required transition rules:

| Transition | Authority | Required durable effect |
| --- | --- | --- |
| create `queued` | accepted host action | command, action receipt, state revision, and requested event commit together |
| `queued → claimed` | authenticated assigned source | claim generation and source identity persist; another source cannot claim it |
| `claimed → executing` | assigned source controller before browser side effect | source-local execution record is atomically persisted before execution is authorized |
| `executing → completed/failed` | assigned source result | redacted outcome and one terminal event persist idempotently |
| `claimed/executing → outcome_unknown` | lease loss, source restart reconciliation, or bounded timeout | uncertainty persists without automatic replay |
| `queued → cancelled` | lease release, game termination, or explicit cancellation | cancellation is terminal and no source may execute it |

The source controller maintains a private durable outbox with an opaque
generation. It serializes all claim, begin-execution, result, acknowledgement,
and clear operations. A response for generation A may never clear generation B.
The browser never receives executable work directly from a server poll:

1. The controller receives a server command and durably records a local claim
   generation.
2. It idempotently commits the matching `queued → claimed` transition to the
   server before exposing work to the browser.
3. The browser requests execution of that exact claim generation.
4. Before authorizing the external call, the controller atomically records the
   claim as `executing`.
5. The browser performs the desired-state Spotify operation once and reports the
   result.
6. The controller atomically records the redacted result before acknowledging it
   to the game API.
7. Only a validated, matching server acknowledgement clears that outbox generation.

A crash after step 3 never causes automatic re-execution. Recovery reports
`outcome_unknown` unless a provider query can safely prove the desired result.
This deliberately chooses **at-most-once external execution with explicit
uncertainty** over duplicate playback.

Lease release and expiry do not delete commands or outcomes. They may cancel a
never-claimed command. A claimed or executing command becomes `outcome_unknown`.
Events are projections of authoritative transitions, so a command cannot be both
terminally interrupted and completed. `interrupted` describes a transition to
unknown execution outcome; it is not a second terminal result.

### 2. Game history has a database-enforced lifecycle

Each game run owns one history lifecycle row:

```text
recording
  -> terminal_pending
  -> sealed
  -> purging
  -> purged
```

- `recording`: the run is active and significant events may be appended.
- `terminal_pending`: exactly one game terminal event and consistent terminal
  snapshot exist, but claimed/executing audio commands may still need a terminal
  or explicitly unknown outcome.
- `sealed`: terminal evidence is consistent and every command has a definitive
  terminal state; `outcome_unknown` must be reconciled before sealing, and no
  new event may be appended.
- `purging`: a retention transaction has claimed the sealed history for deletion.
- `purged`: events, receipts, and provider-execution payloads are gone. Redacted
  command identity, transition state, and outcome fingerprints remain as immutable
  protocol evidence alongside the final authoritative snapshot and purge boundary;
  they cannot authorize new execution or expose the requested track URI.

SQLite enforces the lifecycle. Event insertion is permitted in `recording`.
After game termination, `terminal_pending` permits only enumerated audio
terminal/unknown reconciliation events for commands already bound to that run;
it never permits new gameplay intent. The transition to `sealed` permanently
closes the event trail. No application,
legacy writer, operator script, or cross-process race can insert after sealing or
purge.

The game-terminal transaction must atomically write:

- final run snapshot and revision;
- `ended_at` and durable terminal outcome;
- lobby/run terminal status;
- exactly one matching `game_completed` or `game_abandoned` event; and
- history transition from `recording` to `terminal_pending`.

Sealing verifies the session, active run, phase, `ended_at`, terminal outcome,
terminal event, event coverage, and outstanding audio-command states. Any
contradiction leaves the lifecycle unchanged and produces an operator-visible
inconsistent state.

Retention performs `sealed → purging → purged` and deletion in one
`BEGIN IMMEDIATE` transaction. It never decides eligibility from `ended_at`
alone. Repeated retention observes `purged` and performs no work without changing
the original boundary. Missing lifecycle or coverage data fails closed.

### 3. Schema features use a migration ledger and canonical verification

An additive `cannabeats_feature_migrations` table records immutable feature IDs,
for example:

```text
managed_audio_command_state_v1
game_history_lifecycle_v1
game_event_taxonomy_v2
privacy_projection_contract_v1
```

The Slice 1 application ignores this additive table and remains schema-version-1
compatible. Feature IDs do not replace the release-level `user_version`
expand/promote contract.

For the separated state database, the ledger is written only by the state
service and records state-schema generations. Prior-generation objects remain
byte-for-byte unchanged during their rollback window. A new generation is
additive; it does not repair an old digest by rewriting the attested object.

For each feature migration:

1. Acquire `BEGIN IMMEDIATE` before inspecting capability.
2. If its ledger entry is absent, apply the declared legacy transformation and
   build the canonical objects.
3. Perform canonical verification of columns, keys, indexes, foreign keys,
   triggers, and behavioral invariants using adversarial savepoint probes.
4. Record the feature ID and canonical contract digest only after verification.
5. Roll back the schema, transformed data, and ledger entry together on failure.

Startup verifies every recorded feature against its canonical digest and
behavior. It does not accept a constraint because expected words happen to occur
in its SQL. Legacy values have an explicit migration policy: preserve reviewed
values, map unreviewed privacy-sensitive categories to a fixed sentinel, and
fail closed when safe transformation is impossible.

### 4. History output crosses one privacy-safe projection boundary

Database contents and serialized snapshots are untrusted input, including data
written by an older image, operator repair, corruption, or a future bug.

A single checked-in projection contract defines:

- event, outcome, actor, detail, reason, phase, status, and playback enums;
- UUID requirements for pseudonymous run-scoped references;
- numeric ranges and timestamp rules;
- fields permitted in member history and operator output; and
- fixed `unrecognized_*`, unavailable, purged, incomplete, and inconsistent states.

The application history API and operator report consume the same normalized
projection. Arbitrary persisted strings are never copied through. Member history
may expose valid run-scoped pseudonymous actor, action, and command UUIDs as
already documented; malformed values are omitted or replaced with fixed safe
categories. Operator output continues to omit those references.

The projection distinguishes at least:

- history feature unavailable on a pre-history schema;
- lifecycle or coverage marker missing on a history-capable schema;
- retained history complete from its declared baseline;
- history sealed but not yet purged;
- history purged at an immutable boundary; and
- evidence inconsistent or structurally invalid.

Privacy validation supplements database constraints; it does not assume them.

### 5. Retention execution is independent of the active game image

The retention scheduler belongs to a separately versioned operations artifact,
not `/app` in whichever game image is active. It requests an idempotent purge
from the state service and does not receive a read-write state-database mount.
Its immutable version and state-service protocol range are release metadata
independent of the current/previous game image pair.

Before mutation it checks the feature ledger and canonical history lifecycle.
If the active database lacks the required feature, it exits successfully with a
bounded `unsupported_schema` result and performs no deletion. Exact Slice 1
rollback therefore does not turn the daily timer into a failing job, while a
real retention failure still alerts.

The operations artifact receives only scoped state-service authority and the
minimum backup dependency it requires. It does not gain database-write,
application, or source credentials.

## Cross-cutting invariants

The implementation and tests must preserve all of the following:

1. One accepted action creates at most one playback command.
2. One command receives at most one external execution authorization.
3. No crash or retry automatically executes a command already marked executing.
4. Every command has at most one terminal result; uncertainty remains explicit.
5. Lease deletion cannot erase command identity, claim, result, or history.
6. A lobby or replacement run cannot receive an old command's result.
7. Event chronology is explanatory; the current snapshot remains authoritative.
8. No writer can append significant history after the lifecycle is sealed.
9. Destructive retention acts only on a database-proven sealed run.
10. A feature migration is either fully transformed, verified, and recorded, or
    leaves no change.
11. No arbitrary persisted string crosses a public or operator projection.
12. Exact rollback cannot silently disable or repeatedly fail protection jobs.
13. Only the state-service identity can mutate game-night state.
14. Protocol compatibility is server-issued and persisted, never selected by a
    request payload.
15. A deployed state-schema generation never mutates an attested object required
    by a still-supported rollback generation.

An `outcome_unknown` command produces one coherent server-visible recovery
state. Clients stop managed playback controls for that command and receive an
actionable wait, provider-reconciliation, or explicit local-fallback path. A
source restart therefore converges participants on the same authoritative
uncertainty instead of replaying a side effect or presenting conflicting states.

## Acceptance alignment

The decision satisfies the letter and intent of Slice 2 as follows:

| Slice 2 or protection obligation | Architectural enforcement |
| --- | --- |
| duplicate/retried playback cannot execute twice | stable action identity creates one command; durable claim generation grants at most one external execution authorization |
| network loss or source restart converges coherently | server command state and source outbox survive process loss; executing work becomes actionable `outcome_unknown`, never implicit retry |
| a second host cannot steal the source | claim is bound to source, lobby, run, run generation, and lease authority; schema generation 3 / protocol 4 persist an append-only stop obligation, deny acquisition and listening during quarantine, and permit lease-less execution only for the State-issued pause |
| requested, delivered, acknowledged, failed, interrupted, recovered, and expired outcomes remain explainable | events are derived from command transitions and command identity survives lease cleanup |
| completed and abandoned games reconstruct chronologically | terminalization and sealing require one matching terminal event plus bounded late audio outcomes |
| retention is run-scoped, bounded, and non-destructive to active games | only database-proven `sealed` history may enter an atomic purge transition |
| current snapshot remains authoritative | history is explanatory and never replayed to rebuild gameplay state |
| no credentials, raw provider details, pre-reveal data, or arbitrary persisted strings escape | one shared fail-closed projection contract validates every output field |
| schema expand/rollback protection remains valid | additive feature ledger complements rather than raises schema version 1; canonical verification is transactional |
| exact Slice 1 rollback keeps protection jobs safe | independent operations artifact detects unsupported history capability and performs a bounded no-op |
| real host behavior is still proven before Slice closure | local transition/model tests precede S2-F source reboot, Docker/systemd, backup/restore, and rollback rehearsal |

Known later-stage responsibilities remain later-stage work rather than holes in
this decision: S2-D verifies its now-persisted busy/recovering/fallback and
source-handoff scenarios as a composed matrix; S2-E measures listener/source/relay behavior; S2-F exercises the
protocol on disposable real hosts. Those stages consume these persisted states
and may not replace them with implicit flags.

## Executable verification strategy

Example tests are insufficient. Before production refactoring, build model tests
that enumerate state transitions and crash points.

Managed-audio model tests cover:

- every permitted and forbidden transition;
- duplicate, reordered, and concurrent claim/result/ack requests;
- release and expiry before claim, after claim, during execution, and after result;
- crashes before and after every durable write and external-call boundary;
- controller restart with every outbox state;
- stale outbox generation clearing a newer generation;
- run replacement and source handoff fences; and
- exact server replay after backup/restore.

History model tests cover:

- every lifecycle transition and forbidden event insertion;
- completion and abandonment truth tables;
- missing, duplicate, mismatched, and malformed terminal evidence;
- pending, failed, completed, and unknown audio outcomes at game termination;
- concurrent append, seal, and purge writers;
- repeated purge and immutable boundary behavior; and
- pre-history, partially migrated, restored, and exact-rollback schemas.

Projection tests generate malformed persisted values for every string and
numeric field and assert that only contract values appear in either output.
Migration tests use permissive supersets, misleading SQL tokens, populated
legacy rows, injected failures, and concurrent initializers.

## Consequences

This adds durable states and transitions, but removes lifecycle decisions from
incidental cleanup code. Some failures previously labeled `interrupted` will now
be honestly reported as `outcome_unknown` and require operator recovery or local
fallback. That is preferable to duplicate playback or fabricated certainty.

The refactor may replace much of the uncommitted S2-B/S2-C checkpoint. Existing
regressions remain useful as acceptance tests, but they do not constrain the new
internal representation.

## Rejected alternatives

- **Continue adding ordering-specific patches.** This leaves the protocol
  implicit and creates new combinations faster than tests can enumerate them.
- **Claim exactly-once Spotify execution.** No atomic transaction spans SQLite,
  controller disk, browser JavaScript, and Spotify.
- **Treat every uncertain execution as failed and retry.** `play` may have
  succeeded and would restart the track.
- **Infer schema capability from SQL substrings.** Textual presence does not prove
  constraint semantics.
- **Trust strict database constraints at projection time.** Older images,
  restored data, corruption, and manual repair can violate current assumptions.
- **Run retention from the active game image.** Exact rollback can remove the
  executable while leaving its timer active.

## Non-goals

This ADR does not implement cross-device seat transfer, multi-source playback,
hosted observability, listener diagnostics, or automatic resolution of every
unknown provider outcome. Those remain in their assigned Slice 2 stages. It does
define the command and history boundaries those stages must use.
