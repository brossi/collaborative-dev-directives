# S2-E E7 isolated collector and store specification packet

## Identity and status

- Checkpoint: E7 — isolated collector and physical store
- Scope revision: `E7-spec-v1`
- Status: `E7.2 locally verified`; E7.3 is implemented with independent closure
  review pending
- Risk class: `B — boundary-bearing` for durable replay, retention, and a
  disposable SQLite schema; whole-trace purge is the only destructive edge
- Exact independently reviewed design target:
  `1311f37550f4855ad3a587796178b4dcb7c0c8ee`, tree
  `cfe16d983511fb8396491e760689afe0b04def58`
- Required verified checkpoints: E1 at `736a401`; E2 at `df41d2c`
- Explicitly excluded later checkpoints: external credentials, Game/State
  authority resolution, browser/source/relay routes, and consent transport
  (E8); source and relay reporters (E9/E10); diagnosis UI (E11); real-host
  capacity and timing (E12)
- Primary design date: 2026-08-14
- First independently audited target: commit
  `14c67b1d4082919adf3f81b08cc5b1520540b982`, tree
  `265aed33bac7b41628a6768c89089c9c84cf5e74`; verdict `revise`, no P0
- Final independent review: three focused perspectives passed on 2026-08-14
  with no open P0/P1 after the exact cursor-progression follow-up above

## Boundary map

| Item | Specification |
| --- | --- |
| Sole owner | One collector process owns one disposable SQLite file. |
| Trusted inputs | E1/E2 validators; server-derived trace/context fixtures supplied by the future E8 adapter; collector clock; configured store path and limits. |
| Untrusted inputs | All request bytes, stored rows after restart, request/report identities, query and purge selectors, filesystem usage observations, and SQLite failures. |
| State and side effects | Collector schema ledger, trace projections, canonical uploaded envelopes, exact replay receipts, aggregate quota counters, logical purge, WAL checkpoint. |
| Outputs and consumers | Finite internal results for the future E8 Game and maintenance adapters; bounded stored trace projection for E11. |
| Real interface under test | The actual `node:sqlite` store and a small internal HTTP process in increment 3. |
| Explicit non-goals | No public route, browser/source/relay credential, State lookup, generic query language, audit ledger, backup integration framework, sharding, replication, migrations of valuable data, or forensic-erasure claim. |

E7 treats E8-supplied authority as an exact finite input but does not create or
authenticate it. The isolated store may be tested with server-context fixtures;
only E8 may replace those fixtures with real Game/State facts. E7 never opens
Access or State storage and cannot affect their readiness or transactions.

## Scale filter and implementation increments

The supported deployment is one active uploaded trace, at most eight listener
instances plus one source and one relay, six hours per trace, and 48 hours of
retention after the trace ends. The store accepts at most 32 retained trace
rows, 30,000 reports per trace, and 90,000 reports globally. Three simultaneous
maximum-sized retained traces fill the report allowance; further traces fail
with `quota_exhausted` rather than evicting unexpired evidence. These limits are
intentionally fixed constants.

The smallest mechanism that protects game night is a separate SQLite file with
one writer, exact primary keys, fixed counters, and a disposable-volume policy.
Keeping diagnostic rows in State was rejected because their write cadence could
contend with authority. An in-memory-only collector was rejected because a
restart would destroy the evidence needed to diagnose the interruption.

Version 1 omits tenants, partitions, background job infrastructure, a quota
service, database migrations across incompatible diagnostic generations,
per-read auditing, and configurable retention. A measured inability to fit one
supported trace or a real need to retain more than 48 hours would justify
revisiting these omissions.

Implementation proceeds in three reviewable increments:

1. **E7.1 transactional core:** the narrow E2 envelope encode/restore extension,
   canonical schema identity, one-writer ownership, complete E2 trace/segment,
   issuance, consent, and relay-binding state, report ingest, exact
   replay/conflict, transactional counters, and startup validation. No HTTP,
   timers, purge, Compose, or credentials.
2. **E7.2 bounded retention/read:** bounded trace projection, logical whole-trace
   purge, 48-hour expiry, physical-usage degradation, checkpoint behavior, and
   restart schedules. No external authentication.
3. **E7.3 optional service isolation:** finite internal HTTP adapter, dedicated
   Compose service/volume, absence/hang/schema-incompatibility behavior, backup
   exclusion, and disposable recreation. E8 later supplies real credentials and
   authority mediation.

## Canonical schema and stored data

Schema generation 1 contains only these durable domains:

- `diagnostic_schema_generations(generation, contract_digest, applied_at)`;
- `diagnostic_store(singleton, trace_count, report_count, request_count,
  canonical_bytes, mode, degraded_reason)`;
- `diagnostic_traces(trace_id, run_id, run_generation, status, started_at,
  active_expires_at, ended_at, end_reason, purge_after, current_segment_id,
  report_revision, periodic_count, transition_count, canonical_bytes)`;
- `diagnostic_segments(segment_id, trace_id, lease_id, started_at)` with an
  immutable trace foreign key and at most 256 retained segments per trace;
- `diagnostic_issuances(sample_id, trace_id, instance_id, timebase_id,
  server_receive_ms, server_send_ms, expires_at)`; unused rows expire after 120
  seconds and an accepted report retains its complete sample only in its E2
  envelope;
- `diagnostic_consents(trace_id, listener_instance_id, generation, status,
  first_allowed_sequence, local_consent_started_ms, changed_at)`;
- `diagnostic_relay_bindings(relay_generation_id, trace_id, segment_id,
  lease_id)`; a generation is inserted once and never updated;
- `diagnostic_reports(trace_id, instance_id, sequence, row_ordinal, segment_id, kind, bucket,
  received_at, mapped_start_earliest, mapped_end_latest, core_digest,
  envelope_digest, canonical_envelope)` with primary key
  `(trace_id, instance_id, sequence)` and trace cascade deletion; and
- `diagnostic_requests(request_id, trace_id, operation, fingerprint,
  canonical_receipt, accepted_at, expires_at)` for the five exact E2 mutations
  plus E7 `trace_purge`; and
- `diagnostic_request_tombstones(request_id, fingerprint, created_at, expires_at)` for
  purged/expired E2 requests. Request IDs are globally unique across both
  tables while retained.

`accepted_at` is immutable collector receipt metadata, not authority evidence.
Replay and expiry derive from canonical receipts, trace lifecycle, and exact
expiry relationships; authorization never trusts `accepted_at`.

There is no principal, player, room, song, URI, address, user-agent, free-form
error, or credential column. `canonical_envelope` is the unchanged canonical
E2 uploaded envelope and contains the unchanged E1 encoding. It is revalidated
before acceptance and after restart/read; replay restores the stored envelope
and compares its canonical E1 core bytes to the incoming core. Digests are
SHA-256 integrity/replay aids, never substitutes for the final byte comparison. Indexes are
fixed to the one-active-trace predicate, trace/order lookup, issuance/trace/
request expiry, and request identity. A partial unique index on the literal
active status enforces one active trace in addition to the writer transaction.

Trace relations are exact: `active_expires_at = started_at + 21600000` using
checked arithmetic; active rows have null `ended_at`, `end_reason`, and
`purge_after`; an `expired` row has `ended_at = active_expires_at`, while other
ended rows have `started_at <= ended_at < active_expires_at`.
`purge_after = ended_at + 172800000`. At or after active expiry, E7's
collector-clock edge invokes the E2 authority-free expiry transition and stores
that exact logical terminal state before evaluating another operation. Every segment starts
within its trace and strictly before active expiry. End and purge are monotonic;
no retained trace identity can become active again.

A segment row remains only while it is current or is named by a retained report
or relay binding. Rotation prunes an unreferenced prior segment after advancing
the current pointer. Each report row carries the envelope's validated segment
identity as a denormalized foreign key, so startup and reads can reconcile the
complete retained segment set without a separate history ledger.

The schema ledger stores the SHA-256 digest of standard JSON encoding of
`SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE
'sqlite_%' ORDER BY type,name`; root pages and other runtime metadata are not
included. Startup accepts generation 1 only when both the ledger and recomputed
graph match. An incompatible file is reported
`schema_incompatible`; E7 never mutates it in place. E7.3 may abandon and create
a new disposable volume, but it cannot do so to Access or State files.

### Exact report and request rules

- Identities are lowercase, non-nil RFC-variant UUIDs accepted by verified
  E1/E2. The store never normalizes an alternate spelling.
- A canonical E1 core is at most 2,048 bytes and a complete canonical E2
  envelope is at most 4,096 bytes. `kind`, `instanceId`, `sequence`,
  `traceId`, and report bucket are derived from the validated envelope, never
  accepted as parallel caller labels.
- `bucket=periodic` applies to the three `*_window` kinds;
  `bucket=transition` applies to the three `*_transition` kinds.
- A first listener report is rate-limited when another non-replay listener row
  for the same trace/instance has collector `received_at` less than 1,000 ms
  earlier. Exact replay/conflict is decided first and is never rate-limited.
  Source and relay reporters retain their own later E9/E10 bounded queues.
- On first acceptance, `row_ordinal = trace.report_revision + 1` and the trace
  revision advances to that value in the same transaction. Exact replay and
  conflict do not advance it. `(trace_id,row_ordinal)` is unique, so the
  read-snapshot watermark is independent of mapped-time ordering.
- After complete incoming-envelope validation, exact replay looks up
  `(traceId,instanceId,sequence)` before current consent/trace decisions. The
  same canonical E1 core returns `replayed` with the originally stored envelope,
  receipt time, alignment, and context; changed kind or any other changed core
  byte returns `report_conflict`. Incoming alignment/context never rewrite a
  replayed row.
- Report ingest has no request receipt. The five E2 operations and E7
  `trace_purge` have one canonical command fingerprint and exact canonical
  result receipt. Exact request replay returns the stored finite result;
  conflicting reuse across any operation returns `request_conflict`.
- A request command is fully validated/canonicalized before lookup. The store
  then checks the global live-receipt/tombstone identity before current
  authority or state. Live exact receipt replay returns its original result;
  an exact tombstone returns `trace_absent`; only an absent request may evaluate
  current authority and create an effect.
- E2 operation receipts are restored only through its trusted-store validator.
  The E7 purge receipt has an exact fixed schema. Any retained receipt failure
  makes the store degraded rather than replaying caller-authored JSON.
- An operation receipt is trace-scoped and byte-counted. Trace purge or
  retention removes its E2 receipts and replaces each with a hash-only request
  tombstone expiring 48 hours later. Exact same command lookup against that
  tombstone returns `trace_absent`; conflicting reuse returns
  `request_conflict`. The successful manual purge receipt remains exact until
  `purge commit + 48 hours`. Exact original-result replay is guaranteed only
  while the live receipt is retained; destructive purge/retention deliberately
  changes later retry to finite absence without allowing a second effect.
- Retained rows that fail schema, digest, envelope, identity, or counter
  reconciliation make the collector `degraded` and are never projected as
  partial valid evidence.

### Fixed store operations

E7 exposes only these internal operations to its later adapter:

| Operation | Durable inputs and result |
| --- | --- |
| `trace_start` | Verified E2 command, authority fixture, current active lookup, and issued IDs; commits active trace, first segment, and E2 receipt or returns `trace_busy`/replay. |
| `trace_end` | Verified E2 command/authority/current trace; commits terminal E2 state, `purge_after=ended_at+172800000`, and receipt. At `now >= active_expires_at`, the authority-free expiry edge first stores `ended_at=active_expires_at` with no request receipt. |
| `segment_rotate` | Verified current trace plus E2 authority fixture. Same exact lease/segment edge returns `{status: replayed, state}`; a changed lease atomically inserts the distinct issued segment, advances `current_segment_id`, and returns `{status: accepted, state}`. It has no request receipt. |
| `issuance_put` | Exact server issuance derived by E8; commits one sample lookup retained until `server_send_ms+120000`. E2 still enforces the 60-second local measurement interval. It has no replay receipt and duplicate sample identity must be byte-identical. |
| `consent_opt_in|consent_stop` | Verified E2 command/authority/current consent; commits forward-only consent and E2 receipt atomically. |
| `relay_bind` | Verified E2 command/authority plus atomically loaded generation binding; commits one immutable binding and E2 receipt. |
| `report_ingest` | Complete validated E2 envelope plus listener grant generation when applicable; performs report-identity replay first, then trace/sample/consent/binding/rate/quota decisions, then row and counters. No request receipt. |
| `trace_read` | Exact trace UUID plus optional integrity-bound structured page cursor; returns exact bounded metadata and at most 256 restored envelopes. E8 owns authorization. |
| `trace_purge` | Exact `{requestId,operation:'trace_purge',parameters:{traceId}}`; requires an ended trace, removes its complete projection, converts its E2 request identities to hash-only tombstones, and retains only its exact purge receipt for 48 hours. |
| `retention_sweep` | Collector clock only; deletes expired issuances/receipts/tombstones, expires the active trace if needed, then removes at most one trace with `purge_after <= now`. No caller-supplied cutoff and no receipt. |
| `status` | Counts, physical mode, schema generation, and one finite reason only. |

All operation commands are exact plain parsed-JSON objects, at most 8 KiB,
using E1/E2 UUID and numeric domains. The five E2 command/result receipt shapes
remain owned by E2. E7's purge command/result and read cursor are the only new
shapes:

```text
purge result: {status:"purged"|"trace_absent", traceId:uuid}
first read request: {traceId:uuid, cursor:null}
later read cursor: {
  readSessionId:uuid,
  last:{mappedStartEarliestMs:serverTimeMs,
        mappedEndLatestMs:serverTimeMs,
        kind:E1 kind, instanceId:uuid, sequence:uint}
}
read metadata: {traceId:uuid,status:"active"|"ended",startedAtMs:serverTimeMs,
  endedAtMs:serverTimeMs|null,endReason:E2 end reason|null,reportCount:uint}
```

The first page fully validates every envelope, digest, and denormalized column
for the bounded trace inside one read transaction, then creates one random
in-memory `readSessionId` holding `{traceId,maxRowOrdinal,reportCount,digest}`.
At most 16 sessions exist and each expires after five minutes or process
restart. Its first page returns that ID plus a cursor. Subsequent cursors are
exact `{readSessionId,last:{mappedStartEarliestMs,mappedEndLatestMs,kind,
instanceId,sequence}}`. The session also stores the exact last tuple returned by
the immediately preceding page. A subsequent cursor must equal that stored
tuple, not merely any row in the snapshot; the store advances it atomically only
after producing the next page. Jumping ahead, replaying an old cursor, or racing
two requests with the same cursor returns `read_expired` and invalidates the
session. A complete final page deletes the session before returning.

Every page revalidates all snapshot rows with `row_ordinal <= maxRowOrdinal`,
their derived columns, count, and digest before selecting at most 256 rows in
the fixed tuple order. New reports have larger ordinals and are excluded. Purge,
restart, expiry, corruption, or mismatch returns `read_expired`; all pages are
provisional and E11 must discard them unless a final page with `complete:true`
arrives. Empty reads return `trace_absent` for no trace and `found` with an empty
complete page for a retained trace. A seventeenth concurrent session returns
`collector_busy`; no durable read-session table or general cursor framework is
introduced.

## Invariants

| ID | Normative rule | Violation result | Owning evidence |
| --- | --- | --- | --- |
| E7-SCHEMA-001 | Ledger digest and actual schema graph exactly match generation 1. | `schema_incompatible` without mutation | fresh/open/tamper tests |
| E7-OWN-001 | One process owns one canonical database inode for its lifetime. | second owner fails finitely | same-path/alias/process tests |
| E7-INGEST-001 | Report row plus trace/global counters and canonical bytes commit in one `BEGIN IMMEDIATE` transaction. Each request-bearing E2/E7 operation commits its state and receipt in one such transaction. | no partial durable effect | injected-failure/restart tests |
| E7-REPLAY-001 | Exact report/request replay is immutable; conflicting reuse is rejected. | `report_conflict` or `request_conflict` | all-kind replay table |
| E7-QUOTA-001 | Periodic, transition, trace, receipt/tombstone, trace-byte, global-row, and global-byte limits are checked inside the writer transaction and reconciled on delete. | `quota_exhausted`; no eviction | boundary/concurrent tests |
| E7-TRACE-001 | Reports are accepted only before `active_expires_at` for the single active trace and their validated stored context names that trace/segment. At equality the trace first ends as `expired`. | `trace_inactive` | status/expiry/context table |
| E7-E2STATE-001 | Trace/segment, issuance, consent, relay binding, and E2 receipts are stored/restored exactly; delayed or restarted work cannot be rebound from current authority. | finite fail-closed result | restart and stale-generation matrix |
| E7-READ-001 | Reads fully preflight one bounded trace, then return provisional pages of at most 256 envelopes from one immutable in-memory ordinal watermark in stable `(mapped_start_earliest,mapped_end_latest,kind,instance_id,sequence)` order. Only a final complete page may be published. | `read_expired` or no partial/corrupt projection | malformed-retained/read/cursor/purge tests |
| E7-PURGE-001 | Purge atomically removes the trace, reports, segments, issuances, consents, relay bindings, and E2 receipts; only hash-only prior-request tombstones and its bounded exact purge receipt remain. Global counters reconcile in that transaction. | no partially readable trace | failure/retry/restart tests |
| E7-RET-001 | `purge_after = ended_at + 48h`; equality is eligible. Retention removes one complete eligible trace, replaces its request identities with bounded hash-only tombstones, and never touches another store. | finite failure; no cross-trace delete | cutoff and isolation tests |
| E7-PHYS-001 | New mutation admission stops at 256 MiB observed physical use or host free space below 1 GiB. The threshold permits only the explicitly bounded current transaction/maintenance overshoot and recovers after a successful fresh observation below both limits. | `collector_degraded` | injected-usage/recovery tests |
| E7-ISOLATE-001 | Collector files and service have a separate volume/runtime, are excluded from authority backup/restore/rollback, and are not a Compose readiness dependency of Game, State, Access, or audio. | collector-local failure only | E7.3 topology/configuration tests |
| E7-PRIV-001 | Store, projections, finite errors, and logs contain only the enumerated fields and never free-form input. | whole request/report rejected | recursive schema/log tests |

## Lifecycle, concurrency, and interruption matrix

The SQLite transaction commit is the sole mutation linearization point. A
request receipt, when the operation has one, is written in that same
transaction. SQLite writer ownership
serializes different requests; callers do not coordinate in memory.

| Schedule | Required durable state | Required result | Forbidden result |
| --- | --- | --- | --- |
| Failure before commit | unchanged | finite failure; same identity may retry | receipt without effect |
| Commit then response loss | row/state plus receipt when applicable | exact retry returns stored result | duplicate row/counter |
| Exact concurrent duplicate | one effect and, for request operations, one receipt | accepted plus replayed | uniqueness error/500 |
| Conflicting report identity | original row unchanged | `report_conflict` | overwrite |
| Conflicting request identity | original effect/receipt unchanged | `request_conflict` | second effect |
| Quota boundary race | the transaction that fits may commit | later transaction gets `quota_exhausted` | both exceed cap |
| Trace end versus ingest | transaction order decides | ingest accepted before end or `trace_inactive` after | report committed to ended trace |
| Stop-sharing versus unseen report | transaction order decides | accepted before stop or `sharing_disabled` after | unseen old-generation row after stop |
| Relay bind versus lease rotation | immutable binding uses the segment observed by the winning transaction | original binding or `stale_correlation` | rebind to current lease |
| Segment rotation response loss/restart | one inserted segment and advanced current pointer | same-lease retry returns the retained segment | second segment for one lease or lost prior binding |
| Issuance response loss/expiry | unused issuance remains bounded until expiry | new attempt uses a new issuance | pairing old server times with new local observation |
| Purge versus read/ingest | transaction order decides; purge invalidates read sessions | complete finalized old projection or `read_expired`/inactive | publishing provisional partial pages |
| Skipped/replayed/concurrent page cursor | read session remains exact or is invalidated | next exact page or `read_expired` | skipped rows, duplicate finalization, incomplete `complete:true` |
| Process exit after commit | committed transaction survives | replay after restart | reconstructed caller result differs |
| Process exit before commit | SQLite rollback | retry may accept | orphan counter/row |
| Busy reader/WAL checkpoint | logical data remains correct | bounded deferred checkpoint; reads remain finite | false physical-erasure claim |
| Incompatible restart | original file unchanged | `schema_incompatible` | in-place repair or authority impact |

Startup validates the complete schema and retained aggregate counters before
serving. It deletes expired unused issuances, purge receipts, and request
tombstones, lazily ends an
active trace whose `active_expires_at <= now`, and removes at most one
retention-eligible trace per bounded sweep. Normal operations repeat the active
expiry check inside their writer transaction, so a missed timer cannot extend
authority.

`diagnostic_store.mode` persists only `healthy|data_degraded`; a retained-row or
counter contradiction sets `data_degraded` and requires disposable volume
replacement. Schema incompatibility is reported before the store can be opened
for mutation. Physical pressure is recomputed status, not a durable mode, so
space recovery cannot be blocked by a stale flag.

## Failure and resource model

Finite mutation outcomes are `accepted`, `replayed`, `ended`, `purged`,
`trace_busy`, `trace_inactive`, `trace_absent`, `sharing_disabled`,
`stale_correlation`, `report_invalid`, `report_too_large`, `report_conflict`,
`request_conflict`, `rate_limited`, `quota_exhausted`, `collector_degraded`,
`collector_busy`, and `schema_incompatible`. Reads return `found`,
`trace_absent`, `read_expired`, `collector_busy`, or `collector_degraded`;
status returns `healthy` or `degraded`
with one finite reason. Internal logs contain only outcome, operation, schema
generation, and a freshly generated correlation reference; they never echo
request bodies or persistent identifiers.

Logical limits are 24,000 periodic plus 6,000 transition rows and 64 MiB of
canonical blobs per trace; 90,000 reports, 4,096 retained request records,
32 trace rows, 256 retained segments per trace, and 192 MiB of canonical blobs
globally; one active trace; 2,048
bytes per canonical E1 core; 4,096 bytes per canonical E2 envelope or receipt;
and 256 rows per read page. Envelopes, issuance records, and receipts are
byte-counted once in the global counter; trace-scoped values are also charged to
their trace. Counters do not pretend to estimate SQLite overhead.

The 4,096 request-record limit counts live receipts and tombstones together.
The store computes `cleanupObligations` as two slots for each active trace
(future end and purge), one for each ended retained trace (future purge), and one
for each enabled consent (future stop). A non-reducing request is accepted only
when `requestRecords + 1 + cleanupObligationsAfter <= 4096`. End, stop, and purge
consume a reserved obligation as they add their receipt, so an existing trace
or enabled consent can always move toward less authority even when ordinary
admission is full. Purging a trace replaces its request receipts with the same
number of tombstones and exchanges its purge obligation for the purge receipt.
An absent purge may return `quota_exhausted` when no unreserved slot remains;
it cannot block cleanup of a retained trace. The capacity worksheet uses the measured maximal
valid canonical envelope produced by the E2 prerequisite and proves the normal
21,600-window workload fits the 64-MiB trace budget; if it does not, the schema
does not ship by silently weakening a limit.

Physical admission separately sums the main DB, WAL, SHM, dedicated SQLite temp
directory, and the collector's bounded local log allocation, then observes host
free space. At 256 MiB or below the 1-GiB reserve the store rejects new traces,
effectful segment rotations, issuances, consent opt-in, relay bindings, and
report ingestion. Trace end,
automatic expiry, consent stop, logical purge, reads, and status remain
available through the reserved bounded cleanup allowance when SQLite permits
them. A report transaction
is bounded by the 8-KiB request/4-KiB envelope and fixed indexes; WAL
uses 4-KiB pages and `wal_autocheckpoint=256`. The collector log allocation is
4 MiB and the monitored temp directory allowance is 8 MiB; crossing either
stops ordinary mutation admission. The design allowance above the 256-MiB
threshold is 1 MiB for one already-started ordinary transaction and 128 MiB for
one whole-trace purge/checkpoint. Whole-trace purge may temporarily write up to
one trace's bounded pages, so 256 MiB is explicitly an admission threshold, not
a hard filesystem ceiling. E7.2 demonstrates both ceilings with a schema-level
physical surrogate or lowers the admission threshold before shipping. The local
surrogate fills generation-1 report rows with maximal-size zero blobs until the
64-MiB canonical-payload limit, then uses pinned readers to verify at most 1 MiB
of WAL growth for one committed maximal row and at most 128 MiB for cascading
trace deletion. It measures worst-case payload layout and deletion pressure; it
does not claim to exercise valid E2 envelopes, tombstone creation, the purge
receipt, or the complete collector purge operation. E12 repeats total physical
measurements through the deployed collector path and filesystem. `secure_delete`
is not required.
Logical deletion, bounded checkpoints, and disposable-volume deletion are the
only version-1 cleanup claims.

Degraded physical mode is an observed condition rather than an irreversible
database flag. Before each ordinary mutation the collector refreshes the measurement;
when usage is below 256 MiB and free space is at least 1 GiB, ordinary admission
resumes. Schema or retained-data corruption remains degraded until the volume
is replaced; it never self-repairs authoritative-looking rows.

There is no retry queue. SQLite busy waits are bounded. Once per minute and at
startup, one bounded maintenance pass deletes all expired issuances, request
tombstones, and purge receipts with counter reconciliation, applies automatic
expiry, and removes at most one retention-eligible trace. With at most 32 trace
rows, retention cleanup lag is at most 32 minutes after eligibility while the
process is running. A failed request returns
one finite result and the future E8 gateway decides whether to retry. Retention
runs one bounded trace at a time and records no general job history.

## Privacy walk

- Ingestion and persistence: exact E2 envelope plus derived identity, bucket,
  digest, byte count, and collector receipt time.
- Member copy: not an E7 surface; E6 remains the only member copy boundary.
- Host/operator read: exact validated stored envelopes and finite trace metadata;
  E8 authorizes and E11 renders them.
- Maintenance: status counts/mode/reason and whole-trace purge result only; no
  report bodies.
- Errors and logs: finite codes and ephemeral correlation reference only. A
  purge tombstone may retain the opaque trace UUID in the database for replay,
  but operational logs do not retain it.
- Prohibited everywhere: names, account/player/room IDs, room codes, songs,
  URIs, PCM, IPs, full user agents, credentials, arbitrary exception text, and
  caller-authored labels outside the E1/E2 envelope.

## Dependency firewall

E7 may consume only verified E1 byte validation/canonicalization and the E2
uploaded-envelope encode/trusted-store restoration boundary. The first E7.1
change adds that narrow pure API with E2 tests before SQLite uses it; it does not
change E2 authority or timing decisions. E7 may not import E3-E6, Game routes, State, Access,
React, source, relay, or operations tooling.

The E7.1 focused command will run only E1, E2, and collector-store tests. E7.2
adds store lifecycle tests. E7.3 alone runs the collector process and Compose
isolation checks.

## Evidence and claim ledger

| Claim | Invariants | Required negative schedules | Permitted status wording |
| --- | --- | --- | --- |
| E7.1 core | SCHEMA, OWN, INGEST, REPLAY, QUOTA, TRACE, E2STATE, PRIV | schema tamper, second writer, rollback injection, lost response, consent/relay/restart races, exact/conflicting concurrency, cap ±1 | `transactional core locally verified`; no service/integration claim |
| E7.2 retention/read | READ, PURGE, RET, PHYS | corrupt row, max read, cutoff equality, purge/read race, busy checkpoint, restart | `bounded disposable store locally verified`; no auth claim |
| E7.3 isolation | ISOLATE plus prior invariants | absent/full/incompatible/deleted collector process and volume, resolved-volume collision, label/refusal disposal, backup/restore/rollback topology | `optional collector topology locally verified`; no E8 integrated caller/failure-injection or caller-authority claim |

## Design-review decision

- Findings: the first independent audit found report-identity drift, incomplete
  E2 durable state, conflated lifetime/retention, unbounded receipts, an
  unproved envelope cap, and overstated physical-limit language. This revision
  resolves them with fixed tables, separate clocks, bounded receipt tombstones,
  an E2-owned 4-KiB envelope boundary, and an honest admission threshold.
- Open blockers: none for E7.1/E7.2 design; independent implementation closure
  evidence remains pending.
- Approved implementation scope: E2 complete-envelope encode/restore and
  retained-state restoration/expiry prerequisites, followed by the unwired
  E7.1 transactional SQLite core and focused tests.
- Explicitly prohibited implementation scope: E8 routes/credentials/authority,
  E9/E10 producers, E11 diagnosis UI, E12 measurements.
- Decision: `designed`
- Packet linked from normative checkpoint: yes
- Every `Not applicable` names its owning checkpoint: yes
- Dependency-firewall review passed: yes
- Predictable-failure matrix resolved: yes
- No open P0/P1 design finding: yes
- Implementation authorized at this E7.1/E7.2 design checkpoint: yes, E7.1
  and E7.2; the later E7.3 section records its separate authorization

## E7.1 implementation record

The implemented increment is intentionally unwired. It adds the E2-owned
canonical complete-envelope and trusted-store restoration surfaces, a separate
`diagnostics-service` generation-1 SQLite schema, canonical schema-graph
attestation, canonical-path plus inode lifetime ownership, and an internal
transactional collector. The collector implements trace start/end and automatic
expiry, receipt-free segment rotation and issuance insertion, consent and relay
binding receipts, six-kind report ingest, exact report/request replay and
conflict, fixed logical counters, and complete startup reconciliation.

The focused evidence currently covers all six E1/E2 report families, complete
envelope tamper and size rejection, exact operation/state restoration,
same-path/symlink/hard-link/cross-process owner exclusion, schema tamper,
retained-row corruption, receipt replay/conflict across restart, segment and
consent/relay restart recovery, deterministic expiry, injected report-write
rollback, and counter reconciliation. The focused command is:

```sh
node --test web/tests/s2e-e1-contract.test.mjs \
  web/tests/s2e-e2-correlation.test.mjs \
  diagnostics-service/tests/*.test.mjs
```

This record does not claim an authenticated service, retention/purge/read
support, physical-pressure behavior, Compose isolation, or real-host capacity.
Those remain assigned to E7.2, E7.3, E8, and E12 as specified above. The
permitted status before an independent closure audit is only `E7.1 implemented;
closure review pending`.

## E7.2 implementation record

### Retained-state closure matrix

Governing invariant:

> Every accepted E7.2 operation and retained mutation leaves a complete,
> immutable, restart-valid trace projection, or the collector returns and
> durably records its finite degraded result.

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: `startTrace` rejects a trace UUID still named by a retained purge receipt; schema uniqueness rejects live duplicates. |
| Update | `schema`: report, segment, issuance, relay-binding, request, and tombstone authority rows are immutable; trace lifecycle/revision/counters are monotonic; only named trace/consent transitions update. |
| Delete | `runtime + schema`: one transaction deletes the whole trace domain; FK cascades and exact counter reconciliation prevent partial deletion. |
| Omit | `runtime`: `validateTraceProjection` requires the complete child graph and exact report ordinals `1..report_revision`. |
| Duplicate | `schema`: fixed primary/unique keys cover trace, request, report identity, segment/lease, issuance, consent, and relay generation. |
| Reorder | `runtime`: immutable row ordinals are contiguous; read sessions bind an ordinal watermark and the exact immediately preceding sort tuple. |
| Replay | `runtime`: exact report/request identity returns the retained original result before current-state evaluation. |
| Conflict | `runtime + schema`: changed bytes under a retained identity fail before effects; live/tombstoned request identities cannot overlap. |
| Concurrency | `runtime`: one `BEGIN IMMEDIATE` writer transaction owns lookup, validation, effect, counters, and receipt. |
| Expiry | `schema + runtime`: exact timestamp relationships are constrained and revalidated; before/equality/after behavior is deterministic. |
| Restart | `runtime`: startup runs FK, canonical-byte, denormalized-field, child-graph, ordinal, receipt, lifetime, and counter reconciliation. |
| Dependency failure | `structural`: E7.2 is unwired and has no external dependency; E8 owns authenticated caller failures. SQLite failures become finite collector results. |
| Corruption | `runtime`: every trusted-store restoration/canonicalization failure routes through `dataFail`; reads publish nothing until a final complete page. |
| Capacity | `schema + runtime`: fixed trace/report/request/segment/byte limits and cleanup reservations; physical admission and schema-level WAL surrogate ceilings are tested. |

The matrix is the E7.2 test source. A passing representative fixture does not
replace deletion, gap, identity-reuse, expiry-equality, response-loss, restart,
and relationship-preserving corruption schedules.

E7.2 adds exact purge commands and retained purge receipts, whole-trace deletion,
hash-only request tombstones, startup and explicit retention sweeps, issuance and
receipt expiry, at-most-one-trace retention, validated provisional reads, and
bounded in-memory cursor sessions. Every page revalidates both the complete
current trace and the immutable ordinal-bounded snapshot. Cursor progression is
exact; jump-ahead, replay, expiry, restart, trace mutation, corruption, and
purge fail closed without a publishable partial projection.

Ordinary mutation admission now observes the database/WAL/SHM physical total,
host reserve, and injected bounded temp/log measurements. Exact replay is
decided before the pressure gate, while end, consent stop, purge, reads, status,
and passive-checkpoint maintenance remain available. Physical recovery is
recomputed rather than durably latched. Dedicated temp/log allocation and
service topology remain E7.3 work.

Current evidence covers non-mutating incompatible-file rejection, foreign-key
and exact retained-graph reconciliation, mechanically bounded request and
tombstone lifetimes, the 256-segment ceiling, cutoff equality, two simultaneously
eligible traces
with one removal per sweep, startup retention, active-purge refusal,
failure-before-purge-commit rollback, exact purge replay across restart,
tombstone and purge-receipt expiry, 257-row paging, late out-of-order inserts,
cursor jumps/replays, the 16-session bound, session expiry, corruption before
the first page and between pages, purge invalidation, a pinned WAL reader, exact
pressure admission including segment rotation, schema-level ordinary/cleanup
WAL surrogate ceilings, cleanup under pressure, and pressure recovery. The
implementation remains unwired. Targeted independent transaction/lifetime,
retained-read/corruption, and physical-boundary reviews found no open P0/P1;
the permitted status is `E7.2 closure review passed; checkpoint bookkeeping
pending`. No HTTP, credential, Compose, authority-resolution, or operator-UI
claim is made.

Post-matrix remediation verification: diagnostics `21/21`; combined E1/E2/E7
`53/53`; full Web production build and tests `248/248`; lint has zero errors and
one pre-existing E5 unused-parameter warning. `git diff --check` passes.

## E7.3 topology and isolation design

Governing invariant:

> The diagnostic process and its disposable files may be absent, unhealthy,
> full, incompatible, or deleted without changing gameplay authority, audio
> delivery, backup, restore, or rollback readiness.

### Exact version-1 boundary

E7.3 adds one `diagnostics` Compose-profile service built from
`diagnostics-service/Dockerfile`. It runs as an unprivileged read-only
container, owns only `/diagnostics`, and listens only on the private Compose
network. It has no published host port and no `depends_on` edge in either
direction. Its fixed process interface is:

| Request | Result | Claim |
| --- | --- | --- |
| `GET /live` | `200 {status:"live"}` | The HTTP process can answer; no store-health claim |
| `GET /ready` | `200 {status:"ready"}` or `503 {status:"degraded",reason}` | The generation-1 store opened and its bounded status is healthy |
| `GET /v1/status` | exact bounded E7 status projection | Private topology/test seam only; no authorization claim |

Every other method or path returns one constant `404` response. Request bodies
are never read. E7.3 exposes no trace, issuance, consent, relay, report, read, or
purge operation. E8 later adds authenticated fixed routes and may consume the
same collector owner in process; it may not reinterpret these three endpoints
as authority.

The service owns one `DiagnosticCollector`, one HTTP server, one 60-second
maintenance timer, and fixed signal handlers. Startup validates the complete
store before binding the port. Schema incompatibility or retained corruption
exits without serving readiness. Shutdown stops acceptance, clears the timer,
closes the server, closes SQLite and its ownership locks, and then exits.
Because the interface has no streaming or mutation request in E7.3, bounded
shutdown requires no request-drain framework.

Compose fixes the deployment shape:

- dedicated `cannabeats_diagnostics_data` volume mounted only at
  `/diagnostics`;
- database `/diagnostics/cannabeats-diagnostics.sqlite` and ownership locks
  `/diagnostics/.locks`;
- read-only root filesystem, `node` user, init, all capabilities dropped, and
  `no-new-privileges`;
- 256 MiB memory, 0.25 CPU, 64 PIDs, 32 MiB general `/tmp`, and an 8 MiB
  diagnostics temp tmpfs;
- Docker JSON log rotation of four 1-MiB files, satisfying the E7 log
  allocation structurally rather than by parsing its own logs;
- a loopback healthcheck against `/ready`; and
- no application, State, Access, backup, restore, history, operator, migration,
  or audio service mount or dependency.

The service never deletes an incompatible store. Disposal is an explicit
operator action affecting only the diagnostics volume. Before SQLite opens,
one shared runtime preflight validates that the resolved diagnostics, Access,
and State volume names are all distinct. The same validator is used by the
targeted disposal command, which additionally requires the exact Compose
project and logical-volume labels and refuses an attached volume. Starting with
a missing or newly recreated volume creates a fresh generation-1 store.
Coordinated backup and restore continue to name exactly Access and State; the
diagnostics volume is neither an input nor an output.

### E7.3 closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: startup creates only a missing/empty generation-1 database in the dedicated volume; an incompatible nonempty file fails before listen. |
| Update | `structural`: E7.3 exposes status only; maintenance delegates to the verified E7.2 transaction boundary. |
| Delete | `runtime`: the process deletes no store; `dispose-volume.mjs` revalidates distinct resolved names, exact project/logical-volume labels, and zero attachments before deleting only the named diagnostics volume. |
| Omit | `runtime`: readiness is available only after `DiagnosticCollector` startup validation; status never substitutes for a complete trace read. |
| Duplicate | `runtime`: the E7 ownership lock prevents a second owner of the same database; Compose defines one service instance. |
| Reorder | `not_applicable`: E7.3 introduces no externally accepted mutation or paged read. |
| Replay | `not_applicable`: all three GETs are read-only; E8 owns mutation replay over HTTP. |
| Conflict | `runtime`: resolved diagnostics/Access/State volume-name aliasing, incompatible schema, or a second owner fails before the port binds. |
| Concurrency | `structural`: one process owns one synchronous collector; status and maintenance do not introduce a second writer. |
| Expiry | `runtime`: one bounded startup sweep and one 60-second timer call the verified E7.2 retention operation; timer overlap is impossible in the synchronous process. |
| Restart | `runtime`: every process start reopens and fully validates the retained store before readiness. |
| Dependency failure | `structural`: there is no upstream dependency; no other service depends on diagnostic health or existence. |
| Corruption | `runtime`: startup corruption fails before bind; a retained-data failure reached by maintenance latches degraded status; arbitrary out-of-band live-file tampering is detected on restart rather than by turning each health probe into a full-store scan. E7.3 has no report read surface from which to publish partial data. |
| Capacity | `runtime`: collector admission owns the physical threshold; Compose supplies the named container/tmpfs/log limits, and missing/full service remains optional to every authority and audio path. |

### Predictable schedules and evidence

The implementation tests must cover:

- healthy process liveness/readiness/status and constant unknown-route behavior;
- incompatible store, retained corruption, and second-owner startup before bind,
  plus a maintenance-reached retained-data failure latching degraded readiness;
- startup sweep, one timer sweep, signal shutdown, and restart with retained
  healthy data;
- deleted/missing volume recreation without touching Access or State data;
- diagnostics/Access/State resolved-volume name collisions refusing before the
  store opens, and disposal refusing wrong labels or an attached volume;
- rendered Compose profile, private networking, exact mounts, security/resource
  limits, healthcheck, and absence of every forbidden dependency;
- backup/restore manifests and services continuing to exclude diagnostics; and
- unavailable, stopped, and degraded diagnostics while existing Game, State,
  backup, restore, rollback, and audio readiness definitions remain unchanged.

Docker-unavailable environments may prove the rendered topology statically but
cannot claim container lifecycle closure. The local E7.3 checkpoint requires a
real container build/start/health/stop/delete-volume rehearsal before it may be
called `locally verified`. Rehearsals use a unique labeled Compose project and
volume and remove only resources carrying that exact test ownership label.

The supported disposal path first stops the diagnostics service without broad
volume deletion, then invokes the checked command with the same resolved names:

```sh
export CANNABEATS_DIAGNOSTICS_PROJECT=cannabeats
export CANNABEATS_DIAGNOSTICS_DATA_VOLUME=cannabeats_diagnostics_data
export CANNABEATS_DATA_VOLUME=cannabeats_poc_data
export CANNABEATS_STATE_DATA_VOLUME=cannabeats_state_data
docker compose -f spikes/access-spotify-poc/compose.yaml \
  -p "$CANNABEATS_DIAGNOSTICS_PROJECT" \
  --profile diagnostics rm -sf diagnostics
node diagnostics-service/scripts/dispose-volume.mjs \
  --project "$CANNABEATS_DIAGNOSTICS_PROJECT" \
  --volume "$CANNABEATS_DIAGNOSTICS_DATA_VOLUME"
```

The command refuses a resolved-name alias, a missing or mismatched Compose
project/logical-volume label, or any attached container. Broad commands such as
`docker compose down --volumes` are not the diagnostics disposal procedure.

### Scope and review decision

Implementation scope is limited to the process wrapper, Docker image, optional
Compose-profile service/volume, topology tests, and focused documentation.
Credentials, caller authorization, mutation routes, Game/State clients,
browser upload, producer reporters, comparison UI, Caddy exposure, and real-host
measurements remain prohibited as E8-E12 work.

E7.3 is a boundary-bearing topology change. Implementation begins only after a
targeted design review finds no open P0/P1 in process ownership, mounts,
dependency direction, disposal, and backup/restore exclusion.

Primary design review: the closure matrix and smallest-counterexample pass found
no open P0/P1 after narrowing live corruption detection to startup, reached
maintenance, and restart rather than an unbounded health-check rescan. E7.3
implementation is authorized for the exact scope above. Independent topology
and process closure remains required before `locally verified` status.

## E7.3 implementation record

The implementation adds only the authorized boundary:

- `diagnostics-service/src/server.mjs` owns one real `DiagnosticCollector`, one
  bounded HTTP server, one maintenance timer, and idempotent shutdown;
- `diagnostics-service/src/topology.mjs` rejects resolved volume-name aliases
  before the collector opens, and the checked disposal command reuses that
  boundary plus exact Compose-label and attachment checks;
- the process exposes only `/live`, `/ready`, and `/v1/status`, returns constant
  not-found results for every other method/path, and normalizes status and
  maintenance failures without echoing lower-layer text;
- listen failure releases SQLite ownership, lifecycle observers cannot affect
  the service, and shutdown clears maintenance before closing HTTP and SQLite;
- `diagnostics-service/Dockerfile` contains only the diagnostics service and its
  verified E1/E2 dependencies; and
- the optional Compose service has one private network attachment, one
  diagnostics-only volume, no published port or dependency edge, and the exact
  user, filesystem, capability, tmpfs, CPU, memory, PID, health, and log bounds
  above.

Matrix-derived process, disposal, and topology tests pass `32/32`. The existing coordinated
backup, release/rollback, scheduler, rendered-state topology, and schema-
compatibility regressions pass `59/59`, confirming no diagnostics mount or
readiness dependency entered those paths.

A clean-target Docker rehearsal built image
`sha256:4d8a886b78c42fc5e63c5990d34c48e3e4a297e81b86317b8cec2c60fba5c5b3`
from commit `056e2c1` under unique project `cannabeats-e73-20260815-b1` and
unique labeled volume `cannabeats_e73_20260815_b1`. The service became healthy with no published host
port; all three private responses matched their exact shapes; restart preserved
healthy readiness; and label-scoped cleanup removed the container, network, and
volume with no remnants. This is local disposable-container evidence, not a
production packaging or real-host claim.

A second unique project, `cannabeats-e73-20260815-c1`, seeded a labeled
diagnostics volume with a 22-byte incompatible store. The real container exited
with its finite startup failure, and the store remained byte-for-byte identical
at SHA-256 `57089ddd9086976132247e33581f17532a4be86a722d96ce2c9b7519e741ad1e`.
After confirming the exact Compose ownership labels, removal targeted only that
diagnostics volume. Starting the same topology recreated an empty healthy
generation-1 store; final label-scoped cleanup left no project container,
network, or volume.

The implementation worktree is based on E7.2 checkpoint `93f1715`. No E8 route,
credential, authority lookup, or producer caller exists. The first independent
review passed the process and rendered-topology perspectives but found one
resolved-volume alias/disposal P1. Commit `2b6634b` (tree
`ce13d159b9ee15cb5384e6a7226cd8e7456a4850`) closes it with the shared preflight
and checked disposal boundary. Three targeted re-reviews found no open P0/P1.

Remediation evidence passed the 32 diagnostics process/store/disposal/topology
tests, the combined 64 E1/E2/E7 tests, and the full 105 Access/backup/release
regressions. Image manifest
`sha256:5b3fe515a4e34c8130f5c1b65050f104a43123a6f21d63a96de181b153afcf79`
was built from the exact clean target. A deliberate diagnostics/Access volume
alias refused startup before adding any file to the authority-labeled test
volume; its sole seeded file retained SHA-256
`580962751a3b56e5ead1bf3947a92d98e1adff44be4026eeea90ce008f340c13`.
A separate normal diagnostics volume was removed by the checked disposal tool,
and both unique projects finished with zero containers, networks, or volumes.
The review's sole P2 was the fail-safe runbook ordering: `stop` left an attached
container, so the tool refused. The command above now uses diagnostics-only
`rm -sf` before disposal. Permitted status is `E7.3 locally verified`.
