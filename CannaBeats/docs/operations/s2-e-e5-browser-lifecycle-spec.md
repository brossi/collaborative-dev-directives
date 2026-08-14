# S2-E E5 browser attempt and window lifecycle specification packet

## Identity and status

- Checkpoint: E5 — browser attempt, measurement window, and cleanup lifecycle
- Scope revision: `E5-spec-v1`
- Status: `implementation-in-progress`
- Risk class: `B — boundary-bearing` because this code owns browser resources,
  fetch-attempt ordering, and the acknowledged E4 epoch boundary
- Required verified checkpoints: E1 at `736a401`; E4 at `bf4d760`
- Excluded: React/UI/copy (E6), alignment and upload (E2/E7/E8), producer
  diagnostics (E9/E10), diagnosis display (E11), and device measurements (E12)
- Review date: primary design and independent E4/attempt, lifecycle/resource,
  and E1 measurement design closure 2026-08-14; no open design P0/P1

## Scale and boundary

One page owns at most one shared-audio listener. It has one AudioContext, one
AudioWorkletNode, one stream reader, one active fetch, one ten-second timer, one
visibility listener, and optionally one Long Task observer. The local ring holds
at most 90 ten-second windows (15 minutes) and 64 transitions. There is no
generic event bus, retry framework, background worker, or upload queue.

E5 is split into two small pieces:

1. a framework-free `E5ListenerLifecycle` that accepts typed observations and
   produces bounded local window/transition records; and
2. an `E5WorkletPort` that owns E4 request IDs/epochs, permits one outstanding
   command, and resolves only an exact E4 reply.

The browser session adapter composes those pieces with injected browser
dependencies in the harness. Production React attachment remains off until E5
closure; the existing listener continues using the retained baseline.

## Lifecycle vocabulary

An instance begins on explicit shared-audio start and ends on explicit stop,
page teardown, run replacement, or fatal initialization failure. It rotates on
the next start, acknowledged diagnostic reset, or accepted source-format
change; an ordinary same-format stream reconnect does not rotate it.

Each fetch is one attempt with a zero-based `connectionAttemptSequence`.
Attempts are strictly sequential. Outcomes are:

- `no_response`: fetch rejected before headers;
- `rejected`: finite non-503 HTTP rejection;
- `unsupported_format`: headers do not describe bounded s16le mono/stereo PCM;
- `stream_error`: body read failed after headers;
- `stream_ended`: body reached EOF;
- `aborted`: E5 deliberately aborted it; or
- `open`: the attempt is still active.

HTTP 503 ends an attempt as `rejected` with finite reason `source_waiting`, then
permits a bounded retry. A reconnect is counted only when a later attempt begins
after an earlier attempt delivered at least one complete PCM frame. Ending an
attempt alone never increments reconnect count.

Attempt milestones are emitted at most once and use E1's exact names and order:
`request_started`, `response_headers`, `first_pcm_bytes`, `buffer_primed`,
`first_rendered_quantum`. Re-prime after underrun is not another
`buffer_primed` or `first_rendered_quantum` milestone. E4 `underrun` produces
the E1 `underrun` transition. E4 buffering/playing state and visibility edges
are local UI/lifecycle observations only; they are not invented E1 transition
types.

## Ten-second windows

The timer posts E4 `snapshot-and-rotate` even when one stream read is pending.
JavaScript callback order determines the boundary: a read callback processed
before dispatch posts old-epoch PCM first; a read callback processed after
dispatch stages that single chunk and its partial-frame carry. E5 requests no
next chunk while the command is outstanding. After the exact reply it posts the
staged complete frames under the returned epoch, then resumes reads. Staging is
bounded to one 1 MiB chunk plus three carry bytes; exceeding it fails the
attempt and destroys the uncertain worklet rather than dropping PCM silently.
MessagePort FIFO therefore places every accepted frame on exactly one side of
the rotation.

The E4 effect occurs at an unknown instant between main-thread command dispatch
and matching reply. E5 uses the interval midpoint as the local E1 boundary and
retains half the measured round trip as local-only `boundaryUncertaintyMs`.
Browser observations with timestamps wholly before dispatch go to the old
accumulator; those wholly after reply go to the new accumulator. An observation
inside the ambiguity interval makes the affected epoch a local coverage gap.
The E4 snapshot itself remains exact for counter membership. The E1 report and
its uncertainty sidecar may be copied locally, but E2/E3 upload is forbidden
until E8 either expands alignment by that uncertainty or rejects the report.
E12 measures the real distribution; it does not repair missing evidence.

A foreground timer targets 9,000 ms, leaving one second of ordinary scheduling
headroom, and every E1 listener window is in `(0,10000]`. If timer throttling
makes an epoch exceed 10,000 ms, E5 rotates E4
to restore a bounded next epoch but emits no E1 window for the overlong epoch.
It records one bounded local `coverage_gap` with elapsed duration and reason
`timer_delayed`. It never splits aggregate counters, fabricates zeroes, or calls
the gap complete evidence. The 90-record ring may retain this explicitly
non-report local status; E3 never consumes it.

Chunk delivery metrics are E5-window local. Cross-window chunk gaps are not
counted. E5 carries at most `channels*2-1` bytes (three bytes maximum) between
arbitrary stream chunks. `chunkCount` includes only deliveries containing at
least one complete frame; `receivedBytes` counts only complete-frame bytes. A
terminal nonempty carry makes the attempt `stream_error` rather than silently
dropping a partial frame. E5 accumulates received bytes/frames, chunk gaps,
reconnects, visibility
edges, context suspension edges, and optional Long Task observations. E4 owns
buffer, underrun, re-prime, overflow, reset, and signal counters.

At rotation E5 calls `PerformanceObserver.takeRecords()` before recording the
dispatch boundary and keeps the old report provisional until acknowledgement.
In the matching reply callback it drains `takeRecords()` again before
finalization. Because the main thread cannot process that reply while a Long
Task is still running, the second drain observes any task that delayed or
overlapped reply processing. Entries are assigned using their full
`[startTime,startTime+duration]` interval; overlap with the dispatch/reply
ambiguity makes the epoch a gap. Only after this second drain may E5 validate
and insert the immutable E1 report. Later callbacks cannot mutate or retract an
inserted report. The observer is then re-armed for the next accumulator.
Unsupported Long Task
or latency APIs are represented as `unsupported`; an API
that exists but fails during the instance is `unknown`. Neither is represented
by observed zero.

## E4 command and acknowledgement rules

`E5WorkletPort` begins with request ID 1 and epoch 1. Configure must be
acknowledged before PCM is forwarded. Exactly one configure/control request may
be outstanding. Timeout, abort, malformed reply, mismatched request ID, epoch,
operation, or E4 rejection fails the operation finitely; the adapter does not
guess whether the effect occurred. Exact retry uses the same immutable command.
If uncertainty cannot be resolved, E5 destroys the node/context rather than
issuing newer work to that worklet.

PCM is posted only when no command is outstanding and is tagged with the last
acknowledged configured epoch. A snapshot reply yields the old epoch's metrics
and advances E5 to the returned epoch. Reset and stop likewise take effect only
on acknowledgement. A reply for a lower, already-completed request is ignored.
A malformed reply or a mismatch that claims the current request makes that
operation uncertain and destroys the adapter. Late replies after destruction
are ignored.

Attempt/E4 edges are finite:

| Prior edge | Required acknowledged E4 edge |
| --- | --- |
| 503/no headers | none; E4 has not been configured for that attempt |
| body EOF/read failure/abort | before retry fetch, `reset-and-rotate`; playback is intentionally cleared and the prior configured format retained |
| first valid headers on an unconfigured worklet | before body PCM, configure the initial epoch |
| valid headers match retained format | before body PCM, no additional E4 edge |
| valid headers differ from retained format | before body PCM, rotate E1 instance, `stop-and-rotate`, then configure at the required next epoch |
| any control result uncertain | destroy node/context; a new instance/worklet is required |

A retry attempt begins only after the prior attempt's required reset edge is
acknowledged. The fetch then discovers and validates the new format; any
format-dependent stop/configure edge completes before its body PCM is read or
forwarded. Its first new-epoch E4 buffering-to-playing progression supplies its own
`buffer_primed` then `first_rendered_quantum` milestones exactly once. E5 does
not reuse a previous attempt's playing state.

## Visibility, context, and transition retention

Visibility changes update the point sample; E1 has no visibility transition
kind and E5 does not duplicate visibility into its local gap FIFO.
Running-to-suspended context edges
increment `suspensionCount` and emit `context_suspended`; the reverse emits
`context_resumed`. Hidden time is not subtracted from window duration.

Canonical E1 window/transition storage is a FIFO of 90 windows and 64
transitions. A separate FIFO of 16 exact local-only records holds coverage gaps.
Cleanup returns its finite result directly rather than duplicating it into that
FIFO. On transition overflow E5 drops the oldest diagnostic transition and
increments one local dropped-transition counter; it never coalesces two events
or claims exact multiplicity. E5 creates and validates every canonical report
before insertion. E6 receives those validated reports but never constructs or
repairs measurement authority.

## Cleanup ownership

One idempotent `stop()` performs, in order: mark generation inactive, abort
fetch, cancel reader, clear retry/window timers, disconnect observers/listeners,
detach the MessagePort handler, disconnect the node, and close AudioContext.
Every initialization failure enters this same path. A callback first compares
the active generation and becomes effect-free after stop. Cleanup errors are
collected into a finite returned category and do not prevent later cleanup
steps. Asynchronous cleanup has a one-second deadline; timeout is reported as
`cleanup_timeout`, after every owned cleanup operation has already been invoked.
A body-read failure aborts its fetch and must finish reader cancellation within
the same deadline before retry; otherwise the session terminates instead of
overlapping transports.

Diagnostic reset is not E5 stop. It requests E4 `snapshot-and-rotate` and, only
after acknowledgement, rotates `instanceId`, resets the instance-wide report
sequence, and clears the local record rings while keeping the same
AudioContext/node/stream and current attempt. It does not clear playback. The
current attempt retains its ordinal and already-emitted milestone flags, so
reset cannot duplicate attempt milestones.

E5, not E6, constructs exact E1 `listener_window` and `listener_transition`
JSON and accepts a record into the ring only after `validateMeasurementJson`
returns its normalized report. Local-only lifecycle/gap records use a separate
tagged shape and are never passed to E1, E2, or E3. E4 snapshots with
`windowStartedInUnderrun=true`, `underrunCount=0`, and zero `underrunFrames` map
to a positive E1 `underrunDurationMs` only if E5 observed elapsed carried
underrun time in the window; otherwise the whole window is a local coverage gap
rather than a fabricated E1 report.

## Exact E4/E5 to E1 window mapping

| E1 field group | Sole input and formula |
| --- | --- |
| interval | midpoint of successive dispatch/reply boundary intervals; positive duration must be <=10,000 ms; sidecar uncertainty is the sum of the two half-RTTs |
| received delivery | E5 complete-frame `receivedFrames`; `receivedBytes = frames*channels*2`; E4 `receivedFrames` must equal it or the epoch is a gap; chunks/gaps exclude the carried partial bytes and cross-window gaps |
| signal | E4 silent/clipped/received counts passed to E1 `classifySignalWindow`; impossible counts make the epoch a gap |
| buffer | each E4 source-frame value becomes `frames/sourceSampleRate*1000`; mean uses `bufferSumFrames/bufferSampleCount`; trend is `(endMs-startMs)/(durationMs/1000)` and must satisfy E1 bounds |
| underrun/re-prime | `underrunDurationMs = underrunFrames/outputSampleRate*1000`; counts and carried flag copy from E4; carried=true with zero duration is a gap because E1 requires positive duration |
| overflow/reset | E4 counts copy exactly; discarded source frames remain frames |
| format/rate | acknowledged E4 snapshot; nominal ratio is `sourceSampleRate/outputSampleRate`; change rotates instance |
| attempt/delivery state | E5 current attempt ordinal, reconnect sum, and finite terminal category |
| browser state | E5 AudioContext/visibility point state, suspension edge count, finite latency unions, and Long Task aggregate after the boundary drain rule |
| client constants | start-time captured finite browser/OS/install/version constants; no full user agent |

## Invariants and evidence

| ID | Invariant | Required deterministic evidence |
| --- | --- | --- |
| E5-ATTEMPT-001 | Attempts are sequential; milestones occur once in legal order; reconnect starts only with a new post-PCM attempt. | normal, 503, EOF, failed-read, abort, re-prime schedules |
| E5-WINDOW-001 | Every E4 counter belongs to exactly one FIFO epoch; every valid E1 window is <=10s; delayed/unlocalizable coverage becomes an explicit non-report gap, never fabricated evidence. | delayed timer and response-loss schedules |
| E5-PORT-001 | One immutable E4 request is outstanding; mismatch/timeout never authorizes newer work on an uncertain worklet. | stale/malformed/lost reply schedules through real E4 wrapper |
| E5-API-001 | Missing/failing browser APIs remain unsupported/unknown, never healthy observed zero. | absent/throwing API schedules |
| E5-RESET-001 | Diagnostic reset uses snapshot rotation, preserves playback/stream/attempt and milestone cardinality, and rotates listener instance only after acknowledgement. | active playback reset schedule |
| E5-CLEANUP-001 | Every exit releases all owned resources and late callbacks are effect-free. | failure at each setup stage, stop during fetch/read/request, teardown twice |
| E5-BOUND-001 | Windows <=90, transitions <=64, timers/observers/readers/nodes/contexts <=1 each. | max+1 and repeated retry/reset schedules |
| E5-E1-001 | E5 owns exact E1 listener construction and validation; E6 is never measurement authority and local-only gap/lifecycle state cannot enter E1/E2/E3. | exact mapping and invalid-projection tests |
| E5-PRIV-001 | E5 records contain only local monotonic timing, finite browser/audio categories, format, counts, and local opaque instance identity; no URL, lobby, principal, token, error text, PCM, or authority label. | recursive field review |

Focused acceptance uses fake monotonic time, timers, fetch streams,
AudioContext, AudioWorkletNode/MessagePort, visibility, Long Task support, abort,
and teardown. It must drive the actual public E4 wrapper/core rather than a
handwritten success-only reply. Production build success alone is not E5
evidence. Real browser scheduling, hardware output, and resource measurement
remain E12; their local state definitions and cleanup behavior are E5-owned.

## Decision

- Scope fit: one small listener and one stream; no platform machinery.
- Approved implementation scope: lifecycle state machine, E4 port adapter,
  deterministic browser harness, and an unattached browser session adapter.
- Production attachment: unauthorized until independent E5 implementation
  closure.
- E6/E7 work: unauthorized by this packet.

Implementation increment 1 adds the unattached E4 port adapter and bounded
attempt/milestone lifecycle with actual E4-core composition tests. Window/E1
projection, observer attribution, fetch/AudioContext resource ownership, and
production attachment remain for later E5 increments; this checkpoint makes no
closure claim. Focused E4+E5 verification passes 20/20; lint, the production
build, and the full web suite pass 204/204.

Implementation increment 2 adds exact E1 transition and listener-window
construction, source-frame/unit conversion, E4/E5 counter reconciliation,
partial-frame carry, explicit unsupported API states, boundary-uncertainty
sidecars, and fail-closed local gaps for delayed, ambiguous, or contradictory
epochs. Fetch/AudioContext resource ownership and production attachment remain
unimplemented. Focused E1+E4+E5 verification passes 42/42; closure is not yet
claimed. Lint, the production build, and the full web suite pass 208/208.

Implementation increment 3 adds the unattached browser resource scope: one
abort controller, stream reader, observer, E4 port, node, and AudioContext; two
named timers and two listeners; generation-style late-callback fencing; and
ordered idempotent cleanup that returns only finite failure categories. Fetch
attempt orchestration still remains unattached and unimplemented. Focused
resource verification passes 5/5; cleanup invokes every independent resource
before awaiting asynchronous cancellation. Lint, the production build, and the
full web suite pass 213/213. Closure is not yet claimed.

Implementation increment 4 adds an unattached, dependency-injected fetch-attempt
orchestrator. It composes the bounded resource scope, E4 request/epoch adapter,
partial-frame chunker, exact E1 lifecycle/projector, 503 retry, format admission,
9-second rotation, Long Task drains, and finite terminal cleanup. Production
React remains unchanged and no upload/persistence path exists. Focused session
verification covers normal streaming, retry, unsupported format, initialization
failure, unsupported APIs, and teardown; closure is not yet claimed.
Focused orchestrator verification passes 10/10, including a fetch that never
settles and a chunk delivered while the snapshot acknowledgement is withheld.
The combined focused lifecycle/resource/session suite passes 26/26; lint, the
production build, and the full web suite pass 223/223.

Implementation increment 5 remediates the first independent closure audit. It
owns late initialization results, bounds failed-read retirement and all
asynchronous cleanup, keeps worklet/browser point state current outside an open
attempt while gating attempt milestones, degrades optional Long Task failures
to `unknown`, rejects oversized stream chunks before combining them, records
transition eviction, and exposes the minimal acknowledged playback-preserving
diagnostic reset. Composed schedules cover the original counterexamples plus
lost snapshot replies, delayed timers, and idempotent teardown. Focused
verification passes 37/37; lint, the production build, and the full web suite
pass 234/234. Independent closure remains pending, so production attachment is
still unauthorized.
