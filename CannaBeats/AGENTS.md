# CannaBeats development discipline

This file governs work throughout the repository. Its purpose is to prevent
independent audits from becoming delayed design work while keeping engineering
proportionate to a small friends-and-family game.

## Product scale

CannaBeats is a small, privately operated game, not a multi-tenant platform or
large public community. Prefer fixed limits, small tables, bounded rescans,
plain transactions, and explicit finite state. Do not introduce generalized
workflow engines, distributed coordination, cryptographic ledgers, extensible
policy frameworks, or migration machinery unless a concrete deployment need
requires them.

Scale does not weaken authority, privacy, idempotency, durability, or
fail-closed correctness. It does change the simplest acceptable mechanism.

## Work in closure-sized invariants

Before implementation, state the increment's governing invariant in one
sentence. It should normally cover one authority boundary, lifecycle, durable
identity, or projection. If it needs several unrelated sentences, split the
increment.

Example:

> Every accepted operation and retained mutation leaves a complete, immutable,
> restart-valid projection, or the store fails with its finite degraded result.

Do not begin from a list of endpoints or files. Begin from the invariant those
surfaces jointly enforce.

## Required closure matrix

Before coding a boundary-bearing increment, enumerate the applicable mutation
dimensions below. Omit genuinely irrelevant dimensions, but do not omit one
merely because no current test exercises it.

| Dimension | Question |
| --- | --- |
| Create | Can a new identity or row conflict with retained history? |
| Update | Which fields and relationships may change, and which are immutable? |
| Delete | What complete domain is removed, and what evidence intentionally remains? |
| Omit | Can a required row, event, ordinal, or relationship disappear silently? |
| Duplicate | Can equivalent authority or evidence exist twice? |
| Reorder | Can sequence, time, generation, or page order become contradictory? |
| Replay | Does exact retry return the original result without a second effect? |
| Conflict | Does reuse with different content fail before current-state evaluation? |
| Concurrency | What happens when two valid operations observe the same prior state? |
| Expiry | Are equality, before, and after boundaries deterministic? |
| Restart | Can the exact state and decision be reconstructed after process loss? |
| Dependency failure | Can timeout, malformed output, or response loss create ambiguity? |
| Corruption | Does retained or received inconsistency fail closed without partial output? |
| Capacity | Do the advertised maximum and cleanup reserve fit the fixed limits? |

For every applicable cell, record exactly one disposition:

- `schema`: enforced mechanically by SQLite or another local data constraint;
- `runtime`: enforced by one named shared validator or transaction;
- `structural`: impossible by the chosen representation, with a short reason;
- `deferred`: owned by a named later checkpoint with a precise boundary; or
- `not_applicable`: irrelevant to this invariant, with a short reason when that
  is not obvious.

A matrix is incomplete if a cell merely says “tested” without identifying the
enforcement mechanism.

## Implementation rules

1. Prefer schema constraints and immutable triggers for local row invariants.
2. Prefer one shared validator for canonical bytes and cross-row relationships.
   Startup, reads, sealing, export, and irreversible transitions must not each
   implement weaker variants of the same check.
3. An accepted operation must not create state that the canonical validator
   subsequently rejects.
4. Stored rows are untrusted after restart. Restore and validate them before
   using denormalized fields for authority, ordering, paging, or projection.
5. Exact replay is evaluated before current authority when the original effect
   may already have committed. Conflicting identity reuse fails first.
6. Cleanup and authority-reducing operations retain explicit bounded capacity.
7. Normalize dependency and retained-data failures into the documented finite
   result. Do not leak native, caller-authored, or lower-layer errors.
8. Keep later-checkpoint prototypes out of the current closure gate unless they
   are clearly inert, marked unverified, and cannot make tests appear greener.

## Test derivation

Tests are derived from the closure matrix, not added only after an audit finds a
counterexample.

- Each applicable cell receives a positive boundary, negative schedule, or
  structural assertion.
- Exercise `max-1`, `max`, and `max+1` where a fixed bound matters.
- Exercise before, equality, and after for time boundaries.
- For retained sequences, test deletion, duplication, gaps, and reordering—not
  only count and maximum.
- For response loss, commit the effect and lose the response; a second ordinary
  success call is not equivalent evidence.
- For restart claims, close and reopen the real owner around the retained state.
- For corruption claims, mutate a relationship while preserving other checked
  relationships to test whether validation is genuinely complete.

Test names must describe the proven invariant. Do not use “complete,”
“exhaustive,” or “all” unless coverage is mechanically generated or directly
enumerates the entire finite domain.

## Pre-audit counterexample pass

Before requesting independent audit, perform one local adversarial pass:

> What is the smallest mutation that preserves every relationship currently
> checked but still violates the governing invariant?

Apply that question to identity, timestamps, counters, canonical payloads,
parent/child rows, sequence gaps, replay receipts, and cleanup state. Add any
valid counterexample to the matrix and tests before declaring the increment
ready for audit.

## GitHub issue traceability

Once a working release is under playtest, record a reproducible product defect
in GitHub before correcting it. Keep the record proportionate: observed and
expected behavior, reproduction, impact, the governing invariant, applicable
closure-matrix dispositions, and acceptance evidence are enough.

- Prefix issue titles with `[CannaBeats]` because the GitHub repository contains
  more than this project.
- Reference the issue number in correcting commits and pull requests.
- Record the exact verification result in the issue or linked pull request.
- Close a defect only after its correction is present in the accepted or
  deployed build, not merely because a local commit exists.
- Do not require issues for exploratory questions, unreproduced observations,
  or mechanical documentation edits unless traceability would be useful.

## Role of independent audit

Independent audit confirms the invariant and matrix; it is not the normal place
to discover the basic lifecycle model.

Auditors should:

- review the stated invariant and enforcement disposition for missing
  dimensions;
- attempt counterexamples that preserve already-validated relationships;
- distinguish implementation defects from honestly assigned later work;
- apply the product scale filter; and
- group findings by violated invariant rather than inflate counts by symptom.

After remediation, rerun only the perspectives affected by the change plus the
proportionate regression suite. Repeated broad audits are warranted only after
a boundary or representation changes materially.

## Severity and closure

- `P0`: immediate catastrophic authority, privacy, or unrecoverable data loss.
- `P1`: an executable violation of the increment's governing invariant, or a
  false closure claim with material operational consequences.
- `P2`: bounded hardening, evidence precision, or UX/documentation drift that
  does not invalidate the governing invariant.

An increment closes only when:

1. its invariant and closure matrix are recorded;
2. every applicable cell has a named enforcement disposition;
3. matrix-derived tests pass;
4. the local counterexample pass finds no open P0/P1;
5. independent review finds no open P0/P1; and
6. documentation states exactly what remains deferred.

Passing tests alone do not establish closure, and an audit finding does not
automatically require a larger architecture. Fix the smallest complete
invariant boundary.

## Checkpoint handoff

At each checkpoint, report:

- the governing invariant;
- the matrix dimensions added or changed;
- enforcement locations;
- exact verification commands and results;
- open P0/P1/P2 findings;
- named deferrals; and
- whether the worktree is committed and clean.

Do not advance to the next checkpoint while a current P0/P1 remains open.
