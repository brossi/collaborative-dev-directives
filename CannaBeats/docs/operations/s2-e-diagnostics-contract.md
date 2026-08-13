# S2-E listener, source, and relay diagnostics contract

Status: revised design contract for the S2-E implementation checkpoint. This
revision addresses the pre-implementation authority, timing, privacy, producer,
capacity, and verification ambiguities found by the first adversarial design
audit. No S2-E implementation or acceptance outcome is complete until the
executable gates in this document pass.

This contract defines a bounded diagnostic plane for locating managed-audio
quality failures. It consumes the S2-D stream, lease, handoff, and recovery
boundaries without becoming another source of game or playback authority.

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
and readiness endpoint. It receives no State activation, operator, source, Game,
Access, relay, or browser bearer credential.

- Browsers never call the collector. Game exposes bounded listener endpoints
  for trace status, listener-instance opt-in, upload stop, listener report ingest, and
  authorized trace read. Game authenticates the current principal on every
  call, resolves the run and role through State, discards caller authority
  labels, and uses separate collector capabilities for trace management,
  listener ingestion, and host reads.
- A host may create or end one active trace for an authoritative run through
  Game. Game supplies the run authority and an idempotency key. The collector
  returns an opaque trace ID and synchronization anchor; it does not infer a run
  from report data. Because the deployment has one managed publisher and relay,
  only the run holding that authority may have an active source/relay trace. A
  competing request returns `trace_busy`; local-only listener reporting remains
  available.
- Source reports use the existing public Game source path, not a direct
  collector route. The controller creates an ephemeral source instance at
  process start. For each report, Game first exact-validates and canonicalizes
  the complete source envelope without changing it, then sends its digest and
  source bearer to State's separate diagnostic-assertion operation. State
  verifies the source owns the live lease/work context and returns a short-lived
  assertion binding issuer, audience, `source_summary` scope, run ID, run
  generation, source-instance ID, active lease ID, exact report sequence and
  digest, optional current command reference, expiry, and nonce. It contains no
  stable source identity or command payload. Game forwards the unchanged
  canonical envelope and assertion using `source_ingest`. The collector is the
  authoritative signature, digest, nonce, expiry, and replay verifier.
- The relay adapter reports through a dedicated authenticated Game relay
  endpoint using a relay-to-Game credential distinct from `relay_ingest`. At a
  publisher-generation start, the adapter supplies only the opaque generation
  observed from the pinned relay interface. Game calls State's Game-scoped
  `/v1/diagnostics/managed-stream-authority`, which requires no principal and
  returns only the current managed run ID/generation and lease correlation.
  Game resolves the active trace and creates one immutable generation binding.
  The generation is transport observation, not State authority; it cannot be
  rebound after a handoff. Later reports reference only that binding. Delayed
  reports for an old generation remain attributed to the old binding or are
  rejected after it ends. No run, trace, lobby, source, or lease label from the
  relay is accepted. Collector or State failure leaves the generation unbound
  and produces missing diagnostics without rejecting or delaying relay audio.
- Host reads pass through Game. State must attest that the principal is the
  durable host of the requested run, including after that run ends. Current
  lobby membership alone is insufficient. If State cannot make that historical
  assertion, the read fails closed. Access may continue after run termination
  or history retention only while State retains enough authority evidence to
  make that exact run-host assertion.
- Operator reads use a separately deployed read-only operations client and
  credential. Retention uses a purge-only credential. Their caller bearer
  values are not mounted in Game, State, the source controller, or relay; the
  collector stores only salted verification hashes and key IDs.
- No diagnostic credential is accepted by State, Access, Game mutation routes,
  the relay audio path, or source command routes.

The collector capability matrix is exact:

| Capability | Permitted operations |
| --- | --- |
| `trace_manage` | create/end/status for a Game-attested run |
| `listener_ingest` | write listener reports to one active trace |
| `source_ingest` | write source reports with a valid work-bound assertion |
| `relay_ingest` | write relay reports with a valid generation/run assertion |
| `host_read` | read one State-authorized trace projection |
| `operator_read` | read bounded operator projections only |
| `diagnostic_purge` | delete expired or explicitly selected trace sets |

The corresponding version-1 seams are fixed before implementation:

| Boundary | Operations |
| --- | --- |
| Browser → Game | `/api/diagnostics/trace`, `/api/diagnostics/listener-instance`, `/api/diagnostics/listener-report`, `/api/diagnostics/report`, `/api/diagnostics/stop-sharing` |
| Source → Game | `/api/diagnostics/source-report` |
| Relay adapter → Game | `/api/diagnostics/relay-generation`, `/api/diagnostics/relay-report` |
| Game → State | `/v1/diagnostics/run-host-authority`, `/v1/diagnostics/managed-stream-authority`, `/v1/source/diagnostic-assertion` |
| Game/operations → collector | versioned internal trace, ingest, read, and purge endpoints partitioned by the capability table above |

All mutations require canonical request UUIDs. Exact replay returns the same
finite result; conflicting identity reuse fails. These routes may evolve only
through a reviewed whole protocol version, not by silently widening version 1.

Game-to-collector and operations-to-collector capabilities are random opaque
bearers held only by callers; the collector stores salted verification hashes,
current/previous key IDs, scopes, and audiences. State source assertions use a
dedicated asymmetric key: State alone holds the private signing key, while Game
and collector receive its public verification key. Synchronization anchors use
a separate collector private signing key; browser comparison code receives the
versioned public verification keys. The relay-to-Game credential is distinct
from Game's collector credential. Deployment preflight compares nonreversible
fingerprints and fails on any collision without distributing unrelated
plaintext secrets. Opaque capabilities use a two-key verification window;
asymmetric verification keys remain published through the longest retained
report lifetime plus clock-skew allowance. Expired keys cannot authorize new
traces or reports, but retained signatures remain verifiable.

Assertions are versioned, issuer-bound, audience-bound, scope-bound, and valid
for at most 30 seconds. Source assertions bind one report instance, sequence,
and canonical envelope digest. First use atomically records the nonce and
digest; exact retry returns `replayed`, while any differing reuse returns
`report_conflict`. Relay bindings are similarly generation- and trace-scoped.
Renewal requires fresh State authority. Assertions are not general bearer
capabilities, and the collector is never publicly routed.

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
- Each producer obtains independent signed synchronization samples on one trace
  timebase. A sample contains `timebaseId`, `anchorSampleId`, trace ID,
  `serverReceiveMs`, `serverSendMs`, issued-at, valid-from, valid-until, maximum
  server processing bound, signature algorithm, and key ID. The producer records
  `localSendMs` immediately before the request and `localReceiveMs` immediately
  after the response on its monotonic clock; client wall time is never used.
- For local time `L`, the server-time offset lies in
  `[serverReceiveMs - localSendMs, serverSendMs - localReceiveMs]` after ordering
  the two bounds. The mapped event interval adds that full offset interval to
  the local monotonic start/end. `anchorUncertaintyMs` is half the resulting
  interval width and must not be smaller than half the local round trip after
  subtracting the signed server-processing interval. The exact schema stores
  the four timestamps and derived bounds rather than an ambiguous point offset.
- Different producers and renewals normally have different `anchorSampleId`
  values. Cross-producer comparison requires the same `timebaseId`, individually
  valid signatures and event-time validity, and uncertainty below the schema
  maximum; it never requires the same sample ID. The collector records
  `receivedAt`, which is transport evidence and not event-time truth.
- The comparator may say that A preceded B only when A's latest possible end is
  earlier than B's earliest possible start. Overlap, expired anchors, excessive
  uncertainty, or reports without a common valid timebase produce
  `insufficient_evidence` for ordering-dependent classifications.
- Anchor validity is evaluated at the report event/upload time. Once an accepted
  report was mapped using a then-valid sample, later sample expiry does not
  invalidate retained comparison. Copied reports include the signed public
  sample, derived interval, algorithm/key ID, and uncertainty, while public
  verification keys remain available for the copied-report retention period.
  Reports without a common timebase remain individually useful and may be
  imported together, but cannot establish cross-device precedence.

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
  assertion; authority loss atomically ends or rejects the trace then. A quiet
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

## Versioned report envelope

Every uploaded input uses one exact top-level shape:

```text
schemaVersion: 1
kind: listener_window | listener_transition | source_window |
      source_transition | relay_window | relay_transition
instanceId: UUID
sequence: safe nonnegative integer
alignment: anchored synchronization-sample reference and derived interval
monotonicStartMs: bounded nonnegative number
durationMs: bounded positive number for windows; exactly 0 for point transitions
measurements: exact kind-specific object
```

Local/copy reports use the same measurement schemas but an exact alignment
union: `anchored` contains the verified sample and interval above; `unanchored`
contains only a finite reason (`collector_absent`, `sharing_disabled`,
`anchor_unavailable`, or `anchor_invalid`). Collector ingestion accepts only
`anchored`. Unanchored reports remain locally useful but cross-device ordering
is always `insufficient_evidence`.

The correlation assertion is carried separately from the measurements. The
collector stores its validated claims alongside the report and records its own
receipt time. Producers cannot add tags, labels, dimensions, arbitrary metadata,
or nested extension bags. Schema evolution adds a newly accepted whole version;
it never weakens validation of an existing version.

All counters are per-instance cumulative counters or explicit window deltas as
declared by the schema; a field cannot switch meanings between producers. The
collector rejects decreasing cumulative counters except at an explicit new
instance boundary.

## Listener observation contract

The audio worklet produces aggregate counters using constant memory and no
per-frame object allocation. The main thread owns a bounded ring of summaries.
Attempt milestones live in `listener_transition.measurements`; a transition is
a point event with `durationMs: 0`. Each 10-second listener window may contain
only the window/state fields below:

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
- coarse context: `host` or `member`; browser family and
  major version; OS family; browser/PWA mode; and listener implementation
  version. No full user agent is retained.

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
The client also emits coalesced transition summaries for first playback,
underrun, reset, reconnect, context suspension/resume, terminal stream failure,
and listener stop. Repeated identical transitions within one second coalesce.

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
time counter increments. A separate bounded reporter task or process snapshots
and uploads with a strict deadline, one replaceable aggregate, and no retry
journal. Collector DNS, connection, timeout, or rejection cannot run on or await
the authority polling, capture, publisher, or fan-out loops.

Relay summaries never include IP addresses, bearer tokens, request URLs, user
agents, or unbounded transport errors. The relay adapter must consume a stable
machine interface from the pinned relay; it may not scrape arbitrary log text.

## Upload and storage bounds

- Normal upload cadence is one summary every 10 seconds. An exceptional
  transition may upload immediately, with a maximum of one accepted report per
  listener instance per second.
- Each request, including its assertion, is at most 8 KiB; its validated
  canonical persisted envelope is at most 2 KiB and contains one schema
  version. Unknown fields,
  non-finite numbers, out-of-range values, invalid enum members, and excess
  nesting fail the entire request with a stable error.
- `(traceId, kind, instanceId, sequence)` is the idempotency key for every report
  kind. Exact replay is accepted; conflicting reuse is rejected. Request UUIDs
  protect proxy mutations but do not replace producer sequence idempotency.
- The browser retains at most 15 minutes or 256 KiB of local summaries,
  whichever is reached first. It retains at most one unsent aggregate during
  upload backoff; it does not queue an unbounded retry journal.
- One six-hour trace supports at most eight listener instances concurrently.
  The periodic pool is 24,000 rows per run: 17,280 listener windows and 4,320
  source/relay windows fit within it, leaving 2,400 rows of reserve. A separate
  transition pool is 8,768 rows, for 32,768 total reports per run. Each producer
  also has a 1,024-transition cap per listener instance and 1,024 per source or
  relay generation. A trace accepts at most 32 total listener instances, 32
  source instances, and 64 relay generations. Unused quota from one kind does
  not permit another kind to exceed its bound.
- With a 2 KiB canonical envelope, the logical ceiling is 64 MiB per run and
  384 MiB globally. A generated worst-case storage worksheet must cover accepted
  envelopes, indexes, tombstones, and SQLite overhead and prove the advertised
  six-hour/eight-listener case before these constants can change.
- Physical usage includes the database, indexes, WAL, SHM, temp files, and
  diagnostic logs. The collector uses a dedicated volume with a 768 MiB physical
  ceiling enforced by the deployment's filesystem/project quota rather than a
  logical counter alone, preserves at least 256 MiB inside that allocation plus
  a configured 1 GiB host free-space reserve, bounds WAL/temp/log growth, and rejects new
  diagnostics before either reserve is crossed. It never shares the State
  authority volume or coordinated-backup scratch path.
- Exceeding any budget drops
  diagnostics with a visible bounded reason; it never evicts or blocks State
  authority.
- Server diagnostic retention defaults to 7 days and is configurable from 1 to
  30 days. Purge deletes a complete run-scoped diagnostic set. Diagnostic data
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
  explicit CPU, memory, PID, temporary-storage, and physical-store limits.
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
client address, URL/query, headers, assertions, and bodies. Operational events
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
`operator` projections from one shared allowlist. Unknown persisted values map
to `unknown` or are omitted; they are never passed through.

Operator reads and explicit purges append privacy-safe audit events containing
only timestamp, capability key ID, finite operation/outcome, trace ID, and row
count. They contain no report body, assertion, credential, IP address, URL, or
free-form text.

The advanced UI must label what will be copied before copying. Copy is a local
user action, not an implicit support upload.

## Local diagnostic experience

An advanced, non-primary audio panel provides:

- current connection, buffer, context, and signal-health summaries;
- a bounded timeline of transitions and the last 15 minutes of windows;
- upload state (`current`, `degraded`, `offline`, or `disabled`);
- a copyable privacy-projected report; and
- strict local import/compare of two or more copied reports when collector
  upload is unavailable; and
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
contributing window references, anchor/uncertainty evidence, missing evidence,
and confidence enum. It never embeds raw input or arbitrary prose.

## Performance contract

- Worklet counters are constant-memory and aggregated off the render path.
- Main-thread sampling performs no per-audio-frame work and wakes no more than
  once per second outside explicit state transitions.
- Diagnostic rendering is closed by default and must not create a high-rate
  React state update loop.
- Local synthetic tests enforce buffer and request-size bounds, absence of
  unbounded queues, and no extra underruns under the deterministic test stream.
- Before the browser UI or upload path is wired, the worklet accumulator and
  ring bookkeeping are extracted into an importable pure core. A deterministic
  AudioWorklet harness exercises render quanta, silence/clipping classification,
  buffer transitions, reset, and allocation bounds. A browser lifecycle harness
  exercises attempt rotation, reconnect, visibility, suspended contexts,
  unsupported APIs, upload failure, reset-without-audio-stop, and teardown.
- Producer isolation tests hold collector lookup/ingest indefinitely and prove
  unchanged source authority-poll cadence, lease fail-close timing, publisher
  state, relay fan-out, and listener delivery.
- The initial profiling budgets are at most 2 MiB additional steady-state
  browser memory per listener, 2 KiB/s average diagnostic upload, two percentage
  points additional CPU, 2 ms additional p95 main-thread scheduling delay, and
  zero instrumentation-induced underruns in the deterministic local stream.
- S2-F measures those same CPU, memory, scheduling, startup, and underrun deltas
  on supported real clients. Until those measurements pass, the design may be
  locally implemented but not described as negligible-overhead in the real
  environment.

## Implementation sequence

1. Publish the capability/endpoint matrix, trace/attempt state machines,
   producer assertion profiles, synchronization-anchor format, versioned report
   schemas, finite enums, range validators, privacy projections, capacity
   worksheet, and pure interval-aware comparison model with generated
   adversarial tests.
2. Extract and test the pure worklet accumulator/ring and browser lifecycle
   harness, then add worklet/browser counters and the bounded local ring. Prove the advanced
   local report works with upload disabled before building ingestion.
3. Add the isolated diagnostics collector/store and dedicated physical volume,
   authenticated Game ingestion, idempotency, logical/physical quotas,
   retention, and read-only host/operator projections.
4. Implement and pin the stable nonblocking source and relay diagnostic
   interfaces, then add their isolated reporter tasks. Neither may
   parse free-form logs or receive authority database write access.
5. Add the advanced comparison view and copyable member/operator reports.
6. Run local deterministic fault injection at source, relay, delivery, buffer,
   and browser-output boundaries; verify classification, privacy, and resource
   bounds.
7. Hand the complete package to S2-F for real controller/browser/relay timing,
   supported-client performance, restart, capacity, and cleanup evidence.

Each step is checkpointed and audited before the next data producer is added.

## Local acceptance gate

S2-E is locally complete only when all of the following are executable:

- two listeners sharing a source/relay trace can be compared, and injected
  faults at each modeled boundary produce the expected bounded classification;
- missing or contradictory evidence returns `insufficient_evidence`;
- local reports remain available when ingestion is absent, slow, full, or
  rejects a report;
- duplicate, reordered, malformed, oversized, and over-quota reports fail or
  replay according to the contract without affecting audio or State;
- generated privacy tests cover every input and output field and find no
  prohibited string, identifier, metadata, or high-cardinality label;
- collector loss and diagnostic-store deletion leave gameplay, recovery,
  history, backup/restore, and rollback gates unchanged;
- a hung collector leaves source authority polling, lease behavior, publisher
  state, relay fan-out, and listener delivery unchanged;
- trace/host reads, producer uploads, key rotation, assertion replay/expiry, and
  every cross-capability request pass an exhaustive allow/deny matrix;
- common-timebase reports compare using interval uncertainty, while unrelated or
  overlapping anchors return `insufficient_evidence`;
- the advertised six-hour/eight-listener envelope fits the physical quota with
  reserve, and forced DB/WAL/temp/log growth degrades diagnostics before host
  reserve is crossed;
- buffer, memory, upload, wakeup, and retention bounds are measured locally;
  and
- the S2-D source-handoff and listener-generation suites remain green.

## S2-F handoff decision

The S2-E/S2-F boundary is decided field by field rather than by producer:

- S2-E defines and locally proves all schemas, capabilities, correlation,
  interval comparison, stable producer interfaces, nonblocking isolation,
  deterministic browser/worklet behavior, logical and physical bounds, cleanup,
  and failure-safe degradation.
- S2-F measures those already-defined properties on supported real browsers,
  audio hardware, the real controller/Spotify path, and the packaged relay host.
  It measures CPU, memory, scheduling, startup, underrun deltas, clock-anchor
  uncertainty, revocation timing, real filesystem reserve behavior, shaped-
  network classification, capacity, restart, and installation/cleanup.
- S2-F may tune numeric budgets within a reviewed compatible contract. It may
  not invent authority, schema, privacy, routing, correlation, or failure-
  isolation semantics. A measurement that disproves the local model returns the
  work to S2-E rather than weakening the gate in rehearsal.

Real Spotify effects, hardware audibility, supported-browser performance,
empirical synchronization uncertainty, real network shaping, packaged-host
resource behavior, and production-scale capacity therefore remain legitimate
S2-F evidence gates. Stable interfaces, deterministic timing representation,
routing, local isolation, and capacity arithmetic do not.

## Non-goals

- hosted observability or third-party analytics;
- personal or cross-session player profiles;
- raw per-frame or raw-audio telemetry;
- automatic buffer tuning, drift correction, or transport replacement;
- using diagnostics to infer gameplay authority or provider outcome; and
- retaining diagnostic data as authoritative game history.
