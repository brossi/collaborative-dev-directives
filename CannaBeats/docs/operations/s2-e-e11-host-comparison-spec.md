# S2-E E11 host comparison and composed local proof

## Identity and status

- Checkpoint: E11 — one host comparison proof
- Status: `audit remediation implemented; narrow closure re-review pending`
- Risk class: `B — boundary-bearing`, because this joins retained diagnostic
  evidence to host authorization and a browser-visible conclusion
- Required verified checkpoints: E1-E10 at their recorded exact targets
- Product scale: one advanced host panel, one trace at a time, at most eight
  contemporaneous listeners, and the existing 4,096-report trace ceiling

## Governing invariant

> The host view publishes only one reproducible E3 conclusion assembled from a
> complete, authorized E7 trace snapshot; every incomplete, stale,
> contradictory, over-capacity, purged, or unavailable schedule fails finitely
> without exposing raw measurements, member identifiers, or affecting game or
> audio behavior.

E11 is not an observability dashboard. It adds no query language, saved view,
alerting system, background poller, or new diagnostic authority. The existing
E8 host check remains the sole authorization boundary, E7 remains the sole
retained-data owner, and E3 remains the sole classification owner.

## Exact production boundary

The browser sends the exact body `{traceId}` to
`POST /api/diagnostics/comparison`. The production handler:

1. applies the existing origin, 8 KiB request, finite error, and no-store rules;
2. calls the E8 host-authorized trace read one page at a time;
3. accepts no partial result: every page must have the same trace projection and
   metadata, cursor progress must terminate, and at most 16 pages / 4,096
   reports may be consumed;
4. assembles the deterministic cohort below from the restored, privately
   branded E2 envelopes returned by the collector client;
5. invokes `classifyDiagnosticEvidence` exactly once; and
6. returns only the minimized E11 projection.

The comparison has a two-second outer response deadline. A page already in
flight remains bounded by E8's existing dependency deadline, but no later page
starts after E11 has timed out. The route performs no mutation and creates no
durable state.

The response is exactly:

```text
{
  comparisonVersion: 1,
  trace: { traceId, status, startedAtMs, endedAtMs },
  reportCount,
  diagnosis: {
    result,
    confidence,
    missing,
    evidenceCount,
    interval: null | { startEarliestMs, endLatestMs }
  }
}
```

`result` is one of the five E3 suspicion values or
`insufficient_evidence`. `missing` is the sorted finite E3 reason list. The
browser receives no contributing `instanceId`, sequence, segment, lease,
timebase, platform context, measurement object, or producer/member field.

## Deterministic cohort selection

Only the six verified uploaded envelope kinds may enter the complete snapshot;
E11 considers window kinds and ignores transition kinds for classification.

1. Partition windows by exact `(traceId, correlationSegmentId, leaseId,
   timebaseId)`.
2. Choose the partition containing the newest listener-window end. Ties use the
   lexical partition key. If no listener window exists, E3 receives missing
   listener evidence.
3. For source and relay independently, choose the instance whose newest window
   has the latest mapped end, with instance ID as the tie-break. Use its newest
   two sequence-ordered windows. If the newest instance has fewer than two,
   that family is missing; E11 never falls back to an older instance.
4. For listeners, retain the newest window per instance whose end lies within
   60 seconds of the partition's newest listener end. Sort by instance ID. More
   than eight candidates is over-capacity and is passed to E3 as insufficient
   listener evidence rather than silently truncating a participant.
5. E3 owns series validity, segment/timebase equality, temporal coverage,
   uncertainty, anomaly thresholds, duplicate listeners, and every final
   classification. E11 does not reinterpret an E3 result.

The 60-second cohort horizon is a fixed selection bound, not evidence of
causality. E3 still rejects noncontemporaneous or overlapping evidence.

## Browser view

The advanced host panel is rendered only when the current game projection says
`isHost`. It supports four explicit actions:

- start a trace for the current run;
- refresh the comparison for the retained trace ID;
- stop the trace; and
- close the panel.

There is one pending action. Buttons are disabled while it is pending. Closing
aborts only a read-only comparison request and clears the browser-only result;
start/stop requests are allowed to settle because their effects may already
have committed. One exact versioned `sessionStorage` control record retains the
current run ID, start request ID, optional trace ID, and optional stop request
ID. It is written before a mutation dispatch, allows exact response-loss replay
after refresh in the same tab, and contains no report, measurement, diagnosis,
member identity, credential, or platform context. There is no timer, background
polling, local-storage record, automatic reconnect, or member view.
The panel labels every conclusion as diagnostic evidence rather than an audio
control decision. Collector failure changes only the panel's finite status.

## Closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: only E8 `trace_start` creates a trace; E11 generates one request UUID per explicit start and retains it until the response resolves. |
| Update | `structural`: a comparison response is immutable browser state and cannot update State, audio, E7 evidence, or E3 rules. |
| Delete | `runtime`: E8 stop ends the trace; maintenance-owned whole-trace purge makes later compare return concealed not-found. E11 owns no deletion. |
| Omit | `runtime`: incomplete paging, missing families, fewer than two newest source/relay windows, no listeners, or more than eight recent listener instances returns finite insufficient/unavailable; no partial classification is published. |
| Duplicate | `runtime`: exact page/cursor progression is E7-owned; E11 selects one newest envelope per listener instance and E3 rejects duplicate listener identity or invalid source/relay series. |
| Reorder | `runtime`: E7 snapshot cursors freeze report membership; E11 verifies stable page metadata and sorts by mapped interval, instance, and sequence before deterministic selection. |
| Replay | `runtime`: trace start/stop replay remains E8-owned; comparison is a read-only recomputation over one immutable E7 read snapshot. |
| Conflict | `runtime`: E8 rejects conflicting start/stop request IDs before current authority; E11 accepts only one exact trace locator. |
| Concurrency | `runtime`: the browser admits one action; each server comparison owns one E7 read session and at most 16 sequential page reads. Concurrent host reads remain independent snapshots. |
| Expiry | `runtime`: E8 reconciles active trace expiry before reads; E7 purge/retention equality returns finite not-found/read-expired; E11 invents no grace period. |
| Restart | `runtime`: one validated `sessionStorage` control record retains exact pending lifecycle request identity within the tab; E8 replay reconstructs the trace result. Missing/malformed storage fails finite before mutation and never guesses an active trace. |
| Dependency failure | `runtime`: Access, State, collector, cursor, timeout, malformed response, and deletion failures use the existing finite browser map; the comparison module never runs E3 over a failed/partial read. |
| Corruption | `runtime`: E7 validates the complete retained graph before every page, the collector client restores branded E2 envelopes, E8 rebinds trace/run metadata, and E11 verifies cross-page stability before selection. |
| Capacity | `runtime`: 16 pages, 4,096 reports, eight recent listener instances, one browser action, one diagnosis, and a two-second outer deadline are fixed constants with max-1/max/max+1 tests. |

## Matrix-derived verification

Focused tests must cover:

- each of the five positive E3 results through the E11 selector and minimized
  projection;
- missing source, relay, listener, contradictory, and temporal-overlap results;
- newest-instance no-fallback, segment/timebase partitioning, stale listener
  exclusion, eight/nine listeners, stable sorting, and exact privacy fields;
- one page, 256/257 reports, 16-page completion, a 17th-page refusal, repeated
  cursor, cross-page trace/metadata substitution, and timeout;
- host success, member concealment, unauthenticated auth-before-read, trace
  stop, whole-trace purge, deleted collector, malformed response, and no-store;
- one real local Access -> State -> Game mediation -> collector -> E11 -> E3
  schedule for each fixed fault family plus missing evidence; and
- production page attachment, one-action fencing, close/unmount cleanup, and a
  structural assertion that gameplay/audio/readiness do not import E11.

The pre-audit counterexample question is:

> What is the smallest report, page, cursor, cohort, authorization, or lifecycle
> substitution that preserves every checked field but changes the published E3
> conclusion or exposes evidence outside the host view?

E11 closes only after the focused and composed suites pass and one independent
adversarial review finds no open P0/P1. E12 retains real browser timing,
deployed credentials, real-host capacity, and human usability evidence.

## Implementation checkpoint

The implemented boundary consists of one server comparison module, the existing
host-authorized Game route family, one same-tab lifecycle controller, and one
advanced host panel. It adds no new durable server state, authority, background
poller, query surface, or gameplay/audio dependency.

The local counterexample pass added and closed two schedules before independent
review:

- a browser request that never reached or returned from Game could otherwise
  hold the sole panel action indefinitely; every attempt now has a fixed
  five-second browser deadline in addition to the two-second server comparison
  deadline, while mutation identities remain retained for exact retry; and
- a structurally valid but noncanonical success or error could otherwise put an
  arbitrary reason or mismatched finite code into browser state; result,
  confidence, missing-reason, count, interval, trace-lifecycle, and HTTP
  code/status relations are now operation-bounded before publication.

Local verification at this checkpoint:

- focused route, selector, browser-controller, attachment, and composed suites:
  `29/29`;
- the composed schedule launches real Access, State, and collector HTTP
  services, passes through the production Game mediation/route handler, and
  proves all five fixed classifications plus missing evidence, ended-trace
  reads, purge concealment, and collector-loss isolation;
- production Next build and the complete Web suite: `334/334`;
- ESLint: zero errors and one pre-existing E5 unused-parameter warning;
- syntax checks and `git diff --check`: pass.

The first independent review found no P0 and identified four grouped P1
boundaries plus bounded P2 precision. The remediation keeps the original
representation and closes the counterexamples directly:

- equal listener-anchor partitions now use only the documented lexical tie;
  duplicate uploaded identities fail before selection;
- browser timeout and close ownership cover fetch headers and the complete
  bounded body, explicitly refuse redirects, and remain finite even when an
  injected fetch ignores abort;
- malformed retained control state blocks mutation for that controller
  lifetime instead of being confused with absence;
- start requires an active result, stop requires the exact requested ended
  trace, and comparison count/evidence and trace-lifecycle relations are
  rebound before publication; and
- each refresh clears only its own abort controller, so an old completion
  cannot detach or publish through a newer closed read.

The remediation also canonicalizes response status, content type, and finite
error prose, and adds exact listener `7/8/9`, cohort-horizon
`before/equality/after`, report/page, wrong-result, stalled-body, and ABA
schedules. The affected local finding count is now `P0=0`, `P1=0`, `P2=0`.
E11 is not yet closed: the affected independent perspectives must re-review
the remediation. E12 continues to own real-browser timing, deployed credential
and process topology, supported device capacity, human usability,
installation, restart, and cleanup evidence.
