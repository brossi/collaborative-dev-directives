# S2-E E9 source diagnostics

Status: `E9.1 locally verified and pinned; E9.2 is next`.

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
`321c34d0a3babd29a017cbf7f89841045f66223e` (tree
`31efb3f1ce4045be3f27461a73209668b9abd6e5`) on the sibling branch
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
was owned. A subsequent narrow review exposed the same substitution window
between a public-name bind and its successful attestation. The final target
binds inside a freshly created mode-`0700` private directory, attests that
inode, atomically hard-links it into the absent public name, and only then
hands the bound socket to asyncio. A competing public name makes publication
fail without removing it.

The final review also required the mode change to occur on the attested private
inode before publication. After the atomic link, the implementation performs
no public-path mutation except identity-checked cleanup, so a later pathname
substitution is neither chmodded nor removed.

Private staging cleanup revalidates the freshly created directory's owner and
mode, so even a failure before socket-inode attestation removes the contained
socket and directory without guessing about any public pathname.
Cleanup filesystem failures are contained as the same finite setup failure;
they never replace that outcome with a native exception.

Verification at this checkpoint:

- Python 3.12 full sibling suite: `257/257` pass;
- focused publisher interface and pusher suite: `51/51` pass;
- Ruff check of `src/btaudio/diagnostics.py`, `src/btaudio/capture.py`,
  `src/btaudio/relay.py`, and `tests/test_publisher_diagnostics.py`: pass;
- compileall: pass;
- source distribution and wheel build: pass; and
- sibling and CannaBeats `git diff --check`: pass.

Independent closure reviewed CannaBeats commit `9d3a590` and pinned sibling
commit `321c34d` from the counter, protocol/privacy, and audio-isolation
perspectives. Final findings are `P0=0`, `P1=0`, `P2=0`. E9.1 is locally
verified; E9.2 may now consume only this pinned finite snapshot boundary.

## E9.2 governing invariant

> Every uploaded source report joins one exact E9.1 publisher snapshot and one
> fresh finite controller playback observation under the same source instance,
> while every dependency wait, retry, and retained item remains outside and
> unable to delay the authority poll, browser command, capture, or publication
> paths.

## E9.2 boundary and scale

E9.2 adds one low-priority reporter thread to the existing managed-source
controller. It does not add a process, database, journal, metrics agent, log
scraper, remote management endpoint, or generic job framework. The reporter
owns exactly:

- one E9.1 Unix-socket client;
- one E8 source grant and synchronization transaction;
- one pending periodic window and one pending finite transition;
- one request at a time with a two-second deadline; and
- fixed backoff from one to thirty seconds.

The controller poll loop, its 25-second fail-close clock, browser command
handlers, and `systemctl` start/stop path never call or await the reporter. The
reporter reads the source token independently for each Game request so ordinary
credential rotation requires no process restart. Collector or Game diagnostic
failure can lose diagnostic evidence but cannot change lease authority,
provider sequencing, relay publication, controller readiness, or service exit.

## Finite playback observation

The browser readiness heartbeat gains one exact field:

```json
{"spotifyAuthorization":"authorized|not_authorized|error|unknown",
 "player":"ready|not_ready|error|unknown",
 "playbackObservation":"playing|paused|error|unknown"}
```

The Spotify SDK `player_state_changed` event supplies only `playing` or
`paused`; the existing finite player error listeners supply `error`; absent,
not-ready, disconnected, or older-than-15-second evidence supplies `unknown`.
No track, artist, URI, device ID, provider error, token, or browser object is
retained or exposed. `controller_playback_snapshot()` is an O(1) locked read
returning only the enum. Publisher state is never substituted for playback.

## Reporter protocol and timing

The E9.1 socket request and response retain their verified 512-byte, 2-KiB,
and 250-ms bounds. Game requests use the existing source bearer and exact E8
source route with request/response bodies capped at 8 KiB and a two-second
deadline. The reporter validates exact allowlisted response shapes before
changing local state.

For one publisher instance, the reporter performs this finite cycle:

1. read and validate the E9.1 snapshot;
2. open/replay the E8 source grant with a UUIDv5 request ID derived from the
   publisher instance;
3. synchronize using a UUIDv5 request ID derived from instance and report
   sequence while recording local monotonic send/receive milliseconds;
4. start the measurement interval at the successful synchronization receive
   time and target nine seconds, leaving one second of scheduling headroom;
5. read a closing E9.1 snapshot and the finite playback observation;
6. construct an exact E1 `source_window` with duration in `(0,10000]`; and
7. retry that exact report identity/core/sample until a finite E8 outcome is
   known.

An interval longer than ten seconds, an instance change, malformed snapshot,
or missing publisher discards that incomplete diagnostic interval; it never
fabricates zero counters or changes audio. A new synchronization sample starts
the next interval only after the prior pending reports have a finite outcome.
All snapshot counters remain E9.1 instance-cumulative values; the reporter does
not subtract windows.

Report sequence values are integers derived as four times the monotonic
microsecond and then increased locally for the bounded window/transition pair.
They need not start at zero. Python process replacement necessarily spans more
than one monotonic microsecond, so a controller restart on the same boot
advances beyond its prior reports; a machine restart also restarts `btaudio`
and supplies a new publisher instance. The representation remains within the
E1 safe-integer range for more than seventy years of boot uptime. This avoids a
durable reporter journal without allowing controller restart to reuse an E1
identity. The deterministic open request ID makes a lost open response replay
the original grant across controller restart.

## Pending work and finite outcomes

Only one window and one transition may be pending. A periodic pending item is
created at its first send boundary. Once a request may have reached Game, its
exact core and sample remain unchanged until `accepted`, `replayed`, or another
finite result arrives; newer evidence cannot replace an outcome-unknown
request. Reports are sent in sequence order and at most one transition is sent
per second. A timed-out Game call retains its one daemon helper transaction;
later exact retries observe that same transaction and never create a second
helper while it is unresolved.

The single transition slot has fixed priority:

1. publisher instance change -> `publisher_restarted/process_restart`;
2. increased publisher restart counter ->
   `publisher_restarted/publisher_unavailable`;
3. publisher entering `publishing` -> `publisher_started`; and
4. playback enum change -> `playback_changed`.

Lower-priority simultaneous diagnostic transitions may be omitted; they are
never merged into a false occurrence count. Capture transitions are not
emitted because E9.1 exposes no separate capture lifecycle state.

`accepted` and `replayed` retire the pending report. `quota_exhausted` retires
that evidence and continues after backoff. `stale_correlation`,
`trace_inactive`, and `source_session_lost` retire reports bound to the old
correlation, clear the local grant/sample, and reopen from current State
authority. `report_conflict` retires the conflicting item and advances to a
fresh sequence without altering publisher identity. A finite `report_invalid`
also retires only that locally malformed evidence. Timeout, connection loss,
malformed response, `collector_busy`, and diagnostic unavailability retain the
one exact outcome-unknown item and back off. Native or lower-layer text is
never logged; operational output uses only finite local reason codes.

## E9.2 closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: one shared reporter state machine opens one deterministic grant per publisher instance and creates only exact E1 reports. |
| Update | `runtime`: one owner advances grant, sample, sequence, pending slots, and backoff; publisher/controller snapshots are read-only. |
| Delete | `runtime`: finite terminal outcomes retire only their bound pending item; correlation loss clears only diagnostic grant/sample state. |
| Omit | `runtime`: exact E9.1 and playback validators reject missing fields; delayed intervals become a finite local coverage gap, not a fabricated report. |
| Duplicate | `runtime`: deterministic request IDs and exact report identity make response-loss retries replay; one window and one transition slot bound memory. |
| Reorder | `runtime`: pending reports are sent by increasing sequence; a later report cannot pass outcome-unknown earlier work. |
| Replay | `runtime`: open, synchronization, and report retries retain exact request/core/sample values until the original finite result returns. |
| Conflict | `runtime`: changed response identity or report conflict fails before current-state adoption and advances only by an explicit fresh sequence. |
| Concurrency | `structural`: one reporter thread owns its state; poll/browser/audio paths only expose O(1) snapshot reads and never enter reporter transactions. |
| Expiry | `runtime`: local RTT is at most two seconds, report start is sample receive, duration is at most ten seconds, and stale grants/samples reopen finitely. |
| Restart | `runtime`: deterministic open identity plus monotonic-microsecond report sequences avoid same-instance reuse; publisher restart supplies a new instance and transition. |
| Dependency failure | `structural`: all socket/HTTP waits occur only on the reporter thread with fixed deadlines and backoff; no authority/audio future is shared. |
| Corruption | `runtime`: exact response/core validators and finite error mapping reject malformed, excess, contradictory, or native dependency output. |
| Capacity | `runtime`: one grant, one sample, one window, one transition, one in-flight request, 8-KiB I/O, and 1..30-second backoff are fixed constants. |

## E9.2 matrix-derived verification

Local verification must cover:

- exact playback heartbeat and stale/missing/error mapping without provider
  fields;
- exact E9.1 response shape, counter relations, 512/2048-byte boundaries,
  timeout, missing socket, and instance change;
- open/synchronize/report success, exact response loss replay, credential
  rotation, malformed/oversized response, and two-second timeout;
- nine-second window, ten-second equality, greater-than-ten gap, sample RTT
  before/equality/after, and publisher change during a window;
- one window/one transition capacity, transition priority, increasing report
  order, outcome-unknown retention, quota drop, correlation reset, and fresh
  sequence after conflict;
- controller restart with the same publisher instance and machine restart with
  a new instance;
- held reporter socket/Game calls while the real poll loop retains its cadence,
  25-second lease fail-close remains effective, browser completion remains
  responsive, and publisher state/PCM are unchanged; and
- operational-output scans for token, path, provider/native error, track,
  artist, URI, device, peer, and arbitrary response reflection.

The local pre-audit counterexample question is: what smallest response-loss,
restart, instance-change, or two-slot interleaving preserves every validated
field but lets an old correlation, sample, sequence, or playback observation be
published as current? E9.2 implementation is authorized only within this
recorded boundary. E10 remains separate.

## E9.2 implementation checkpoint

Status: implemented; local counterexample pass complete; independent closure
review pending. E10 is not authorized by this checkpoint.

The contained implementation adds `source_reporter.py`, attaches one daemon
reporter thread to the existing controller, enables the exact pinned publisher
socket in the relay-push unit, and carries the finite playback observation in
the existing browser heartbeat. The controller receives only the dedicated
`cannabeats-diagnostics` publisher-socket group and cannot traverse the
separate `cannabeats-audio` PulseAudio directory, while the reporter reuses the
already source-scoped credential; no diagnostic credential is added to the
browser or publisher process.

The pre-audit pass found and closed these relationship-preserving schedules
before review:

- a startup transition using sequence `N+1` before its reserved window `N`;
- a lost synchronization response advancing to a different request/sequence;
- a slow-drip Game response exceeding a nominal socket timeout by retaining
  only one bounded helper transaction behind a strict reporter deadline;
- a correlation reopen emitting a false second publisher-start transition;
- same-instance cumulative counter regression reaching the E1 boundary;
- a valid synchronization response substituting another trace timebase; and
- a reused audio group granting the controller unnecessary access to the raw
  PulseAudio socket; the final runtime uses a distinct tmpfiles-owned
  diagnostics directory and group.

Enforcement locations are the exact publisher/client validators and the
single-owner `SourceReporter` state machine in
`spikes/managed-audio-source-poc/source_reporter.py`; the O(1) playback read and
finite logger are in `controller.py`; the browser classifier is the pure
`classifyPlaybackObservation` helper in `source-ui/protocol.mjs`; Unix-socket
access and installation are fixed by the source systemd/install artifacts.

Local verification on the implementation worktree:

- affected Python Ruff: pass;
- managed-source Python discovery: `51/51` pass;
- browser protocol tests: `4/4` pass;
- Python compile, browser syntax, installer shell syntax, and diff check: pass;
- retained btaudio pin/topology scheduler regression: `8/8` pass.

Open local findings are `P0=0`, `P1=0`, `P2=0`. E10 still owns the relay
adapter/reporter, E11 owns host projection and comparison presentation, and
E12 owns real-host installation, real browser/Spotify timing, measured
overhead, and cross-process failure rehearsal.
