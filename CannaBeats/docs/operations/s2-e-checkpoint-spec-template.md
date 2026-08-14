# S2-E checkpoint specification packet template

Use one copy of this template for each E1-E12 checkpoint. Fill every section,
link it from the normative S2-E contract, and complete an adversarial design
review before writing or remediating production code. `Not applicable` requires
a reason and names the checkpoint that owns the concern.

## Identity and status

- Checkpoint:
- Scope revision:
- Status: `draft | design-review-pending | designed | implemented | verification-pending | verified | blocked`
- Exact source/tree identity:
- Required prior verified checkpoints:
- Explicitly excluded later checkpoints:
- Reviewers and review date:

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

Document or link the exact plain-object schemas. For every field specify:

- required or optional status;
- identity normalization and canonical encoding;
- unit, range, enum, and malformed-input behavior;
- semantic operator: identity, ordinal, constant, window sum, window aggregate,
  point sample, instance cumulative, interval, or transition;
- relational rules with other fields;
- ingestion, persistence, member copy, host/operator, audit, error, and log
  visibility; and
- malformed retained-read behavior.

Include truth tables for every finite relational domain. Recursively enumerate
nested objects rather than assigning privacy to the container alone.

## Lifecycle, concurrency, and interruption matrix

Name the state/epoch/generation owner and linearization point. Complete the
matrix for each state-changing operation.

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

Resolve the checkpoint row from the normative predictable-failure matrix and
record the expected result of at least these common probes:

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

Tests are planned before implementation and become exact references after they
pass. Generated finite matrices are preferred to representative fixtures.

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
- Decision: `revise | designed`
- Packet linked from the normative checkpoint: `yes | no`
- Every `Not applicable` names its owning checkpoint: `yes | no`
- Dependency-firewall review passed: `yes | no`
- Predictable-failure matrix resolved: `yes | no`
- No open P0/P1 design finding: `yes | no`
- Implementation authorized: `yes | no`

If implementation or a later audit discovers a missing rule, set the packet to
`design-review-pending`, amend the specification and tests first, and rerun this
decision before implementation continues.

Implementation is authorized only when the decision is `designed` and every
authorization item is `yes`. A packet may describe prototype code while
authorization is `no`; that code cannot be used as evidence that the design
gate passed.
