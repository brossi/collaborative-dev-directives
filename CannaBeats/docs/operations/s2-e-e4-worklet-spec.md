# S2-E E4 worklet core and atomic MessagePort specification packet

## Identity and status

- Checkpoint: E4 — worklet core and atomic cross-thread protocol
- Scope revision: `E4-spec-v1`
- Status: `implementation-candidate`
- Risk class: `B — boundary-bearing` because the real AudioWorklet MessagePort
  owns ordering, acknowledgement, and reset linearization
- Required prior verified checkpoint: E1 at `736a401`
- Explicitly excluded later checkpoints: browser/fetch lifecycle (E5), UI/copy
  (E6), persistence and routes (E7/E8), producers (E9/E10), composed diagnosis
  (E11), and real-device measurement (E12)
- Review date: primary design 2026-08-14; independent protocol, PCM/metric, and
  contract/evidence design closure 2026-08-14; implementation closure remains
  required before E5 consumes the port

## Boundary and scale

One PCM worklet instance serves one listener. The worklet owns its playback ring,
render state, one diagnostic epoch, constant-size counters, a monotonic request-ID
high-water mark, and one last request/reply receipt. The main thread owns epoch
and request allocation and permits at most one outstanding request. MessagePort
FIFO delivery is the linearization order.

Version 1 supports one or two signed-16 input channels, 8,000–192,000 Hz, a
12-source-second PCM ring, messages no larger than 1 MiB, and diagnostic rotation
every ten seconds with a 60-second maximum tolerated epoch. It adds no generic
RPC framework, schema registry, shared-memory transport, worker pool, or timer.
E5 owns clocks, retries, and the ten-second schedule.

## Exact protocol

All records are exact own-property plain objects. Integers are safe nonnegative
integers unless narrowed below. Unknown fields or types are invalid. `epoch`,
`nextEpoch`, and `requestId` are positive safe integers.

Main-to-worklet messages:

```text
configure = {
  type: "configure", requestId, epoch,
  sampleRate: integer 8000..192000, channels: 1|2
}

pcm = {
  type: "pcm", epoch,
  buffer: genuine ArrayBuffer, 1..1048576 bytes,
          byteLength divisible by channels*2,
          decoded frame count <= sourceSampleRate*12
}

control = {
  type: "snapshot-and-rotate" | "reset-and-rotate" | "stop-and-rotate",
  requestId, epoch, nextEpoch // nextEpoch == epoch + 1
}
```

Initial `configure` accepts any positive epoch. A stopped worklet accepts
configure only at `currentEpoch + 1`; it never reuses or rolls back the stopped
epoch. Configure clears playback and diagnostic counters, starts the supplied
epoch, and acknowledges `configured`. PCM is accepted only
for the current configured non-stopped epoch. Malformed or stale PCM is silently
dropped and cannot mutate counters, playback, or state; it has no request ID and
therefore no reply.

Worklet-to-main messages:

```text
configured = {
  type: "configured", requestId, epoch, sampleRate, channels
}

snapshotRotated = {
  type: "snapshot-rotated", requestId,
  operation: "snapshot" | "reset" | "stop",
  previousEpoch, epoch, snapshot
}

commandRejected = {
  type: "command-rejected", requestId, epoch,
  code: "stale_epoch" | "invalid_rotation" | "invalid_state" |
        "not_configured" | "request_conflict"
}

playbackState = {
  type: "playback-state", epoch,
  state: "buffering" | "playing" | "underrun" | "stopped",
  ordinal: safe nonnegative integer
}
```

The exact snapshot is:

```text
{
  epoch,
  sourceSampleRate: 8000..192000,
  sourceChannels: 1|2,
  outputSampleRate: 8000..192000,
  receivedFrames, renderedFrames,
  silentInputFrames, clippedInputFrames,
  bufferSampleCount, bufferCurrentFrames,
  bufferMinFrames, bufferMaxFrames, bufferSumFrames,
  bufferTrendStartFrames, bufferTrendEndFrames,
  underrunCount, underrunFrames, reprimeCount,
  windowStartedInUnderrun: boolean,
  overflowCount, discardedFrames, resetCount
}
```

Schema-malformed messages are silently dropped before request journaling; E4
does not attempt to canonicalize arbitrary structured-clone values. Exact-shape
request-bearing messages share one receipt model and always contain a positive
safe `requestId` plus submitted epoch. For such a message:

- `requestId == lastRequestId` plus the exact same canonical command replays the
  stored reply without another effect;
- the same ID with different bytes, or any ID below the high-water mark, returns
  `request_conflict` without an effect; and
- a higher ID advances the high-water mark and stores its success or finite
  rejection for exact replay.

An uncertain request may be abandoned only by destroying the worklet. A timeout
does not authorize a later request against the same instance.

Counters saturate at `Number.MAX_SAFE_INTEGER`; they never wrap. Buffer fields
are source-frame integers sampled exactly once at the end of every render
quantum, not on PCM arrival. Fractional resampling cursor state is rounded down
only for the observed buffer sample and is not rewritten by diagnostics.
For zero samples, all buffer fields are zero. Otherwise min/current/max and
start/end are observed samples and `min <= current <= max`,
`min <= start/end <= max`, and `sum >= min*sampleCount`.

An input frame is silent when every channel has absolute signed-16 magnitude
strictly below 64. It is clipped when either channel has magnitude at least
32760. A frame
is counted at most once in each category before resampling; E1 later derives the
upload-safe categories.

## Invariants

| ID | Normative rule | Failure/result | Evidence |
| --- | --- | --- | --- |
| E4-PORT-001 | Every request-bearing reply carries its request and resulting epoch. Exact retry replays the last reply without another effect; equal conflicting or lower request reuse is rejected. | finite reply | response-loss/retry table |
| E4-PORT-002 | Snapshot capture and counter rotation are one MessagePort handler effect. PCM ordered before it belongs to the old epoch; PCM after it must carry the new epoch. | stale PCM dropped | boundary schedule |
| E4-PORT-003 | A stale reply or command cannot rotate, reset, stop, or repopulate another epoch. | `stale_epoch` or ignored PCM | stale matrix |
| E4-METRIC-001 | Snapshot rotation does not change PCM buffers, read position, priming, or output. | checkpoint failure | uninterrupted-output baseline |
| E4-METRIC-002 | Reset rotation snapshots the old epoch, then clears playback and starts the new epoch with `resetCount=1`. Stop snapshots and clears playback, starts a stopped epoch with all counters zero, and remains stopped until configure. | fixed reply/state | reset/stop table |
| E4-UNDERRUN-001 | Pre-prime silence is buffering. An underrun begins only after PCM-backed rendering, remains active across snapshot-only rotation, and ends on re-prime/reset/stop. | coherent counters/state | underrun schedules |
| E4-OVERFLOW-001 | The ring contains `sourceSampleRate*12` source frames. One PCM message holds at most that many frames. After writing a message, `available > capacity-2` is overflow. With `reserve=floor(capacity/2)`, it advances the fractional read cursor by integer `floor(available)-reserve`, leaving exactly `reserve + fractionalPart(available)` available source frames and preserving interpolation phase. It records one overflow and that exact integer discard. | bounded continuation | overflow vectors |
| E4-PCM-001 | Instrumentation does not alter PCM/resampling output or introduce an underrun under the retained baseline schedule. | exact output equality | baseline comparison |
| E4-RESOURCE-001 | The render path performs no per-quantum diagnostic allocation or message. It may allocate/post one fixed state record only on an actual playback-state transition. Snapshots allocate one bounded reply only in the message handler. | checkpoint failure | source inspection + harness |
| E4-PRIV-001 | Messages contain only PCM, finite format/state, epochs, counters, and fixed codes. No identity, URL, token, error text, clock, or authority field exists. | invalid/review failure | recursive field review |

## Lifecycle and interruption

The main thread owns strictly increasing epochs and request IDs. Configure creates the first
active epoch. `snapshot-and-rotate` snapshots the old counters and begins the
new diagnostic epoch without touching playback. `reset-and-rotate` additionally
clears the ring and continuous-playback/underrun state. `stop-and-rotate` clears
the ring and rejects PCM until a new configure.

Within one diagnostic epoch, playback moves:

```text
buffering -> playing -> underrun -> playing
buffering|playing|underrun -> buffering (reset)
any configured state -> stopped
```

State messages are emitted only on actual state change. `ordinal` increases
within a worklet lifetime and saturates safely. Configure acknowledgement and
snapshot/reset/stop replies are posted before any state message caused by that
same request.

Snapshot-only rotation during an active underrun starts the new epoch with
`windowStartedInUnderrun=true`, `underrunCount=0`, `underrunFrames=0`, and
`reprimeCount=0`. Continued silent render frames accrue to the new epoch; the
eventual recovery increments the new epoch's `reprimeCount` once without
inventing another underrun. Reset and stop end the underrun and start the new
epoch with `windowStartedInUnderrun=false`; reset sets `resetCount=1`, while
stop leaves all new counters zero.

The E4 snapshot is not itself an E1 report. If a carried underrun has zero
rendered underrun frames before the next rotation or immediate re-prime, E5 must
derive a positive bounded carried duration from its monotonic epoch interval or
omit that empty listener window; it may not emit the E1-invalid combination
`windowStartedInUnderrun=true` with zero `underrunDurationMs`.

| Schedule | Required result |
| --- | --- |
| Before control effect | old epoch and counters remain authoritative |
| After configure/control effect before reply consumption | exact retry replays the stored reply; no second effect |
| Equal conflicting or lower request ID | `request_conflict`; no effect |
| Stale epoch or nonconsecutive next epoch | finite rejection; no effect |
| PCM immediately before/after rotation | FIFO boundary plus exact epoch assigns it to one epoch only |
| Snapshot during buffering/render/underrun | playback unchanged; new counters coherent; active underrun carries in |
| Reset during buffering/render/underrun | old snapshot returned; new epoch buffering with reset count one |
| Stop/teardown | reply precedes stopped state; old snapshot returned; ring cleared; future process calls output silence |
| Browser/process restart | E5 creates a new worklet and epoch; E4 persists nothing |

The single retained receipt plus request high-water is sufficient because E5
permits one outstanding request. A newer completed request replaces the receipt;
older IDs remain rejected by the high-water mark. E5 must not issue another
request before receiving the prior reply; uncertainty destroys the worklet.

## Resource, privacy, and dependency model

After configure, the PCM ring is two fixed Float32 arrays of
`sourceSampleRate*12` source frames. At the maximum rate this is about 18.4 MiB;
E12 measures the supported real devices before production enablement.
Diagnostics add constant-size numeric state and at most one frozen receipt. The
PCM receive handler creates only one Int16Array view; the render loop creates no
per-quantum diagnostic collection or message, with one fixed record permitted
only on an actual state transition. E4 has no timer, fetch, React state, log,
storage, retry queue, credential, or gameplay/State dependency. Its failure can
only silence this listener's local output; it cannot affect source authority or
another player.

E4 consumes no E2/E3 semantics. Its focused test imports the actual public
worklet wrapper and the E4 core with a fake MessagePort and AudioWorklet globals.
It may import no React, fetch, collector, SQLite, State, E5 lifecycle, or later
checkpoint module.

## Planned evidence and decision

Focused command:

```sh
node --test web/tests/s2e-e4-worklet.test.mjs
```

The deterministic table covers exact protocol rejection; configure/reset/stop
response loss and replay; request rollback/conflict; stopped configure; PCM on
both sides of rotation; active-underrun rotation and re-prime; zero/one/multiple
buffer samples; fractional resampling depth; fractional-cursor and maximum-chunk
overflow; stale reply/command; saturation; stop; and teardown. Signal vectors
cover ±63/±64, 32759/32760, -32768, and either stereo channel. A retained
test-only pre-instrumentation core receives both stereo unity-rate and mono
non-unity-rate PCM/render schedules; output and baseline underrun behavior must
match exactly.

- Approved implementation scope: one bounded worklet core, the actual public
  wrapper, one retained test baseline, and one focused harness.
- Prohibited scope: browser fetch/attempt lifecycle, React/UI, upload, E1 report
  production, persistence, routes, authority, producers, generalized RPC, or a
  browser simulation framework.
- Design decision: `designed`; three independent perspectives found no open
  P0/P1 after the request, overflow, ring-unit, threshold, and underrun revisions.
- Implementation authorized: `yes`, only for the approved E4 scope.
