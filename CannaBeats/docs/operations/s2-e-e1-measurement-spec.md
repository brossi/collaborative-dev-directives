# S2-E E1 measurement vocabulary and privacy specification packet

## Identity and status

- Checkpoint: E1 — measurement vocabulary and privacy schema
- Scope revision: `E1-spec-v2`
- Status: `design-review-pending`
- Source baseline: Git `06926949d997349fbc3589c459602b7af3957819`
  on `feature/slice-2-game-night-resilience`
- Packet identity: the Git commit containing this file; the independent audit
  records `git rev-parse HEAD` before review
- Required prior verified checkpoints: S2-D local closure
- Explicitly excluded later checkpoints: E2 alignment/correlation authority; E3
  health derivation/comparison; E4 worklet transport; E5 browser lifecycle; E6
  UI/clipboard composition; E7 persistence; E8-E10 routing/reporters; E11 fault
  localization; E12 real-environment evidence
- Reviewers and review date: primary Codex adversarial design review on
  2026-08-13; independent design review pending

## Boundary map

| Item | Specification |
| --- | --- |
| Sole owner | A pure shared E1 contract module owning version-1 measurement validation, normalization, canonical encoding, local identity/replay classification, signal-category derivation, and safe projections. |
| Trusted inputs | None. Even values produced by CannaBeats code are untrusted until E1 validation succeeds. |
| Untrusted inputs | Parsed JSON, local accumulator objects, worklet summaries, source/relay snapshots, restored diagnostic rows, and objects supplied directly by tests or internal callers. |
| State and side effects | None. E1 is deterministic and performs no I/O, cryptography, clock reads, persistence, logging, upload, UI mutation, or authority lookup. |
| Outputs and consumers | Frozen normalized measurement reports; UTF-8 canonical bytes; local report identity; finite replay result; member/operator projections; malformed-retained sentinel; categorical signal result. E2, E5, E6, E7, E9, and E10 may consume these only after E1 verification. |
| Real interface under test | The exported shared-module functions invoked with ordinary parsed JSON and adversarial JavaScript objects. A pure imported-module test is the real E1 interface. Later MessagePort, HTTP, SQLite, and React interfaces cannot count as E1 evidence. |
| Explicit non-goals | Trace/run/lease authority, synchronization, signatures, consent, health classification, storage, capacity planning beyond one envelope, browser lifecycle, collection cadence, reporter scheduling, and UI behavior. |

### Dependency firewall

E1 imports no E2-E12 module. Its report shape contains no `traceId`, `runId`,
`leaseId`, `alignment`, assertion, key ID, signature, health, confidence, or
comparison field. E2 may wrap canonical E1 bytes with authority and alignment;
it may not change those bytes. The E1 focused command imports only the E1 module
and E1 fixtures. Passing E2 timing, E3 comparison, E7 capacity, or browser tests
cannot advance E1.

## Invariants

| ID | Normative rule | Violation result | Planned evidence |
| --- | --- | --- | --- |
| E1-SHAPE-001 | Every accepted value is a recursively plain JSON object containing only own enumerable data properties; accessors, symbols, class instances, inherited required fields, sparse arrays, non-finite numbers, and negative zero are rejected. | `report_invalid` | Generated object-shape matrix |
| E1-SHAPE-002 | Each of the six kinds has one exact envelope and one exact kind-specific measurement shape. Optional fields are explicitly listed and no extension bag exists. | `report_invalid` | Six-kind required/optional/unknown-field matrix |
| E1-ID-001 | UUID identity fields are lowercase canonical UUID versions 1-8. Alternate case or spelling is rejected, not normalized silently. | `report_invalid` | UUID spelling matrix |
| E1-ID-002 | `sequence` is a zero-based instance-wide ordinal. The E1 identity is `(instanceId, sequence)`; changing `kind` under the same identity is a conflict. | `report_conflict` | All-kind replay/conflict matrix |
| E1-CANON-001 | Accepted reports encode using RFC 8785 JSON Canonicalization Scheme in UTF-8. Object insertion order cannot affect bytes; no accepted value has two canonical encodings. | `report_invalid` or identical bytes | Reordered/numeric-boundary vectors |
| E1-CANON-002 | A canonical E1 envelope is at most 2 KiB. Size is measured after validation and canonicalization. | `report_too_large` | Exact boundary vectors |
| E1-REPLAY-001 | First identity is `accepted`; identical canonical bytes are `replayed`; different bytes under the same identity are `report_conflict`; a different identity is `distinct`, not a replay decision. | Finite replay result | Cartesian all-kind matrix |
| E1-SEM-001 | Every field has exactly one semantic operator, unit, range, privacy rule, and malformed-read rule. | Specification/build failure | Generated registry-to-schema parity |
| E1-SEM-002 | Finite cross-field truth tables are enforced, including byte/frame/channel, buffer statistics, gap statistics, source counter ordering, relay count relationships, transition field/type, and signal categories. | `report_invalid` | Generated truth-table matrices |
| E1-SEM-003 | A pure relation validator enforces stable constants and nondecreasing instance-cumulative fields between any two same-kind windows from one instance, independent of arrival order. | `report_invalid` | Mixed-kind/reordered relation matrix |
| E1-SIGNAL-001 | Signal categories are derived only by the version-1 classifier from bounded ephemeral counts; numeric signal counts never enter a report or projection. | `report_invalid` | Exhaustive boundary classifier table |
| E1-PRIV-001 | Recursive projection rules, not container rules, govern every nested field. Member projection accepts listener kinds only and exposes no host/operator-only identity or authority field. | `not_authorized` or omission | Recursive privacy walk |
| E1-PRIV-002 | The version-1 local export wrapper is validated before encoding and contains only member-projected listener reports plus reviewed wrapper fields. | `report_invalid` | Wrapper exact-shape/malformed-value matrix |
| E1-READ-001 | Strict ingress rejects malformed reports. A malformed retained row projects only `{status:'unavailable', reason:'invalid_retained_report'}` and never echoes malformed content. | Safe finite sentinel | Malformed retained corpus |
| E1-BOUND-001 | E1 validation, canonicalization, replay, and projection do not invoke alignment, comparison, storage, browser, or producer code. | Checkpoint failure | Import/dependency inspection |

## Executable data contract

### Accepted JSON domain

An E1 validator first walks the full value graph without invoking getters. An
object is accepted only when its prototype is exactly `Object.prototype` or
`null`; every own property is enumerable, is a data property, and has a string
key; no symbol keys exist. Arrays are rejected from measurement reports. The
separately validated export wrapper permits one dense `summaries` array only.
That array has prototype `Array.prototype`, own enumerable data elements at
every index, no holes, symbols, accessors, or extra string properties other than
its standard non-accessor `length`. Strings must be valid Unicode scalar
sequences. Numbers must be finite, within
the declared bound, and not negative zero. Validation constructs a new
null-prototype normalized object and deep-freezes it. It never returns or freezes
the caller's object.

### Pure module interface and finite failures

The E1 module exports exactly these behavior surfaces (constant registries and
types may also be exported):

- `validateMeasurementReport(value)` returns a frozen normalized report;
- `canonicalMeasurementBytes(report)` returns RFC 8785 UTF-8 bytes after
  validation;
- `measurementIdentity(report)` returns the exact `(instanceId, sequence)` key;
- `classifyMeasurementReplay(existing, incoming)` returns
  `accepted|replayed|distinct|report_conflict` after validating both values;
- `validateMeasurementRelation(earlier, later)` validates stable constants and
  cumulative ordering for two same-instance, same-kind windows;
- `classifySignalWindow(counts)` returns the paired categorical signal result;
- `projectMemberMeasurement(value)` and `projectOperatorMeasurement(value)`
  return recursively allowlisted frozen projections;
- `validateLocalDiagnosticExport(value)` returns the frozen member export; and
- `projectRetainedMeasurement(value, audience)` returns a safe projection or
  the constant invalid-retained sentinel.

Contract rejection throws `E1ContractError` containing only one finite `code`:
`report_invalid`, `report_too_large`, or `not_authorized`. It contains no caller
value, field contents, nested exception, or free-form persisted error. A static
reviewed message may be used for local development but is never an API, audit,
or log payload.

### Base measurement envelope

Every kind has these exact top-level fields:

| Field | Type/range | Semantic | Member | Host/operator |
| --- | --- | --- | --- | --- |
| `schemaVersion` | exact integer `1` | constant | yes | yes |
| `kind` | six-kind enum | constant discriminator | yes for listener kinds | yes |
| `instanceId` | lowercase canonical UUID | identity | yes for listener kinds | yes |
| `sequence` | safe integer `0..MAX_SAFE_INTEGER` | instance-wide ordinal | yes | yes |
| `monotonicStartMs` | finite `0..MAX_SAFE_INTEGER`, not `-0` | interval start on one producer clock | yes | yes |
| `durationMs` | windows: `(0,60000]`; transitions: exact `0` | interval duration | yes | yes |
| `measurements` | exact kind-specific object | structured measurement | recursively projected | recursively projected |

E1 deliberately contains no trace or synchronization field. `monotonicStartMs`
cannot be compared across instances. E2 later binds unchanged canonical E1 bytes
to trace authority and a verified alignment interval.

### Field semantic operators

- `identity`: stable opaque identifier for one diagnostic instance.
- `ordinal`: ordered nonnegative integer; not an additive counter.
- `constant`: fixed for the report kind or instance; a change requires a new
  instance unless the field definition says otherwise.
- `window_sum`: additive events/amount observed only within this window.
- `window_aggregate`: min, max, mean, trend, or categorical reduction over an
  explicitly counted window sample set.
- `point_sample`: state observed at the end of the window.
- `instance_cumulative`: monotonic total since this instance began; a decrease
  requires a new instance.
- `interval`: local monotonic start/duration with no cross-instance authority.
- `transition`: one point event governed by a type-specific truth table.

### Listener window

Required fields and semantics:

| Field | Type/range | Semantic | Relational rule |
| --- | --- | --- | --- |
| `connectionAttemptSequence` | safe integer | ordinal | Current attempt for the end of the window. |
| `receivedBytes` | safe integer | window_sum | Equals `receivedFrames * sourceChannels * 2`. |
| `receivedFrames` | safe integer | window_sum | Complete decoded s16le frames only. |
| `chunkCount` | safe integer | window_sum | Counts delivered chunks containing at least one complete frame; zero iff frames/bytes are zero. |
| `chunkGap` | observed `{status:'observed', count>=1, meanMs, maxMs}` or `{status:'not_applicable'}` | window_aggregate | Observed iff `chunkCount >= 2`, with `count = chunkCount - 1` and `meanMs <= maxMs`. Not applicable iff `chunkCount <= 1`. Cross-window gaps are not included. |
| `reconnectCount` | safe integer | window_sum | Counts a new attempt after a prior attempt delivered PCM. Stream end alone is not a reconnect. |
| `terminalCategory` | finite enum | point_sample | `none` while current attempt is open; otherwise its finite terminal state. |
| `bufferDepth` | observed `{status:'observed', sampleCount>=1, currentMs, minMs, maxMs, meanMs, trendMsPerSecond}` or `{status:'unknown'}` | window_aggregate plus point sample | Observed requires `min <= mean <= max` and `min <= current <= max`; unknown contains no numeric fields. E4 later fixes sampling cadence. |
| `underrunCount` | safe integer | window_sum | Pre-prime silence is not an underrun. |
| `underrunDurationMs` | finite `0..60000` | window_sum | Positive only when this window starts in an underrun or records a new underrun; zero when neither is true. |
| `reprimeCount` | safe integer | window_sum | Cannot exceed underrun count plus one carried-in underrun, represented explicitly by `windowStartedInUnderrun`. |
| `windowStartedInUnderrun` | boolean | point_sample | Discloses the permitted carried-in re-prime relationship. |
| `overflowCount` | safe integer | window_sum | Zero requires `discardedFrames=0`. |
| `discardedFrames` | safe integer | window_sum | Positive requires positive overflow count. |
| `resetCount` | safe integer | window_sum | Counts acknowledged playback-buffer resets, not diagnostic epoch rotation. |
| `sourceSampleRate` | integer `8000..384000` | constant | A change rotates instance. |
| `sourceChannels` | integer `1|2` | constant | A change rotates instance. |
| `outputSampleRate` | integer `8000..384000` | constant | A change rotates instance. |
| `nominalRateRatio` | finite `0.02..50` | point_sample | Equals `sourceSampleRate / outputSampleRate` within `1e-12`. |
| `audioContextState` | finite enum | point_sample | `running|suspended|closed|interrupted|unknown`. |
| `baseLatencyMs` | observed finite value or `unknown|unsupported|not_applicable` | point_sample | Zero is allowed only as observed zero. |
| `outputLatencyMs` | same union | point_sample | Same rule. |
| `visibilityState` | `visible|hidden|unknown` | point_sample | Transitions are separate listener events in E5. |
| `suspensionCount` | safe integer | window_sum | Counts running-to-suspended edges in this window. |
| `longTasks` | observed `{status:'observed', count, maxDurationMs}` or `{status:'unsupported'|'unknown'}` | window_aggregate | Unsupported/unknown has no zero-valued numeric fields; observed zero requires max zero. |
| `signalPresence` | `unknown|silent|present` | window_aggregate | Must be an output of the E1 signal classifier. |
| `clippingSeverity` | `unknown|none|isolated|sustained` | window_aggregate | Must be the paired output of the same classifier. |
| `role` | `host|member` | constant | Derived later by Game; local-only producer uses its current safe room projection. |
| `browserFamily` | finite coarse enum | constant | No full user agent. |
| `browserMajor` | observed `{status:'observed', value: positive safe integer}` or `{status:'unknown'}` | constant | Unknown carries no numeric zero. |
| `osFamily` | finite coarse enum | constant | No device model. |
| `displayMode` | finite enum | constant | `browser|standalone|fullscreen|unknown`. |
| `implementationVersion` | positive safe integer | constant | Version of listener measurement implementation. |

### Source window

Format constants are `sampleRate` (`8000..384000`), `channels` (`1|2`), and
`encoding` (exact `s16le`). All numeric counters are nonnegative safe integers and
`instance_cumulative`: `capturedFrames`, `enqueuedFrames`, `publishedFrames`,
`publishedBytes`, `captureGapCount`, `droppedUploadCount`, `reconnectCount`, and
`publisherRestartCount`. They obey
`publishedFrames <= enqueuedFrames <= capturedFrames` and
`publishedBytes = publishedFrames * channels * 2`. `publisherState` and
`playbackObservation` are finite point samples. A decrease of any cumulative
counter is invalid within one instance and requires instance rotation; E7/E9
enforce cross-report monotonicity.

### Relay window

Format constants are `sampleRate` (`8000..384000`), `channels` (`1|2`), and
`encoding` (exact `s16le`), with
`ingressBytes = ingressFrames * channels * 2`. All numeric counters except
`activeListenerCount` are nonnegative safe integers
and `instance_cumulative`: `ingressFrames`, `ingressBytes`, `ingressGapCount`,
`rejectedIngressCount`, `droppedIngressCount`, `acceptedListenerCount`,
`closedListenerCount`, `deliveredBytes`, `backpressureClosureCount`,
`generationFenceDisconnectCount`, and `processRestartCount`.
`activeListenerCount` is a point sample. It equals
`acceptedListenerCount - closedListenerCount`; closed cannot exceed accepted.
Counter decreases require a new relay generation/instance.

All byte/frame products must themselves be safe integers. Implementations use
overflow-safe comparison, such as BigInt or checked division; rounded or
overflowed Number multiplication can never satisfy a relation.

### Cross-report semantic relation

`validateMeasurementRelation(earlier, later)` validates both reports and
requires the same `instanceId`, the same window `kind`, and a strictly increasing
`sequence`. Every `constant` field present in both reports must be equal and
every `instance_cumulative` field in the later report must be greater than or
equal to the earlier value. Window sums, aggregates, and point samples may
change subject to their per-report truth tables. Transitions have no E1
cross-report cumulative relation. E7 may interleave kinds by the shared ordinal
and uses the last accepted window of the same kind for this relation. Arrival
may be out of order, but ordered durable history must satisfy this rule.

### Kind-specific transitions

Every transition has required `type` and `category`, with no shared optional
field bag. The following exact schemas are separate:

Listener transitions always require `connectionAttemptSequence`:

| Type | Category | Additional exact fields |
| --- | --- | --- |
| `request_started` | `observed` | `elapsedMs: 0` |
| `response_headers`, `first_pcm_bytes`, `buffer_primed`, `first_rendered_quantum` | `observed` | bounded `elapsedMs` |
| `underrun`, `reset`, `reconnect`, `context_suspended`, `context_resumed` | `observed` | none |
| `stream_failed` | `error|unknown` | `reason: no_response|rejected|unsupported_format|stream_error|unknown`; `unknown` category iff reason is `unknown` |
| `listener_stopped` | `observed|unknown` | `reason: requested|page_teardown|run_changed|unknown`; `unknown` category iff reason is `unknown` |

Source transitions never accept listener attempt fields:

| Type | Category | Additional exact fields |
| --- | --- | --- |
| `capture_started`, `publisher_started` | `observed` | none |
| `capture_stopped` | derived from reason | `reason: requested|input_unavailable|authority_lost|process_restart|unknown` |
| `publisher_stopped` | derived from reason | `reason: requested|publisher_unavailable|authority_lost|process_restart|unknown` |
| `publisher_restarted` | `observed|error|unknown` | `reason: publisher_unavailable|process_restart|unknown` |
| `playback_changed` | `observed|error|unknown` | `playbackObservation: playing|paused|error|unknown`; category is `error` for error, `unknown` for unknown, otherwise observed |

Relay transitions never accept listener attempt fields:

| Type | Category | Additional exact fields |
| --- | --- | --- |
| `process_started`, `generation_started` | `observed` | none |
| `process_stopped` | derived from reason | `reason: requested|process_restart|authority_lost|unknown` |
| `generation_stopped` | derived from reason | `reason: requested|publisher_closed|generation_replaced|authority_lost|process_restart|unknown` |
| `generation_fenced` | `observed|error|unknown` | `reason: generation_replaced|backpressure|authority_lost|unknown` |

For reason-derived categories the mapping is exact: `input_unavailable`,
`publisher_unavailable`, and `backpressure` map to `error`; `unknown` maps to
`unknown`; and `requested`, `authority_lost`, `process_restart`,
`publisher_closed`, and `generation_replaced` map to `observed`. The generated
Cartesian fixtures enumerate every accepted tuple and
reject every other field/type/category/reason combination. A field permitted for
one transition type is unknown for another.

## Signal classifier truth table

The classifier accepts ephemeral `{observedFrames, silentFrames, clippedFrames}`
safe integers plus `sourceChannels` (`1|2`). It requires
`silentFrames + clippedFrames <= observedFrames`. A frame is silent only when
every channel has absolute s16 value less than `64`. A frame is clipped once
when either channel has absolute value at least `32760`.

| Input | `signalPresence` | `clippingSeverity` |
| --- | --- | --- |
| `observedFrames = 0` | `unknown` | `unknown` |
| all observed frames silent | `silent` | `none` |
| at least one non-silent, zero clipped | `present` | `none` |
| clipped ratio greater than zero and less than `0.01` | `present` | `isolated` |
| clipped ratio at least `0.01` | `present` | `sustained` |

Numeric classifier inputs and ratios are never included in a canonical report,
copy, persisted row, comparison input, audit event, error, or log.
Listener-window validation uses `receivedFrames` as the nonnumeric bridge:
zero received frames requires `unknown/unknown`; positive received frames rejects
`unknown` and permits only `silent/none`, `present/none`, `present/isolated`, or
`present/sustained`. Every other category pair is invalid.

## Canonical identity, encoding, and replay

Validation returns a frozen normalized report. RFC 8785 canonical UTF-8 bytes
are computed only from that normalized value. E1 local identity is
`(instanceId, sequence)` because the ordinal is instance-wide across windows and
transitions. For the same identity:

| Retained value | Incoming value | Result |
| --- | --- | --- |
| absent | valid | `accepted` |
| same canonical bytes | same | `replayed` |
| different `kind` or any other different byte | valid | `report_conflict` |
| malformed | any | `report_invalid` and retained value unchanged |

Different identities return `distinct`; they are not compared for replay. E2
later adds trace authority to the storage key without changing E1 bytes.

## Privacy and export contract

### Recursive classification

Member projection accepts only listener kinds and includes every E1 base field
plus the reviewed listener measurements. Source and relay kinds are
host/operator-only. E1 has no authority or alignment metadata to accidentally
expose. Numeric signal classifier inputs, raw PCM, URLs, headers, credentials,
direct identity, full user agent, IP, exception text, device name, song data,
and extension fields are prohibited at validation.

### Local member export wrapper

The exact wrapper is:

```text
{
  schemaVersion: 1,
  status: "local_only",
  uploadState: "disabled",
  generatedAtMonotonicMs: bounded finite number,
  instanceId: lowercase canonical UUID,
  summaries: member-projected listener reports
}
```

`summaries` is the only E1 array exception, is dense, and contains at most 4096
entries and at most 256 KiB in canonical wrapper encoding. E1 validates each summary,
requires every summary instance ID to equal the wrapper instance ID, requires
strictly increasing sequence, and canonicalizes the wrapper before copy. E6
owns clipboard invocation and disclosure; it may consume only this validated
wrapper.

### Malformed retained reads

Strict ingress returns `report_invalid`. A future E7 read supplies the retained
value to the E1 safe-read projector. Any schema, semantic, privacy, or canonical
failure returns exactly:

```text
{ status: "unavailable", reason: "invalid_retained_report" }
```

No malformed field is echoed or mapped individually. This is fail-closed and
replaces the earlier ambiguous promise to pass unknown values through.

## Lifecycle, concurrency, and interruption matrix

E1 is stateless; the caller owns persistence. Its linearization point is the
return of a fully validated, normalized, canonical result. No partial object is
observable.

| Schedule | Required state/result | Forbidden result |
| --- | --- | --- |
| Validation fails before normalization | Finite `report_invalid`; caller input untouched | Partial normalized output |
| Encoding/size fails after semantic validation | `report_too_large`; no accepted bytes | Truncated encoding |
| Exact retry | `replayed` against retained canonical bytes | A second accepted identity |
| Conflicting reuse | `report_conflict`; retained bytes unchanged | Overwrite or merge |
| Concurrent duplicates | E1 returns identical key/bytes; E7 later serializes acceptance | Nondeterministic bytes |
| Alternate property order | Identical canonical bytes | Conflict |
| Alternate UUID case/spelling | `report_invalid` | Silent normalization to another identity |
| Reset/rotation | New `instanceId`, sequence zero; old identity remains distinct | Counter reset under old instance |
| Restart | New instance unless producer durably retains exact instance/ordinal under its later checkpoint contract | Guessing or reusing an uncertain ordinal |
| Teardown | No E1 state or resource remains | Timer, file, socket, or mutable cache |

## Failure and resource model

- Finite outcomes: `accepted`, `replayed`, `distinct`, `report_invalid`,
  `report_too_large`, `report_conflict`, `not_authorized`, and the retained-read
  sentinel.
- Unknown/unsupported/not-applicable are schema-specific tagged unions; they are
  never encoded as a healthy numeric zero.
- One canonical measurement report is at most 2 KiB. The canonical export
  wrapper is at most 256 KiB and 4096 summaries; E5 owns time/ring eviction and
  E6 owns copy behavior. Request/global storage bounds belong to E7-E8 and cannot
  be counted as E1 evidence.
- E1 has no queue, retry loop, backoff, degraded mode, cleanup, or external
  resource. It cannot block gameplay, State, audio, backup, or rollback because
  it performs bounded synchronous pure computation only. E1 complexity is
  bounded by the 2 KiB accepted report or 256 KiB export wrapper plus rejected-
  input walk caps: maximum depth `8`, maximum own fields `128` per object,
  maximum summaries `4096`, and maximum total UTF-8 string bytes `8192` for one
  report or `262144` for one wrapper before normalization.

## Predictable adversarial probes

The pre-implementation suite must include:

- prototype-inherited required fields, getters, symbols, class instances,
  null-prototype valid objects, sparse arrays, excessive depth/fields, cycles,
  `NaN`, infinities, and negative zero;
- uppercase UUID, noncanonical UUID, reordered keys, Unicode and numeric
  canonicalization vectors;
- registry/schema bidirectional parity for every field and transition kind;
- all cross-field truth-table invalid rows and every valid boundary row;
- nested privacy walk and prohibited sentinel in every input position;
- all six kinds across accepted/replayed/conflict/different-identity outcomes;
- reordered and gapped report arrival with same-kind cumulative/constant
  relation checks;
- malformed retained values proving the constant safe sentinel;
- E1 import graph proving no E2/E3 symbol executes; and
- deliberately weakened fixtures proving the generated matrix fails when one
  required row or assertion is removed.

Quota, disk, network timeout, collector cleanup, browser reset, and process
restart effects are `Not applicable` to pure E1 and are owned by E4-E10 as named
above.

## Evidence and claim ledger

| Claim | Invariant IDs | Negative schedules | Real interface | Planned evidence | Permitted wording before pass |
| --- | --- | --- | --- | --- | --- |
| Exact six-kind schema | E1-SHAPE-001/002, E1-SEM-001/002/003 | inherited, unknown, missing, impossible and cross-report relations | E1 module import | Generated shape/truth matrices | designed only |
| Stable canonical identity | E1-ID-001/002, E1-CANON-001/002 | reorder, alternate spelling, size edge | E1 module import | RFC vectors plus all-kind identity matrix | designed only |
| Exact replay/conflict | E1-REPLAY-001 | exact, conflict, distinct, concurrent equivalent | E1 module import | Six-kind Cartesian replay suite | designed only |
| Upload-safe signal categories | E1-SIGNAL-001 | zero, silent, isolated/sustained thresholds, invalid counts | E1 classifier export | Exhaustive boundary table | designed only |
| Recursive privacy/export | E1-PRIV-001/002, E1-READ-001 | nested sentinel, malformed wrapper/retained value | E1 projection/export exports | Generated recursive privacy suite | designed only |
| E1 scope isolation | E1-BOUND-001 | attempted E2/E3 import | Module dependency graph | Focused command/import assertion | designed only |

Resource result, exact implementation tree identity, test names, and reviewed
privacy-field output are populated only after implementation is authorized and
the evidence exists. No S2-F measurement is deferred from E1; later checkpoints
own browser/process/storage measurements.

## Design-review decision

- Findings: the primary design review found and corrected ambiguous carried-in
  underrun accounting, cross-window gap arithmetic, missing source/relay format
  relationships, incomplete transition reason/category matrices, missing export
  bounds, declarative-only cumulative semantics, ambiguous browser-version
  unknowns, unchecked multiplication overflow, and a missing categorical bridge
  from received frames to signal results.
- Specification changes made: this revision separates E1 measurement bytes from
  E2 authority/alignment; replaces ambiguous semantic labels with exact
  operators; defines per-kind transition shapes, cross-field and signal truth,
  recursive privacy, a validated export wrapper, strict versus retained-read
  behavior, all-kind identity, and a dependency firewall.
- Open blockers: independent adversarial design review.
- Approved implementation scope: none until review passes
- Explicitly prohibited implementation scope: E2-E12; modification of worklet,
  browser hook, UI, collector, State/Game, source, or relay under E1
- Decision: `revise`
- Packet linked from the normative checkpoint: `yes`
- Every `Not applicable` names its owning checkpoint: `yes`
- Dependency-firewall review passed: `yes` for the specification; current
  prototype implementation remains noncompliant and supplies no evidence
- Predictable-failure matrix resolved: `yes` in the specification
- No open P0/P1 design finding: `pending`
- Implementation authorized: `no`
