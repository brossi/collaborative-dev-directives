# S2-E E3 evidence derivation and comparison specification packet

## Identity and status

- Checkpoint: E3 — evidence derivation and comparison
- Scope revision: `E3-spec-v1`
- Status: `closure-review`
- Risk class: `A — isolated`
- Required prior verified checkpoints: E1 at `736a401`; E2 at `df41d2c`
- Explicitly excluded later checkpoints: persistence and queries (E7), HTTP and
  authorization (E8), producer adapters (E9/E10), UI/composed faults (E11), and
  real-host measurements (E12)
- Reviewers and review date: primary Codex review 2026-08-14; independent
  closure required before E11 or another consumer attaches

Implementation checkpoint: the fixed classifier and focused table are
implemented. Combined E1-E3 verification passes 39/39 with 98.27% E3 line and
89.54% E3 branch coverage. Independent closure is pending; no consumer is
authorized yet.

## Boundary and scale

One pure module owns a fixed version-1 classifier. It accepts only E2-branded
uploaded envelopes containing E1 window reports. There is no JSON, database,
network, clock, UI, authority, or side-effect surface in E3.

One call is bounded to:

- one source pair (`prior`, `current`);
- one relay pair (`prior`, `current`); and
- one to eight current listener windows.

Pairs exist because source and relay counters are instance-cumulative. Listener
measurements are already window-scoped. The classifier introduces no rule
engine, weights, plugins, configuration, history search, or diagnosis text.

## Invariants

| ID | Rule | Violation/result |
| --- | --- | --- |
| E3-IN-001 | Every input is an E2-branded envelope for one trace and one server timebase. Source/relay pairs retain kind and instance, increase sequence, do not overlap locally, and pass E1 series validation. | `insufficient_evidence` |
| E3-IN-002 | Exactly one source pair, one relay pair, and `1..8` distinct listener windows are accepted. Caller-authored component, health, interval, confidence, or result labels do not exist. | `insufficient_evidence` |
| E3-TIME-001 | Two mapped intervals overlap unless one interval's latest possible end is strictly before the other's earliest possible start. Overlap never proves precedence. | `insufficient_evidence` for an ordering-dependent rule |
| E3-RULE-001 | Only the five ordered rules below may produce a suspicion result. First matching rule wins; otherwise the result is `insufficient_evidence`. | finite result |
| E3-EVID-001 | Every suspicion result contains only exact references to contributing reports and their mapped interval/uncertainty. It contains no raw report, measurement object, or prose. | checkpoint failure |
| E3-PRIV-001 | E3 output is host/operator-only and contains no member projection. E8 owns authorization; E11 owns display. | `not_authorized` at later boundary |
| E3-BOUND-001 | E3 imports only verified E1/E2 pure surfaces and performs bounded synchronous work. | checkpoint failure |

## Exact input contract

The internal call is:

```text
classifyDiagnosticEvidence({
  source: {prior: source_window envelope, current: source_window envelope},
  relay: {prior: relay_window envelope, current: relay_window envelope},
  listeners: [listener_window envelope, ...] // 1..8
})
```

The outer object is an internal inert object assembled by E7/E11. Every envelope
must retain E2 private provenance. E3 validates:

- one shared `traceId`, correlation segment, lease, and `timebaseId`;
- exact authority/report family agreement;
- source and relay pairs share instance, kind, and strictly increasing sequence;
- E1 pair-series relations, including nondecreasing cumulative counters;
- listener instance IDs are distinct; and
- every report is a window, never a transition.

A missing component, wrong family, malformed/forged envelope, mixed trace or
timebase, bad pair, duplicate listener, or empty/oversized listener set returns
an `insufficient_evidence` result with a finite missing/reason code. It does not
throw caller data or attempt partial classification.

## Fixed derived states

Source and relay deltas are `current - prior`. Negative deltas are invalid. A
cumulative delta is not localized to the current report window. Its conservative
possible-occurrence span begins at the prior report's earliest mapped end and
ends at the current report's latest mapped end.

One cumulative pair strictly precedes another component only when the pair's
latest possible end is before the other component's earliest possible start.
A regular pair covers a listener window only when the listener's earliest start
is at or after the prior report's latest mapped end and its latest end is at or
before the current report's earliest mapped end. A regular source pair covers an
anomalous relay pair under the equivalent conservative pair boundary. Evidence
that does not prove these relationships yields `ordering_overlap`.

### Source

`source_anomalous` is true when any source delta for `captureGapCount`,
`droppedUploadCount`, `reconnectCount`, or `publisherRestartCount` is positive;
`publisherState` is `backoff|error`; or captured, enqueued, and published
frame deltas are not equal.

`source_regular` requires all four event deltas to be zero, positive and equal
captured/enqueued/published frame deltas, `publisherState == publishing`, and
`playbackObservation == playing`. Equal zero flow is `unknown`, not affirmative
regular evidence.

### Relay

`relay_anomalous` is true when any relay delta for `ingressGapCount`,
`rejectedIngressCount`, `droppedIngressCount`, `backpressureClosureCount`, or
`generationFenceDisconnectCount` is positive, or ingress advances while at
least one listener is active and delivered bytes do not advance.

`relay_regular` requires all five deltas to be zero, positive ingress and
delivered-byte deltas, and at least one active listener. Listener accept/close
counts are retained evidence but are not themselves an audio-failure signal.

### Listener delivery

`delivery_anomalous` is true when `receivedFrames == 0`, `reconnectCount > 0`,
`terminalCategory` is one of `no_response`, `rejected`, `unsupported_format`,
`stream_error`, `stream_ended`, or `aborted`; or an observed
`chunkGap.maxMs > 250`.

`delivery_regular` requires positive received frames, zero reconnects, terminal
category `open`, and either `chunkGap:not_applicable` or observed maximum at
most 250 ms.

Unknown publisher or listener terminal state is neither regular nor anomalous
and therefore yields `insufficient_evidence`.

### Listener buffer

`buffer_anomalous` is true when `underrunCount > 0`, `overflowCount > 0`, or an
observed buffer has `currentMs < 100` and `trendMsPerSecond < 0`.

`buffer_regular` requires zero underruns/overflows and an observed buffer that
does not meet the low/falling condition. `bufferDepth:unknown` is neither.

### Browser output

`output_anomalous` is true when `audioContextState` is
`suspended|interrupted|closed`, `suspensionCount > 0`, or observed long tasks
have `count > 0` and `maxDurationMs >= 100`.

`output_regular` requires context `running`, zero suspensions, and long tasks
that are observed with zero count or explicitly unsupported. Unknown output
evidence is neither.

## Fixed ordered classification table

| Order | Required evidence | Result | Confidence |
| --- | --- | --- | --- |
| 1 | source anomalous; relay anomalous; every listener delivery anomalous; source interval strictly precedes relay and every listener; relay strictly precedes every listener | `source_suspected` | `high` |
| 2 | source regular and conservatively covering the relay pair and every listener; relay anomalous; every listener delivery anomalous; relay evidence span strictly precedes every listener | `relay_suspected` | `high` |
| 3 | source and relay regular and conservatively covering every listener; exactly one listener delivery anomalous; every other listener delivery regular | `listener_delivery_suspected` | `medium` |
| 4 | source and relay regular and conservatively covering every listener; exactly one listener delivery regular and buffer anomalous; every other listener delivery/buffer regular | `listener_buffer_suspected` | `medium` |
| 5 | source and relay regular and conservatively covering every listener; exactly one listener delivery/buffer regular and output anomalous; every other listener delivery/buffer/output regular | `browser_output_suspected` | `medium` |
| fallback | any missing, unknown, contradictory, overlapping ordering evidence, zero/multiple isolated candidates, or no anomaly | `insufficient_evidence` | `insufficient` |

Strict precedence is `earlierEvidenceSpan.endLatestMs <
laterEvidenceSpan.startEarliestMs`. For cumulative pairs, the evidence span is
the possible-occurrence span defined above, not merely the current report
window. Equality or overlap is not precedence.

The table is deliberately layer-ordered for this small deployment. “Multiple
isolated candidates” means multiple candidates within the same rule layer. A
delivery diagnosis may therefore take precedence over a separate buffer or
browser-output symptom; E3 does not attempt a multi-diagnosis explanation.

## Exact output

```text
{
  diagnosisVersion: 1,
  result: "source_suspected" | "relay_suspected" |
          "listener_delivery_suspected" | "listener_buffer_suspected" |
          "browser_output_suspected" | "insufficient_evidence",
  confidence: "high" | "medium" | "insufficient",
  contributing: [evidenceRef, ...], // 0..12, sorted by mapped start then identity
  missing: finiteMissingCode[]       // sorted unique values
}

evidenceRef = {
  traceId: uuid,
  instanceId: uuid,
  sequence: uint,
  kind: "source_window" | "relay_window" | "listener_window",
  interval: {
    timebaseId: uuid,
    startEarliestMs: serverTimeMs,
    startLatestMs: serverTimeMs,
    endEarliestMs: serverTimeMs,
    endLatestMs: serverTimeMs,
    uncertaintyMs: 0..1000
  }
}
```

Finite missing codes are `source`, `relay`, `listener`, `trace_mismatch`,
`timebase_mismatch`, `invalid_pair`, `duplicate_listener`, `unknown_state`,
`segment_mismatch`, `ordering_overlap`, `contradictory_evidence`, and
`no_anomaly`.

Suspicion results have `missing:[]`. `insufficient_evidence` has at least one
missing code and includes only valid references that explain the failed
comparison; it never includes raw measurements.

## Failure, privacy, and lifecycle

E3 owns no state, receipt, epoch, queue, timer, resource, persistence, or retry.
Reset/restart/concurrency schedules are not applicable here and belong to the
producer checkpoints or E7/E8. One call allocates at most twelve small references
and performs no I/O. Any exception escaping verified E1/E2 input is converted to
the fixed insufficient result; no nested error or caller value is returned.

All output is host/operator diagnostic data. It is never member-copy data and
never contains source IDs, lease IDs, role, principal, network data, signal
envelopes, or arbitrary text. E8 and E11 must enforce the audience at their real
interfaces.

## Evidence and decision

Focused command:

```sh
node --test web/tests/s2e-e3-comparison.test.mjs
```

Planned fixed-table evidence covers all five positive rows; no anomaly; missing
component; mixed trace/timebase; invalid cumulative pair; duplicate listener;
zero and nine listeners; one versus multiple isolated candidates; exact 250/100
ms thresholds; strict precedence, equality, overlap, and uncertainty; forged
envelope rejection; output projection; and an E1/E2-only import firewall.

- Open blockers for isolated implementation: none.
- Approved scope: one pure E3 module and focused fixed-table tests.
- Prohibited scope: E7-E12, persistence, routes, authorization, UI, producers,
  generalized rules, scoring, configuration, or diagnosis prose.
- Decision: `proceed-isolated`
- Implementation authorized: `yes`, only for the approved isolated scope.
