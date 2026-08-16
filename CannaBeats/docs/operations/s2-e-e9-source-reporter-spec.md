# S2-E E9 source diagnostics

Status: `E9.1 implemented and pinned; independent closure review pending`.

This packet applies the repository scale filter. There is one managed source,
one `btaudio-push` process, one local controller, and one future reporter task.
There is no general metrics agent, remote-management surface, event journal, or
log scraper.

## Increment sequence

1. **E9.1 publisher snapshot boundary:** add and pin one finite local
   `btaudio-publisher-diagnostics/v1` interface. It observes publisher state
   and counters but performs no Game/collector calls.
2. **E9.2 source reporter:** join the E9.1 snapshot with the controller's
   finite playback observation and E8 source mediation using one bounded,
   replaceable pending aggregate.

E9.1 must close before E9.2 can consume it.

## E9.1 governing invariant

> Every publisher diagnostic snapshot is an exact, allowlisted, monotonic
> projection of one diagnostic instance, while snapshot and rotation work can
> neither block nor change capture, queueing, publication, or reconnect
> behavior.

## Boundary and scale

E9.1 changes the pinned `btaudio` sibling and the CannaBeats revision pin only.
It does not change the managed-source authority poll, controller commands,
provider sequencing, Game routes, collector, relay, or deployment services.

The machine interface is a permission-restricted Unix-domain socket enabled
only by an explicit `btaudio-push --diagnostics-socket PATH`. There is no TCP
listener. Socket ownership/group installation remains E12; local E9.1 tests
prove mode `0660`, exact protocol behavior, and cleanup.

## Exact protocol

The interface name is exactly `btaudio-publisher-diagnostics/v1`. Each
connection carries one newline-terminated JSON request of at most 512 bytes
and receives one newline-terminated JSON response before close. Reads have a
250-ms deadline. Invalid UTF-8, invalid JSON, excess bytes, missing newline,
unknown fields, and unknown actions return only:

```json
{"status":"invalid_request"}
```

The two exact requests are:

```json
{"interface":"btaudio-publisher-diagnostics/v1","action":"snapshot"}
{"interface":"btaudio-publisher-diagnostics/v1","action":"snapshot_and_rotate","requestId":"lowercase UUIDv4","expectedInstanceId":"lowercase UUIDv4"}
```

`snapshot` returns `{status:'ok', snapshot:SOURCE_SNAPSHOT}`.
`snapshot_and_rotate` returns
`{status:'rotated', snapshot:OLD_SOURCE_SNAPSHOT, currentInstanceId:UUID}`.
The rotation response is journaled only until the next distinct successful
rotation. An exact retry of the current retained request returns the original
response without a second rotation. A different request while a rotation is
executing returns `busy`; reuse of the retained request identity with a
different exact command returns `request_conflict`. No queue is created.
An otherwise valid rotation for an instance that is no longer current returns
`stale_instance` without another rotation.
Rotation also returns `busy` while a capture callback has not reached the
publisher queue or while old-instance PCM remains queued/in-flight. This
zero-carry rule prevents later publication from crossing diagnostic
identities; it never waits for or drains that audio.

All internal/native failures become one of `invalid_request`, `busy`,
`request_conflict`, `stale_instance`, or `unavailable`. No exception, path, peer, token, device
name, URL, or caller bytes appear in a response or normal operational output.

## Exact source snapshot

Every field is required and every unlisted field is prohibited:

| Field | Exact value/domain |
| --- | --- |
| `interface` | `btaudio-publisher-diagnostics/v1` |
| `schemaVersion` | integer `1` |
| `instanceId` | lowercase UUIDv4 |
| `sampleRate` | integer `8000..384000` |
| `channels` | integer `1|2` |
| `encoding` | `s16le` |
| `capturedFrames` | integer `0..9007199254740991` |
| `enqueuedFrames` | same unsigned range |
| `publishedFrames` | same unsigned range |
| `publishedBytes` | same unsigned range |
| `captureGapCount` | same unsigned range |
| `droppedUploadCount` | same unsigned range |
| `reconnectCount` | same unsigned range |
| `publisherRestartCount` | same unsigned range |
| `publisherState` | `idle|connecting|publishing|backoff|stopped|error|unknown` |

The exact relations are:

- `publishedFrames <= enqueuedFrames <= capturedFrames`;
- `publishedBytes = publishedFrames * channels * 2` with checked arithmetic;
- counters never decrease within one `instanceId`; and
- sample rate, channels, and encoding never change within one instance.

The snapshot deliberately excludes playback observation. E9.2 obtains
`playing|paused|error|unknown` from the controller's separate finite local
interface; publisher readiness is not playback evidence.

## Counter provenance and rotation

- `capturedFrames` is the capture callback's cumulative complete-frame count.
- `enqueuedFrames` counts complete frames accepted into the publisher queue,
  including a newest chunk that replaces a dropped oldest chunk.
- `publishedFrames`/`publishedBytes` count complete PCM drained to the relay
  writer.
- `droppedUploadCount` counts queue-overflow drops, one per discarded chunk.
- `reconnectCount` counts connection attempts after the first attempt.
- `publisherRestartCount` counts entries into `publishing` after the first
  publishing epoch.
- `captureGapCount` increments when two callbacks in one continuous capture
  epoch are separated by strictly more than twice the current callback's
  nominal frame duration. Start/stop boundaries do not count as gaps.

Audio-critical paths perform scalar increments and the existing event-loop
handoff only. They do not serialize JSON, touch the socket, acquire a
diagnostic lock, allocate a diagnostic event, or wait for a reporter.

Raw process counters never reset. A successful diagnostic rotation snapshots
the old baselines, creates a new random instance ID, and records those exact
raw values as the new baselines. The old snapshot and new baselines use the
same reads, so no counter is discarded. Snapshot order is published,
enqueued, then captured, preserving the E1 inequalities while the capture
thread advances. Rotation does not stop capture, empty the audio queue, close a
connection, or change publisher state.

A rotation commits only when raw `capturedFrames == enqueuedFrames` and the
publisher's bounded queued/in-flight byte count is zero. Otherwise it returns
`busy` without retaining a receipt. This is the exact safe boundary for PCM
already captured under the old instance.

## E9.1 closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: CLI/socket startup validates one absolute path and refuses an existing path before publisher work. |
| Update | `structural`: raw counters only increase; rotation swaps diagnostic baselines/identity without mutating audio state. |
| Delete | `runtime`: bounded close removes only the exact owned socket path after server close. |
| Omit | `runtime`: one shared exact snapshot constructor emits every required field or finite `unavailable`. |
| Duplicate | `runtime`: one server owner per socket; one retained rotation receipt; a concurrent rotation returns `busy`. |
| Reorder | `structural`: scalar counters are read in the fixed published/enqueued/captured order and one synchronous event-loop rotation establishes baselines. |
| Replay | `runtime`: exact retained `snapshot_and_rotate` request returns the original response without another rotation. |
| Conflict | `runtime`: malformed/extra-field commands fail before action; conflicting retained request reuse returns `request_conflict`. |
| Concurrency | `runtime`: snapshot is read-only; rotation has one in-flight flag, requires the zero-carry boundary, and has no waiting queue. |
| Expiry | `not_applicable`: the interface is process-local and receipts live only until the next rotation/process exit. |
| Restart | `structural`: process restart creates a new instance ID and zero baselines; E9.2 reports the restart transition. |
| Dependency failure | `structural`: E9.1 has no network or collector dependency; a hung socket caller is cut off by the request deadline. |
| Corruption | `runtime`: exact request parsing and exact snapshot construction fail finitely; no retained file exists. |
| Capacity | `runtime`: one 512-byte request, one sub-2-KiB response, one connection task, no queue, and one retained receipt. |

## Matrix-derived verification

Before closure, tests must prove:

- exact snapshot shape, relations, and monotonic deltas;
- capture-gap equality/before/after and start/stop reset behavior;
- queue overflow, publication, reconnect, and publisher-restart provenance;
- snapshot/rotation replay, conflict, concurrent `busy`, and process-restart
  identity;
- invalid UTF-8/JSON, unknown/extra fields, 511/512/513-byte boundaries,
  missing newline, timeout, socket collision, mode, and exact cleanup;
- instrumentation-disabled versus enabled PCM/output/counter parity under the
  existing deterministic pusher fixtures; and
- operational-output scans showing no peer, token, path, URL, device name, or
  arbitrary exception in the new interface output.

The pre-audit counterexample question is: what smallest interleaving or scalar
change preserves the existing published/enqueued/captured inequalities while
moving a frame, drop, reconnect, or rotation into the wrong diagnostic
instance? Any valid answer becomes a focused test before independent review.

E9.1 implementation is authorized within this boundary. E9.2 reporter timing,
controller playback observation, E8 uploads, credential rotation, and
collector failure remain explicitly outside this increment.

## E9.1 implementation checkpoint

The pinned sibling target is
`5704f4a3ca3a56940ff0beaefe40a63cd5985e12` (tree
`e370a342276d08f0a05c10f5f37d054dde02214d`) on the sibling branch
`feature/s2-e-publisher-diagnostics`. It adds `btaudio` version `0.4.0`, the
finite Unix-socket interface, capture/publisher scalar provenance, exact
rotation/replay, finite operational output, and no reporter or network
dependency.

The local counterexample pass found and closed one instance-boundary defect:
queued old-instance PCM could be published after rotation and violate
`publishedFrames <= enqueuedFrames` in the new instance. Rotation now requires
the exact zero-carry boundary and returns `busy` without waiting or changing
audio when capture-to-queue or queue-to-writer work remains.

The first independent review found two further lifecycle races. A relay verdict
could win in the same event-loop turn in which `queue.get()` had already taken
ownership of PCM, stranding unpublished accounting; and peer resets could let
native write/close errors escape the Unix-socket handler. The remediated target
retires a simultaneously owned queue item before returning, keeps the capture
handoff live until PortAudio stops, and bounds/suppresses connection-scoped
write and close failures. It also records socket ownership before mode changes
and exercises the real capture callback with diagnostics both disabled and
enabled. The first targeted re-review found one bounded cleanup substitution:
a pre-attestation failure could make cleanup guess that a replacement socket
was owned. The final target binds the socket itself, records its exact inode
before handing it to asyncio, and never unlinks an unattested or substituted
path. Final narrow re-review remains pending.

Verification at this checkpoint:

- Python 3.12 full sibling suite: `254/254` pass;
- focused publisher interface and pusher suite: `48/48` pass;
- Ruff check of `src/btaudio/diagnostics.py`, `src/btaudio/capture.py`,
  `src/btaudio/relay.py`, and `tests/test_publisher_diagnostics.py`: pass;
- compileall: pass;
- source distribution and wheel build: pass; and
- sibling and CannaBeats `git diff --check`: pass.

Open local findings are `P0=0`, `P1=0`, `P2=0`. E9.1 remains unconsumable by
E9.2 until targeted independent re-review closes the remediated boundary.
