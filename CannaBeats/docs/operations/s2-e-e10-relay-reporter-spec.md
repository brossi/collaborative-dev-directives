# S2-E E10 relay diagnostics

Status: `E10.0/E10.1 independently closed; E10.2 implemented and locally verified, independent review pending`.

This packet applies the repository scale filter: one relay process, one active
publisher, at most eight listeners, and one low-priority reporter task. It does
not add a metrics daemon, reporter process, event journal, log parser, or
general observability framework.

## E10.0 complete-frame relay prerequisite

The legacy relay forwarded arbitrary HTTP chunk fragments, including a terminal
partial s16le frame. Verified E1 requires both ingress and total fan-out bytes
to be frame-divisible, so that behavior cannot produce an exact relay report.
The authorized E10 remediation therefore includes one contained, non-diagnostic
prerequisite:

> `RelaySource` forwards only complete s16le frames, with at most one
> `channels*2-1` byte carry, and discards a terminal partial identically whether
> diagnostics are disabled, enabled, or have failed.

This is an intentional relay correctness change, not credited as observational
parity with the pre-E10 relay. It occurs before the E10.1 observation boundary;
E10.1 parity compares diagnostics-disabled and diagnostics-enabled execution of
this same structural framing behavior.

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `not_applicable`: framing creates no durable or authority identity. |
| Update | `structural`: once the Hub callback is armed, one `RelaySource` carry selects only complete frames before every callback. |
| Delete | `runtime`: release/stop clears only the bounded terminal partial; complete PCM is already forwarded. |
| Omit | `runtime`: input received before the Hub callback is armed is dropped by the existing lifecycle rule; after arming, only a terminal incomplete frame is deliberately omitted. |
| Duplicate | `structural`: each armed input byte is either in the sole carry, one forwarded payload, or the terminal omission; unarmed input never enters the carry. |
| Reorder | `structural`: carry bytes precede the next network fragment in the emitted payload. |
| Replay | `not_applicable`: the live PCM callback has no retry identity. |
| Conflict | `not_applicable`: exact format validation occurs before the source claim. |
| Concurrency | `structural`: the one accepted publisher feeds the one carry on the relay event loop. |
| Expiry | `not_applicable`: carry ends with the publisher lifecycle. |
| Restart | `structural`: process loss discards the in-memory partial and creates no retained state. |
| Dependency failure | `not_applicable`: framing calls no external dependency. |
| Corruption | `runtime`: declared s16le format fixes frame size; malformed chunk framing terminates the accepted stream. |
| Capacity | `structural`: carry length is always `0..channels*2-1`. |

## Increment sequence

1. **E10.1 relay-generation observation:** add and pin one exact in-process
   `btaudio-relay-diagnostics/v1` snapshot owner. It observes scalar relay and
   fan-out state but performs no Game or collector calls.
2. **E10.2 isolated reporter:** consume only E10.1 snapshots, bind each
   reportable generation once through E8, and upload one bounded aggregate.

E10.1 closes before E10.2 attaches networking. This split keeps fan-out
instrumentation independently comparable with the E10.0 structural baseline.

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
generation-bound clients is closing. The last close releases it; pending Hub
callbacks for an omitted generation commit audio but deliberately add no
diagnostic evidence. This is not a reportable or unbounded generation history.

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
  active, is at most eight, and is zero when finalized;
- `backpressureClosureCount <= closedListenerCount`;
- `generationFenceDisconnectCount <= closedListenerCount`; and
- all counters are monotonic within one generation and never reset in place.

## Counter provenance

- E10.0 `RelaySource` framing is identical whether diagnostics are disabled,
  enabled, or have failed. It may join network fragments, but diagnostics do
  not further change callback segmentation, listener queue pressure, delivered
  PCM, or terminal-partial handling. Complete frames enter
  `ingressFrames/Bytes`; the structural terminal carry increments
  `droppedIngressCount` once when diagnostics remain available and is excluded.
- `ingressFrames/Bytes` reserve the captured generation and feed timestamp,
  but advance only in `Hub._broadcast` after the Hub commits the same callback
  payload to `total_bytes`. The reportable prior remains unavailable until its
  pending commits complete; a coverage-lost generation's delayed callback is
  intentionally unobserved. Snapshots never expose bytes early.
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
| Dependency failure | `structural`: E10.1 has no external dependency; an internal diagnostic failure disables observation but the RelaySource generation tag, E10.0 framing, and Hub fan-out filter remain active. |
| Corruption | `runtime`: exact snapshot construction rejects non-finite, out-of-range, impossible, or unknown state without partial output. |
| Capacity | `runtime`: `Server.stream` admits at most eight live plus in-flight listener slots; the snapshot owner independently rejects a ninth active listener. Accepted/closed counts remain cumulative safe integers. One active plus one prior generation are reportable, and every detached record requires one of those fixed live clients. |

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

## E10.2 isolated relay reporter

### Governing invariant

> One low-priority reporter may bind, synchronize, and upload exact evidence
> for one relay generation, but reporter state, credentials, Game behavior,
> collector behavior, and reporter failure can neither change nor delay relay
> ingest, fan-out, fencing, readiness, cleanup, or process exit.

The reporter is an optional coroutine in the relay process. It reads only the
exact E10.1 object boundary and calls only the two E8.3c relay routes. It never
reads `/healthz`, client objects, peer addresses, stdout, or journal text. No
reporter process, local socket, journal, database, or generalized queue is
introduced.

### Configuration and HTTP boundary

The reporter is enabled only when all of these are true:

- relay mode and `--disconnect-listeners-on-source-disconnect` are active;
- one HTTPS Game base URL is supplied; and
- one absolute relay credential file is supplied.

An incomplete, malformed, unreadable, or insecure reporter configuration
disables reporting with one finite `diagnostics_configuration_invalid` notice.
The credential must be a root- or process-owned regular file with no
other-user access and no group write/execute access; owner-only and
group-read-only modes are allowed. Invalid configuration never blocks server
creation. The credential is reread for every newly
started HTTP transaction and is never retained in snapshots or output. The
reporter derives the fixed paths `/api/diagnostics/relay-generation` and
`/api/diagnostics/relay-report`; redirects are rejected. Requests and responses
are UTF-8 JSON, at most 8,192 bytes, under a two-second deadline. JSON objects
reject duplicate member names recursively. Success and error responses have
exact finite shapes, and every error code is bound to its canonical HTTP status
and fixed public message. Native, caller-authored, URL, token, path, peer, and
lower-layer text is reduced to a finite reporter code.

The synchronous standard-library HTTP operation runs in one daemon transaction
thread. Only one transaction may be active. Cancellation fences its result
immediately; the two-second network deadline bounds the detached operation, and
the daemon cannot become a server-exit condition.

### Correlation and report lifecycle

The reporter owns one observable generation at a time. A deterministic
lowercase UUIDv5 bind request ID is derived from the fixed label and exact
`relayGenerationId`; no other generation can reuse it. The same canonical bind
command remains pending across timeout or response loss. A canonical
`request_conflict` is terminal for that generation because the deterministic
identity cannot be advanced safely. `stale_correlation`,
`relay_generation_unbound`, and `trace_inactive` abandon only that generation's
diagnostic coverage.

Synchronization uses a fresh UUIDv4 request ID. Its retained transaction owns
the original local send time and the helper-completion local receive time;
retry harvests that same exchange rather than relabeling it with retry time.
The exact response must bind the requested generation, derived sample ID,
trace timebase, server interval, and local round trip. Both intervals are
ordered, the server interval is at most the local round trip, and the local
round trip is at most 2,000 ms. An unknown synchronization outcome retries the
same request. A terminal correlation result abandons that generation.

After synchronization, the reporter targets a window close at nine seconds.
It publishes only when elapsed time is positive and at most 10,000 ms. A later
tick records one finite local `coverage_gap` and starts a fresh synchronization;
it never fabricates or splits counters. The exact E1 `relay_window` copies the
ten cumulative E10.1 counters and the fixed format directly from the closing
snapshot. `monotonicStartMs` is the acknowledged local receive time and
`durationMs` is the measured elapsed browser-independent monotonic interval.

The generation produces at most these transition reports:

- `generation_started/observed` after its first successful synchronization;
- `generation_fenced` only when the finalized fence counter increased, using
  `generation_replaced/observed` only for that exact terminal reason and
  `unknown/unknown` otherwise; and
- `generation_stopped` from the immutable E10.1 terminal reason, with
  `unknown/unknown` for the unknown reason and `observed` otherwise.

Sequences are strictly increasing safe integers derived from process-monotonic
microseconds with room for the bounded window/transition pair. The reporter
keeps at most one outcome-unknown window and one outcome-unknown transition.
It always sends the lower sequence first. Exact retry retains the same
measurement core and sample observation. `accepted`, `replayed`,
`report_conflict`, `report_invalid`, and `quota_exhausted` retire that one item;
the latter three lose evidence but create no second effect. Correlation-loss
results abandon the generation. Retryable dependency results retain evidence
with exponential backoff capped at 30 seconds.

When a generation finalizes, its immutable binding, issuance observation, and
pending reports remain attached to that generation. The reporter calls
`take_finalized(expectedGenerationId)` only after every owned item reaches a
finite terminal outcome or the generation is deliberately abandoned. A new
active generation may continue serving PCM while this happens. If it cannot be
adopted because the one reporter slot is occupied, its evidence may be omitted;
E10.1's bounded `coverageLossCount` is observed once and logged as the finite
`coverage_gap` code. There is no generation backlog.

Process restart reconstructs no reporter state. It creates a new E10.1 process
and generation identity; retained E8 bind/report identities still prevent a
different generation from taking ownership of prior evidence. Losing an
in-memory outcome-unknown report at process loss is an honest diagnostic gap,
not a replay or authority transfer.

### Operational-output privacy

Before E10.2 closes, relay-mode normal output is reduced to fixed event codes
and bounded scalar counts. Startup never prints listen or ingest bearer values.
Source/listener connect, disconnect, framing, and reporter messages never print
peer/IP, request path, URL, token, filesystem path, native exception, or
caller-authored text. Authenticated operator endpoints remain unchanged and are
not reporter input.

### E10.2 closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: one exact active E10.1 generation may create one correlation; bind and synchronization identities are generated once and retained with their canonical command. |
| Update | `runtime`: one reporter state machine changes only its own scalar/canonical evidence after exact owner snapshots and exact HTTP results. |
| Delete | `runtime`: exact-generation finalized consumption occurs only after all owned evidence is terminal or deliberately abandoned; wrong-generation consumption is effect-free. |
| Omit | `runtime`: an occupied reporter slot, a >10-second interval, unavailable correlation, or E10.1 coverage loss emits only a finite local gap and never invents a report. |
| Duplicate | `structural`: one correlation slot, one pending window, and one pending transition; deterministic bind identity and retained canonical report bytes prevent duplicate effects. |
| Reorder | `runtime`: bind precedes synchronize; synchronization precedes reports; pending reports send by sequence; finalized consumption follows terminal outcomes. |
| Replay | `runtime`: response loss retains the exact bind/sync/report command and original timing; E8 returns the original result before current authority. |
| Conflict | `runtime`: request ID, generation, response fields, core, and observation are rebound exactly; finite conflict retires or abandons only the affected evidence as specified above. |
| Concurrency | `structural`: one event-loop reporter task and one HTTP transaction; relay work never awaits it, and the fixed pending slots admit no concurrent mutation. |
| Expiry | `runtime`: the reporter exercises valid synchronization at before/equality/after 2,000 ms and windows at before/equality/after 10,000 ms; E8 owns trace/issuance expiry. |
| Restart | `structural`: reporter state is intentionally volatile; UUID generation identity and retained E8 replay/conflict rules prevent cross-restart rebinding. |
| Dependency failure | `runtime`: timeout, malformed/oversized output, response loss, credential failure, and unexpected reporter exceptions become finite codes/backoff and never alter the relay task set or exit result. |
| Corruption | `runtime`: one shared strict JSON/response validator rejects duplicate keys, extra/missing fields, unsafe numbers, wrong UUIDs, wrong status/code relations, and cross-generation substitution before state change. |
| Capacity | `structural`: one generation correlation, one pending window, one pending transition, one transaction, 8 KiB bodies, two-second deadline, and 30-second maximum backoff. |

### E10.2 matrix-derived verification

Focused tests cover bind success/exact response loss/conflict; synchronization
original timing and 1,999/2,000/2,001 ms; window 9,999/10,000/10,001 ms;
accepted/replayed/terminal/retryable report outcomes; generation substitution;
active-to-final handoff; final consumption ordering; occupied-slot coverage
loss; reporter cancellation; malformed, duplicate-key, oversized, redirect,
credential, and timeout responses; one-window/one-transition capacity; and
fixed operational-output scans. One integration schedule holds Game indefinitely
while publisher ingest and listener fan-out continue and relay shutdown returns
normally.

The local counterexample question is: what smallest preserved generation,
request, sample, sequence, or pending-state substitution could cause evidence
to be uploaded under another relay generation or cause relay work to wait? Any
valid answer is added to this matrix before requesting independent review.

## E10.1 implementation checkpoint

Status: `locally verified; independent review complete`.
E10.2 is not authorized by this checkpoint.

The remediated pinned sibling target is
`cb4815bda0bd34fa0a423dbdf9ca5976add8c994` (tree
`cf19f94326d9a33549880cff2346675456652ff6`). It adds the E10.0
complete-frame relay baseline and the exact
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
- a ninth concurrent listener entering through an in-flight admission race;
- nine sequential listeners invalidating cumulative accepted/closed counters;
- delayed old-generation PCM reaching a newly admitted generation; and
- pending callbacks growing the detached-generation map without live clients;
- and a pre-arm partial byte surviving to contaminate PCM after the Hub callback
  becomes active.

Enforcement lives in `src/btaudio/relay_diagnostics.py`; `RelaySource` owns
claim/feed/release identity and the E10.0 structural complete-frame carry,
identically across diagnostic modes. `Hub` commits bytes before ingress
observation and filters a scheduled publisher payload to clients of that same
generation even after diagnostics fail. `Server.stream` owns the eight-slot
reservation and post-header generation check. The immutable client generation
and captured frame size own delivery/fence/close updates. The current and prior
generations are the only reportable objects; bounded detached records disappear
on their final client cleanup.

Local verification:

- focused E10.0/E10.1 relay diagnostics: `26/26` pass;
- full pinned sibling suite: `285/285` pass;
- affected Ruff: pass;
- compileall and sibling/CannaBeats diff checks: pass; and
- the exact CannaBeats pin assertion: pass as part of managed-source discovery.

Independent review of the final implementation target found `P0=0`, `P1=0`,
`P2=0` after the matrix wording correction. E10.2 still owns Game credentials,
binding, synchronization, uploads, retry/backoff, normal-output privacy cleanup,
and collector failure isolation.

## E10.2 implementation checkpoint

Status: `implemented and locally verified; independent review pending`.

The pinned sibling implementation is
`ffc889b6fd719da5f0c7f0179787ffc09b0e18bf` (tree
`9af390154dba95c042297c826e87e4c75f41f4ae`). It adds the strict
`RelayGameClient`, the one-slot `RelayReporter`, optional relay CLI attachment,
and fixed relay-mode operational output. `RelaySource`, `Hub`, and listener
tasks do not call or await the reporter.

Enforcement is split at three small boundaries:

- `src/btaudio/relay_reporter.py` owns exact 8 KiB HTTP parsing, canonical
  status/code relations, per-transaction credential reads, bind/synchronization
  replay identity, original timing, bounded reporter state, sequence order,
  retry/backoff, and exact E1 construction;
- `src/btaudio/server.py` owns optional configuration, daemon-task lifecycle,
  and fixed relay-mode output; and
- E10.1 remains the sole owner of generation identity, counters, finalized
  snapshots, and exact-ID consumption.

The local counterexample pass added and closed:

- a finalizing generation being mistaken for missing while listener cleanup
  still made its finalized snapshot unavailable;
- a terminally rejected active generation being immediately re-adopted;
- a pre-existing finalized generation occupying the sole evidence slot;
- a valid but request-unrelated synchronization sample being substituted;
- a timeout retry relabeling the original synchronization exchange with retry
  timestamps;
- a cancelled default-executor request delaying process shutdown;
- a publisher-close fence being mislabeled as `generation_replaced`; and
- a malformed dependency error or redirect impersonating a finite terminal
  result.

Local verification at this checkpoint:

- pinned sibling full suite: `301/301` pass;
- focused reporter tests: `18/18` pass;
- focused E10.0/E10.1 plus server/ingest regression: `101/101` pass;
- affected Ruff and Python compileall: pass;
- CannaBeats E1/E8 producer boundary: `28/28` pass;
- managed-source pin/lifecycle discovery: `58/58` pass;
- Access/State scheduler and exact runtime pin: `8/8` pass;
- an actual reporter-produced relay window/transition pair validates through
  E1 series validation; and
- both repository diff checks: pass.

The matrix intentionally does not claim installed relay-host credentials,
systemd wiring, real network timing, or measured reporter overhead. E12 owns
those fresh-host and real-host proofs. E10.2 closure requires an independent
review of this exact pinned target with no open P0/P1.
