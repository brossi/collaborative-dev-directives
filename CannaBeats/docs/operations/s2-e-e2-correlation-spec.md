# S2-E E2 synchronization and correlation authority specification packet

## Identity and status

- Checkpoint: E2 — synchronization and correlation authority
- Scope revision: `E2-spec-v1`
- Status: `locally-verified`
- Risk class: `B — boundary-bearing model`; isolated pure implementation is
  permitted, but authority/persistence/routing integration remains gated
- Draft baseline: commit `b3540a1` on
  `feature/slice-2-game-night-resilience`; the independent review records the
  exact commit and tree containing this packet.
- Required prior verified checkpoint: E1 implementation target `736a401`, with
  verification recorded by `b3540a1`
- Explicitly excluded later checkpoints: E3 diagnosis/comparison; E4 worklet;
  E5 browser lifecycle; E6 UI/copy; E7 collector persistence; E8 HTTP and
  State/Game mediation; E9 source reporter; E10 relay reporter; E11 composed
  fault localization; E12 real-host measurements
- Reviewers and review date: primary Codex design review on 2026-08-13;
  independent three-perspective implementation closure completed 2026-08-14

Verified implementation target: commit `df41d2c`. Timing provenance, interval mapping, immutable
envelope composition, trace/segment lifecycle, relay binding, listener consent,
operation-receipt replay, and report-ingest decisions are implemented in the
isolated E2 module. Focused E1+E2 verification passes 30/30 and independent
closure found no open P0/P1. Later checkpoints may consume this pure boundary;
this status does not verify persistence, routing, or authenticated integration.
The complete-envelope canonical encode/trusted-store restoration extension
specified below is an E7.1 prerequisite and is not part of the `df41d2c`
verification claim until its focused tests and E7 review pass.

## Boundary map

| Item | Specification |
| --- | --- |
| Sole owner | One pure E2 module owns version-1 synchronization-sample validation, interval mapping, exact uploaded-envelope composition, trace/segment state transitions, and consent/replay decisions. |
| Trusted inputs | Frozen E1 reports from the verified E1 module and an opaque branded authority fixture representing a successful future Game/State lookup. E8 owns creation of that brand at the real HTTP boundary. |
| Untrusted inputs | Length-bounded JSON bytes for clock observations and lifecycle commands; producer monotonic timestamps remain observations, never authority. |
| State and side effects | The E2 model is deterministic and side-effect free. It returns next states and finite decisions; E7/E8 later own transactions, clocks, request journals, and persistence. Private weak provenance brands may distinguish E2-produced values without retaining report data. |
| Outputs and consumers | Exact uploaded envelopes, mapped server-time intervals, trace/segment next states, consent next states, and finite results. E3 consumes stored intervals; E7 persists; E8 mediates callers. |
| Real interface under test | Pure module functions over E1 canonical bytes, bounded JSON bytes, and fixed branded authority fixtures. Passing SQLite, HTTP, React, or producer tests cannot advance E2. |
| Explicit non-goals | Health classification, offline alignment, signatures/PKI, public keys, arbitrary capabilities, principal persistence, storage, routing, source/relay scheduling, UI, and real clock-uncertainty measurement. |

E2 defines authority and timing truth but does not claim that a pure model proves
the future Game/State or collector transaction. E8 must compose the same model
through the real authenticated boundary; E7 must preserve its replay and
linearization rules transactionally.

## Scale filter

- Concrete deployment maximum: one active trace system-wide, one active run,
  one current managed lease segment, eight listener instances, one source
  instance, one relay generation, six hours per trace, and one clock sample per
  producer per minute.
- Smallest sufficient mechanism: fixed plain-object schemas, one two-way clock
  inequality, and two small pure state reducers.
- Simpler option considered: collector receipt time alone cannot establish event
  order across unrelated browser/source/relay monotonic clocks.
- Platform-scale mechanisms explicitly omitted: clock-daemon protocol, drift
  estimator, NTP implementation, PKI, signed offline reports, capability
  framework, multi-trace scheduler, generic workflow engine, and event sourcing.
- Evidence that would justify more: measured supported-device drift exceeding
  the one-minute sample window, or a future requirement for offline aligned
  comparison without the collector.

## Invariants

| ID | Normative rule | Violation result | Owning test or planned test |
| --- | --- | --- | --- |
| E2-CORE-001 | E2 accepts only an E1-produced frozen measurement report. Re-encoding that report through E1 produces the exact original canonical bytes; E2 never rewrites it. | `report_invalid` | Reorder/tamper/core-byte matrix |
| E2-TIME-001 | A sample is physically possible only when local and server intervals are ordered, server processing does not exceed local round trip, and local round trip is at most 2000 ms. | `sample_invalid` | Inequality boundary table |
| E2-TIME-002 | Offset bounds are exactly `lower = serverSendMs - localReceiveMs` and `upper = serverReceiveMs - localSendMs`, with `lower <= upper`; bounds are never repaired by sorting. | `sample_invalid` | Asymmetric-delay and impossible-order vectors |
| E2-TIME-003 | A report maps only when its local interval begins at or after sample receipt and ends no later than 60000 ms after sample receipt. | `sample_expired` | Exact validity-boundary matrix |
| E2-TIME-004 | Mapping derives four safe server-time bounds and uncertainty `(upper-lower)/2`; checked arithmetic must stay finite in `0..MAX_SAFE_INTEGER`, and uncertainty must be at most 1000 ms. | `alignment_invalid` | Overflow/uncertainty matrix |
| E2-TIME-005 | Different `timebaseId` values are unrelated. E2 never rewrites or compares them; E3 later returns `insufficient_evidence`. | Finite unrelated result | Different-timebase fixture |
| E2-TIME-006 | Producer input contains only sample ID, instance ID, and local send/receive observations. Timebase and server timestamps come only from the matching branded issuance record; caller copies are rejected. | `sample_invalid` | Issuance/observation provenance matrix |
| E2-AUTH-001 | `runId`, run generation, trace, segment, lease, role, source association, and relay generation appear only in branded server context derived from the trusted authority input. | `authority_invalid` | Caller-label/provenance matrix |
| E2-AUTH-002 | Listener context stores only `host|member`; source and relay variants are exact and cannot accept fields from another authority kind. No principal identity is retained. | `authority_invalid` | Exact union/privacy matrix |
| E2-TRACE-001 | At most one trace is active system-wide. Start requires current host/run authority; a competing run returns `trace_busy`; exact request replay returns the original result. | Finite trace result | Start/replay/conflict table |
| E2-TRACE-002 | A trace ends on explicit stop, six-hour expiry, run replacement, or authority loss. End is monotonic and cannot reopen the same trace identity. | Finite end result | End-reason/state table |
| E2-SEG-001 | One active trace has one current correlation segment. Exact same lease replays; lease replacement creates a new segment; a relay generation binds once to its then-current segment and never rebinds. | `stale_correlation` | Lease/generation rotation table |
| E2-CONSENT-001 | Listener sharing is disabled by default. Opt-in increments consent generation and records the first allowed local sequence/start; pre-opt-in observations are never eligible for upload. | `sharing_disabled` | Opt-in boundary matrix |
| E2-CONSENT-002 | Stop-sharing commits revocation before acknowledgement. An unseen old-generation report is rejected, while exact replay of a report committed before stop remains `replayed` without a new write. | Finite ingest decision | Stop/ingest interleaving table |
| E2-REPLAY-001 | Stored report identity is `(traceId, instanceId, sequence)`. Same E1 bytes replay the originally stored alignment/context; different E1 bytes conflict. A retry never rewrites correlation. | `replayed|report_conflict` | Response-loss/replay matrix |
| E2-REPLAY-002 | Trace, consent, and relay-binding reducers return one fixed canonical command/result receipt. A branded retained receipt plus identical command replays its result; conflicting request-ID reuse fails. Sample acquisition is a side-effect-free timing attempt and is deliberately not replayed. | `replayed|request_conflict` | Fixed-operation replay table |
| E2-STORE-001 | The complete uploaded envelope has one registry-order canonical encoding no larger than 4,096 bytes. Trusted-store restoration revalidates its E1 bytes, timing/context relations, and exact re-encoding before restoring provenance. | `report_invalid|report_too_large` | Six-kind maximal-shape, reorder, tamper, and 4,096/4,097 tests |
| E2-PRIV-001 | E2 authority/alignment is host/operator diagnostic data only. Local/member copy remains the E1 projection and never gains E2 siblings. | `not_authorized` | Recursive projection matrix |
| E2-BOUND-001 | E2 imports E1 only and performs bounded synchronous computation over one report/state transition. | Checkpoint failure | Dependency/source inspection |

## Executable data and privacy contract

### Scalar aliases and byte boundary

- `uuid` is the lowercase canonical RFC-variant/version `1..8` UUID domain
  already verified by E1.
- `uint` is an integer `0..9007199254740991`.
- `positiveUint` is an integer `1..9007199254740991`.
- `serverTimeMs` and `localTimeMs` are finite numbers
  `0..9007199254740991`, including fractional milliseconds and excluding `-0`.
- `signedOffsetMs` is finite in
  `-9007199254740991..9007199254740991`, excluding `-0` except exact numeric
  zero.
- E2 JSON inputs are UTF-8 bytes no larger than 8 KiB and use the same fatal
  decode, inert parsed-JSON, exact-object, lowercase-identity, finite-error, and
  private-provenance rules as E1.
- Every object below is exact. Unknown fields and cross-variant fields are
  rejected; no extension bag exists.
- Complete uploaded-envelope canonical encoding and trusted-store restoration
  are the only additive E2 storage surfaces. They accept no authority override,
  database row, receipt, or E7 metadata.

### Synchronization sample

The authenticated producer submits only this exact observation:

```text
{
  sampleId: uuid,
  instanceId: uuid,
  localSendMs: localTimeMs,
  localReceiveMs: localTimeMs
}
```

The future Game/collector issuance store supplies a separately branded exact
record `{sampleId, timebaseId, instanceId, serverReceiveMs, serverSendMs}`.
E2 requires both IDs to match and composes them into the exact accepted sample.
E7 retains the unused issuance for a 120-second transport grace while E2 keeps
the report-mapping validity below at exactly 60 seconds:

```text
{
  sampleVersion: 1,
  sampleId: uuid,
  timebaseId: uuid,
  instanceId: uuid,
  localSendMs: localTimeMs,
  localReceiveMs: localTimeMs,
  serverReceiveMs: serverTimeMs,
  serverSendMs: serverTimeMs
}
```

No public E2 input accepts `timebaseId`, `serverReceiveMs`, or `serverSendMs`.
If a producer includes a copy, the unknown fields are rejected rather than used
or corrected. E8 owns authenticated issuance/lookup and E7 owns its bounded
120-second transport-grace persistence; the pure E2 fixture supplies only the same private
provenance brand.

No additional synchronization route is introduced. The listener-instance,
source-work, and relay-generation responses carry the first issuance. A
successful listener/source/relay report response may carry the next issuance
when renewal is due. The producer records local send immediately before that
request and local receive after the response, so the new sample applies only to
subsequent measurement intervals. A lost response yields no usable sample and
does not authorize pairing the issuance with another request's local times.

Let `localRtt = localReceiveMs - localSendMs` and
`serverWork = serverSendMs - serverReceiveMs`. Validation requires:

```text
localSendMs <= localReceiveMs
serverReceiveMs <= serverSendMs
0 <= serverWork <= localRtt <= 2000
offsetLowerMs = serverSendMs - localReceiveMs
offsetUpperMs = serverReceiveMs - localSendMs
offsetLowerMs <= offsetUpperMs
mappingUncertaintyMs = (offsetUpperMs - offsetLowerMs) / 2 <= 1000
```

The offset bounds are not sorted. If the inequalities do not already establish
their order, the sample is impossible and rejected. Producer timestamp honesty
is not elevated to authority: a producer can at worst degrade its own optional
diagnostic evidence. E8 authenticates which instance may submit the sample.

### Alignment mapping

The E1 report local end is `monotonicStartMs + durationMs` using checked
arithmetic. Mapping requires:

```text
report.monotonicStartMs >= sample.localReceiveMs
reportLocalEndMs <= sample.localReceiveMs + 60000
report.instanceId == sample.instanceId
```

The exact derived alignment is:

```text
{
  alignmentVersion: 1,
  sample: synchronizationSample,
  offsetLowerMs: signedOffsetMs,
  offsetUpperMs: signedOffsetMs,
  mappedStartEarliestMs: serverTimeMs,
  mappedStartLatestMs: serverTimeMs,
  mappedEndEarliestMs: serverTimeMs,
  mappedEndLatestMs: serverTimeMs,
  mappingUncertaintyMs: finite 0..1000
}
```

The four mapped bounds are the local start/end plus the lower/upper offsets.
They must satisfy:

```text
startEarliest <= startLatest <= endLatest
startEarliest <= endEarliest <= endLatest
startEarliest <= endEarliest
startLatest <= endLatest
```

Expiry is evaluated when the report first linearizes. Once E7 stores a valid
alignment, later sample expiry does not invalidate it. Collector receipt time
is E7 transport metadata, not part of this envelope and not event-time truth.
The pure mapper privately binds every derived alignment to the exact canonical
E1 bytes from which it was calculated. Envelope composition rejects reuse with
another sequence, interval, kind, or payload even when the instance ID matches.

### Branded server context

All variants share:

```text
contextVersion: 1
traceId: uuid
runId: uuid
runGeneration: positiveUint
correlationSegmentId: uuid
leaseId: uuid
authorityKind: listener | source | relay
```

The exact variant suffixes are:

```text
listener: { authorityKind:"listener", role:"host"|"member",
            listenerInstanceId:uuid }
source:   { authorityKind:"source", role:"source", sourceId:uuid,
            sourceInstanceId:uuid }
relay:    { authorityKind:"relay", role:"relay", relayGenerationId:uuid }
```

The variant instance/generation ID must equal the E1 `instanceId`. `leaseId`
and segment must be the live managed-stream authority observed for the trace.
The context contains no principal, display name, account, cookie, invitation,
IP, URL, credential, song, command payload, or free text.

The pure E2 implementation accepts server context only through a private brand
created from the fixed trusted-authority fixture. Production creation of that
brand is deliberately absent until E8 composes the real Game/State response.
There is no public function that accepts a caller-authored context object.

### Uploaded envelope

The exact E2 output is:

```text
{
  uploadVersion: 1,
  measurementCore: frozen normalized E1 report,
  alignment: derivedAlignment,
  serverContext: brandedServerContext
}
```

`measurementCore` is the exact E1-produced object; calling E1 canonical encoding
on it yields the same bytes accepted at the E2 boundary. Alignment and context
are siblings and cannot rewrite it. Envelope identity is
`(traceId, E1.instanceId, E1.sequence)`. E2 owns one registry-order standard
JSON encoding of the complete envelope and one trusted-store restoration API.
The encoding is at most 4,096 bytes and includes the unchanged canonical E1
core plus exact alignment and server context. Restoration revalidates the E1
core, every exact sibling shape, timing arithmetic, instance/family/trace
relationships, and the same canonical encoding before restoring private
provenance. It does not reauthenticate historical server authority; E7 may call
it only for bytes previously committed through the authenticated E8-to-E7
boundary. All-six-kind maximal-shape and 4,096/4,097-byte tests are a required
E7.1 prerequisite. E7 owns transactions and storage, not a second envelope
schema.

E2 also exposes narrow trusted-store restoration functions for the exact trace,
consent, relay-binding, and synchronization-issuance projections. Each reruns
the complete shape and relational invariants before restoring private
provenance; none accepts authority overrides or derives a new decision. A
receipt-free `expireDiagnosticTrace(currentTrace)` transition is defined only
for an active trace at its logical boundary. It sets reason `expired` and
`endedAtMs = expiresAtMs` exactly, regardless of when a collector restart first
observes the boundary. The existing trace-end reducer uses that same rule when
its observed clock is at or after expiry. These additive restoration/expiry
surfaces and their restart tests are part of the E7.1 prerequisite, not the
earlier `df41d2c` claim.

### Trace and segment state

Absence of an active trace is represented only by exact `null`. It is not an
empty or partially populated trace object.

The pure current-state projection is exact:

```text
{
  traceVersion: 1,
  traceId: uuid,
  runId: uuid,
  runGeneration: positiveUint,
  status: "active" | "ended",
  startedAtMs: serverTimeMs,
  expiresAtMs: serverTimeMs,
  ended: {status:"not_applicable"} |
         {status:"ended", endedAtMs:serverTimeMs,
          reason:"host_stopped"|"expired"|"run_replaced"|"authority_lost"},
  segment: {
    segmentId: uuid,
    leaseId: uuid,
    startedAtMs: serverTimeMs
  }
}
```

`expiresAtMs = startedAtMs + 21600000` with checked arithmetic. For
`reason:"expired"`, `endedAtMs` is exactly `expiresAtMs`; other end reasons must
commit before expiry and use the observed server time. An ended trace
retains its final segment only as diagnostic correlation. It authorizes no new
sample, consent, report, or read. E7 stores the current trace and prior segment bindings needed
for already accepted reports; the E2 current projection deliberately is not an
event log.

Trace commands carry a canonical request UUID. The pure reducer accepts a
branded current host/run/lease authority and derives all IDs except request ID.
An active trace for another run returns `trace_busy`; an active trace for the
same run returns the existing trace only for the exact accepted request replay.
An ended trace ID cannot reopen, a new lease must receive a segment ID distinct
from the current segment, and terminal time cannot precede the final segment.
At or after `expiresAtMs`, `expired` is the only accepted terminal reason.
Repeating an already-applied lease/segment projection returns that exact state;
it does not create another segment. Restored state also requires the retained
segment to begin strictly before trace expiry.

Relay generation binding is exact `{relayGenerationId, traceId, segmentId,
leaseId}`. Once created it is immutable. A delayed report uses that original
binding or is rejected; current lease lookup never relabels it. The reducer
receives E7's retained lookup for the requested generation. After exact receipt
replay, any non-null lookup result fails closed; a new binding is created only
from an atomically proven absent lookup. This also rejects a wrong-row lookup
rather than silently treating it as absence.

### Fixed operation replay

Only five E2 operations create durable state: `trace_start`, `trace_end`,
`consent_opt_in`, `consent_stop`, and `relay_bind`. Each command is an exact
object with `{requestId, operation, parameters}`, where `parameters` is the
fixed operation-specific object and contains no authority field that E2 derives
from its branded server facts.

| Operation | Exact `parameters` |
| --- | --- |
| `trace_start` | exact empty object; current run/lease/host and issued trace/segment IDs come from branded server facts |
| `trace_end` | exact empty object; the current active trace comes from branded server facts |
| `consent_opt_in` | `{listenerInstanceId:uuid, firstAllowedSequence:uint, localConsentStartedMs:localTimeMs}` |
| `consent_stop` | `{listenerInstanceId:uuid, expectedGeneration:positiveUint}` |
| `relay_bind` | `{relayGenerationId:uuid}`; current trace/segment/lease come from branded server facts |

A successful pure reducer returns an exact branded receipt:

```text
{
  receiptVersion: 1,
  requestId: uuid,
  operation: trace_start | trace_end | consent_opt_in | consent_stop | relay_bind,
  canonicalCommand: exact normalized command object,
  result: exact operation-specific E2 result
}
```

The operation-specific result is respectively an active trace state, ended
trace state, enabled consent state, revoked consent state, or immutable relay
binding. E2 canonical encoding of `canonicalCommand` supplies the replay bytes.
E2 exposes an explicitly trusted-store restoration function for E7; it is not
an untrusted ingest surface. Restoration validates the operation/result status,
command identity, consent boundary/generation, listener identity, and relay
generation before recovering private provenance. On retry, identical canonical
command bytes return
the retained result with `replayed`; different bytes under the same
request ID return `request_conflict`. The retained result is never recomputed
from current authority.

Synchronization acquisition is not in this list. It is a side-effect-free
timing attempt: each network attempt uses a new request UUID, and only a response
actually received by the producer supplies the matching local receive time.
A lost response creates no usable sample and retry starts a new attempt. The
issuance becomes durable before its response is returned and expires after 120
seconds. A response-loss issuance is harmless and expires unused. The complete
accepted sample first becomes durable inside a report envelope when that report
and its physically valid mapping commit together in E7.

Automatic six-hour expiry is not a sixth request operation. It is an
authority-reducing deterministic transition of the retained trace at its
already-committed `expiresAtMs`; it has no caller request ID or receipt. A later
explicit trace-end request observes the ended trace and returns the finite
inactive result rather than creating another terminal effect.

### Listener consent state and ingest decision

The current consent projection is:

```text
{
  consentVersion: 1,
  traceId: uuid,
  listenerInstanceId: uuid,
  generation: positiveUint,
  status: "enabled" | "revoked",
  firstAllowedSequence: uint,
  localConsentStartedMs: localTimeMs,
  changedAtMs: serverTimeMs
}
```

Opt-in is forward-only. E5 supplies the next local sequence and current local
monotonic time; E8 authenticates the instance and journals the request. A report
is eligible only when its sequence and local start are not earlier than those
two stored boundaries and its grant generation equals the enabled generation.
Stop increments generation and marks revoked before returning. Re-opt-in may
advance but never lower either boundary or the server change time.

The ingest/replay truth table is:

| Stored identity | E1 bytes | Consent at first attempt | Result |
| --- | --- | --- | --- |
| absent | valid | current enabled generation and after forward boundary | `accepted` |
| absent | valid | revoked, stale generation, or before boundary | `sharing_disabled` |
| present | identical | any later consent state | `replayed` with original alignment/context |
| present | different | any | `report_conflict` |
| absent/present | malformed | any | `report_invalid`; retained value unchanged |

This consent column applies only to listener envelopes. A first authenticated
source or relay envelope is `accepted` without listener consent; its exact
identity replay and conflict rows are otherwise identical. E2 returns the
decision only. E7 owns the atomic stored-identity lookup/write; E8 owns listener
grant and producer authority authentication plus the external acknowledgement.

### Recursive privacy matrix

| Exact data | Ingest | Diagnostic persistence | Member/local copy | Host/operator | Audit/error/log | Malformed retained read |
| --- | --- | --- | --- | --- | --- | --- |
| unchanged E1 core | E1 validate | yes after E2 acceptance | E1 member projection only | E1 operator projection | finite code only | whole-envelope unavailable |
| sample IDs, timebase, four sample times, offsets, mapped interval, uncertainty | E2 derive/validate | yes | never | yes | finite code only | whole-envelope unavailable |
| trace/run/generation/segment/lease IDs and coarse role | server derive | yes | never | yes | finite code only | whole-envelope unavailable |
| source ID / relay generation | server derive | yes | never | yes | finite code only | whole-envelope unavailable |
| principal/account/player/cookie/IP/URL/credential/free text | reject | never | never | never | never | never echo |

Trace status may expose only trace active/ended and finite reason to the
authenticated current host through E8. Local copy remains exactly E1 and has no
aligned mode in version 1.

## Lifecycle, concurrency, and interruption matrix

The future E7 transaction is the durable linearization point. E2 defines the
required next state/result without claiming persistence.

| Schedule | Required durable state | Required caller result | Forbidden result |
| --- | --- | --- | --- |
| Trace start before commit | no trace | finite failure/unknown | claimed active trace |
| Trace start committed, response lost | one active trace/request receipt | exact retry returns original trace | second trace/new IDs |
| Competing trace starts | exactly one winner | winner accepted; loser `trace_busy` | two active traces |
| Trace end committed, response lost | trace ended once | retry `replayed` | reopened/new end reason |
| Lease changes during report | report uses binding established before commit or fails stale | `accepted|stale_correlation` | relabel to new lease |
| Relay generation start response lost | one immutable generation binding | exact retry original binding | rebind to current lease |
| Sample response lost | no sample or report | retry uses a new timing attempt/request ID | combining old server timestamps with new local send/receive times |
| Sample expires during ingest | serialization decides before/after boundary | accepted with stored mapping or `sample_expired` | accepted without valid mapping |
| Opt-in response lost | enabled generation/boundary committed once | exact retry original grant state | backfill or generation skip |
| Stop races unseen report | one transaction wins | accepted if ingest first; otherwise `sharing_disabled` | post-stop unseen acceptance |
| Stop races accepted replay | retained accepted row unchanged | `replayed` | deletion or sharing-disabled rewrite |
| Conflicting report retry | retained row unchanged | `report_conflict` | overwrite/merge |
| Process restart | E7 reloads trace/consent/sample/request state | same decisions | inferred authority from memory |
| Teardown | no E2 resource exists | not applicable | timer/socket/file owned by E2 |

## Failure and resource model

- Finite outcomes/errors: `accepted`, `replayed`, `trace_busy`, `ended`,
  `sharing_disabled`, `report_conflict`, `report_invalid`, `sample_invalid`,
  `sample_expired`, `alignment_invalid`, `authority_invalid`,
  `stale_correlation`, `request_conflict`, `not_authorized`, and
  `unrelated_timebase`.
- `unknown`: authority or sample evidence is absent/indeterminate and cannot be
  treated as current. `unsupported`: not applicable to E2 because it probes no
  platform API; E5, E9, and E10 own unsupported producer APIs.
  `not_applicable`: only the active trace's ended union.
- Logical limits: one 8-KiB input, one E1 report, one sample, one context, one
  trace state, and one consent state per pure call; sample RTT 2 seconds,
  validity 60 seconds, uncertainty 1 second, trace lifetime 6 hours.
- Physical limits/reserve: not applicable because E2 allocates no service,
  file, database, queue, or retained collection. E7 owns diagnostic-store
  limits; E8 owns HTTP body/time limits.
- Queue/retry/backoff/drop: none in E2. E7 owns transactional replay; E8-E10 own
  network/report queues.
- Degraded/read-only behavior: invalid/missing authority or timing fails closed;
  E2 has no degraded mutable mode.
- Cleanup/restart: no resource. Pure output can be discarded; E7/E8 own restart.
- Gameplay isolation: E2 does no I/O and cannot mutate State, audio, gameplay,
  backup, history, or rollback.

## Dependency firewall

E2 may import only these verified E1 surfaces from
`web/lib/s2e-e1-contract.mjs`: `validateMeasurementJson`,
`canonicalMeasurementBytes`, `measurementIdentity`, and `E1ContractError`.
It may not import E3 classification, SQLite, HTTP clients/routes, React,
worklets, source/relay adapters, clocks, crypto, or collector code.

Planned focused command:

```sh
node --test web/tests/s2e-e2-correlation.test.mjs
```

The focused test imports only E1, E2, and fixed authority fixtures. Its source
assertion rejects E3-E12 imports and any database/network/UI dependency.

## Predictable adversarial probes

- Non-byte, invalid UTF-8, unknown fields, inherited/live objects, uppercase or
  nil IDs, negative zero, fractional boundaries, and safe-number overflow.
- Impossible clock schedules: reversed local/server intervals, server work
  longer than RTT, RTT 2000/2000+epsilon, negative offset interval, uncertainty
  1000/1000+epsilon, report before sample, expiry boundary, and different
  timebases.
- Caller attempts to supply run/trace/lease/role/source/relay fields; wrong
  authority variant; instance mismatch; stale trace/segment/lease; delayed old
  relay generation.
- Trace start response loss, competing start, exact/conflicting request replay,
  end response loss, expiry/run replacement/authority loss, and attempted reopen.
- Sample response loss followed by a new timing attempt; old server timestamps
  must never be paired with the retry's local timestamps.
- Consent opt-in response loss, pre-opt-in backfill, stop versus unseen ingest,
  stop versus accepted replay, stale generation, exact replay with a new sample,
  and conflicting E1 bytes.
- Reordered E1 properties preserve bytes; E2 never rewrites the core.
- Unsupported authority dependency returns finite failure; quota/disk/queue are
  explicitly E7-E10-owned and cannot be claimed by a pure E2 test.
- A deliberately weakened test must fail if it sorts impossible offset bounds,
  trusts a caller serverContext, rewrites accepted correlation on replay, or
  allows an unseen old-generation report after stop.

## Evidence and claim ledger

| Claim | Invariant IDs | Negative schedules | Real interface | Test/evidence | Permitted status wording |
| --- | --- | --- | --- | --- | --- |
| Physically valid mapping | E2-TIME-001..005 | impossible order, RTT/work/expiry/overflow bounds | pure sample/map API | finite inequality matrix | implemented; closure pending |
| Unchanged E1 boundary | E2-CORE-001 | reordered/tampered/forged core | E1 frozen report into E2 | all-six-kind canonical byte equality | implemented; closure pending |
| Server-only authority context | E2-AUTH-001/002 | caller labels, wrong variant, stale authority | branded fixed authority seam | exact context/privacy matrix | implemented pure seam; E8 later proves HTTP derivation |
| Trace/segment lifecycle | E2-TRACE-001/002, E2-SEG-001, E2-REPLAY-002 | duplicate/race/expiry/handoff/restart | pure reducers/receipt validator | state/result table | implemented pure reducer; E7/E8 later prove transactions |
| Consent/replay lifecycle | E2-CONSENT-001/002, E2-REPLAY-001 | backfill, stop race, response loss, conflict | pure decision table | finite interleaving table | implemented pure reducer; E7/E8 later prove transactions |
| Bounded isolation | E2-BOUND-001 | attempted later import/I/O | pure module | dependency assertion | implemented; closure pending |

Exact implementation identity, focused results, and reviewed output fields are
recorded only after implementation. No E2 real-clock accuracy is claimed:
supported-device/host uncertainty and drift measurement remains E12/S2-F, after
E2 locally proves the formula and fixed bounds.

## Design-review decision

- Findings: the primary pass fixed the clock formula, provenance, replay,
  consent, and friends-and-family scale. Two implementation increments and two
  adversarial closure rounds then closed alignment provenance, identity reuse,
  forward-consent, producer ingest, receipt restoration, and retained-state
  fail-closed schedules. No P0/P1 remains in the pure E2 boundary.
- Specification changes made: split the pure E2 authority/timing model from E7
  persistence and E8 HTTP composition; fixed the physically correct offset
  formula without sorting; selected one-minute sample validity and finite
  friends-and-family limits; excluded PKI/offline alignment.
- Open blockers: none for the pure E2 boundary. E7/E8 still own and must verify
  persistence and authenticated integration before deployment.
- Approved implementation scope: one dependency-free E2 pure module and its
  focused tests using verified E1 outputs and opaque authority fixtures.
- Explicitly prohibited implementation scope: E3-E12, database/service/route/UI,
  source/relay reporter, or production authority-brand creation.
- Decision: `designed`
- Packet linked from the normative checkpoint: `yes`
- Every `Not applicable` names its owning checkpoint: `yes`
- Dependency-firewall review passed: `yes`; E2 imports only verified E1
- Predictable-failure matrix resolved: `yes` for the pure model
- No open P0/P1 design finding: `yes` for the reviewed pure boundary
- Implementation authorized: `yes`; later integration remains owned by its
  checkpoint
