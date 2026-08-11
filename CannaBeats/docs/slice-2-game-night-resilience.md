# Slice 2: Game-night resilience

- Status: preparation complete; S2-A action identity and idempotency in progress
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

### S2-B: Complete transition and playback idempotency

- Extend the receipt boundary through advance, skip, start/begin as required by
  measured retry behavior, audio selection/acquire/release, and pause/resume.
- Remove nested transaction seams so room mutation, playback-command enqueue,
  and receipt commit as one authoritative decision.
- Make playback commands describe desired intent rather than toggle ambiguity.

Gate: response loss and retry cannot skip twice, advance twice, reveal twice,
enqueue duplicate playback, or invert pause/resume.

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
