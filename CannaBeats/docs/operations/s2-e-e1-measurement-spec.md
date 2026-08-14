# S2-E E1 measurement vocabulary and privacy specification packet

## Identity and status

- Checkpoint: E1 — measurement vocabulary and privacy schema
- Scope revision: `E1-spec-v3`
- Status: `design-review-pending`
- First independent closure audit target: commit
  `784430dda5c385051929439088d93ce1033ff3a1`, tree
  `f9df721cfd5385eca74f52c24dbd5b822752295f`, on
  `feature/slice-2-game-night-resilience`. The remediation audit must record the
  later exact checkpoint containing these fixes; this text never attempts to
  contain its own Git identity.
- Required prior verified checkpoint: S2-D local closure `25cd9a6`, as recorded
  by `docs/operations/s2-d-recovery-contract.md`
- Explicitly excluded later checkpoints: E2 alignment/correlation authority; E3
  health derivation/comparison; E4 worklet transport; E5 browser lifecycle; E6
  UI/clipboard composition; E7 persistence; E8-E10 routing/reporters; E11 fault
  localization; E12 real-environment evidence
- Reviewers and review date: primary Codex adversarial design review on
  2026-08-13; independent Boyle/Gauss/Cicero review of `784430d` on 2026-08-13
  returned `revise`; remediation review pending

## Boundary map

| Item | Specification |
| --- | --- |
| Sole owner | A pure shared E1 contract module owning version-1 measurement validation, normalization, canonical encoding, local identity/replay classification, signal-category derivation, and safe projections. |
| Trusted inputs | None. Even values produced by CannaBeats code are untrusted until E1 validation succeeds. |
| Untrusted inputs | Length-bounded UTF-8 JSON bytes. After parsing, the validator accepts only inert JSON values. Worklet summaries, source/relay snapshots, restored rows, and test fixtures must cross that same byte boundary. JavaScript `Proxy` objects are outside the contract and may never be passed across a production E1 boundary. |
| State and side effects | None. E1 is deterministic and performs no I/O, cryptography, clock reads, persistence, logging, upload, UI mutation, or authority lookup. |
| Outputs and consumers | Frozen normalized measurement reports; UTF-8 canonical bytes; local report identity; finite replay result; member/operator projections; malformed-retained sentinel; categorical signal result. E2, E5, E6, E7, E9, and E10 may consume these only after E1 verification. |
| Real interface under test | The exported shared-module functions invoked with length-bounded UTF-8 JSON bytes, plus pure relation/classifier calls over values returned by that parser. A pure imported-module test is the real E1 interface. Later MessagePort, HTTP, SQLite, and React interfaces cannot count as E1 evidence. |
| Explicit non-goals | Trace/run/lease authority, synchronization, signatures, consent, health classification, storage, capacity planning beyond one envelope, browser lifecycle, collection cadence, reporter scheduling, and UI behavior. |

E1 is intentionally a closed six-shape contract for a small game. It is not a
generic telemetry SDK: there are no custom fields, schema plugins, query model,
arbitrary dimensions, generic event reconstruction, or multi-tenant concepts.
When bounded observations do not support a conclusion, E3 reports
`insufficient_evidence` rather than expanding E1 to capture every possible fact.

## Scale filter

- Concrete maximum: one active game trace, at most eight listeners, one source,
  one relay, six report shapes, 10-second full windows, and at most 256 reports
  in one E1 series/export call.
- Smallest sufficient mechanism: one pure JavaScript validator/normalizer with
  fixed tables and standard JSON encoding.
- Simpler option rejected: TypeScript types alone cannot validate browser,
  source, relay, copied, or restored JSON at runtime.
- Explicit omissions: custom JSON parser, RFC 8785 implementation, schema/plugin
  registry, generic event reconstruction, query model, and cross-language
  producer canonicalization. Game is the sole canonicalization boundary for
  uploaded source/relay values.
- Escalation evidence: add machinery only if a future supported non-JavaScript
  trusted storage/canonicalization boundary or a measured report shape cannot be
  represented by these six fixed tables.

### Dependency firewall

E1 imports no E2-E12 module. Its report shape contains no `traceId`, `runId`,
`leaseId`, `alignment`, assertion, key ID, signature, health, confidence, or
comparison field. E2 may wrap canonical E1 bytes with authority and alignment;
it may not change those bytes. The E1 focused command imports only the E1 module
and E1 fixtures. Passing E2 timing, E3 comparison, E7 capacity, or browser tests
cannot advance E1.

Planned focused command after implementation is
`node --test web/tests/s2e-e1-contract.test.mjs`. That test may import only the
E1 contract module and fixtures located beside it. A dependency assertion in
the same command rejects imports from E2-E12 modules.

## Invariants

| ID | Normative rule | Violation result | Planned evidence |
| --- | --- | --- | --- |
| E1-SHAPE-001 | Every accepted value originates as length-bounded UTF-8 JSON parsed with the platform JSON parser and is normalized into recursively plain own-property records. Non-byte public input, decoding/parse failure, trailing data, invalid Unicode scalar values, out-of-domain numbers, and negative zero are rejected. | `report_invalid` | Generated byte/parser/domain matrix |
| E1-SHAPE-002 | Each of the six kinds has one exact envelope and one exact kind-specific measurement shape. Optional fields are explicitly listed and no extension bag exists. | `report_invalid` | Six-kind required/optional/unknown-field matrix |
| E1-ID-001 | UUID identity fields are lowercase canonical RFC-variant UUIDs with a version nibble `1..8`; the nil UUID, alternate case, and alternate spelling are rejected rather than normalized silently. | `report_invalid` | UUID spelling/variant/nil matrix |
| E1-ID-002 | `sequence` is a zero-based instance-wide ordinal. The E1 identity is `(instanceId, sequence)`; changing `kind` under the same identity is a conflict. | `report_conflict` | All-kind replay/conflict matrix |
| E1-CANON-001 | Accepted reports encode as UTF-8 `JSON.stringify` of the normalized null-prototype object whose keys are inserted in reviewed registry order. Input order cannot affect bytes; no accepted value has two encodings. | `report_invalid` or identical bytes | Reordered/numeric-boundary vectors |
| E1-CANON-002 | A canonical E1 envelope is at most 2 KiB. Size is measured after validation and canonicalization. | `report_too_large` | Exact boundary vectors |
| E1-REPLAY-001 | First identity is `accepted`; identical canonical bytes are `replayed`; different bytes under the same identity are `report_conflict`; a different identity is `distinct`, not a replay decision. | Finite replay result | Cartesian all-kind matrix |
| E1-SEM-001 | Every field has exactly one semantic operator, unit, range, privacy rule, and malformed-read rule. | Specification/build failure | Generated registry-to-schema parity |
| E1-SEM-002 | Finite cross-field truth tables are enforced, including byte/frame/channel, buffer statistics, gap statistics, source counter ordering, relay count relationships, transition field/type, and signal categories. | `report_invalid` | Generated truth-table matrices |
| E1-SEM-003 | A pure series validator enforces one producer family, ordered identity, nonoverlapping same-kind windows, stable constants, nondecreasing cumulative fields, and nondecreasing listener attempt ordinals. It does not reconstruct missing transitions. | `report_invalid` | Mixed-kind/reordered/impossible-series matrix |
| E1-SIGNAL-001 | The version-1 classifier is the producer helper for deriving signal categories from bounded ephemeral counts; report validation enforces the exact legal category pairs but does not claim to prove producer provenance. Numeric signal counts never enter a report or projection. E4 owns proof that listener producers use this helper. | `report_invalid` | Exhaustive boundary classifier table plus E4 producer-use gate |
| E1-PRIV-001 | Recursive projection rules, not container rules, govern every nested field. Member projection accepts listener kinds only and exposes no host/operator-only identity or authority field. | `not_authorized` or omission | Recursive privacy walk |
| E1-PRIV-002 | The version-1 local export wrapper is validated before encoding and contains only member-projected listener reports plus reviewed wrapper fields. | `report_invalid` | Wrapper exact-shape/malformed-value matrix |
| E1-READ-001 | Strict ingress rejects malformed reports. A malformed retained row projects only `{status:'unavailable', reason:'invalid_retained_report'}` and never echoes malformed content. | Safe finite sentinel | Malformed retained corpus |
| E1-BOUND-001 | E1 validation, canonicalization, replay, and projection do not invoke alignment, comparison, storage, browser, or producer code. | Checkpoint failure | Import/dependency inspection |

## Executable data contract

### Accepted JSON domain

The public untrusted boundary accepts UTF-8 JSON bytes, not arbitrary live
JavaScript objects. Measurement input is rejected before parsing above `8192`
bytes; local-export input is rejected above `524288` bytes. A fatal UTF-8 decoder
and the platform JSON parser reject malformed encoding, invalid JSON, and
trailing data. Duplicate JSON names follow the platform parser's ordinary
last-name behavior; only the resulting normalized value is authoritative for
validation and canonical identity. This feature does not justify a custom JSON
parser. The validator separately rejects unpaired Unicode surrogate values,
out-of-domain numbers, and negative zero.

Because parsed JSON cannot contain accessors, symbols, sparse arrays,
prototypes, cycles, or class instances, it creates the inert input domain E1 can
inspect without invoking caller code. Production callers serialize their bounded
local value and cross this byte boundary; they do not pass a live `Proxy`.

After parsing, every record must have only own enumerable string-keyed data
properties. Arrays are rejected from measurement reports. The export wrapper
permits one dense `summaries` array only. Strings and numbers must satisfy their
declared domain; negative zero is rejected. Validation constructs a new null-
prototype normalized object and deep-freezes it. It never returns or freezes the
parsed object. Object-only helpers, if retained for generated tests, accept only
inert values produced by the reviewed parser and are not a security or resource
boundary.

### Pure module interface and finite failures

The E1 module exports exactly these behavior surfaces (constant registries and
types may also be exported):

- `validateMeasurementJson(bytes)` checks the raw limit, decodes UTF-8, uses
  the platform JSON parser,
  validates semantics and canonical size, and returns a frozen normalized
  report;
- `canonicalMeasurementBytes(report)` returns the registry-order standard JSON UTF-8 bytes after
  revalidating the normalized report;
- `measurementIdentity(report)` returns the string
  `instanceId + ":" + sequence.toString(10)`;
- `classifyMeasurementReplay(existing, incoming)` accepts `existing === null`
  as the sole absence sentinel and otherwise requires two valid normalized
  reports; it returns `accepted|replayed|distinct|report_conflict`;
- `validateMeasurementSeries(reports)` accepts a dense array of `1..256`
  normalized reports, returns `undefined` on success, and throws
  `E1ContractError('report_invalid')` for a bound or relation failure;
- `classifySignalWindow(counts)` returns the paired categorical signal result;
- `projectMemberMeasurementJson(bytes)` and
  `projectOperatorMeasurementJson(bytes)` cross the same bounded JSON boundary
  and return recursively allowlisted frozen projections;
- `validateLocalDiagnosticExportJson(bytes)` returns the frozen member export;
- `canonicalLocalDiagnosticExportBytes(exportValue)` returns its unique
  registry-order standard JSON UTF-8 encoding; and
- `projectRetainedMeasurementJson(bytes, audience)` parses retained bytes and
  returns a safe projection or the constant invalid-retained sentinel.

Every surface whose parameter is named `report`, `reports`, `existing`, or
`incoming` accepts only the frozen normalized output of
`validateMeasurementJson`; it is an internal composition surface, not another
untrusted-object boundary. Public adapters and retained reads always enter via a
`*Json(bytes)` function. Implementations may combine parse/validate/encode in
one pass, but must preserve the same finite results and canonical bytes.

Contract rejection uses this precedence: raw-byte/JSON/domain failure,
shape/field failure, semantic or history failure => `report_invalid`; only a
semantically valid value whose canonical encoding exceeds the limit =>
`report_too_large`; only a valid and size-compliant projection presented to a
disallowed audience => `not_authorized`. Replay validates incoming first, then
non-null retained existing, before comparing identity or bytes. Contract
rejection throws `E1ContractError` containing only one finite `code`:
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
| `sequence` | integer `0..9007199254740991` | instance-wide ordinal | yes | yes |
| `monotonicStartMs` | finite `0..9007199254740991`, not `-0` | interval start on one producer clock | yes | yes |
| `durationMs` | windows: `(0,10000]`; transitions: exact `0` | interval duration | yes | yes |
| `measurements` | exact kind-specific object | structured measurement | recursively projected | recursively projected |

E1 deliberately contains no trace or synchronization field. `monotonicStartMs`
cannot be compared across instances. E2 later binds unchanged canonical E1 bytes
to trace authority and a verified alignment interval. The checked sum
`monotonicStartMs + durationMs` must remain in `0..9007199254740991`.
Full windows have `durationMs = 10000`. A shorter positive window is a partial
flush caused by stop, reset, or producer shutdown; E1 validates only the finite
range, while E4/E5/E9/E10 prove that producer provenance.

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

The following scalar aliases are exact and are used by every table below:

- `uint` is an integer in `0..9007199254740991`;
- `positiveUint` is an integer in `1..9007199254740991`;
- `windowMs` is a finite number in `0..60000`;
- `latencyMs` is a finite number in `0..60000`;
- `trendMsPerSecond` is finite in `-60000..60000`;
- all numeric domains reject negative zero; and
- a tagged union is exact: no field from one variant is accepted by another.

Units are determined exactly by the registry name and may not vary by producer:
`*Ms`, `meanMs`, `maxMs`, `currentMs`, and `minMs` are milliseconds;
`trendMsPerSecond` is milliseconds per second; `*SampleRate` and `sampleRate`
are hertz; `*Bytes` are bytes; `*Frames` are complete interleaved PCM frames;
every `*Count` and `sampleCount` is an occurrence/sample count; ratios are
unitless; identifiers, ordinals, booleans, states, categories, and versions are
unitless. Every field listed in the six schemas is required except fields
excluded by an exact tagged-union variant. Any malformed field invalidates the
whole report; there is no per-field coercion or omission at ingress.

### Listener window

Required fields and semantics:

| Field | Type/range | Semantic | Relational rule |
| --- | --- | --- | --- |
| `connectionAttemptSequence` | `uint` | ordinal | Current attempt at the end of the window. |
| `receivedBytes` | `uint` | window_sum | Equals `receivedFrames * sourceChannels * 2`. |
| `receivedFrames` | `uint` | window_sum | Complete decoded s16le frames only. |
| `chunkCount` | `uint` | window_sum | Counts delivered chunks containing at least one complete frame; zero iff frames/bytes are zero, and `chunkCount <= receivedFrames`. |
| `chunkGap` | exact `{status:'observed',count:positiveUint,meanMs:windowMs,maxMs:windowMs}` or `{status:'not_applicable'}` | window_aggregate | Observed iff `chunkCount >= 2`, with `count = chunkCount - 1` and `meanMs <= maxMs`. Not applicable iff `chunkCount <= 1`. Cross-window gaps are excluded. |
| `reconnectCount` | `uint` | window_sum | Counts new attempts after an earlier attempt delivered PCM. Stream end alone is not a reconnect. |
| `terminalCategory` | `open|no_response|rejected|unsupported_format|stream_error|stream_ended|aborted|unknown` | point_sample | `open` means the current attempt has not ended. |
| `bufferDepth` | exact `{status:'observed',sampleCount:positiveUint,currentMs:windowMs,minMs:windowMs,maxMs:windowMs,meanMs:windowMs,trendMsPerSecond:trendMsPerSecond}` or `{status:'unknown'}` | window_aggregate plus point sample | Observed requires `min <= mean <= max` and `min <= current <= max`; unknown contains no numeric fields. E4 fixes sampling cadence. |
| `underrunCount` | `uint` | window_sum | Pre-prime silence is not an underrun. |
| `underrunDurationMs` | finite `0..60000` | window_sum | Positive iff this window starts in an underrun or records a new underrun; zero otherwise. |
| `reprimeCount` | `uint` | window_sum | Cannot exceed underrun count plus one carried-in underrun, represented explicitly by `windowStartedInUnderrun`. |
| `windowStartedInUnderrun` | boolean | point_sample | Discloses the permitted carried-in re-prime relationship. |
| `overflowCount` | `uint` | window_sum | Zero iff `discardedFrames=0`. |
| `discardedFrames` | `uint` | window_sum | Positive iff overflow count is positive. |
| `resetCount` | `uint` | window_sum | Counts acknowledged playback-buffer resets, not diagnostic epoch rotation. |
| `sourceSampleRate` | integer `8000..384000` | constant | A change rotates instance. |
| `sourceChannels` | integer `1|2` | constant | A change rotates instance. |
| `outputSampleRate` | integer `8000..384000` | constant | A change rotates instance. |
| `nominalRateRatio` | finite `0.020833333333333332..48` | point_sample | Equals `sourceSampleRate / outputSampleRate` within `1e-12`. |
| `audioContextState` | `running|suspended|closed|interrupted|unknown` | point_sample | Exact current AudioContext state category. |
| `baseLatencyMs` | exact `{status:'observed',value:latencyMs}` or `{status:'unknown'|'unsupported'|'not_applicable'}` | point_sample | Non-observed variants contain no value. |
| `outputLatencyMs` | same exact union | point_sample | Same rule. |
| `visibilityState` | `visible|hidden|unknown` | point_sample | Transitions are separate listener events in E5. |
| `suspensionCount` | `uint` | window_sum | Counts running-to-suspended edges in this window. |
| `longTasks` | exact `{status:'observed',count:uint,maxDurationMs:windowMs}` or `{status:'unsupported'|'unknown'}` | window_aggregate | Observed count is zero iff max is zero; positive count requires positive max. Other variants contain no numeric fields. |
| `signalPresence` | `unknown|silent|present` | window_aggregate | Must form a legal pair from the E1 classifier truth table; producer provenance is E4-owned. |
| `clippingSeverity` | `unknown|none|isolated|sustained` | window_aggregate | Must form the paired legal category. |
| `browserFamily` | `chromium|firefox|safari|other|unknown` | constant | No full user agent. |
| `browserMajor` | exact `{status:'observed',value:integer 1..999}` or `{status:'unknown'}` | constant | Unknown carries no numeric field. |
| `osFamily` | `android|ios|macos|windows|linux|chromeos|other|unknown` | constant | No device model. |
| `displayMode` | `browser|standalone|unknown` | constant | Installation mode only; transient fullscreen is intentionally excluded. |
| `implementationVersion` | `positiveUint` | constant | Version of listener measurement implementation. |

### Source window

Every listed field is required; every unlisted field is rejected.

| Field | Exact domain | Semantic |
| --- | --- | --- |
| `sampleRate` | integer `8000..384000` | constant |
| `channels` | integer `1|2` | constant |
| `encoding` | exact `s16le` | constant |
| `capturedFrames`, `enqueuedFrames`, `publishedFrames`, `publishedBytes`, `captureGapCount`, `droppedUploadCount`, `reconnectCount`, `publisherRestartCount` | `uint` | instance_cumulative |
| `publisherState` | `idle|connecting|publishing|backoff|stopped|error|unknown` | point_sample |
| `playbackObservation` | `playing|paused|error|unknown` | point_sample |

`publishedFrames <= enqueuedFrames <= capturedFrames` and `publishedBytes =
publishedFrames * channels * 2`. A counter decrease within one instance is
invalid and requires rotation.

### Relay window

Every listed field is required; every unlisted field is rejected.

| Field | Exact domain | Semantic |
| --- | --- | --- |
| `sampleRate` | integer `8000..384000` | constant |
| `channels` | integer `1|2` | constant |
| `encoding` | exact `s16le` | constant |
| `ingressFrames`, `ingressBytes`, `ingressGapCount`, `rejectedIngressCount`, `droppedIngressCount`, `acceptedListenerCount`, `closedListenerCount`, `deliveredBytes`, `backpressureClosureCount`, `generationFenceDisconnectCount` | `uint` | instance_cumulative |
| `activeListenerCount` | `uint` | point_sample |

`ingressBytes = ingressFrames * channels * 2`. `closedListenerCount` means every
accepted listener removed from the active set exactly once, including normal
EOF, client cancellation, backpressure closure, generation fencing, and relay
shutdown. Therefore `closedListenerCount <= acceptedListenerCount` and
`activeListenerCount = acceptedListenerCount - closedListenerCount`.
`deliveredBytes` is total fan-out bytes across listeners, is divisible by
`channels * 2`, and has no fixed ratio to ingress bytes because fan-out varies.
Backpressure and generation-fence counts are subsets of closed listeners and
must each be no greater than `closedListenerCount`; their sum may be lower, but
never higher. Counter decreases require a new relay generation/instance.

All byte/frame products must themselves be integers in
`0..9007199254740991`. Implementations use
overflow-safe comparison, such as BigInt or checked division; rounded or
overflowed Number multiplication can never satisfy a relation.

### Cross-report series relation

`validateMeasurementSeries(reports)` accepts a dense array of `1..256` reports containing one
instance's reports in ascending `sequence`. The first retained sequence may be
nonzero after bounded local eviction, but every later sequence is strictly
greater. Every report must belong to exactly one producer family: listener,
source, or relay. Mixing families under one instance is invalid.

For each window kind independently, `monotonicStartMs` is strictly increasing
and the next window starts at or after the previous window end. Every `constant`
field is equal and every `instance_cumulative` field is nondecreasing. Window
sums, aggregates, and point samples may change subject to their truth tables.
The export wrapper must invoke this series validator; individually valid
summaries cannot bypass it.

Across retained listener windows and transitions,
`connectionAttemptSequence` never decreases. If two successive retained
listener windows have the same attempt ordinal, the later window's
`reconnectCount` is zero; if it advances by `d`, that window's reconnect count
is at most `d`. The once-per-attempt set is exactly `request_started`,
`response_headers`, `first_pcm_bytes`, `buffer_primed`, and
`first_rendered_quantum`; each may appear at most once for an attempt. When two
or more are retained, their fixed precedence is the order just listed and their
`elapsedMs` values are nondecreasing in that precedence. At most one of
`stream_failed`, `stream_ended`, and `listener_stopped` is retained as that
attempt's terminal transition. `reconnect` occurs at most once per attempt.
Other transition types may repeat. The validator does not require missing
request, milestone, terminal, or reconnect transitions to exist and does not
infer a terminal category from an incomplete suffix.

This is deliberately not a forensic event-reconstruction engine. E3 may use a
series only when the observations needed by a diagnosis are present and
consistent; missing or contradictory evidence yields `insufficient_evidence`.

Arrival may be out of order, but E7 orders accepted history by sequence before
calling this validator. E1 does not infer cross-instance or wall-clock order.

### Kind-specific transitions

Every transition has required `type` and `category`, with no shared optional
field bag. The following exact schemas are separate:

Listener transitions always require `connectionAttemptSequence`:

| Type | Category | Additional exact fields |
| --- | --- | --- |
| `request_started` | `observed` | `elapsedMs: 0` |
| `response_headers`, `first_pcm_bytes`, `buffer_primed`, `first_rendered_quantum` | `observed` | `elapsedMs: windowMs` |
| `underrun`, `reset`, `reconnect`, `context_suspended`, `context_resumed` | `observed` | none |
| `stream_failed` | `error|unknown` | `reason: no_response|rejected|unsupported_format|stream_error|unknown`; `unknown` category iff reason is `unknown` |
| `stream_ended` | `observed` | `reason: eof` |
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

Each transition represents exactly one event. It has no occurrence multiplier,
and two real events require two identities. E1 does not coalesce. If a later
bounded producer checkpoint drops a diagnostic transition, it records that drop
in its own counter; it may not fabricate an aggregate point event.

## Signal classifier truth table

The classifier accepts ephemeral `{observedFrames, silentFrames, clippedFrames}`
values in the exact `uint` domain plus `sourceChannels` (`1|2`). It requires
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

Validation returns a frozen normalized report. Registry-order standard JSON
UTF-8 bytes are computed only from that normalized value. E1 local identity is
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

`existing === null` is the only absence representation. `undefined`, a missing
argument, or another sentinel is `report_invalid`. On `accepted`, the caller
may persist incoming canonical bytes; E1 itself never persists. Replay is
defined over those bytes and therefore does not change result after a later E2
consent or privacy transition.

## Privacy and export contract

### Recursive classification

Member projection accepts only listener kinds and includes every E1 base field
plus the reviewed listener measurements. Source and relay kinds are
host/operator-only. E1 has no authority or alignment metadata to accidentally
expose. Numeric signal classifier inputs, raw PCM, URLs, headers, credentials,
persistent personal identity, full user agent, IP, exception text, device name,
song data, and extension fields are prohibited at validation. `instanceId` is a
pseudonymous diagnostic identifier and is explicitly disclosed as such; it is
not described as anonymous.

The executable registry has one privacy row for every leaf path. The notation
`measurements.*` below means the generated expansion of every exact leaf,
including each tagged-union `status` and numeric leaf; it does not authorize an
unknown descendant.

| Exact field paths | Ingress | Diagnostic persistence | Member local/copy | Host/operator | Audit | Error | Log | Malformed retained read |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| listener base fields: `schemaVersion`, `kind`, `instanceId`, `sequence`, `monotonicStartMs`, `durationMs` | validate | yes after E2 authority | yes | yes | no values | no values | no values | whole-report sentinel |
| every generated `listener_window.measurements.*` and `listener_transition.measurements.*` leaf | validate | yes after E2 authority | yes | yes | no values | no values | no values | whole-report sentinel |
| source/relay base fields | validate | yes after E2 authority | no; `not_authorized` | yes | no values | no values | no values | whole-report sentinel |
| every generated source/relay `measurements.*` leaf | validate | yes after E2 authority | no; `not_authorized` | yes | no values | no values | no values | whole-report sentinel |
| export `schemaVersion`, `status`, `uploadState`, `generatedAtMonotonicMs`, `instanceId` and every recursively validated `summaries[]` leaf | validate | no | yes, after the required E6 disclosure | yes | no values | no values | no values | export rejected as a whole |
| prohibited/unknown path | reject | never | never | never | never | never | never | sentinel only |

“No values” means a later audit/error/log record may contain only a reviewed
finite code and never a report identity, timing, measurement, or caller value.
E7 may persist only exact valid reports plus its separately specified E2
authority wrapper. E1 does not authorize E2 fields by implication.
For a valid listener report, both member and operator projections are the exact
normalized E1 report. For a valid source/relay report, operator projection is
the exact normalized report and member projection fails `not_authorized`.
There is no partially redacted source/relay member shape.

### Local member export wrapper

The exact wrapper is:

```text
{
  schemaVersion: 1,
  status: "local_only",
  uploadState: "disabled",
  generatedAtMonotonicMs: finite 0..9007199254740991,
  instanceId: lowercase canonical UUID,
  summaries: member-projected listener reports
}
```

`summaries` is the only E1 array exception, is dense, and contains `1..256`
entries and at most 256 KiB in canonical wrapper encoding. E1 validates each
summary, requires every summary instance ID to equal the wrapper instance ID,
runs `validateMeasurementSeries(summaries)`, and requires
`generatedAtMonotonicMs` to be at least the maximum
`monotonicStartMs + durationMs` without numeric overflow. The canonical wrapper
encoder is `canonicalLocalDiagnosticExportBytes`; no other serialized copy shape
is valid. E6 owns clipboard invocation and disclosure and may consume only
these bytes.

### Malformed retained reads

Strict ingress returns `report_invalid`. A future E7 read supplies the retained
value to the E1 safe-read projector. Any schema, semantic, privacy, or canonical
failure returns exactly:

```text
{ status: "unavailable", reason: "invalid_retained_report" }
```

No malformed field is echoed or mapped individually. This is fail-closed and
replaces the earlier ambiguous promise to pass unknown values through.
The only accepted `audience` values are exact `member` and `operator`; another
value returns `not_authorized`. A valid source/relay retained report requested
by `member` also returns `not_authorized`, while malformed retained content
always returns the sentinel before audience projection.

## Lifecycle, concurrency, and interruption matrix

E1 is stateless; the caller owns persistence. Its linearization point is the
return of a fully validated, normalized, canonical result. No partial object is
observable.

| Schedule | Required state/result | Forbidden result |
| --- | --- | --- |
| Validation fails before normalization | Finite `report_invalid`; caller input untouched | Partial normalized output |
| Encoding/size fails after semantic validation | `report_too_large`; no accepted bytes | Truncated encoding |
| Response lost after successful pure return | Exact retry over the same bytes returns the same normalized value/key; a later E7 caller uses replay classification | A changed identity or bytes |
| After external effect, before acknowledgement | Not applicable to E1 because E1 has no effect. E7 owns persistence linearization; E8 owns HTTP acknowledgement. | Claim that an E1 return durably accepted a report |
| Exact retry | `replayed` against retained canonical bytes | A second accepted identity |
| Conflicting reuse | `report_conflict`; retained bytes unchanged | Overwrite or merge |
| Concurrent duplicates | E1 returns identical key/bytes; E7 later serializes acceptance | Nondeterministic bytes |
| Stale epoch/generation response | E1 has no epoch or generation. It validates the measurement core only; E2 rejects stale trace/alignment authority and E4 rejects stale worklet epochs. | Treating a valid E1 core as current authority |
| Alternate property order | Identical canonical bytes | Conflict |
| Alternate UUID case/spelling | `report_invalid` | Silent normalization to another identity |
| Reset/rotation | New `instanceId`, sequence zero; old identity remains distinct | Counter reset under old instance |
| Restart | New instance unless producer durably retains exact instance/ordinal under its later checkpoint contract | Guessing or reusing an uncertain ordinal |
| Timeout/cancellation | The synchronous byte-bounded call either returns or throws before control returns. E5/E8 own cancellation around browser/network calls and may discard an E1 result that has not been externally committed. | Background E1 work or a partially returned value |
| Unsupported browser/producer API | Not applicable to pure E1. E5 maps browser absence into exact tagged fields; E9/E10 map producer-interface absence. | E1 probing an API or inventing observed zero |
| Queue, quota, disk, or cleanup failure | Not applicable to E1. E5 owns the local ring; E7 owns persistence/quota/disk; E9/E10 own reporter queues; E6 owns clipboard cleanup. | An E1 queue, retry journal, file, timer, or cleanup side effect |
| Teardown | No E1 state or resource remains | Timer, file, socket, or mutable cache |

## Failure and resource model

- Finite outcomes: `accepted`, `replayed`, `distinct`, `report_invalid`,
  `report_too_large`, `report_conflict`, `not_authorized`, and the retained-read
  sentinel.
- Unknown/unsupported/not-applicable are schema-specific tagged unions; they are
  never encoded as a healthy numeric zero.
- One raw measurement input is at most 8 KiB and one canonical measurement
  report is at most 2 KiB. One raw export input is at most 512 KiB. The canonical export
  wrapper is at most 256 KiB and 256 summaries; E5 owns time/ring eviction and
  E6 owns copy behavior. Request/global storage bounds belong to E7-E8 and cannot
  be counted as E1 evidence.
- E1 has no queue, retry loop, backoff, degraded mode, cleanup, or external
  resource. It cannot block gameplay, State, audio, backup, or rollback because
  it performs byte-bounded synchronous pure computation only. Parsing is
  O(raw bytes). After parsing, nesting and field count are bounded by the exact
  six schemas; summaries are additionally
  capped at `256`. Raw-byte rejection occurs before JSON parse, so E1 does not
  need a generic graph-budget framework. E1 makes no physical heap or scheduling
  claim; E4-E7 own measured runtime/resource gates at their real interfaces.

## Predictable adversarial probes

The pre-implementation suite must include:

- passing a non-byte object to the public boundary, plus JSON encodings for
  excessive nesting, invalid Unicode, trailing data, numeric overflow, and
  negative zero; inherited fields, getters, symbols,
  class instances, sparse arrays, cycles, and Proxies are unrepresentable in the
  accepted JSON domain and the object-only test helper is not a public boundary;
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

Quota/disk/persistence/cleanup are E7-owned; network timeout and acknowledgement
are E8-owned; worklet reset is E4-owned; browser cancellation/teardown is
E5-owned; clipboard cleanup is E6-owned; source and relay restart/queue effects
are E9 and E10-owned. They are not E1 evidence.

## Evidence and claim ledger

| Claim | Invariant IDs | Negative schedules | Real interface | Planned evidence | Permitted wording before pass |
| --- | --- | --- | --- | --- | --- |
| Exact six-kind schema/history | E1-SHAPE-001/002, E1-SEM-001/002/003 | malformed JSON, unknown, missing, impossible fields and impossible history | bounded JSON-byte API | Generated shape/truth/history matrices | designed only |
| Stable canonical identity | E1-ID-001/002, E1-CANON-001/002 | reorder, alternate spelling, size edge | E1 module import | ECMAScript JSON numeric/string vectors plus all-kind identity matrix | designed only |
| Exact replay/conflict | E1-REPLAY-001 | exact, conflict, distinct, concurrent equivalent | E1 module import | Six-kind Cartesian replay suite | designed only |
| Legal signal categories and producer helper | E1-SIGNAL-001 | zero, silent, isolated/sustained thresholds, invalid counts and category pairs | E1 classifier export | Exhaustive boundary table; E4 separately proves producer use | designed only |
| Recursive privacy/export | E1-PRIV-001/002, E1-READ-001 | nested sentinel, malformed wrapper/retained value | E1 projection/export exports | Generated recursive privacy suite | designed only |
| Finite lifecycle outcomes | E1-REPLAY-001, E1-BOUND-001 | response loss, after-effect-before-ack, stale epoch, cancellation, restart, unsupported API, queue/disk/cleanup failure | bounded JSON-byte API | Pure retry/error tests plus explicit E2/E4-E10 ownership assertions | designed only |
| Bounded E1 work | E1-CANON-002, E1-BOUND-001 | raw limit ±1, canonical limit ±1, series/export count 256 and 257, export byte limit ±1 | bounded JSON-byte API | Raw-byte/parser boundary vectors and elapsed/heap observation labeled local-only | designed only |
| E1 scope isolation | E1-BOUND-001 | attempted E2/E3 import | Module dependency graph | `node --test web/tests/s2e-e1-contract.test.mjs` import assertion | designed only |

Resource result, exact implementation tree identity, test names, and reviewed
privacy-field output are populated only after implementation is authorized and
the evidence exists. No S2-F measurement is deferred from E1; later checkpoints
own browser/process/storage measurements.

## Design-review decision

- Findings: the independent audit of `ec5d8bb` found an E1/E2 envelope and role-
  authority contradiction, incomplete field domains, individually valid but
  impossible histories, container-level privacy, ambiguous replay/size/error
  surfaces, an unrealizable arbitrary-JavaScript-object promise, unbounded
  rejected-input work, incomplete interruption ownership, and overstated signal
  provenance.
- Specification changes made: revision v3 defines an authority-free E1 core and
  separate E2 wrapper; removes role from E1; provides exact scalar, listener,
  source, relay, and transition domains; adds a bounded series validator and
  wrapper enforcement; recursively maps every leaf across every disclosure
  surface; defines null replay, canonical export, error precedence, strict
  bounded JSON input, and exact later-checkpoint ownership for every N/A; and
  narrows the signal guarantee to what E1 can prove.
- Open blockers: independent adversarial design review.
- Approved implementation scope: none until review passes
- Explicitly prohibited implementation scope: E2-E12; modification of worklet,
  browser hook, UI, collector, State/Game, source, or relay under E1
- Decision: `revise`
- Packet linked from the normative checkpoint: `yes`
- Every `Not applicable` names its owning checkpoint: `yes`
- Dependency-firewall review passed: `yes` for the specification; the active
  tree contains no E1 implementation and therefore supplies no implementation
  evidence
- Predictable-failure matrix resolved: `yes` in the specification
- No open P0/P1 design finding: `pending`
- Implementation authorized: `no`
