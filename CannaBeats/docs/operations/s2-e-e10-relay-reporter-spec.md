# S2-E E10 relay diagnostics

Status: `E10.1 design complete; implementation authorized`.

This packet applies the repository scale filter: one relay process, one active
publisher, at most eight listeners, and one low-priority reporter task. It does
not add a metrics daemon, reporter process, event journal, log parser, or
general observability framework.

## Increment sequence

1. **E10.1 relay-generation observation:** add and pin one exact in-process
   `btaudio-relay-diagnostics/v1` snapshot owner. It observes scalar relay and
   fan-out state but performs no Game or collector calls.
2. **E10.2 isolated reporter:** consume only E10.1 snapshots, bind each
   reportable generation once through E8, and upload one bounded aggregate.

E10.1 closes before E10.2 attaches networking. This split keeps fan-out
instrumentation independently comparable with the pre-instrumentation relay.

## E10.1 governing invariant

> Every relay diagnostic snapshot is an exact, generation-scoped projection of
> ingress and fan-out effects already committed by the relay, while observation
> can neither change nor wait on publisher ingest, listener delivery, fencing,
> or cleanup.

## Boundary and representation

The snapshot owner is a plain Python object in the pinned `btaudio` relay
process. The eventual reporter calls this versioned object boundary directly;
there is no second local socket because producer and consumer share one event
loop. The interface is still exact and machine-consumed: the reporter may not
read `/healthz`, `Client.describe()`, stdout, or journal text.

One successful `RelaySource.claim()` creates a random lowercase UUIDv4
`relayGenerationId` before accepting body PCM. That identity never changes or
rebinds. Source disconnect finalizes it. The next successful claim creates a
new identity even when format and peer happen to match. A refused source never
creates a generation.

The owner retains only:

- one active generation; and
- one prior generation in `ending` or immutable `finalized` state awaiting
  listener quiescence/E10.2 consumption.

Every successful claim still receives a fresh identity. If an active generation
ends while the prior-generation slot is still occupied, its final snapshot is omitted,
the process-scoped `coverageLossCount` increments once, and the next generation
starts normally. Neither retained generation is overwritten or relabeled.
E10.2 observes that scalar and may record only a finite local coverage-loss
notice; it retries only already-owned evidence and never creates a generation
queue. Any omitted generation record is detached from the report interface and
retained only by its still-closing generation-bound clients; the Hub's global
eight-listener limit bounds those records, and the last close releases them.

## Exact snapshot

`active_snapshot()` and `finalized_snapshot()` each return either
`{status:"absent",coverageLossCount:SAFE_INTEGER}` or exactly:

```json
{
  "status":"active|finalized",
  "coverageLossCount":"safe integer >=0",
  "snapshot":{
    "interface":"btaudio-relay-diagnostics/v1",
    "schemaVersion":1,
    "relayProcessId":"lowercase UUIDv4, constant for process lifetime",
    "relayGenerationId":"lowercase UUIDv4",
    "sampleRate":"integer 8000..384000",
    "channels":"1|2",
    "encoding":"s16le",
    "ingressFrames":"safe integer >=0",
    "ingressBytes":"safe integer >=0",
    "ingressGapCount":"safe integer >=0",
    "rejectedIngressCount":"safe integer >=0",
    "droppedIngressCount":"safe integer >=0",
    "acceptedListenerCount":"safe integer >=0",
    "closedListenerCount":"safe integer >=0",
    "deliveredBytes":"safe integer >=0",
    "backpressureClosureCount":"safe integer >=0",
    "generationFenceDisconnectCount":"safe integer >=0",
    "activeListenerCount":"safe integer 0..8"
  }
}
```

Each method returns only its named state; internal `ending` is not reportable.
`coverageLossCount` is process-cumulative interface metadata and never enters
an E1 report. `finalized` also has exactly `terminalReason`, one of
`publisher_closed|generation_replaced|authority_lost|process_restart|unknown`.
The version-1 relay does not close slow listeners on queue overflow, so
`backpressureClosureCount` is truthfully zero; existing drop-oldest behavior is
not renamed as a closure. Listener delivery diagnostics still observe the
resulting client-side interruption. If a later relay policy closes a slow
listener, this counter increments only after that terminal removal commits.

Exact relations:

- `ingressBytes = ingressFrames * channels * 2` with checked arithmetic;
- `relayProcessId` is constant across every generation in one process and a
  process restart creates a new value;
- `closedListenerCount <= acceptedListenerCount`;
- `activeListenerCount = acceptedListenerCount - closedListenerCount` while
  active, and is zero when finalized;
- `backpressureClosureCount <= closedListenerCount`;
- `generationFenceDisconnectCount <= closedListenerCount`; and
- all counters are monotonic within one generation and never reset in place.

## Counter provenance

- `ingressFrames/Bytes` advance only for complete s16le frames accepted by
  `RelaySource.feed` and handed to the Hub callback. Network fragmentation is
  reconciled with a bounded carry of at most `channels*2-1` bytes; a terminal
  partial frame increments `droppedIngressCount` once and is not counted as
  ingress.
- `ingressGapCount` increments when accepted feed callbacks in one generation
  are separated by strictly more than twice the later callback's nominal audio
  duration. Equality is not a gap; lifecycle boundaries are not gaps.
- `rejectedIngressCount` increments on the active generation for each
  authenticated, exact-format publisher attempt refused because its slot is
  occupied. Authentication and malformed-header failures occur before a
  generation is known and are deliberately not attributed.
- `droppedIngressCount` counts one malformed accepted chunk stream or one
  terminal partial-frame carry, at most once per generation.
- `acceptedListenerCount` increments only after stream response headers are
  sent and the listener is inserted into `Hub.clients` with its immutable
  generation ID.
- `closedListenerCount` increments exactly once on that client's retained
  generation when it is removed, regardless of EOF, transport failure,
  cancellation, or fence. It never consults whichever generation is current.
- `deliveredBytes` advances on that retained generation only after
  `writer.drain()` succeeds for PCM body bytes. WAV headers and HTTP/chunk
  framing are excluded.
- `generationFenceDisconnectCount` increments for each active listener whose
  queue receives the terminal sentinel due to publisher-generation fencing.

Counters are updated by scalar event-loop operations at the existing commit
points. The capture/feed callback, listener write loop, and fence path never
serialize JSON, call Game, wait for diagnostics, or acquire a diagnostic lock.
Snapshot construction copies fixed scalars only.

## Lifecycle and cleanup

Generation creation occurs after format validation and successful slot claim,
before the first feed. Publisher release moves it to internal `ending` before
the slot can be claimed again. In the fenced production relay,
`disconnect_clients` atomically signals each generation-bound client and
commits the fence count. The old generation becomes immutable `finalized` only
after every in-flight drain and client cleanup has committed its delivered and
closed counters. A new publisher may start while that bounded quiescence is in
progress; its bytes and clients carry the new identity. A listener admitted
with no active generation is structurally impossible because the stream route
already rejects when the source is not running.

`take_finalized(expectedGenerationId)` returns the immutable finalized snapshot
only on exact ID match and then frees that one slot. Wrong/stale IDs have no
effect. E10.1 tests use this consumption seam; E10.2 may consume only after it
has obtained a finite report outcome or deliberately recorded a local coverage
loss. Process shutdown finalizes the active generation as `process_restart`
for in-process observation, but process exit may discard it; restart creates a
new identity and never reconstructs old counters.

Current peer/IP/path-bearing relay operational output remains outside this
interface and must be removed or reduced before E10.2 closure, because the
parent privacy disclosure covers normal relay output as well as reports.

## E10.1 closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: one successful source claim creates one random generation before feed; refused/malformed attempts create none. |
| Update | `runtime`: named Hub/Server commit points perform scalar monotonic increments; exact snapshot validation owns cross-field relations. |
| Delete | `runtime`: exact-ID `take_finalized` removes only the one immutable finalized snapshot; audio lifecycle cleanup is unchanged. |
| Omit | `runtime`: exact constructor emits every required field or finite `unavailable`; partial frames become one explicit drop and excess finalized evidence increments `coverageLossCount`. |
| Duplicate | `structural`: one active and one finalized object; generation UUID is assigned once and cannot be copied into a new claim. |
| Reorder | `runtime`: creation precedes feed/admission; each client retains its generation; delivery increments after drain; close/fence increments precede finalization. |
| Replay | `structural`: snapshot is read-only and repeated reads return the same scalar state until a named relay effect occurs. |
| Conflict | `runtime`: finalized consumption requires the exact generation ID; wrong reuse is effect-free. |
| Concurrency | `structural`: relay mutations and snapshot/consume run on the single asyncio event loop; capture handoff schedules existing callbacks only. |
| Expiry | `not_applicable`: generations end by publisher lifecycle, not wall-clock expiry. |
| Restart | `structural`: no durable E10.1 state; restart creates a new generation ID and cannot reuse prior counters. |
| Dependency failure | `not_applicable`: E10.1 has no network, credential, Game, State, or collector dependency. |
| Corruption | `runtime`: exact snapshot construction rejects non-finite, out-of-range, impossible, or unknown state without partial output. |
| Capacity | `runtime`: one active plus one finalized generation, at most eight listener records already owned by Hub, and fixed scalar fields. |

## E10.1 matrix-derived verification

Focused tests must cover:

- successful/refused/malformed claim identity creation;
- same-format reconnect still creating a new generation;
- ingress frame fragmentation, exact-frame equality, terminal partial carry,
  gap before/equality/after, and malformed stream drop;
- listener admission, successful delivered bytes, disconnect/cancellation, full
  queue behavior, and generation fence counts;
- snapshot exact shape, monotonicity, cross-field relations, repeated read,
  wrong-ID consume, and active/finalized capacity;
- publisher handoff and process-restart identity; and
- deterministic PCM/listener behavior parity with instrumentation disabled and
  enabled, plus output scans showing no new peer, token, URL, path, or native
  error in the snapshot boundary.

The local counterexample question is: what smallest claim/feed/listener/fence
interleaving preserves every currently checked total but attributes a byte,
listener, closure, or generation to the wrong publisher? Any valid answer is
added to this matrix before E10.1 audit.

## E10.2 boundary preview

E10.2 will add one low-priority coroutine to the same relay process. For one
observable generation it will:

1. bind with a deterministic request ID derived from the generation;
2. retain that exact bind across response loss;
3. synchronize with original local exchange timing;
4. emit exact E1 `relay_window` and finite relay transitions at a nine-second
   target; and
5. retain at most one outcome-unknown report and one transition.

Binding replay is evaluated before current authority. A fresh generation never
reuses an old bind identity, and delayed finalized reports use only their
immutable retained binding. Credential reads occur per new HTTP transaction.
Malformed/hung Game or collector behavior can lose diagnostics but cannot
change ingress, fencing, fan-out, listener delivery, readiness, or service
exit. Exact route outcomes, reporter capacity, restart, and privacy are closed
in the E10.2 matrix after E10.1 is pinned; they are not E10.1 evidence.
