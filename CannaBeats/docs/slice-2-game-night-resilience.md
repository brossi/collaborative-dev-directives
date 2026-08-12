# Slice 2: Game-night resilience

- Status: S2-B gate locally verified; Slice 2 remains in progress
- Started: 2026-08-11
- Branch: `feature/slice-2-game-night-resilience`
- Parent checkpoint: Slice 1 closure `b8820d9`
- Parent: [CannaBeats development slices](development-slices.md#slice-2-game-night-resilience)
- Baseline protection: [Slice 1](slice-1-baseline-protection.md)

## Player and operator outcome

A retry, refresh, short network loss, duplicate command, or managed-source
restart returns every participant to one authoritative game and playback state.
The system records enough selected history to explain what was accepted, what
failed, and whether recovery completed, without retaining audio, credentials,
pre-reveal answers, or persistent device fingerprints.

## Starting evidence

- Core game mutations currently update the serialized `game_runs.state`
  snapshot directly. Requests carry no stable intent identifier, so a response
  lost after commit cannot be distinguished from an action that never arrived.
- Placement, retraction, reveal, advance, and skip are individually guarded by
  phase checks, but a manual retry can fail ambiguously or apply to a later
  phase. Skip and advance can select another track more than once.
- Managed-audio commands have server-generated command IDs, but the caller's
  playback intent has no stable ID. A repeated pause/resume request can enqueue
  another command or invert the intended state.
- Guest identity already survives refresh through an HttpOnly session and
  `game_run_player_identities`; same-device seat reclaim therefore has a useful
  base, but host recovery and stale-client behavior are not yet explicit
  contracts.
- Slice 1 provides encrypted recovery, immutable releases, schema compatibility
  checks, correlation IDs, redacted structured logs, and sanitized disposable
  host images. Slice 2 must preserve those protections.

## Contracts and boundaries

### Deployment and client generations

- During this refactor there are no active production games or uncontrolled
  pre-deployment browser clients. The operator controls deployment timing, so
  the Slice 2 bridge does not need a mixed-version compatibility window for
  clients loaded from the Slice 1 application.
- Once the refactored application is deployed for future games, every newly
  loaded client must use the Slice 2 action contract. Mandatory action IDs may
  therefore fail closed instead of silently accepting legacy retry-unsafe
  mutations.
- This controlled cutover does not waive future compatibility work. S2-D still
  defines actionable stale-client and incompatible-version behavior for clients
  that remain open across later releases.

### Stable action identity

- Every retryable game or playback intent carries a client-generated UUID in
  `actionId`. One user intent keeps the same ID across automatic retries.
- Each intent also carries the opaque run ID and monotonic state revision the
  client acted on. An unrecorded intent for another run or revision fails with
  `stale_action`; an already accepted intent is resolved through its receipt
  before the revision check.
- Identity is scoped by run and authenticated actor. IDs grant no authority:
  session and lobby membership are established before receipt lookup. A new
  action still passes its current role, turn, and phase checks; an identical
  replay relies on the durable record that those checks already passed, then
  returns only the actor-filtered current view.
- Reusing an ID with the same action and canonical request fingerprint returns
  the current authoritative snapshot with `replayed: true` and does not mutate
  state again.
- Reusing an ID with a different action or payload fails with a stable
  `action_id_conflict` response. It never guesses which intent was intended.
- A fresh accepted action returns its ID, accepted outcome, replay status, and
  the authoritative current snapshot. Correlation IDs remain request-scoped
  and distinct from action IDs.

### Durable event trail

- Receipts prevent duplicate execution; selected game and audio events explain
  chronology. Neither is a general request log or an event-sourced replacement
  for the current authoritative snapshot.
- Events use server time, run/lobby/round, actor or actor type, stable action ID
  when applicable, accepted/rejected outcome, and reviewed error categories.
- Pre-reveal track metadata, credentials, raw provider errors, audio samples,
  names not required for reconstruction, and free-form client payloads are not
  persisted.
- Retention and deletion operate at game/run scope. Cross-session player
  profiles and personal analytics remain outside this slice.

### Recovery and profiling

- Recovery prefers a coherent current snapshot over replaying every missed
  command or audio frame.
- Same-device reclaim precedes cross-device transfer. A second host cannot take
  an existing source lease or silently duplicate host control.
- Listener summaries are periodic and bounded. They contain timing, buffer,
  interruption, recovery, coarse client context, and version facts—not audio,
  answers, credentials, or a persistent fingerprint.
- Polling remains acceptable when measured behavior satisfies recovery and
  freshness gates.

## Schema and release strategy

Slice 2 adds durable receipts and selected events, but the Slice 1 release gate
correctly rejects a direct migration from schema 1 to a target the current
schema-1 image cannot read. Use an expand/promote sequence:

1. **Expand bridge:** add only backward-compatible tables, indexes, and nullable
   or defaulted columns. The bridge reads schema versions 0 through 2, targets
   version 1, and never lowers an already newer `user_version`. The Slice 1
   image can still roll back because the database remains version 1 and ignores
   additive objects.
2. **Promotion:** after the bridge is the recorded known-good release, promote
   the target to version 2. The bridge's maximum readable version is 2, so the
   release gate can prove rollback compatibility before migration.
3. Destructive cleanup or removal of legacy state is deferred to a later slice
   and requires another expand/contract decision.

Tests must prove schema-1 restore compatibility, no version downgrade, schema-2
readability by the bridge, rejection of versions newer than 2, and agreement
across access, game, Compose, release, backup, and rollback contracts.

## Development sequence

### S2-A: Action identity and atomic receipts

- Add the schema-version bridge and additive action-receipt storage.
- Require UUID action IDs for placement, retraction, reveal, advance, skip, and
  managed playback commands; introduce them incrementally without breaking
  non-retryable setup and membership actions.
- Make receipt creation and the protected mutation atomic.
- Return current authoritative state for an identical replay and reject payload
  conflicts.
- Generate one ID per client intent and preserve it across bounded network
  retry.

Gate: duplicate and concurrently repeated core actions apply once; conflicting
ID reuse fails closed; authorization and pre-reveal response filtering are
unchanged; the bridge remains rollback-compatible with Slice 1.

#### S2-A checkpoint 1 — 2026-08-11

- Added the expand bridge (`readable 0–2`, `target 1`) without lowering a
  database already marked version 2; versions newer than 2 fail before schema
  changes.
- Added game-owned, foreign-keyed action receipts and one atomic SQLite boundary
  around placement, retraction, and reveal.
- Added stable UUID generation and one bounded network retry in the browser for
  those intents. Both attempts reuse the exact request body.
- Proved simultaneous identical placement requests produce one mutation and one
  receipt, actor scope cannot be crossed, identical replays return current
  state, conflicting payload reuse fails closed, and retraction/reveal effects
  occur once.
- Local evidence: access/operations `64/64`, web `42/42`, production Next.js
  build, catalogue consistency check, TypeScript compilation, and ESLint all
  pass.

Advance, skip, and managed playback remain in the next S2-A/S2-B checkpoint;
schema promotion to target version 2 remains deferred until the expand bridge
is a recorded known-good release.

#### Adversarial P1 remediation — 2026-08-11

- Bound protected intents to an authoritative run and monotonic state revision,
  preventing delayed or previously rejected requests from becoming valid in a
  later round.
- Moved the complete response—including body consumption—inside a two-attempt,
  per-attempt timeout boundary. Identical serialized bodies and action IDs are
  retained across transport, body-read, timeout, and reviewed gateway retries;
  stable API errors are preserved without retry.
- Added UUIDv4 generation using `crypto.getRandomValues` when secure-context
  `crypto.randomUUID` is unavailable, preserving the supported HTTP LAN player
  path.
- Decoupled receipt actor identity from live user-row retention. Guest expiry
  leaves the run's pseudonymous receipt trail intact, while run deletion still
  cascades receipt deletion.
- Made release validation expect `max(pre-deployment schema, candidate target)`,
  matching the migrators' no-downgrade contract.
- Local evidence: access/release/backup `65/65`, web/client/API `47/47`,
  production Next.js build, TypeScript compilation, and ESLint pass.

The audit's P1 findings are remediated locally. The broader schema promotion,
independent-process contention, deterministic privacy/fault-injection, action
matrix, and other P2 evidence remain before this foundation is considered
complete.

#### Follow-on P1 remediation — 2026-08-11

- Moved the authoritative game revision into an additive `game_runs.revision`
  column. A database trigger advances it for every state update, including an
  update made by the exact Slice 1 rollback image; the bridge backfills an
  existing valid JSON revision without promoting `user_version`.
- Retryable 2xx responses now fail closed unless they contain a fully validated
  room for the requested run and a matching accepted action result. The same
  runtime room contract also guards poll, prepare, join, and transition
  responses before they reach React. An invalid first retryable response is
  retried with the identical serialized request; the final failure is the typed
  `invalid_response` error.
- Room snapshots are reconciled by server-issued run generation, per-run
  revision, and request sequence. A late poll cannot replace a newer revision,
  an older run generation, or an intentionally cleared room.
- Regression evidence covers a rejected action replayed after a Slice 1-style
  state write, populated Slice 1 revision backfill and trigger advancement,
  incomplete/mismatched successful responses, out-of-order snapshots,
  misrouted lobby responses, and join envelopes that would otherwise persist an
  invalid player session.
- Final local evidence: access/release/backup `65/65`, web/client/API `51/51`,
  production Next.js build, TypeScript, ESLint, and diff checks pass.

#### Adversarial P2 remediation checkpoint

1. Make every room writer compare the authoritative database revision, preserve
   related database effects in the same transaction, and map SQLite contention
   to a stable retryable outcome. Prove stale independent connections cannot
   erase an accepted action.
2. Expand the schema/recovery evidence through populated legacy receipt
   migration, backup/restore, bridge promotion failure, and exact-image
   rollback/re-forward matrices.
3. Add deterministic authorization, pre-reveal privacy, and transaction fault
   injection at the receipt boundary.
4. Close the action/fingerprint matrix, UUID privacy enforcement, pending-intent
   recovery, and the remaining detailed-plan assignments before extending the
   same boundary through S2-B playback actions.

P2 begins with item 1 because later action and playback receipts are not
trustworthy if another application writer can silently overwrite their state.

##### P2 item 1 — independent writer safety (closed)

- Every room save now compares the revision that was actually loaded. The
  trigger-owned database revision advances only the winning update; a stale
  writer receives `stale_action` rather than replacing newer serialized state.
- A save owns a short `BEGIN IMMEDIATE` transaction when its caller does not
  already own one. Player removal, game start, and game completion include
  their related identity/session/run writes in that same transaction.
- SQLite lock exhaustion is normalized to `database_busy` with HTTP 503, so a
  protected client reuses its existing bounded retry and identical action ID.
- Executable evidence opens two independent connections against one WAL
  database: the first state wins, the stale connection is rejected without
  data loss, and an externally held write lock produces the typed busy result.
- Two independently running standalone application processes now submit the
  same protected public-API action against one WAL database. Exactly one
  mutation and receipt are committed and both callers converge on the accepted
  authoritative room.
- A database trigger injects failure after the room update but before receipt
  insertion; both effects roll back and the same action ID remains usable.
  Separate failure injections prove player removal, game start, and game
  completion do not retain partial identity, invitation, session, or run data.
- The production busy-timeout path remains five seconds by default and accepts
  a validated test override. A real held writer lock therefore proves the 503
  `database_busy` response promptly without slowing the suite.

##### P2 item 2 — schema and recovery evidence (closed locally)

- The game initializer now proves that losing the fresh-database startup race
  to access rolls back cleanly and succeeds on retry after access creates its
  base tables.
- Populated legacy receipts execute the actor-foreign-key rebuild path. Their
  pseudonymous actor survives user deletion, run deletion still cascades, the
  index and primary key survive, and `foreign_key_check` remains clean. An
  orphaned legacy row forces the copy to fail and proves the old table, row,
  columns, and schema version all roll back together.
- Encrypted online backup/restore now carries a real receipt plus the revision
  and run-generation triggers, then verifies referential integrity after
  restore.
- Release tests model a real 1-to-2 schema observation followed by failure to
  publish release state. The bridge remains current, schema 2 makes it the
  rollback floor, and rollback to the prior Slice 1 range is rejected before
  containers change.
- Both runtime services reject release metadata that disagrees with their
  compiled schema constants, preventing a record from claiming target 2 while
  the image still targets 1.
- Bridge tests execute the Slice 1 insert and state-update forms for both an
  existing run and a run created after rollback; database revision and lobby
  generation remain monotonic when the current bridge resumes.

An actual Slice 1 image boot against a copied bridge-expanded database remains
an operator rehearsal gate immediately before schema promotion. It does not
block target-1 bridge development and must not be described as automated local
evidence until that rehearsal is recorded.

##### P2 item 3 — authorization, privacy, and fault injection (closed)

- Unauthorized actors cannot create a receipt or change state before the
  intended actor submits the action. Actor-scoped replay remains inaccessible
  to another participant.
- Public-API checks prove a player snapshot before reveal contains neither the
  current song nor its provider URI.
- Database-trigger fault injection covers the state/receipt seam and the
  identity, invitation, session, and run side effects of multi-row mutations.
  Every forced failure leaves the complete pre-action state intact.

##### P2 item 4 — identity and uncertain outcomes (closed for S2-A scope)

- Protected action IDs are UUIDv4 and meaningful fingerprint changes fail with
  `action_id_conflict` for placement, retraction, and reveal. Run identity
  remains a separately validated UUID contract.
- An exhausted transport or gateway retry returns
  `action_outcome_unknown` with the original action ID. The browser performs an
  authoritative refresh before another intent is allowed, preventing a new ID
  from being guessed while the first action may already have committed.
- Incomplete successful responses retain their typed `invalid_response`
  classification and action identity; they use the same refresh-before-retry
  reconciliation path.

The checkpoint evidence was access/release/backup `67/67` and web/client/API
`55/55`, including the production Next.js build and TypeScript compilation.
ESLint and whitespace validation also passed. A follow-on audit then found the
additional P1 concurrency and uncertain-outcome failures below; the checkpoint
must not be treated as the end of P2 remediation.

#### Follow-on concurrency P1 remediation — 2026-08-11

- Both database initializers now acquire `BEGIN IMMEDIATE` before reading or
  validating `user_version`. A concurrent promotion can no longer occur between
  the read and write and be lowered by the bridge initializer. Cross-process
  regressions reproduce the original access and game races and prove version 2
  remains version 2.
- The game database singleton is published only after initialization succeeds.
  PRAGMA, lock-acquisition, version, or migration failures close and discard the
  local handle, so a later call retries initialization instead of returning an
  unmigrated connection that can satisfy a shallow readiness query.
- Room-state compare-and-swap now binds the persisted `runId` as well as lobby,
  active-run identity, and expected revision. A stale state loaded from an old
  run cannot overwrite a replacement run that happens to have the same
  revision.
- Prepare acquires the lobby write transaction before deciding whether a run
  exists. Concurrent prepare requests from independent application processes
  serialize and converge on one run: one returns created and the other returns
  the same existing run.
- Successful room-producing transition responses now pass the shared runtime
  room and lobby contract before reaching React. A malformed HTTP 200 response
  is a typed `invalid_response`, not a successful transition.
- An uncertain protected action carries the complete immutable original request
  back to the caller. The client resolves it only by replaying that exact action
  identity and payload; if the outcome remains uncertain, controls remain
  blocked instead of allowing a new intent to race a delayed original request.
  Refreshes used during definitive rejection recovery are bounded by timeout.

These fixes were added behind regressions that failed against the checkpoint.
Final local evidence is access/release/backup `69/69` and web/client/API
`58/58`, including the production Next.js build and TypeScript compilation.
ESLint and whitespace validation pass. The audited P1 findings are closed
locally. At this checkpoint, the follow-on audit still assigned stale
join-identity cleanup, durable release state after rename, additional
relational/privacy response hardening, explicit busy-versus-unknown outcome
classification, and S2-B audio response ordering.

#### Follow-on adversarial P1/P2 remediation — 2026-08-11

- Successful room-producing transitions now classify invalid JSON, empty/204
  bodies, interrupted body reads, and body-read timeouts as typed
  `invalid_response` outcomes. The browser performs authoritative
  reconciliation and remains blocked if that reconciliation is unavailable.
- An explicit server `database_busy` response still receives one identical
  bounded retry, but exhaustion preserves the definitive `database_busy`
  classification without inventing a pending action outcome.
- Protected actions, transition responses, and state compare-and-swap now bind
  both run ID and lobby run generation. Reactivating the same run cannot make
  state or intent captured during an earlier activation valid again.
- Runtime response validation now covers relational room invariants, UUID
  identities, rule bounds, pre-reveal song privacy, and managed-audio shape.
  Room and audio snapshots commit together on the client; a stale room response
  cannot regress audio state, and invalid audio cannot partially update the UI.
- Stale player-identity replacement is inside the same write transaction as
  room state, identity, and membership. Injected save failure preserves the
  original identity and leaves no partial replacement.
- Release-state switching records the prior active target before rename. A
  post-rename synchronization failure restores and synchronizes the prior link;
  failed promotion can no longer delete the newly active state and leave a
  dangling release record.
- Deterministic source-order assertions complement the live migration and
  independent-process prepare races, preventing timing-only false passes. A
  real API composition test commits an action, loses its first response, then
  proves the identical retry resolves through one receipt without a second
  mutation. The pending-intent state machine is behaviorally tested for
  confirmed, rejected, and still-pending outcomes.

Final local evidence is access/release/backup `71/71` and web/client/API
`65/65`, including the production Next.js build and TypeScript compilation.
ESLint and whitespace validation pass. This closes the P1 and P2 findings from
the follow-on audit; it does not pull the planned S2-B transition/playback
idempotency expansion into this checkpoint.

#### Invariant-driven mutation contract — incomplete checkpoint 2026-08-11

The follow-on targeted audit showed that action-specific remediation still left
sibling mutations able to bypass run context and uncertain-outcome handling.
Slice 2 therefore uses one executable action catalog and one server mutation
boundary rather than relying on individual route branches to remember the
contract.

| Request class | Required context | Server decision boundary | Delivery/outcome contract |
| --- | --- | --- | --- |
| `prepare` | Authenticated lobby and host | Lobby write transaction chooses or creates one active run | Naturally convergent; concurrent calls return the same run |
| `join` / `joinGuest` | Authenticated or invitation-bound lobby | Identity and room state commit together | Reuses an existing run identity for an existing principal; guest bootstrap remains separately scoped |
| Gameplay mutation | Run ID, lobby generation, revision, action ID | One `BEGIN IMMEDIATE` boundary validates context, checks receipt, authorizes, mutates, saves by CAS, and records receipt | Exact immutable request replay; success, definitive rejection, or pending/unknown only |
| Playback mutation | Run ID, lobby generation, revision, action ID | The same mutation boundary includes lease/command writes | Exact immutable request replay; no toggle-only ambiguity |
| Poll/read | Lobby membership | Read-only authoritative snapshot | Safe bounded retry; runtime schema validation before UI commit |
| Invitation creation | Authenticated host and lobby phase | Invitation write | Not a game-state mutation; full bootstrap idempotency remains separately tracked |

The executable gameplay/playback catalog is `web/lib/game-action-contract.ts`.
Every cataloged action is receipt-backed and the route accepts cataloged actions
only through the shared transactional executor. The browser assigns an action
ID before first dispatch and retains the exact serialized request across every
transport, gateway, response-body, or validation uncertainty. No cataloged
gameplay or playback mutation may reach React as a raw transport exception.

The closure gate is matrix-based rather than example-based. At this incomplete
checkpoint, the stale-context matrix enumerates the full catalog; receipt replay
and transport fault cases remain a combination of shared-boundary proofs and
representative end-to-end actions rather than one independent scenario per
action:

- every cataloged action rejects the wrong run ID, generation, or revision
  before action-specific validation or side effects;
- every cataloged action replays one receipt without a second room, identity,
  lease, or command mutation;
- failures are injected before dispatch, after dispatch, after commit, after
  headers, during body delivery, and during response validation;
- room and audio snapshots satisfy cross-field runtime invariants before either
  is applied;
- bootstrap, adoption, promotion, and rollback either restore their prior
  active state or complete a documented recoverable state.

The targeted regressions first failed against checkpoint `591798a`: stale
context mutated `addPlayer`, and a headers-only successful response escaped as
a raw timeout. The checkpoint implementation rejects stale context for all 14
cataloged actions before action validation, exact-replays representative room
and audio mutations through one receipt, persists unresolved intent across a
reload, rejects cross-field-impossible room/audio snapshots, and makes initial
bootstrap/adoption rollback fully on either side of the active-link rename.
Those passing checks exposed further protocol gaps: intent is not journaled
before dispatch or retried continuously, audio mutations do not advance an
authoritative clock, and legacy adoption can delete a newly active state if
stable-link creation fails. This checkpoint is intentionally not a completion
claim; the evidence counts describe only the behaviors then covered.

#### Mutation-contract remediation verification — 2026-08-11

- Every cataloged browser mutation is synchronously exposed to the session
  journal before its first fetch dispatch. A pending request is replayed with its
  exact action ID and serialized fields on a bounded-backoff reconciliation loop;
  the UI stays blocked until receipt replay confirms the action or the server
  definitively rejects it. Host leave/release uses this path instead of issuing a
  fire-and-forget playback mutation.
- Every cataloged mutation now advances the trigger-owned room revision through
  the shared save boundary. Playback selection, lease, pause, and resume
  decisions therefore participate in the same stale-context clock as gameplay;
  the regression sends conflicting pause/resume intents from one revision and
  proves only the first command is accepted.
- The action policy controls response expectations as well as routing. Actions
  that promise audio must return a relationally valid audio snapshot, while
  non-audio actions cannot apply an unrelated audio snapshot.
- A stable-link failure after first bootstrap or legacy adoption preserves the
  newly active, durable state directory. The next release invocation can repair
  the stable links rather than following a dangling `active` link or deleting
  the only recoverable state.
- Verified local evidence: production Next.js build and TypeScript compilation;
  all web/client/API tests `72/72`; all access/release/backup tests `74/74`;
  ESLint and whitespace validation pass.

This verifies the current remediation checkpoint, not Slice 2 as a whole. Guest
bootstrap and invitation creation remain explicitly outside the receipt-backed
run-mutation catalog, the exact Slice 1 image rehearsal remains an operator gate
before schema promotion, and the S2-B/C/D gates below remain open until their own
implementation and verification evidence is recorded.

### S2-B: Complete transition and playback idempotency

- The invariant-driven remediation pulls the receipt boundary through advance,
  skip, start/begin, audio selection/acquire/release, and pause/resume before
  further Slice 2 feature work.
- Remove nested transaction seams so room mutation, playback-command enqueue,
  and receipt commit as one authoritative decision.
- Make playback commands describe desired intent rather than toggle ambiguity.

Gate: response loss and retry cannot skip twice, advance twice, reveal twice,
enqueue duplicate playback, or invert pause/resume.

#### S2-B gate verification — 2026-08-12

- The production API/client composition now loses the first successful response
  body after commit for `start`, `begin`, `reveal`, `advance`, `skip`, and
  `audioControl: pause`. Each retry sends the exact original request, resolves
  through one receipt, and returns `replayed: true`.
- Start and reveal retain one game transition; begin, advance, and skip enqueue
  exactly one `play` command; advance and skip increment the round exactly once;
  and a lost pause response leaves exactly one `pause` command rather than
  issuing or inferring a resume.
- A distinct resume carrying the stale pre-pause context is rejected before it
  can enqueue. A later resume with current context creates one explicit `resume`
  command, so playback intent is desired-state-specific rather than toggle-based.
- Receipt-insert fault injection after a playback mutation begins proves the
  room snapshot/revision, lease status, playback command, and receipt all roll
  back together. The managed-audio helpers join the shared outer transaction;
  they do not publish an independently committed nested result.

These gate tests passed against checkpoint `bffa7de` without a production-code
change: the invariant-driven shared mutation executor already implemented the
S2-B behavior, while this checkpoint supplies the previously missing literal
end-to-end evidence. Verification is the production Next.js build and TypeScript
compilation, web/client/API `72/72`, ESLint, and whitespace validation. This
verifies S2-B only; S2-C and S2-D remain open.

### S2-C: Significant game and audio history

- Persist selected join, start, track request, placement, retraction, reveal,
  advance, skip, completion, abandonment, and managed-audio lifecycle events.
- Add run-scoped chronological reconstruction and extend the authorized
  operator summary with action and recovery outcomes.
- Define bounded retention, game-history deletion, and redaction tests.

Gate: a completed and an abandoned test game can be reconstructed without
container logs, and the current snapshot remains authoritative.

### S2-D: Session, seat, and host recovery

- Make same-device guest reclaim explicit across refresh, expiry boundaries,
  phone sleep, and short disconnects.
- Recover authorized host control without creating a duplicate lobby or host.
- Add stale-client/version responses and coherent current-state recovery.
- Present managed-source busy, recovering, retry, and explicit local-fallback
  states without exposing another lobby.

Gate: returning clients recover the same seat/round without hidden data; a
second host cannot steal the source or ambiguously control the game.

### S2-E: Listener, source, and relay diagnostics

- Measure listener startup, chunk cadence/gaps, buffer depth/trend, underruns,
  re-primes, overflows, resets, AudioContext state, loudness, and clipping.
- Add correlated bounded source and relay summaries for frames, bytes, dropped
  uploads, listeners, interruptions, and restarts.
- Provide a local advanced diagnostic view and copyable report that works when
  upload fails.
- Measure profiling overhead and enforce privacy/cardinality limits.

Gate: two listeners can be compared to localize an injected stutter, profiling
contains no prohibited data, and playback scheduling impact is negligible.

### S2-F: Real-environment rehearsal and closure

- Restore fresh disposable application/source hosts from the retained Slice 1
  images; do not depend on persistent rehearsal Droplet IDs.
- Exercise response loss, duplicate/concurrent actions, browser refresh/sleep,
  source reboot, relay interruption, network interruption, lease contention,
  listener comparison, reconstruction, backup/restore, and exact rollback.
- Use `--droplet-agent=false` for private-only DigitalOcean hosts unless
  controlled public egress is provided.
- Sanitize and destroy live rehearsal hosts after evidence is recorded; retain
  only explicitly reviewed reusable images.

Gate: every Slice 2 acceptance outcome has local and real-environment evidence,
the Slice 1 protection gates still pass, and temporary credentials/resources
are removed.

## Deferred beyond Slice 2

- Cross-device player transfer before same-device reclaim is reliable
- Personal accuracy, familiarity, or cross-session player profiles
- Broad analytics aggregation, hosted observability, or raw per-frame telemetry
- UX restructuring beyond the recovery/status surfaces needed to prove these
  contracts
- Transport replacement without measurements showing polling or the current
  relay cannot satisfy the gates
