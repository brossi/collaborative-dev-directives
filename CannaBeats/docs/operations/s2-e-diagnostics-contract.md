# S2-E listener, source, and relay diagnostics contract

Status: proposed design contract for the S2-E implementation checkpoint. No
S2-E implementation or acceptance outcome is complete until the executable
gates in this document pass.

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
  command, history, and retention state.
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

- Browser reports enter through Game. Game authenticates the current principal,
  rechecks current listener authority, replaces all authority labels with its
  own projection, and forwards the bounded envelope using a collector-ingest
  credential that can only write listener summaries.
- When State returns source work, it may issue a short-lived diagnostics
  assertion containing only issuer, audience, `source_summary` scope, trace,
  source instance, run, expiry, and nonce. The source uses that assertion with
  the collector; its long-lived source credential is never sent to diagnostics.
- The pinned relay adapter uses a distinct `relay_summary` credential and may
  report only the active opaque relay generation assigned by the collector.
- Host reads pass through Game after current host authority is checked. Operator
  reads use a distinct read-only diagnostics credential. Neither credential can
  ingest, purge, or mutate authority.
- Retention uses a purge-only credential. No diagnostic credential is accepted
  by State, Access, Game mutation routes, the relay audio path, or source command
  routes.
- All configured diagnostic credentials and assertion keys must be nonempty and
  pairwise distinct from every existing service/source/relay credential.

Assertions are versioned, audience-bound, scope-bound, short-lived, and replay
bounded. They are not general bearer capabilities. Collector endpoints are not
publicly routed except for the Game proxy used by authenticated listeners.

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
        └── summarySequence (monotonic within that listener instance)
```

- All identifiers are opaque UUIDs and are scoped to the current run or process
  instance. None is a device identity.
- A listener instance rotates on page reload, explicit stop/start, or run
  replacement. It is not stored in a cookie or durable browser storage.
- The server derives `runId`, diagnostic trace, coarse role, source association,
  and relay generation from authenticated authority. Caller-supplied values for
  those fields are rejected rather than corrected silently.
- Windows carry monotonic elapsed offsets and durations. Client wall-clock time
  is never treated as ordering authority. The collector records `receivedAt`.
- Cross-host clock offset and uncertainty are measured during S2-F; until then,
  comparisons use server receipt time, monotonic sequence, and overlapping
  windows rather than pretending clocks are exact.

## Trace lifecycle and consent

- Local listener measurement starts only when that browser enables shared audio
  and ends on listener stop, run replacement, or page teardown.
- Local measurement and the copyable local report require no collector.
- Server upload is disabled by default. A user enables diagnostic sharing from
  the advanced local panel for the current listener instance. A host can invite
  participants to share but cannot silently enable another browser.
- Starting an uploaded trace is a host action in the diagnostic plane. It does
  not change room revision or State. The trace has a maximum six-hour lifetime
  and a visible active/ended status.
- Source and relay summaries are collected only while an uploaded trace exists
  and managed playback is active. Ending the trace stops new ingestion without
  stopping playback.
- The UI states that bounded technical summaries—not audio or player identity—
  are being shared, and offers an immediate stop-sharing action.

## Versioned report envelope

Every input uses one exact top-level shape:

```text
schemaVersion: 1
kind: listener_window | listener_transition | source_window |
      source_transition | relay_window | relay_transition
instanceId: UUID
sequence: safe nonnegative integer
monotonicStartMs: bounded nonnegative number
durationMs: bounded positive number
measurements: exact kind-specific object
```

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
Each 10-second window may contain only the following typed measurements:

- connection timing: request start, response headers, first PCM bytes, buffer
  primed, and first audible frame, all as bounded elapsed milliseconds;
- delivery: received bytes and frames, chunk count, mean/max chunk gap,
  reconnect count, and a finite terminal/error category;
- buffer: current/min/max/mean depth in milliseconds, linear depth trend,
  underrun count and duration, re-prime count, overflow/discarded-frame count,
  and reset count;
- clocks: source sample rate, output sample rate, and bounded resampling ratio;
- browser state: `AudioContext` state, coarse base/output latency when exposed,
  visibility/suspension transitions, and long-task count/max duration;
- signal aggregates: RMS range, peak range, and clipped-frame count. PCM,
  spectral data, fingerprints, song identity, and sample windows are forbidden;
  and
- coarse context: `host`, `player`, or `group_display`; browser family and
  major version; OS family; browser/PWA mode; and listener implementation
  version. No full user agent is retained.

Missing browser APIs produce explicit `unsupported` or `unknown` fields. Zero
must not be used to imply that an unavailable measurement was observed healthy.

The client also emits coalesced transition summaries for first playback,
underrun, reset, reconnect, context suspension/resume, terminal stream failure,
and listener stop. Repeated identical transitions within one second coalesce.

## Source and relay observation contract

Source summaries use the same diagnostic trace and bounded windows. They may
include:

- captured, encoded, and published frames/bytes;
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

Relay summaries never include IP addresses, bearer tokens, request URLs, user
agents, or unbounded transport errors. The relay adapter must consume a stable
machine interface from the pinned relay; it may not scrape arbitrary log text.

## Upload and storage bounds

- Normal upload cadence is one summary every 10 seconds. An exceptional
  transition may upload immediately, with a maximum of one accepted report per
  listener instance per second.
- Each request is at most 16 KiB and one schema version. Unknown fields,
  non-finite numbers, out-of-range values, invalid enum members, and excess
  nesting fail the entire request with a stable error.
- `(listenerInstanceId, summarySequence)` is the idempotency key. Exact replay is
  accepted; conflicting reuse is rejected.
- The browser retains at most 15 minutes or 256 KiB of local summaries,
  whichever is reached first. It retains at most one unsent aggregate during
  upload backoff; it does not queue an unbounded retry journal.
- The collector accepts at most 32 listener instances, eight concurrently
  sharing listeners, and 16,384 summaries per run, plus one source and one relay
  summary stream per active generation.
- Collector admission caps stored diagnostic payload at 32 MiB per run and
  512 MiB globally in addition to row limits. Exceeding a budget drops
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

## Privacy and disclosure contract

Allowed diagnostic data is an exact schema, not an open logging envelope.

Never collect or transmit:

- PCM or derived audio capable of reconstructing content;
- Spotify URI, track title, artist, album, artwork, or pre-reveal answer data;
- invitation, session, source, relay, or provider credentials;
- display name, email, principal ID, player ID, IP address, full user agent, or
  persistent device/browser identifier;
- arbitrary exception messages, URLs, query strings, headers, or log lines; or
- free-form notes in the machine diagnostic payload.

Member-facing local diagnostics expose only that browser's observations and
safe current stream status. Cross-listener comparison and source/relay details
require host/operator authorization. Copyable reports have `member` and
`operator` projections from one shared allowlist. Unknown persisted values map
to `unknown` or are omitted; they are never passed through.

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
| source and relay remain regular; one listener has receive gaps | `listener_network_suspected` |
| delivery remains regular; one buffer trends to zero or overflows | `listener_buffer_suspected` |
| delivery/buffer remain regular; context suspends or long tasks align | `browser_output_suspected` |
| clocks, windows, or required components do not align | `insufficient_evidence` |

Every result includes the contributing window references, missing evidence,
and confidence enum. It never embeds raw input or arbitrary prose.

## Performance contract

- Worklet counters are constant-memory and aggregated off the render path.
- Main-thread sampling performs no per-audio-frame work and wakes no more than
  once per second outside explicit state transitions.
- Diagnostic rendering is closed by default and must not create a high-rate
  React state update loop.
- Local synthetic tests enforce buffer and request-size bounds, absence of
  unbounded queues, and no extra underruns under the deterministic test stream.
- The initial profiling budgets are at most 2 MiB additional steady-state
  browser memory per listener, 2 KiB/s average diagnostic upload, two percentage
  points additional CPU, 2 ms additional p95 main-thread scheduling delay, and
  zero instrumentation-induced underruns in the deterministic local stream.
- S2-F measures those same CPU, memory, scheduling, startup, and underrun deltas
  on supported real clients. Until those measurements pass, the design may be
  locally implemented but not described as negligible-overhead in the real
  environment.

## Implementation sequence

1. Publish versioned schemas, finite enums, range validators, privacy
   projections, and the pure comparison model with generated adversarial tests.
2. Add worklet/browser counters and the bounded local ring. Prove the advanced
   local report works with upload disabled before building ingestion.
3. Add the isolated diagnostics collector/store, authenticated Game ingestion,
   idempotency, quotas, retention, and read-only host/operator projections.
4. Add source summaries, then a stable relay diagnostic adapter. Neither may
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
- buffer, memory, upload, wakeup, and retention bounds are measured locally;
  and
- the S2-D source-handoff and listener-generation suites remain green.

Real Spotify, relay-host, network-shaping, supported-device overhead, and
capacity observations remain S2-F gates. They validate this contract; they do
not substitute for its local safety and privacy tests.

## Non-goals

- hosted observability or third-party analytics;
- personal or cross-session player profiles;
- raw per-frame or raw-audio telemetry;
- automatic buffer tuning, drift correction, or transport replacement;
- using diagnostics to infer gameplay authority or provider outcome; and
- retaining diagnostic data as authoritative game history.
