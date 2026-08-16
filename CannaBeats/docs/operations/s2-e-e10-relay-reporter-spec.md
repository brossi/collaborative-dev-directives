# S2-E E10 relay diagnostics

Status: `E10.1 remediation implemented; independent re-review pending`.

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

The report interface retains only:

- one active generation; and
- one prior generation in `ending` or immutable `finalized` state awaiting
  listener quiescence/E10.2 consumption.

Every successful claim still receives a fresh identity. If an active generation
ends while the prior-generation slot is still occupied, its final snapshot is omitted,
the process-scoped `coverageLossCount` increments once, and the next generation
starts normally. Neither retained generation is overwritten or relabeled.
E10.2 observes that scalar and may record only a finite local coverage-loss
notice; it retries only already-owned evidence and never creates a generation
queue. Any omitted generation record is detached from the report interface in
a generation-keyed map. It exists only while at least one of the fixed eight
generation-bound clients is closing or one already-scheduled Hub ingress
commit is pending. The last close/commit releases it; this is not a reportable
or unbounded generation history.

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
    "acceptedListenerCount":"integer 0..8",
    "closedListenerCount":"safe integer >=0",
    "deliveredBytes":"safe integer >=0",
    "backpressureClosureCount":"safe integer >=0",
    "generationFenceDisconnectCount":"safe integer >=0",
    "activeListenerCount":"integer 0..8"
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

- Complete-frame normalization is a structural `RelaySource` behavior whether
  diagnostics are enabled or disabled. Network fragmentation is reconciled
  with a bounded carry of at most `channels*2-1` bytes; a terminal partial is
  never delivered, increments `droppedIngressCount` when observed, and is not
  counted as ingress. Diagnostics therefore cannot change callback chunking,
  listener queue pressure, delivered PCM, or terminal-partial handling.
- `ingressFrames/Bytes` reserve the captured generation and feed timestamp,
  but advance only in `Hub._broadcast` after the Hub commits the same complete
  payload to `total_bytes`. A pending reservation keeps an ending generation
  reachable until that scheduled commit completes; snapshots never expose the
  bytes early.
- `ingressGapCount` increments when accepted feed callbacks in one generation
  are separated by strictly more than twice the later callback's nominal audio
  duration. Equality is not a gap; lifecycle boundaries are not gaps.
- `rejectedIngressCount` increments on the active generation for each
  authenticated, exact-format publisher attempt refused because its slot is
  occupied. Authentication and malformed-header failures occur before a
  generation is known and are deliberately not attributed.
- `droppedIngressCount` counts one malformed accepted chunk stream or one
  terminal partial-frame carry, at most once per generation.
- A listener reserves one of eight slots and captures the exact format and
  generation before sending headers. After the header await, a changed or
  absent generation aborts admission. `acceptedListenerCount` increments only
  after the listener is inserted into `Hub.clients` with that captured ID.
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
| Reorder | `runtime`: creation precedes feed/admission; Hub byte commit precedes ingress observation; each client retains its generation; delivery increments after drain; close/fence increments precede finalization. |
| Replay | `structural`: snapshot is read-only and repeated reads return the same scalar state until a named relay effect occurs. |
| Conflict | `runtime`: finalized consumption requires the exact generation ID; wrong reuse is effect-free. |
| Concurrency | `runtime`: relay mutations and snapshot/consume run on one asyncio event loop; pending-ingress reservations preserve identity across scheduling, and a listener reservation plus post-header generation check makes admission atomic across its only await. |
| Expiry | `not_applicable`: generations end by publisher lifecycle, not wall-clock expiry. |
| Restart | `structural`: no durable E10.1 state; restart creates a new generation ID and cannot reuse prior counters. |
| Dependency failure | `not_applicable`: E10.1 has no network, credential, Game, State, or collector dependency. |
| Corruption | `runtime`: exact snapshot construction rejects non-finite, out-of-range, impossible, or unknown state without partial output. |
| Capacity | `runtime`: `Server.stream` admits at most eight live plus in-flight listener slots; the snapshot owner independently rejects a ninth. One active plus one prior generation are reportable, and the bounded detached map exists only for those fixed clients or already-scheduled ingress commits. |

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

## E10.1 implementation checkpoint

Status: `implemented; local counterexample pass complete; independent review pending`.
E10.2 is not authorized by this checkpoint.

The remediated pinned sibling target is
`7fab3edf7be087855d79660ec8f13584c2ba85ba` (tree
`d8cbc2b4925cbd95201c3deb9f220d8477249ba7`). It adds the exact
`RelayDiagnostics` owner, generation creation at successful claim, bounded
frame carry, generation-bound listener attribution, and scalar hooks at the
existing ingress/drain/fence/cleanup commit points. It performs no network or
credential work.

The local counterexample pass closed these schedules before review:

- an old listener drain completing after a new publisher starts and being
  charged to the current generation;
- generation finalization becoming visible before the last listener drain and
  close counters commit;
- a rapid handoff overwriting an older finalized generation;
- diagnostic failure with a partial-frame carry dropping PCM that the
  pre-instrumentation relay would have delivered; and
- repeated fencing or cleanup incrementing a listener terminal counter twice;
- one-byte fragmentation changing queue pressure when diagnostics are enabled;
- a Hub ingress snapshot becoming visible before the same payload commits;
- publisher handoff or disconnect during the listener header drain rebinding
  or silently omitting that listener; and
- a ninth listener entering through an in-flight admission race.

Enforcement lives in `src/btaudio/relay_diagnostics.py`; `RelaySource` owns
claim/feed/release identity and structural bounded carry; `Hub` commits bytes
before ingress observation; and `Server.stream` owns the eight-slot reservation
and post-header generation check. The immutable client generation continues to
own delivery/fence/close updates. The current and prior generations are the
only reportable objects; bounded detached records disappear on their final
client cleanup or already-scheduled ingress commit.

Local verification:

- focused relay diagnostics: `18/18` pass;
- full pinned sibling suite: `277/277` pass;
- affected Ruff: pass;
- compileall and sibling/CannaBeats diff checks: pass; and
- the exact CannaBeats pin assertion: pass as part of managed-source discovery.

Open local findings are `P0=0`, `P1=0`, `P2=0`; independent E10.1 review is
pending. E10.2 still owns Game credentials, binding, synchronization, uploads,
retry/backoff, normal-output privacy cleanup, and collector failure isolation.
