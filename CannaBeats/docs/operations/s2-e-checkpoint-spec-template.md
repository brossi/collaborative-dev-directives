# S2-E checkpoint specification packet template

Use one copy of this template for each E1-E12 checkpoint. Fill the sections
required by the checkpoint's risk class and link it from the normative S2-E
contract. The packet exists to make consequential choices explicit, not to
prevent isolated implementation from testing a design. `Not applicable`
requires a reason and names the checkpoint that owns the concern.

## Identity and status

- Checkpoint:
- Scope revision:
- Status: `draft | implementation-candidate | closure-review | locally-verified | integrated | blocked`
- Risk class: `A — isolated | B — boundary-bearing | C — irreversible/external`
- Exact source/tree identity:
- Required prior verified checkpoints:
- Explicitly excluded later checkpoints:
- Reviewers and review date:

### Risk-class rule

- **A — isolated:** deterministic/pure code, bounded local UI state, or
  disposable diagnostics with no authority, persistence, secret, external
  effect, or downstream dependency. A primary design pass may authorize an
  isolated implementation candidate. Independent review is required before
  another checkpoint consumes it or it is called locally verified.
- **B — boundary-bearing:** identity, authorization, consent, privacy
  projection, durable replay, storage/schema, a network interface, or a secret.
  Pure or stubbed model code may begin after the boundary and major lifecycle
  rules are articulated, but it must remain unwired. Independent design and
  implementation closure are required before integration.
- **C — irreversible/external:** migration, cutover, rollback, backup/restore,
  destructive retention, provider effects, or real-host operations. Independent
  design closure remains mandatory before implementation, followed by fault and
  recovery rehearsal before use.

Implementation discoveries amend the packet and tests without stopping work
unless they change the authority owner, persistent schema, privacy/retention
exposure, external-effect ordering, rollback/recovery model, or resource-
isolation class. Those changes return B/C work to design review.

## Boundary map

| Item | Specification |
| --- | --- |
| Sole owner | |
| Trusted inputs | |
| Untrusted inputs | |
| State and side effects | |
| Outputs and consumers | |
| Real interface under test | |
| Explicit non-goals | |

## Scale filter

- Concrete deployment maximum (users, producers, traces, duration):
- Smallest mechanism that protects the game-night outcome:
- Simpler option considered and why it is insufficient:
- Platform-scale mechanisms explicitly omitted:
- Evidence that would justify adding one of those mechanisms later:

A checkpoint must not introduce a generic framework, extension system,
distributed protocol, additional service/process, or broad compatibility layer
when a fixed finite table or one bounded task is enough for the documented
friends-and-family deployment. Prefer `insufficient_evidence` over collecting
new fields merely to explain every theoretical failure. Complexity may be added
later only in response to a measured supported-host/client need or a concrete
authority, privacy, or audio-isolation invariant.

## Invariants

Every invariant receives a stable checkpoint-scoped ID such as `E4-PORT-003`.

| ID | Normative rule | Violation result | Owning test or planned test |
| --- | --- | --- | --- |
| | | | |

## Executable data and privacy contract

For B/C boundaries, document or link the exact plain-object schemas. For A,
specify only fields and relations that affect a declared invariant. Include:

- required or optional status;
- identity normalization and canonical encoding;
- unit, range, enum, and malformed-input behavior;
- semantic operator: identity, ordinal, constant, window sum, window aggregate,
  point sample, instance cumulative, interval, or transition;
- relational rules with other fields;
- ingestion, persistence, member copy, host/operator, audit, error, and log
  visibility; and
- malformed retained-read behavior.

Include truth tables for finite authority, lifecycle, privacy, and error domains.
Representative malformed cases and every semantic branch are sufficient for
isolated A code; exhaustive Cartesian or mutation testing is not a universal
requirement. Recursively enumerate privacy-bearing nested objects rather than
assigning privacy to the container alone.

## Lifecycle, concurrency, and interruption matrix

Name the state/epoch/generation owner and linearization point. Complete the
applicable rows for each state-changing operation. Pure A functions may mark
stateful/interruption rows not applicable with their future B/C owner.

| Schedule | Required durable state | Required caller result | Forbidden result |
| --- | --- | --- | --- |
| Before first effect | | | |
| After effect, before acknowledgement | | | |
| Exact retry | | | |
| Conflicting identity reuse | | | |
| Concurrent duplicate | | | |
| Stale epoch/generation response | | | |
| Reset or rotation in flight | | | |
| Timeout/cancellation | | | |
| Process/browser restart | | | |
| Teardown/final cleanup | | | |

## Failure and resource model

- Finite error and outcome taxonomy:
- `unknown`, `unsupported`, and `not_applicable` semantics:
- Logical limits:
- Physical limits and reserve:
- Queue, retry, backoff, and drop behavior:
- Degraded/read-only behavior:
- Cleanup ownership and restart recovery:
- Proof this checkpoint cannot block gameplay, State, audio, backup, or rollback:

## Dependency firewall

List the exact previously verified functions/types consumed by this checkpoint.
Later checkpoint concepts must be represented only by an opaque fixture or
stub. Record the focused test command and prove it does not import or execute a
later validator, reducer, database, network adapter, or UI consumer.

## Predictable adversarial probes

Resolve the applicable checkpoint row from the normative predictable-failure
matrix. B/C work covers every relevant schedule below; A work covers only those
that can occur at its isolated interface:

- inherited and non-plain required fields;
- alternate identity case/spelling and reordered input;
- impossible cross-field values;
- nested privacy bypass and malformed retained data;
- stale epoch, response loss, exact retry, and conflicting retry;
- concurrency, reset, restart, and teardown;
- unsupported dependency or API;
- quota, disk, queue, and cleanup failure; and
- a false-green test name whose assertions are deliberately weakened.

## Evidence and claim ledger

Tests are planned with the design and become exact references after they pass.
Small table-driven cases are preferred. Generated exhaustive matrices are
reserved for finite authority/privacy/lifecycle domains where omission could
change an outcome.

| Claim | Invariant IDs | Negative schedules | Real interface | Test/evidence | Permitted status wording |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

Record local resource results, exact source/build identity, reviewed privacy
fields, and every deferred measurement with its S2-F owner. A passing pure model
supports only a pure-model claim.

## Design-review decision

- Findings:
- Specification changes made:
- Open blockers:
- Approved implementation scope:
- Explicitly prohibited implementation scope:
- Decision: `revise | proceed-isolated | designed`
- Packet linked from the normative checkpoint: `yes | no`
- Every `Not applicable` names its owning checkpoint: `yes | no`
- Dependency-firewall review passed: `yes | no`
- Predictable-failure matrix resolved: `yes | no`
- No open P0/P1 design finding: `yes | no`
- Implementation authorized: `yes | no`

`proceed-isolated` authorizes only the explicitly listed A code or unwired B
model. It does not authorize a consumer, persistence, production route, secret,
or external effect. `designed` is required before B integration and all C
implementation. Any prototype remains evidence only for the interface it
actually exercises.
