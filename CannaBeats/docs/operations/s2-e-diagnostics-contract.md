# S2-E listener, source, and relay diagnostics contract

Status: the S2-E architecture and checkpoint framework use the small-deployment
scale filter and each detailed checkpoint must pass its own closure gate.
E1-E10 are locally verified at their recorded exact targets and independently
closed where their boundary risk required it. This includes E7's transactional
store and isolated service, E8's fixed mediation/caller matrix, and the bounded
E9/E10 source and relay reporters. E11 composition and E12/S2-F real-environment
proof remain open.
The earlier broad executable-contract and listener prototypes remain
archived outside the active branch and supply no evidence.

This contract defines a bounded diagnostic plane for locating managed-audio
quality failures. It consumes the S2-D stream, lease, handoff, and recovery
boundaries without becoming another source of game or playback authority.

This is a small-game diagnostic tool for one host and a handful of friends or
family, not a general telemetry platform. Version 1 optimizes for eight or fewer
listeners, one source, one relay, short-lived troubleshooting, and simple finite
schemas. It deliberately has no tenant framework, query language, extension
registry, generic event bus, distributed-consensus protocol, or promise to
reconstruct every missing observation. Missing or contradictory evidence yields
`insufficient_evidence`.

Three pieces of complexity remain because simpler choices would defeat the
feature: the collector stays separate so high-frequency disposable writes can
never contend with State; server-time mapping stays because unrelated browser
clocks cannot otherwise support cross-listener ordering; and finite source plus
relay snapshots stay because listener-only data cannot distinguish where the
shared stream failed. Everything else begins as a fixed table, bounded task, or
disposable file and grows only after a real game-night measurement shows that it
must.

## Questions the system must answer

For one reported interruption, an authorized tester must be able to determine
which evidence is consistent with:

1. capture or source publication stopping;
2. relay ingress, fan-out, or publisher-generation interruption;
3. one listener's network delivery becoming irregular;
4. one browser's jitter buffer draining, growing, or resetting;
5. browser suspension, output-device timing, or a main-thread stall; or
6. insufficient evidence to distinguish those cases.

The report may say `suspected`, `correlated`, or `insufficient_evidence`. It may
not claim a definitive cause merely because the nearest observed counter moved.

## Authority and failure boundaries

- State remains the sole authority for lobby, run, membership, lease, handoff,
  command, history, and authoritative game-history retention state. The
  collector owns only disposable diagnostic retention.
- Listener, source, and relay diagnostics are observations. They cannot grant
  membership, acquire or release a lease, acknowledge a command, clear a
  handoff, seal history, or change the room projection.
- Game authenticates the listener and resolves its current run and stream
  context before issuing or accepting diagnostic correlation. The browser does
  not author lobby, run, source, lease, role, or player identity labels.
- The diagnostics collector owns a separate diagnostic store. It has no
  read-write mount of either the Access or State authority database. State and
  Game do not open the diagnostic store.
- Diagnostic ingestion, projection, purge, and export are separately bounded.
  Their failure must not fail audio delivery, gameplay requests, State
  readiness, history sealing, coordinated authority backup, or rollback.
- The diagnostic store is disposable support data. It is excluded from the
  coordinated Access/State backup and is never required to restore authority.

This separation is deliberate: optional high-frequency observation must not
reintroduce contention or migration risk into the single-writer State database.

## Service and credential topology

The diagnostics collector is a standalone internal service with its own
unprivileged runtime identity, schema contract, database file, retention job,
and readiness endpoint. It receives no State activation, Access, source, relay,
or browser bearer credential.

- Browsers, sources, and the relay never call the collector. Game is its sole
  online gateway. Game authenticates the caller at the existing browser,
  source, or relay boundary; resolves current run/role/lease authority through
  State; rejects caller authority labels; and forwards one exact internal
  request using a single diagnostics-service credential. The collector trusts
  only that private Game credential and never interprets an external session or
  source token.
- A host may create or end one active trace for an authoritative run through
  Game. Game supplies the run authority and request ID. Because there is one
  managed publisher and relay, at most one uploaded trace is active system-wide;
  a competing request returns `trace_busy`, while local-only reporting remains
  available.
- Source reports use the existing authenticated Game source path. Game validates
  the E1 bytes, asks State whether that source currently owns the live managed
  work, and attaches the returned run/lease correlation to the internal
  collector request. No separate source-signing key, nonce ledger, or report-
  digest assertion is introduced.
- The relay adapter uses one relay-to-Game credential. At publisher-generation
  start, Game asks State for current managed-stream authority and binds the
  observed opaque relay generation once to that run/lease. It never rebinds the
  generation after handoff. Delayed reports remain on the old binding or are
  rejected. Collector or State failure leaves evidence missing and never delays
  relay audio.
- Host reads pass through Game. State must attest that the principal is the
  durable host of the requested run, including after that run ends. Current
  lobby membership alone is insufficient. If State cannot make that historical
  authority response, the read fails closed. Access may continue after run termination
  or history retention only while State retains enough authority evidence to
  make that exact run-host decision.
- A maintenance credential permits only status and whole-trace purge and is
  mounted only in the operations job. The Game credential cannot purge; the
  maintenance credential cannot ingest or read report bodies. Pairwise secret
  inequality is checked at startup. No diagnostic credential is accepted by
  State, Access, gameplay mutation routes, relay audio, or source commands.

The corresponding version-1 seams are fixed before implementation:

| Boundary | Operations |
| --- | --- |
| Browser → Game | `/api/diagnostics/trace`, `/api/diagnostics/listener-instance`, `/api/diagnostics/listener-report`, `/api/diagnostics/report`, `/api/diagnostics/stop-sharing` |
| Source → Game | `/api/diagnostics/source-report` |
| Relay adapter → Game | `/api/diagnostics/relay-generation`, `/api/diagnostics/relay-report` |
| Game → State | `/v1/diagnostics/run-host-authority`, `/v1/diagnostics/managed-stream-authority` |
| Game → collector | versioned internal trace, ingest, and read operations under one Game credential |
| operations → collector | status and whole-trace purge under the maintenance credential |

Trace, consent, relay-binding, and purge commands require canonical request
UUIDs. Segment rotation is idempotent by the exact retained prior/current lease
edge, synchronization issuance by `sampleId`, and reports by their E1 identity.
Exact replay returns the same finite result; conflicting identity reuse fails.
The internal collector request
contains the already-validated E1 bytes plus server-derived correlation. The
collector revalidates E1 and owns `(traceId, instanceId, sequence)` replay. This
two-boundary validation is enough for one private gateway; version 1 introduces
no signature PKI, key-history service, general capability framework, or public
collector route.

Collector liveness is process-only. Collector readiness covers its own schema,
quota, and store, but is not a dependency of Game or State readiness. Operator
status reports it as optional `healthy`, `degraded`, `unavailable`, or `unknown`.

## Correlation model

The diagnostic hierarchy is:

```text
runId (server authority)
└── diagnosticTraceId (server-issued for one managed-audio interval)
    ├── sourceInstanceId (ephemeral per controller start)
    ├── relayGenerationId (ephemeral per publisher generation)
    └── listenerInstanceId (ephemeral per local listener start)
        ├── connectionAttemptSequence (monotonic within the instance)
        └── summarySequence (monotonic within that listener instance)
```

- All identifiers are opaque UUIDs and are scoped to the current run or process
  instance. None is a device identity.
- A listener instance rotates on page reload, explicit stop/start, or run
  replacement. It is not stored in a cookie or durable browser storage.
- The server derives `runId`, diagnostic trace, coarse role, source association,
  and the run/lease binding for an authenticated relay-observed generation.
  Caller-supplied authority values are rejected rather than corrected silently.
- Each producer may obtain a synchronization sample through authenticated Game.
  The sample contains a collector `timebaseId`, `serverReceiveMs`, and
  `serverSendMs`. The producer records `localSendMs` immediately before the
  request and `localReceiveMs` immediately after the response on its monotonic
  clock; client wall time is never used. Game/collector store the accepted
  sample and mapped interval with uploaded reports. Version 1 does not sign
  samples for offline verification.
- For local time `L`, the physically valid server-time offset interval is
  `[serverSendMs - localReceiveMs, serverReceiveMs - localSendMs]`. These bounds
  are never sorted: local/server intervals must already be ordered and server
  processing must not exceed the local round trip. The mapped event interval
  adds the lower/upper offsets to the local monotonic start/end.
  `mappingUncertaintyMs` is exactly half the offset width, equivalently half the
  local round trip after subtracting server processing. The exact schema stores
  all four timestamps and derived bounds rather than an ambiguous point offset.
- Different producers and renewals normally have different samples. Cross-
  producer comparison requires the same collector timebase, a physically
  possible sample accepted with the report, and uncertainty below the fixed
  E2 maximum. The collector records `receivedAt`, which is transport evidence
  and not event-time truth.
- The comparator may say that A preceded B only when A's latest possible end is
  earlier than B's earliest possible start. Overlap, expired samples, excessive
  uncertainty, or reports without a common valid timebase produce
  `insufficient_evidence` for ordering-dependent classifications.
- Sample validity is evaluated at upload. Once the collector stores a mapped
  interval, later expiry does not invalidate that retained interval. Local
  copied E1 reports are deliberately unaligned; without the collector they may
  be inspected individually but cannot establish cross-device precedence. This
  removes public verification keys and long-lived signed-sample handling from
  the small-deployment design.

## Trace lifecycle and consent

- Local listener measurement starts only when that browser enables shared audio
  and ends on listener stop, run replacement, or page teardown.
- Local measurement and the copyable local report require no collector.
- Server upload is disabled by default. A user enables diagnostic sharing from
  the advanced local panel for the current listener instance. A host can invite
  participants to share but cannot silently enable another browser.
- On opt-in, Game creates the listener instance and returns a short-lived,
  memory-only listener grant bound to the authenticated principal, run, trace,
  instance, consent generation, scope, and expiry. Game verifies that grant and
  the current principal on every report and stop request but forwards neither to
  the collector. The collector stores only instance sharing state and monotonic
  consent generation. Page reload loses the grant and requires a new instance
  and opt-in.
- The successful opt-in commit is the sharing linearization point. Local windows
  or transitions created before it are never backfilled from the local ring.
  Stop-sharing atomically increments the consent generation and marks the
  instance revoked before acknowledging. An unseen report identity from the old
  generation that has not committed before stop returns `sharing_disabled`.
  Exact replay of a report accepted before stop returns `replayed` without a new
  write or disclosure; conflicting reuse remains `report_conflict`. Stop-sharing
  therefore prevents new collection without rewriting durable idempotency truth.
- Starting an uploaded trace is an idempotent host action in the diagnostic
  plane. It does
  not change room revision or State. The trace has a maximum six-hour lifetime
  and a visible active/ended status.
- A trace rotates on run replacement and ends on explicit host stop, six-hour
  expiry, or loss of the authoritative run. Lease replacement creates a new
  correlation segment inside that trace. Producer process restarts rotate their
  instance IDs. Browser reconnects increment `connectionAttemptSequence` but do
  not rotate the listener instance unless the user explicitly resets it.
- Diagnostics do not subscribe to or block State transitions. Every trace
  management, ingest, and read operation rechecks the applicable fresh State
  authority response; authority loss atomically ends or rejects the trace then. A quiet
  stale row may remain until its fixed expiry but conveys no authority and cannot
  accept or disclose reports.
- Source and relay summaries are collected only while an uploaded trace exists
  and managed playback is active. Ending the trace stops new ingestion without
  stopping playback.
- The UI states that bounded technical summaries are being shared and that they
  are pseudonymous rather than anonymous: in a small game, timing, role, browser
  family, and run context may make a participant recognizable to the host. It
  offers an immediate stop-sharing action. Stop-sharing prevents future upload;
  it does not delete prior reports. Version 1 does not retain a principal-to-
  instance mapping and therefore does not promise post-hoc participant-specific
  deletion. The UI states that accepted reports remain until whole-trace purge
  or retention expiry. Network peers necessarily process IP addresses, but
  application and proxy stores and logs must not retain them.

Before opt-in, the UI communicates substantially: CannaBeats shares bounded
stream timing, buffer behavior, coarse browser/OS category, and random trace-
scoped identifiers; it does not share audio, song/answer content, display name,
account/player identity, or credentials; and reports are pseudonymous rather
than anonymous and may be attributable from the context of the game.

## Versioned measurement core and uploaded envelope

E1 owns one exact, authority-free `measurementCore` and its canonical bytes.
They are useful for local validation and copy without a collector and never contain `traceId`,
`runId`, `leaseId`, `role`, an alignment sample, a signature, or an assertion:

```text
schemaVersion: 1
kind: listener_window | listener_transition | source_window |
      source_transition | relay_window | relay_transition
instanceId: UUID
sequence: safe nonnegative integer
monotonicStartMs: bounded nonnegative number
durationMs: bounded positive number for windows; exactly 0 for point transitions
measurements: exact kind-specific object
```

E2 owns a distinct exact `uploadedReport` whose fields are
`{measurementCore, alignment, serverContext}`. `measurementCore` is the frozen
E1-produced object and re-encodes to the unchanged canonical E1 bytes.
`alignment` and `serverContext` are siblings
of `measurementCore`; they are never inserted into or used to rewrite it.
Game/State derive role, run, trace, lease, source, and relay-generation authority
only into `serverContext`. A caller-
authored authority label is rejected rather than corrected in E1 bytes.

Local/copy exports contain E1 measurement cores only. They have no alignment
claim and cannot establish cross-device precedence. Collector ingestion accepts
only the E2 aligned uploaded envelope.

The collector stores validated E2 server context alongside the unchanged E1 bytes and
records its own receipt time. Producers cannot add tags, labels, dimensions,
arbitrary metadata, or extension bags. Schema evolution adds a newly accepted
whole version; it never weakens validation of an existing version.

All counters are per-instance cumulative counters or explicit window deltas as
declared by the schema; a field cannot switch meanings between producers. The
collector rejects decreasing cumulative counters except at an explicit new
instance boundary.

## Listener observation contract

The audio worklet produces aggregate counters using constant memory and no
per-frame object allocation. The main thread owns a bounded ring of summaries.
Attempt milestones live in `listener_transition.measurements`; a transition is
a point event with `durationMs: 0`. Each full listener window is 10 seconds. A
final window flushed by stop, reset, or producer shutdown may be shorter but
remains positive. Listener windows may contain only the window/state fields
below:

- attempt-specific connection timing: request start, response headers, first PCM
  bytes, buffer primed, and first PCM-backed rendered output quantum, all as
  bounded elapsed milliseconds and associated with one
  `connectionAttemptSequence`; these milestones are emitted once per attempt,
  not repeated as window observations;
- delivery: received bytes and frames, chunk count, mean/max chunk gap,
  reconnect count, and a finite terminal/error category;
- buffer: current/min/max/mean depth in milliseconds, linear depth trend,
  underrun count and duration, re-prime count, overflow/discarded-frame count,
  and reset count;
- clocks: source sample rate, output sample rate, and nominal source/output rate
  ratio. Measured drift is not claimed unless a future schema defines a bounded
  estimator;
- browser state: `AudioContext` state, coarse base/output latency when exposed,
  visibility/suspension transitions, and long-task count/max duration;
- upload-safe signal aggregates: `signalPresence` (`unknown`, `silent`, or
  `present`) and `clippingSeverity` (`unknown`, `none`, `isolated`, or
  `sustained`). Clipping is measured on decoded signed-16 PCM before resampling
  using fixed versioned whole-window thresholds. Numeric RMS/peak values and
  signal counts may exist only in the local 15-minute display and are never
  uploaded, persisted in copied summaries, or used for shared comparison. PCM,
  spectral data, fingerprints, song identity, and sample windows are forbidden;
  and
- coarse client context: browser family and major version, OS family,
  browser/PWA installation mode, and listener implementation version. Role is
  server-derived E2 authority metadata, not an E1 measurement field. No full
  user agent is retained.

Every field declares whether it is a window delta, instance cumulative value,
attempt milestone, or point sample. Received frames means decoded PCM frames
derived from byte count and channel count; chunk gap means JavaScript stream
delivery gap, not network packet gap. Buffer depth is converted to source-frame
milliseconds and its min/mean/max/trend sampling cadence is fixed by the schema.
Missing browser APIs produce explicit `unsupported`, `unknown`, or
`not_applicable` fields. Zero
must not be used to imply that an unavailable measurement was observed healthy.

Pre-prime startup silence is buffering, not an underrun. An underrun begins only
after PCM-backed rendering has occurred in the current continuous playback epoch
and ends at re-prime, reset, or stop according to the versioned state machine.
The client also emits distinct transition summaries for first playback,
underrun, reset, reconnect, context suspension/resume, terminal stream failure,
and listener stop. E1 never coalesces distinct events. E5 may drop a redundant
best-effort diagnostic transition to meet its bounded queue, but it must not
rewrite two events as one or claim exact multiplicity after a drop.

## Source and relay observation contract

Source summaries use the same diagnostic trace and bounded windows. They may
include:

- captured, enqueued, and published PCM frames/bytes;
- capture gaps, dropped upload packets, reconnects, and publisher restarts;
- controller/source instance and relay publisher state;
- finite playback observation (`playing`, `paused`, `error`, `unknown`); and
- the opaque command reference already present in State history when relevant.

Relay summaries may include:

- publisher generation start/stop and finite stop reason;
- ingress frames/bytes/gaps and rejected or dropped ingress units;
- active listener count, accepted/closed listener counts, and bytes delivered;
- slow-consumer/backpressure closures and generation-fence disconnects; and
- process restart and bounded resource counters.

Before either producer is implemented, the pinned publisher/relay sibling must
provide two versioned, allowlisted machine interfaces:

- a source snapshot/reset interface over a permission-restricted local Unix
  socket, exposing only the fields in the source schema; and
- a relay snapshot/reset interface exposing its opaque process and publisher
  generation IDs plus only the relay fields above.

The source reporter also consumes one finite local controller playback snapshot
(`playing`, `paused`, `error`, or `unknown`) through a separate exact interface;
publisher readiness is not treated as playback observation. The reporter joins
the two bounded snapshots without accessing browser automation state, provider
errors, or credentials.

Snapshot reads are O(1), nonblocking, and do not reset counters. A diagnostic
reset atomically rotates the diagnostic instance/generation before counters are
zeroed; live counters never decrease within one identity. Reset cannot affect
capture, publication, or fan-out. Current stdout and the existing general relay
health response are not diagnostic interfaces and must not be scraped. Adopting
these interfaces requires a reviewed and newly pinned sibling revision. That
revision also removes peer/IP, URL/path, credential, and arbitrary-error fields
from normal publisher/relay stdout and journal output; tests scan operational
output and the new interfaces, not merely collector projections.

The source capture/publisher path and relay fan-out path perform only constant-
time counter increments. One low-priority reporter task per process snapshots
and uploads with a strict deadline, one replaceable aggregate, and no retry
journal. A separate reporter process is unnecessary unless local measurement
later proves the task can disturb audio. Collector connection, timeout, or
rejection cannot run on or await authority polling, capture, publication, or
fan-out loops.

Relay summaries never include IP addresses, bearer tokens, request URLs, user
agents, or unbounded transport errors. The relay adapter must consume a stable
machine interface from the pinned relay; it may not scrape arbitrary log text.

## Upload and storage bounds

- Normal upload cadence is one summary every 10 seconds. An exceptional
  transition may upload immediately, with a maximum of one accepted report per
  listener instance per second.
- Each report body is at most 8 KiB; its validated E1 core is at most 2 KiB and
  its complete canonical E2 persisted envelope is at most 4 KiB. Each contains one schema
  version. Unknown fields,
  non-finite numbers, out-of-range values, invalid enum members, and excess
  nesting fail the entire request with a stable error.
- `(traceId, instanceId, sequence)` is the idempotency key for every report.
  `kind` is derived validated data, not another identity dimension. Exact replay
  of identical E1 core bytes returns the originally stored alignment/context;
  conflicting core reuse is rejected. Request UUIDs
  protect proxy mutations but do not replace producer sequence idempotency.
- The browser retains at most 15 minutes or 256 KiB of local summaries,
  whichever is reached first. It retains at most one unsent aggregate during
  upload backoff; it does not queue an unbounded retry journal.
- One six-hour trace supports at most eight listeners concurrently. It has one
  simple allowance of 24,000 periodic rows and 6,000 transition rows. The normal
  six-hour/eight-listener cadence uses 21,600 periodic rows, leaving 2,400 in
  reserve. Exhausting the transition allowance loses optional diagnostic detail;
  it does not borrow from periodic capacity or affect audio.
- The logical ceiling is 64 MiB per trace and 192 MiB globally. A short checked-
  in arithmetic test proves the normal six-hour/eight-listener cadence fits;
  version 1 does not need a general capacity-planning subsystem.
- Physical usage includes the database, indexes, WAL, SHM, the dedicated SQLite
  temp directory, and bounded diagnostic logs. The collector uses a dedicated
  volume and stops accepting new reports at a 256-MiB admission threshold or
  when host free space falls below 1 GiB. One already-started transaction or
  logical whole-trace purge may create bounded SQLite maintenance overshoot;
  this threshold is not described as a filesystem quota. A filesystem project-quota
  integration is not required for this small optional store. It never shares
  the State authority volume or coordinated-backup scratch path.
- Exceeding any budget drops
  diagnostics with a visible bounded reason; it never evicts or blocks State
  authority.
- An active trace ends no later than six hours after start. Server diagnostic
  retention is a fixed 48 hours after its terminal timestamp in version 1.
  Purge deletes a complete trace projection; one bounded purge receipt may
  remain for its finite replay horizon, and hash-only prior request tombstones
  prevent conflicting UUID reuse without retaining trace state. Diagnostic data
  is not promoted into significant game history before a separate reviewed
  contract exists.
- A full, unavailable, or purging diagnostic store returns a stable degraded
  outcome. The browser continues local observation and audio playback.

The finite ingestion outcomes are `accepted`, `replayed`, `sharing_disabled`,
`trace_inactive`, `not_authorized`, `report_invalid`, `report_too_large`,
`report_conflict`, `rate_limited`, `quota_exhausted`, and
`collector_unavailable`. Producers do not branch on free-form messages.

## Deployment and lifecycle boundary

- Compose defines an unprivileged diagnostics service and dedicated volume with
  ordinary memory, PID, temporary-storage, and application-level store limits.
  Access, State, Game readiness, audio services, backup, retention, release, and
  rollback do not depend on collector readiness.
- Game diagnostic proxy calls have bounded connect and response deadlines and
  do not share gameplay transactions. Optional operator status reports the
  collector separately as `healthy`, `degraded`, `unavailable`, or `unknown`.
- Coordinated backup and restore contain exactly Access and State authority.
  Restore proves authority readiness before an empty diagnostics store may be
  created. Collector deletion or an incompatible diagnostics schema causes only
  the disposable diagnostic volume to be atomically abandoned/recreated.
- Release preflight verifies scoped credential fingerprints, exact collector
  schema compatibility, and the pinned publisher/relay interface version for a
  release that enables diagnostics. An incompatible diagnostic store is
  abandoned and recreated rather than failing application promotion or
  rollback. Rollback may retain a compatible store or discard it; diagnostic
  state cannot raise the State rollback floor or block application rollback.
- Local Compose rehearsal covers collector absence, hung ingestion, quota/full
  disk, schema incompatibility, purge, volume deletion, and cleanup while the
  complete S2-D gameplay, listener fencing, backup/restore, and rollback gates
  remain unchanged.

## Privacy and disclosure contract

Allowed diagnostic data is an exact schema, not an open logging envelope.

Never place in diagnostic payloads, persistence, exports, or application/proxy
logs:

- PCM or derived audio capable of reconstructing content;
- Spotify URI, track title, artist, album, artwork, or pre-reveal answer data;
- invitation, session, source, relay, or provider credentials;
- display name, email, principal ID, player ID, IP address, full user agent, or
  persistent device/browser identifier;
- arbitrary exception messages, URLs, query strings, headers, or log lines; or
- free-form notes in the machine diagnostic payload.

Reverse-proxy and collector access logging use an exact allowlist that excludes
client address, URL/query, headers, grants/server context, and bodies. Operational events
contain only finite endpoint, outcome, and aggregate-count codes.

The system promises absence of direct identity fields, not anonymity. Ephemeral
instance identifiers, role, browser family, timing, and run context are
pseudonymous and may be linkable by an authorized host familiar with the game.
This limitation is disclosed before upload. Game may transiently associate the
authenticated principal while authorizing a report, but it does not forward or
persist that association in diagnostics.

Member-facing local diagnostics expose only that browser's observations and
safe current stream status. Cross-listener comparison and source/relay details
require host/operator authorization. Copyable reports have `member` and
`operator` projections from one shared allowlist. Any retained report that fails
schema, semantic, privacy, or canonical validation projects only
`{status:'unavailable', reason:'invalid_retained_report'}`; malformed fields are
never mapped individually or echoed. A valid source or relay report requested
by a member projects the separate finite `not_authorized` result.

Explicit purge appends one privacy-safe operational event containing only
timestamp, finite outcome, trace ID, and row count. Routine host reads are not
individually audited in this small private deployment. Neither path records a
report body, credential, IP address, URL, or free-form text.

The advanced UI must label what will be copied before copying. Copy is a local
user action, not an implicit support upload.

## Local diagnostic experience

An advanced, non-primary audio panel provides:

- current connection, buffer, context, and signal-health summaries;
- a bounded timeline of transitions and the last 15 minutes of windows;
- upload state (`current`, `degraded`, `offline`, or `disabled`);
- a copyable privacy-projected report; and
- copy of one local report for manual support when upload is unavailable; and
- a reset action that rotates the listener instance without changing playback
  or server authority.

The primary game UI continues to show only actionable S2-D states. Diagnostic
classification cannot silently trigger a reconnect, change buffer policy,
pause Spotify, or switch to local playback.

## Comparison contract

The comparison engine is a pure, versioned function over aligned summaries. It
returns evidence, not control actions. At minimum it distinguishes:

| Evidence pattern | Permitted result |
| --- | --- |
| source capture/publish gap precedes relay and all listeners | `source_suspected` |
| source remains regular; relay ingress/fan-out degrades for all listeners | `relay_suspected` |
| source and relay remain regular; one listener has receive gaps | `listener_delivery_suspected` |
| delivery remains regular; one buffer trends to zero or overflows | `listener_buffer_suspected` |
| delivery/buffer remain regular; context suspends or long tasks align | `browser_output_suspected` |
| clocks, windows, or required components do not align | `insufficient_evidence` |

Ordering-dependent results use the synchronization intervals defined above.
Receipt order, sequence values from different instances, or overlapping
uncertainty intervals cannot establish precedence. Every result includes the
contributing window references, mapping/uncertainty evidence, missing evidence,
and confidence enum. It never embeds raw input or arbitrary prose.

## Performance contract

- Worklet diagnostics add only fixed scalar counter updates on the render path;
  serialization and report construction remain off it.
- Main-thread sampling performs no per-audio-frame work and wakes no more than
  once per second outside explicit state transitions.
- Diagnostic rendering is closed by default and must not create a high-rate
  React state update loop.
- Local synthetic tests enforce buffer and request-size bounds, absence of
  unbounded queues, and no extra underruns under the deterministic test stream.
- Before UI/upload wiring, a deterministic worklet harness exercises render,
  classification, buffer transitions, reset, and teardown. A focused browser
  harness covers one normal attempt, one reconnect, background suspension,
  unsupported APIs, reset, upload failure, and teardown. This is a fixed
  scenario set, not a browser-simulation framework.
- Producer isolation tests hold collector lookup/ingest indefinitely and prove
  unchanged source authority-poll cadence, lease fail-close timing, publisher
  state, relay fan-out, and listener delivery.
- Local gates require the configured ring/request bounds and zero
  instrumentation-induced underruns in the deterministic stream. S2-F records
  browser memory, CPU, scheduling, startup, upload rate, and underrun deltas on
  the few supported real clients. Numeric performance limits are fixed from
  those measurements before production enablement rather than building a local
  benchmarking framework that poorly predicts the phones used at game night.

## Risk-weighted implementation discipline

S2-E checkpoints are scoped to one consistency boundary, not one user-facing
feature. Design is a guardrail and record of consequential decisions;
implementation is also a legitimate way to test an isolated design. Review
effort therefore follows consequence:

- **A — isolated:** pure functions, bounded local state, and disposable
  diagnostic helpers may proceed after a primary design pass identifies their
  inputs, outputs, invariants, bounds, and exclusions.
- **B — boundary-bearing:** identity, consent, privacy, durable replay, storage,
  routes, and secrets may have an unwired pure model built early, but require
  independent design and implementation closure before integration.
- **C — irreversible/external:** migration, destructive retention, backup,
  rollback, provider effects, and host operations require independent design
  closure before implementation and fault/recovery rehearsal before use.

A checkpoint may consume a previously verified boundary, but it may not claim
the consumer and producer are composed until a test crosses their real
interface. Every checkpoint has these shared entry and exit rules:

1. Before isolated implementation, publish its owner, inputs/outputs, major
   invariants, finite failures, bounds, and exclusions. Complete state,
   identity/epoch, atomicity, privacy, and recovery rules before the boundary
   that needs them is integrated.
2. Build tests for each applicable semantic branch and consequential boundary.
   Stale-response, interruption, retry, reset, and teardown matrices are
   mandatory only where the interface can produce those schedules.
3. Test the real interface at least once. A pure model cannot verify a
   MessagePort, HTTP, SQLite, React, process, or host boundary on its own.
4. Compare every status/documentation claim to a named executable test. A
   property without direct evidence is `implemented; verification pending`, not
   `verified`.
5. Run a targeted independent closure audit before attaching the next consumer
   or data producer. An independent pre-code audit is additionally mandatory
   for C work and for B integration, but not for an isolated model.

The closure evidence record for each checkpoint contains: invariant IDs; test
names; the exact source/tree identity; negative schedules exercised; applicable
resource results; privacy fields reviewed; deferred measurements with their
S2-F owner; and an honest status from the checkpoint template. Exact commit/tree
identity is required for closure evidence, not for a mutable draft reviewing
itself. Status advances through the template's risk-class, scope, decision, and
implementation-authorization fields.

## Proportional design closure gate

Each E1-E12 checkpoint publishes one specification packet using the
[S2-E checkpoint specification template](s2-e-checkpoint-spec-template.md),
scaled to its risk class. Before an A implementation candidate or an unwired B
model begins, the packet fixes the boundary, owner, inputs/outputs, major
invariants, finite failure results, scale limit, dependency firewall, and
planned tests. Before B integration or any C implementation it includes all of
the following applicable artifacts:

1. **Boundary map:** the sole owner, trusted and untrusted inputs, output and
   side-effect surfaces, downstream consumers, explicitly excluded concerns,
   and the exact interface at which composition will later be tested.
2. **Executable data contract:** plain-object requirements, own-property rules,
   normalization and canonical encoding, identity spelling, exact required and
   optional fields, per-field semantic operator, range and unit, nested privacy
   classification, malformed-retained-data policy, and every cross-field truth
   relationship. A list of fields without its relational truth table is not a
   complete schema.
3. **Lifecycle and interruption model:** legal states and edges, epoch or
   generation ownership, atomicity/linearization point, idempotency identity,
   and the result of interruption before and after each effect. It explicitly
   covers stale response, exact retry, conflicting reuse, concurrent call,
   reset, rotation, restart, timeout, cancellation, and teardown.
4. **Failure and resource model:** finite errors; unknown, unsupported, and not
   applicable semantics; logical and physical bounds; queue/backoff policy;
   degraded/read-only behavior; cleanup ownership; and proof that the diagnostic
   path cannot become an authority or availability dependency.
5. **Privacy walk:** recursively inspect every field of ingestion, persistence,
   member copy, host/operator read, audit event, error, and log projections.
   Classifying only a containing object never authorizes all nested fields.
6. **Evidence design:** invariant IDs; complete small tables for consequential
   finite authority/privacy/lifecycle domains; hand-written adversarial
   schedules where the domain is not finite; the
   retained reference/baseline; the real-interface composition test; resource
   measurement; and the exact documentation claim each test can support.
7. **Dependency firewall:** a checkpoint may consume only previously verified
   semantics. Later-stage fields are opaque or stubbed. Its focused test command
   must not execute a later checkpoint's validator, reducer, store, or adapter
   and then borrow that green result as current evidence.

For B integration and C implementation, the specification packet receives an
independent adversarial design review. Reviewers attempt the applicable subset
of: inherited and non-plain input;
alternate identity spelling; reordered canonical input; impossible cross-field
values; nested privacy bypass; stale epoch; lost response; exact and conflicting
retry; concurrent/reset/restart schedules; unsupported API; quota/cleanup
failure; and a green test whose name claims more than its assertions. A finding
changes the specification and tests. Isolated implementation may discover
ordinary details; it pauses for renewed design review only when the discovery
changes an authority owner, persistent schema, privacy/retention exposure,
external-effect order, rollback/recovery model, or resource-isolation class.

Tests are written from invariant IDs as implementation proceeds. The
implementation cannot silently weaken the packet to make them pass. Ordinary
clarifications are updated with code and tests and reviewed at closure;
boundary-changing discoveries follow the pause rule above.

## Predictable-failure matrix by checkpoint

The following questions are mandatory before a checkpoint is consumed,
integrated, or called locally verified. For A and unwired B models, they may be
resolved jointly through specification, implementation, and closure review.

| Checkpoint | Must close before consumption or integration |
| --- | --- |
| E1 | Plain/own JSON shape; lowercase canonical identities; exact per-kind envelopes and transitions; semantic operators such as ordinal, window sum, window aggregate, point, and instance cumulative; byte/frame/channel and signal truth tables; nested member/operator privacy; one validated copy/export wrapper; all-kind replay/conflict; malformed retained-read policy; and an E1 validator that does not execute E2 alignment or E3 diagnosis. |
| E2 | Exact E1-core/E2-wrapper boundary; physically possible clock inequalities and interval formula; Game/State-derived authority; one-active-trace lifecycle; consent start/stop versus accepted replay; trace/run/lease/generation rotation; unrelated timebases; and fail-closed stored interval mapping. No diagnostic PKI. |
| E3 | Versioned health derivation from validated report fields; no caller-authored component, health, interval, or timebase labels; uncertainty-aware overlap and precedence; contradictory/missing evidence; exact contributing references; confidence semantics; and exhaustive classification plus `insufficient_evidence` matrices. |
| E4 | Epoch-tagged MessagePort request/reply shapes; one atomic snapshot-and-rotate operation; acknowledgement and stale-message handling; reset during buffering, render, underrun, and re-prime; fixed sampling/aggregation definitions; overflow and teardown; pre-instrumentation playback baseline; allocation and render-path bounds; and no lost or cross-epoch observations. |
| E5 | Once-only ordered attempt milestones; reconnect only after a new attempt; background sleep and timer-throttling coverage; visibility transitions; unsupported versus observed zero; structured finite errors; abort/retry/reset races; old worklet replies; and cleanup of every timer, observer, reader, node, listener, and AudioContext on every exit. |
| E6 | Closed-panel subscription/render behavior; recursively projected copy shape; pseudonymous-field disclosure before copy; clipboard failure; accessibility announcement cadence; reset acknowledgement without playback mutation; malformed local data; bounded export; and proof that UI state is never measurement authority. |
| E7 | Canonical disposable schema identity; transactional ingest/idempotency; WAL/busy/crash schedules; fixed row/byte/free-space caps; 48-hour retention and whole-trace purge; startup recovery; backup exclusion; disposable rollback; and collector absence from authority readiness. |
| E8 | Fixed browser/source/relay/host/Game/maintenance caller matrix; server-derived run/lease/generation binding; trusted server clock; request identity and response-loss replay; consent-generation races; delayed old-generation reports after handoff; bounded errors; and proof diagnostic failure cannot share a gameplay transaction. |
| E9 | Exact finite source snapshot and local privilege boundary; monotonic counter/reset identity; reporter queue/backoff/drop semantics; credential rotation; malformed/hung collector; source/controller restart; no log or raw-error scraping; and unchanged authority poll cadence, lease fail-close, provider sequencing, and publisher state. |
| E10 | Exact finite relay snapshot; generation creation and immutable binding; delayed old-generation reports; handoff/fence ordering; listener fan-out/backpressure counters; reporter queue and credentials; relay/collector restart; no peer/IP/path leakage; and unchanged audio delivery under collector failure. |
| E11 | The five fixed source/relay/delivery/buffer/output classifications derived only from E1-E3; missing/contradictory evidence; host/member reads; purge and cleanup; and real-interface composition rather than simulator constants. |
| E12 | Exact local evidence inventory; measurement-only S2-F responsibilities; image/release/host identity; interruption/reboot/restore/rollback schedules; credential and resource cleanup; acceptance thresholds fixed before rehearsal; and an explicit route back to the owning E checkpoint when reality disproves the model. |

## Revised implementation sequence

The scale filter is part of the design, not an invitation to re-add machinery
during implementation:

| Checkpoint | Retained because it protects a game night | Explicitly omitted in version 1 |
| --- | --- | --- |
| E2 | one active trace, consent, server-derived correlation, simple server-time interval | PKI, public verification keys, offline aligned comparison, general capabilities |
| E3 | five fixed suspicion patterns plus `insufficient_evidence` | rule engine, query language, extensible diagnosis plugins |
| E4 | atomic worklet snapshot/reset and a deterministic PCM check | generic cross-thread framework or comprehensive audio simulator |
| E5 | normal, reconnect, background, unsupported, reset, failure, teardown scenarios | general browser/clock simulation framework |
| E6 | one advanced panel and clearly labeled local copy | dashboard builder, automatic support upload, multi-report offline diagnosis |
| E7 | optional sidecar, separate SQLite volume, simple caps, 48-hour retention | project-quota integration, configurable retention service, per-read audit ledger |
| E8 | fixed browser/source/relay/host/Game/maintenance routes | arbitrary scopes, delegation, policy language, assertion infrastructure |
| E9/E10 | one finite snapshot and low-priority reporter task per producer | separate reporter processes unless real measurements require them |
| E11 | one host view and five deterministic injected faults | general observability UI or open-ended fault lab |
| E12 | measurements on the actual few supported devices/hosts | broad device certification or fleet-scale capacity program |

Execution resumes at E2. The archived pre-spec prototype remains outside the
active branch and supplies no checkpoint evidence. E2 and E4 both require verified E1. E4 may then proceed without verified
E2-E3 because it consumes neither authority nor comparison semantics. E5
requires verified E4; E6 requires verified E1 and E5; E7-E12 proceed in the
numbered order. No collector work begins merely because a local report can
already be rendered.

### E1 — Measurement vocabulary and privacy schema

Status: `locally-verified`. The bounded six-shape implementation, systematic
finite matrices, full web build/suite, and three-perspective independent closure
review are recorded in the detailed packet. E1 supplies no E2 authority or
timing claim.

Detailed specification packet:
[E1 measurement vocabulary and privacy](s2-e-e1-measurement-spec.md).

Publish only the six exact E1 measurement cores; precise field semantics including
identity, ordinal, constant, window sum, window aggregate, point sample,
instance cumulative, interval, and transition; finite enums; numeric ranges;
versioned signal thresholds and relational truth tables; member/operator and
copy/export projections; and canonical encoding/idempotency identity. Generated
tests reject unknown fields,
cross-semantic substitutions, prohibited data, malformed values, and conflicting
identity reuse. No timing alignment, diagnosis, storage, browser wiring, or
producer integration is in this checkpoint.

Exit gate: every field eligible for persistence or copy has one executable
semantic, relational, and recursive privacy rule; the validated export wrapper
is defined; and all-kind exact replay/conflict behavior passes. E6 later proves
that the browser copy action consumes this boundary without bypassing it.

### E2 — Synchronization and correlation authority

Status: `locally-verified` at `df41d2c`. The isolated pure timing/authority model
and lifecycle reducers passed focused E1+E2 verification (30/30) and independent
three-perspective closure with no open P0/P1. E7 persistence and E8 authenticated
HTTP/State integration remain separate, unverified boundaries.

Detailed specification packet:
[E2 synchronization and correlation authority](s2-e-e2-correlation-spec.md).

Implement the one-active-trace lifecycle, forward-only listener consent, Game-
derived run/role/lease correlation, relay-generation binding, and the simple
collector-timebase round-trip mapping. Tests cover impossible timing, stale
trace/lease/generation, consent stop versus accepted replay, unrelated
timebases, and report reordering. There is no diagnostic PKI, public-key
distribution, or offline signed-sample verification. This checkpoint produces
stored aligned intervals for uploaded reports; it does not classify health.

Exit gate: no caller can author run/lease/trace/role authority, and every mapped
interval is derived by Game/collector from a physically possible authenticated
sample or fails closed.

### E3 — Evidence derivation and comparison reducer

Status: `locally-verified` at `9075294`. The isolated pure classifier and
fixed-table tests passed independent timing/provenance, rule-truth, and
contract/evidence closure. Persistence, routes, UI, and producer integration
remain later checkpoints.

Detailed specification packet:
[E3 evidence derivation and comparison](s2-e-e3-comparison-spec.md).

Build one version-1 pure comparison function for the five evidence patterns in
this contract. It accepts only validated E1 reports and E2 envelopes; it never
accepts caller-authored health/component labels. A finite table test proves the
positive cases and that missing, contradictory, overlapping, or unaligned
evidence returns `insufficient_evidence`. No rule engine or query language is
introduced.

Exit gate: every diagnosis is reproducible from contributing validated report
references and carries its interval/uncertainty evidence.

### E4 — Worklet core and atomic cross-thread protocol

Status: `locally-verified` at `bf4d760`. The bounded protocol in
[E4 worklet core and atomic MessagePort](s2-e-e4-worklet-spec.md) passed design
and three-perspective implementation closure behind an unattached public
wrapper. E5 may now consume that exact port; production remains on the retained
baseline until E5 itself closes.

Instrument the PCM core without React, fetch, or upload. Add one small epoch-
tagged MessagePort protocol for configure, PCM, atomic snapshot-and-rotate, and
stop/reset. Use the actual worklet wrapper and a deterministic harness covering
normal render, one underrun/re-prime, overflow, stale reply, reset, and teardown.
Compare PCM output to the retained pre-instrumentation baseline.

Exit gate: observations cannot be lost or cross epochs; attempt-independent
worklet events are coherent; allocation/storage bounds pass; and the deterministic
baseline shows zero instrumentation-induced underruns or PCM divergence.

### E5 — Browser attempt and window lifecycle

Status: `locally-verified` at `087b8ea`. The bounded design, exact closure
identity, and evidence are maintained in [E5 browser attempt and window
lifecycle](s2-e-e5-browser-lifecycle-spec.md). Three independent final reviews
found no open P0/P1. E5 deliberately excludes React/UI, copying, upload,
persistence, and production attachment; E6 may now consume the verified session.

Implement the listener attempt state, 10-second accumulator, visibility/
suspension observation, unsupported-API states, 15-minute ring, and instance
rotation without UI. A focused harness uses fake fetch/AudioContext/MessagePort
for normal playback, one failed/retried stream, background suspension, reset,
unsupported API, and teardown. It composes through the real adapter and E4.

Exit gate: milestones occur once in legal order, reconnect begins only with a
new attempt, suspended coverage is not silently discarded, unsupported does not
mean healthy zero, and every exit releases its observers, timers, streams, node,
and AudioContext.

### E6 — Local UI, copy, and rendering isolation

Status: `locally-verified` at `b0596f2`. The bounded local-only design is maintained
in [E6 local diagnostics UI and copy](s2-e-e6-local-ui-spec.md). It consumes
only verified E1/E5 surfaces and adds no upload, persistence, comparison, or
diagnostic service.

Attach the verified E5 model to the advanced local panel while upload remains
disabled. Rendering subscriptions activate only while the panel needs live
display; collection remains bounded independently of React. Copy uses the E1
member projection and discloses pseudonymous identifiers, role, browser, timing,
and stream behavior before the local user action. Reset is composed through the
acknowledged E4/E5 epoch transition.

Exit gate: component tests prove closed-panel render isolation, accurate copy
disclosure/projection, reset without playback mutation, accessible status
behavior, and bounded report export.

### E7 — Isolated collector and physical store

Status: `E7.2 and E7.3 locally verified`. The transactional and bounded
retention/read increments are closed.
The optional private process, image, volume, and Compose isolation are
implemented and closure-verified. The independently reviewed bounded
storage design is maintained in
[E7 isolated collector and store](s2-e-e7-collector-store-spec.md).

Add the disposable collector/store and dedicated volume in three increments:
transactional SQLite core, bounded retention/read behavior, then optional
service/Compose isolation. Implement exact idempotency, fixed
row/byte/free-space caps, 48-hour retention, host projection, whole-trace purge,
and degraded/read-only behavior. E7 accepts only a stubbed trusted internal
caller; E8 owns real Game/maintenance credentials and State-derived authority.
Game/State/audio readiness, backup, and rollback do not depend on diagnostics.

Exit gate: process/SQLite/Compose tests prove caps, retention/purge, restore
exclusion, disposable-schema recreation, separate mounts/resources, and no
collector dependency in authority readiness. The real two-credential caller
matrix, bounded Game proxy behavior, collector hang/loss effects on Game/audio,
and unchanged S2-D behavior remain E8 gates.

The E7.3 HTTP adapter is a loopback/private-topology test seam and is not
production-enabled or authorized until E8. Production enablement requires E8's distinct Game and
maintenance credentials, exact caller matrix, request/body deadlines, and
State-derived authority mediation.

### E8 — Game/State mediation and consent routing

Status: `E8.1, E8.2, E8.3a, E8.3b, and E8.3c locally verified`.

The contained implementation sequence and current gate are maintained in
[E8 diagnostic mediation](s2-e-e8-mediation-spec.md).

Wire trace management, listener opt-in, source authority lookup, relay-generation
binding, host reads, and forward-only consent through Game. Test the real HTTP
boundaries and the small fixed caller matrix: browser, source, relay, host,
Game-to-collector, and maintenance. No source or relay reporter is attached yet.

Exit gate: correlation is server-derived, exact replays retain their original
finite result, revoked unseen work is rejected, and ingestion failure cannot
change gameplay or playback transactions.

### E9 — Source diagnostic interface and isolated reporter

Status: `E9.1 and E9.2 locally verified`.

Implement and pin the finite publisher snapshot interface, then attach one
low-priority bounded reporter task using E8 authority. Audio and authority-poll
paths do constant-time counter updates only and never wait for diagnostics.

Exit gate: stable-interface, credential, malformed-response, hung-collector,
restart, queue-bound, and no-free-form-output tests pass without changing source
poll cadence, lease fail-close behavior, or publisher state.

### E10 — Relay diagnostic interface and isolated reporter

Status: `E10.0, E10.1, and E10.2 independently closed`.

Implement and pin the finite relay-generation snapshot interface and attach one
low-priority bounded reporter task. Bind a generation once at start and never
rebind delayed work after handoff.

Exit gate: generation, fencing, fan-out, backpressure, credential, restart, and
hung-collector tests pass without changing relay delivery or S2-D isolation.

### E11 — Comparison experience and composed local fault injection

Status: `locally verified; independent closure review complete`.

Add one host comparison view over E3/E7. Inject one deterministic fault at each
of the five modeled boundaries, plus one missing/contradictory evidence case.
Verify member privacy, host read, trace purge, collector absence, and cleanup.

Exit gate: the complete local acceptance gate below passes through real
interfaces and no finding is justified solely by a pure-model test.

### E12 — S2-F handoff

Hand the verified local package to S2-F for the real controller, the few
supported phones/browsers, relay timing, restart, installation, and cleanup.
Failed real measurements return to the owning E1-E11 boundary rather than being
waived in rehearsal notes.

Detailed specification packet:
[E12 real-environment rehearsal](s2-e-e12-real-environment-spec.md). Its
external Droplet, provider-tag/firewall and public-egress mutations; Tailscale
ephemeral node/auth-key/certificate creation (including Certificate
Transparency hostname publication and any separately required tailnet-policy
or HTTPS change); temporary Spotify authorization; and exact destructive
cleanup require a separate exact-resource operator approval before execution.

## Local acceptance gate

S2-E is locally complete only when all of the following are executable:

- two listeners sharing a source/relay trace can be compared, and injected
  faults at each modeled boundary produce the expected bounded classification;
- missing or contradictory evidence returns `insufficient_evidence`;
- local reports remain available when ingestion is absent, slow, full, or
  rejects a report;
- duplicate, reordered, malformed, oversized, and over-quota reports fail or
  replay according to the contract without affecting audio or State;
- E1 privacy projection tests cover every retained/copied field and a sentinel
  scan finds no prohibited content or direct identity;
- collector loss and diagnostic-store deletion leave gameplay, recovery,
  history, backup/restore, and rollback gates unchanged;
- a hung collector leaves source authority polling, lease behavior, publisher
  state, relay fan-out, and listener delivery unchanged;
- trace/host reads and listener/source/relay uploads pass the fixed caller matrix,
  while maintenance can only status/purge;
- common-timebase reports compare using interval uncertainty, while unrelated or
  overlapping mappings return `insufficient_evidence`;
- the advertised six-hour/eight-listener cadence fits the row/byte caps, and a
  near-cap store degrades before the host free-space reserve is crossed;
- configured buffer, upload, and retention bounds pass locally; real CPU/memory
  and scheduling measurements remain S2-F;
  and
- the S2-D source-handoff and listener-generation suites remain green.

## S2-F handoff decision

The S2-E/S2-F boundary is decided field by field rather than by producer:

- S2-E defines and locally proves schemas, the fixed caller matrix, correlation,
  interval comparison, producer interfaces, nonblocking isolation, deterministic
  browser/worklet behavior, configured bounds, cleanup, and safe degradation.
- S2-F measures those already-defined properties on supported real browsers,
  audio hardware, the real controller/Spotify path, and the packaged relay host.
  It measures CPU, memory, scheduling, startup, underrun deltas, clock-sample
  uncertainty, revocation timing, real filesystem reserve behavior, shaped-
  network classification, capacity, restart, and installation/cleanup.
- S2-F may tune numeric budgets within a reviewed compatible contract. It may
  not invent authority, schema, privacy, routing, correlation, or failure-
  isolation semantics. A measurement that disproves the local model returns the
  work to S2-E rather than weakening the gate in rehearsal.

Real Spotify effects, hardware audibility, supported-browser performance,
empirical synchronization uncertainty, real network shaping, packaged-host
resource behavior, and maximum game-night capacity therefore remain legitimate
S2-F evidence gates. Stable interfaces, deterministic timing representation,
routing, local isolation, and capacity arithmetic do not.

## Non-goals

- hosted observability or third-party analytics;
- personal or cross-session player profiles;
- raw per-frame or raw-audio telemetry;
- automatic buffer tuning, drift correction, or transport replacement;
- using diagnostics to infer gameplay authority or provider outcome; and
- retaining diagnostic data as authoritative game history.
