# S2-E E7 isolated collector and store specification packet

## Identity and status

- Checkpoint: E7 — isolated collector and physical store
- Scope revision: `E7-spec-v1`
- Status: `design-review-pending`
- Risk class: `B — boundary-bearing` for durable replay, retention, and a
  disposable SQLite schema; whole-trace purge is the only destructive edge
- Exact source/tree identity: to be recorded by the independent design review
- Required verified checkpoints: E1 at `736a401`; E2 at `df41d2c`
- Explicitly excluded later checkpoints: external credentials, Game/State
  authority resolution, browser/source/relay routes, and consent transport
  (E8); source and relay reporters (E9/E10); diagnosis UI (E11); real-host
  capacity and timing (E12)
- Primary design date: 2026-08-14

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
retention. The store accepts at most 30,000 reports per trace and 90,000 reports
globally. These limits are intentionally fixed constants.

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

1. **E7.1 transactional core:** canonical schema identity, one-writer ownership,
   trace rows, report ingest, exact replay/conflict, transactional counters, and
   startup validation. No HTTP, timers, purge, Compose, or credentials.
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
- `diagnostic_store(singleton, report_count, canonical_bytes, mode,
  degraded_reason)`;
- `diagnostic_traces(trace_id, run_id, run_generation, status, started_at,
  ended_at, expires_at, periodic_count, transition_count, canonical_bytes)`;
- `diagnostic_reports(trace_id, kind, instance_id, sequence, bucket,
  received_at, envelope_digest, canonical_envelope)` with primary key
  `(trace_id, kind, instance_id, sequence)` and trace cascade deletion; and
- `diagnostic_requests(request_id, operation, fingerprint, result_json,
  accepted_at)` for exact mutation replay.

There is no authority, player, room, song, URI, address, user-agent, free-form
error, or credential column. `canonical_envelope` is the unchanged canonical E2
uploaded envelope and is revalidated before acceptance and after restart/read.
The digest is SHA-256 of those exact bytes and is only an integrity/replay aid.
Indexes are fixed to trace/order lookup, expiry, and request identity.

The schema ledger stores the SHA-256 digest of the exact canonical
`sqlite_schema` graph. Startup accepts generation 1 only when both the ledger
and recomputed graph match. An incompatible file is reported
`schema_incompatible`; E7 never mutates it in place. E7.3 may abandon and create
a new disposable volume, but it cannot do so to Access or State files.

### Exact report and request rules

- Identities are lowercase, non-nil RFC-variant UUIDs accepted by verified
  E1/E2. The store never normalizes an alternate spelling.
- A canonical envelope is at most 2,048 bytes. `kind`, `instanceId`, `sequence`,
  `traceId`, and report bucket are derived from the validated envelope, never
  accepted as parallel caller labels.
- `bucket=periodic` applies to the three `*_window` kinds;
  `bucket=transition` applies to the three `*_transition` kinds.
- Exact replay requires the same primary key and identical envelope digest and
  bytes. It returns `replayed` without changing timestamps or counters.
  Different bytes under that key return `report_conflict`.
- Each request-bearing trace/end/purge mutation has one canonical command
  fingerprint. Exact request replay returns the stored finite result;
  conflicting reuse returns `request_conflict`.
- Retained rows that fail schema, digest, envelope, identity, or counter
  reconciliation make the collector `degraded` and are never projected as
  partial valid evidence.

## Invariants

| ID | Normative rule | Violation result | Owning evidence |
| --- | --- | --- | --- |
| E7-SCHEMA-001 | Ledger digest and actual schema graph exactly match generation 1. | `schema_incompatible` without mutation | fresh/open/tamper tests |
| E7-OWN-001 | One process owns one canonical database inode for its lifetime. | second owner fails finitely | same-path/alias/process tests |
| E7-INGEST-001 | Report row, trace/global counters, canonical bytes, and request receipt commit in one `BEGIN IMMEDIATE` transaction. | no partial durable effect | injected-failure/restart tests |
| E7-REPLAY-001 | Exact report/request replay is immutable; conflicting reuse is rejected. | `report_conflict` or `request_conflict` | all-kind replay table |
| E7-QUOTA-001 | Periodic, transition, trace-byte, global-row, and global-byte limits are checked inside the writer transaction. | `quota_exhausted`; no eviction | boundary/concurrent tests |
| E7-TRACE-001 | Reports are accepted only for one active, unexpired trace and their validated context names that trace. | `trace_inactive` | status/expiry/context table |
| E7-READ-001 | Reads return one bounded trace in stable `(mapped interval, kind, instance, sequence)` order or one finite degraded result. | no partial/corrupt projection | malformed-retained/read-bound tests |
| E7-PURGE-001 | Purge atomically removes the trace, all reports, and trace-scoped projections; exact retry remains finite through its request receipt. | no partially readable trace | failure/retry/restart tests |
| E7-RET-001 | A trace becomes purge-eligible at `expires_at`; retention never touches Access, State, game history, or another trace. | finite failure; no cross-trace delete | cutoff and isolation tests |
| E7-PHYS-001 | New ingestion stops when DB+WAL is at least 256 MiB or observed host free space is below 1 GiB. | `collector_degraded` | injected-usage boundary tests |
| E7-ISOLATE-001 | Collector absence, hang, full store, incompatible schema, or deletion cannot change Game/State/audio readiness, backup, or rollback. | diagnostics unavailable only | E7.3 topology/rehearsal tests |
| E7-PRIV-001 | Store, projections, finite errors, and logs contain only the enumerated fields and never free-form input. | whole request/report rejected | recursive schema/log tests |

## Lifecycle, concurrency, and interruption matrix

The SQLite transaction commit is the sole mutation linearization point. The
request receipt is written in that same transaction. SQLite writer ownership
serializes different requests; callers do not coordinate in memory.

| Schedule | Required durable state | Required result | Forbidden result |
| --- | --- | --- | --- |
| Failure before commit | unchanged | finite failure; same request may retry | receipt without effect |
| Commit then response loss | effect plus receipt | exact retry returns stored result | duplicate row/counter |
| Exact concurrent duplicate | one effect and one receipt | accepted plus replayed | uniqueness error/500 |
| Conflicting report identity | original row unchanged | `report_conflict` | overwrite |
| Conflicting request identity | original effect/receipt unchanged | `request_conflict` | second effect |
| Quota boundary race | the transaction that fits may commit | later transaction gets `quota_exhausted` | both exceed cap |
| Trace end versus ingest | transaction order decides | ingest accepted before end or `trace_inactive` after | report committed to ended trace |
| Purge versus read/ingest | transaction order decides | complete old projection or finite absent/inactive | partial trace |
| Process exit after commit | committed transaction survives | replay after restart | reconstructed caller result differs |
| Process exit before commit | SQLite rollback | retry may accept | orphan counter/row |
| Busy reader/WAL checkpoint | logical data remains correct | degraded/pending physical cleanup | false physical-erasure claim |
| Incompatible restart | original file unchanged | `schema_incompatible` | in-place repair or authority impact |

## Failure and resource model

Finite store outcomes are `accepted`, `replayed`, `trace_inactive`,
`report_invalid`, `report_too_large`, `report_conflict`, `request_conflict`,
`quota_exhausted`, `collector_degraded`, `collector_busy`, and
`schema_incompatible`. Internal logs contain only outcome, operation, schema
generation, and a freshly generated correlation reference; they never echo
request bodies or persistent identifiers.

Logical limits are 24,000 periodic plus 6,000 transition rows and 64 MiB of
canonical envelope bytes per trace; 90,000 rows and 192 MiB globally; one
active trace; 2,048 bytes per canonical envelope; and a maximum 30,000-row read
projection. Counters include only canonical envelope bytes, not an estimate of
SQLite overhead.

Physical admission separately observes main DB plus WAL bytes and host free
space. Reaching 256 MiB or dropping below the 1-GiB reserve changes the store to
degraded/read-only for ingestion. Reads and purge remain available when SQLite
permits them. Physical cleanup uses `secure_delete`, bounded WAL checkpoints,
and disposable-volume deletion; version 1 promises logical deletion and
ordinary SQLite cleanup, not cryptographic or forensic erasure.

There is no retry queue. SQLite busy waits are bounded. A failed request returns
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
- Errors and logs: finite codes and ephemeral correlation reference only.
- Prohibited everywhere: names, account/player/room IDs, room codes, songs,
  URIs, PCM, IPs, full user agents, credentials, arbitrary exception text, and
  caller-authored labels outside the E1/E2 envelope.

## Dependency firewall

E7 may consume only verified E1 byte validation/canonicalization and the E2
uploaded-envelope validation/canonicalization boundary. If E2 lacks the latter
byte surface, the first E7.1 change must add that narrow pure API with E2 tests
before SQLite uses it. E7 may not import E3-E6, Game routes, State, Access,
React, source, relay, or operations tooling.

The E7.1 focused command will run only E1, E2, and collector-store tests. E7.2
adds store lifecycle tests. E7.3 alone runs the collector process and Compose
isolation checks.

## Evidence and claim ledger

| Claim | Invariants | Required negative schedules | Permitted status wording |
| --- | --- | --- | --- |
| E7.1 core | SCHEMA, OWN, INGEST, REPLAY, QUOTA, TRACE, PRIV | schema tamper, second writer, rollback injection, lost response, exact/conflicting concurrency, cap ±1 | `transactional core locally verified`; no service/integration claim |
| E7.2 retention/read | READ, PURGE, RET, PHYS | corrupt row, max read, cutoff equality, purge/read race, busy checkpoint, restart | `bounded disposable store locally verified`; no auth claim |
| E7.3 isolation | ISOLATE plus prior invariants | absent/hung/full/incompatible/deleted collector, backup/restore/rollback | `optional collector locally verified`; no real caller-authority claim |

## Design-review decision

- Findings: primary design split authentication from storage and reduced E7 to
  three bounded increments; independent adversarial review remains pending.
- Open blockers: exact E2 uploaded-envelope byte restoration API and independent
  review of the persistent schema/lifecycle.
- Approved implementation scope: none until the E7 B-boundary design review.
- Explicitly prohibited implementation scope: E8 routes/credentials/authority,
  E9/E10 producers, E11 diagnosis UI, E12 measurements.
- Decision: `revise`
- Packet linked from normative checkpoint: pending this change
- Every `Not applicable` names its owning checkpoint: yes
- Dependency-firewall review passed: pending
- Predictable-failure matrix resolved: pending independent review
- No open P0/P1 design finding: pending
- Implementation authorized: no
