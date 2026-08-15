# S2-E E8 diagnostic mediation

Status: `E8.1 and E8.2 implemented; independent closure review pending`. E8.3
remains unimplemented and unauthorized until the preceding increments close.

This packet applies the repository scale filter: one private collector, one
Game gateway, one State authority service, and two collector credentials. It
does not introduce scopes, delegation, token refresh, a general proxy, or an
authorization framework.

## Increment sequence

1. **E8.1 collector credential boundary:** replace the unauthenticated E7.3
   status-only seam with the fixed Game and maintenance route matrix, exact
   bodies, bounded reads, finite results, and trusted collector receipt time.
2. **E8.2 State diagnostic authority:** add the two read-only State projections
   for durable run-host and current managed-stream authority. They mutate no
   lobby, run, lease, command, or history state.
3. **E8.3 Game mediation and consent:** add the browser/source/relay/host Game
   routes, derive every authority field from authenticated Game/State context,
   and prove collector failure never enters a gameplay or playback transaction.

E8.1 exposes no browser, source, relay, or host route. Only Game can reach its
online mutation/read interface; only the operations job can status or purge.

## E8.1 governing invariant

> Every collector request is accepted under exactly one fixed credential and
> route, parsed within fixed bounds, and delegated once with collector-owned
> receipt time; wrong-scope, malformed, timed-out, or failed requests have no
> collector effect and return only a finite result.

## E8.1 exact boundary

The E8.1 adapter is enabled only when its constructor receives two distinct
opaque secrets, each 32–256 visible ASCII bytes with no whitespace:

- `CANNABEATS_DIAGNOSTICS_GAME_TOKEN`; and
- `CANNABEATS_DIAGNOSTICS_MAINTENANCE_TOKEN`.

The process compares complete bearer values without prefix or normalization.
Missing, malformed, equal, or out-of-range enabled configuration refuses
startup before the collector opens. The Compose process remains explicitly in
its E7.3 status-only mode until E8.3 mounts the two files and enables this
adapter for both the collector and its callers; omission cannot expose an
unauthenticated mutation route. The credentials are never returned, logged,
hashed into a response, or accepted by State, Access, gameplay, or audio routes.

`/live` and `/ready` retain their bounded E7.3 responses. Every `/v1/*` route
requires one exact bearer credential:

| Route | Method | Credential | Exact request | Delegated operation |
| --- | --- | --- | --- | --- |
| `/v1/game/trace/context` | POST | Game | exactly `{traceId}`, `{activeRunId}`, or `{active:true}` | `traceContext` |
| `/v1/game/trace/start` | POST | Game | `{command,authority}` | `startTrace` |
| `/v1/game/trace/end` | POST | Game | `{command,authority}` | `endTrace` |
| `/v1/game/segment/rotate` | POST | Game | `{authority}` | `rotateSegment` |
| `/v1/game/synchronization/issue` | POST | Game | `{traceId,issuance}` | `putIssuance` |
| `/v1/game/synchronization/context` | POST | Game | `{sampleId}` | `issuanceContext` |
| `/v1/game/consent/opt-in` | POST | Game | `{command,authority}` | `optIn` |
| `/v1/game/consent/stop` | POST | Game | `{command,authority}` | `stopSharing` |
| `/v1/game/relay/bind` | POST | Game | `{command,authority}` | `bindRelay` |
| `/v1/game/report/ingest` | POST | Game | `{envelope,grantGeneration}` | `ingestReport` with collector receipt time |
| `/v1/game/trace/read` | POST | Game | exact E7 read request | `readTrace` |
| `/v1/maintenance/status` | GET | maintenance | no body | `status` |
| `/v1/maintenance/trace/purge` | POST | maintenance | exact E7 purge command | `purgeTrace` with collector time |

The E8.1 adapter consumes the verified E1/E2/E7 validators. It adds the narrow
production E2 JSON restoration entry points needed to turn exact internal bytes
into branded operation authority and uploaded-envelope values; those entry
points use the same normalizers and canonical-byte checks as the already
verified trusted-store/test seams.

The service and collector share one injected collector clock. HTTP receipt,
purge, trace-context lazy expiry, issuance-context expiry, and scheduled
retention therefore cannot make different equality decisions inside one
process.

Authentication is decided before a body is read. Missing or unknown bearer
credentials return `401 authentication_required`; a known credential on a
route owned by the other scope returns `403 not_authorized`. Unknown paths and
wrong methods return the existing constant `404 not_found` without reading a
body. Request bodies are at most 8 KiB and must be one exact JSON object;
oversize, invalid UTF-8/JSON, unknown fields, and schema-invalid values return
`400 request_invalid`. An incomplete body is abandoned after two seconds and
returns `408 request_timeout` if the response remains writable.

Successful calls return `200` with the collector's bounded result. Known
collector contract/store outcomes map to one allowlisted status/code pair.
Unexpected failures become `503 collector_unavailable`; native or
caller-authored error text is never returned. Because collector operations are
synchronous transactions, aborting the HTTP response after delegation cannot
cancel or duplicate an effect; retry uses the existing request or report
identity and returns the retained result.

The two context routes are the only Game restoration seams. A trace lookup returns the
exact retained E2 trace state; an active-run lookup returns that state only when
the deployment's sole active trace belongs to the requested run; and
`{active:true}` returns the deployment's sole active trace without accepting a
caller-authored run locator. Missing, ended-by-run lookup, or mismatched context
returns `trace_absent`. The collector applies deterministic lazy expiry before
the lookup. This route prevents Game
from trusting a caller-returned trace, segment, or lease label after Game or a
producer restarts; it returns no reports, consent rows, receipts, or principal
data. A synchronization lookup returns the exact retained E2 issuance only
before its retention boundary; equality returns `sample_absent`. It lets Game
validate the producer's local send/receive sample without trusting returned
server timestamps after either side restarts.

| HTTP | Finite codes |
| --- | --- |
| 400 | `request_invalid`, `authority_invalid`, `sample_invalid`, `alignment_invalid`, `report_invalid`, `report_too_large` |
| 401 | `authentication_required` |
| 403 | `not_authorized` |
| 408 | `request_timeout` |
| 409 | `request_conflict`, `report_conflict`, `stale_correlation`, `sample_expired`, `read_expired`, `trace_inactive` |
| 503 | `collector_busy`, `collector_degraded`, `quota_exhausted`, `schema_incompatible`, `collector_unavailable` |

## E8.1 closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: startup validates both credentials before collector creation; route handlers create only through existing collector transactions. |
| Update | `structural`: the adapter owns no durable state and delegates exactly once to the named collector method. |
| Delete | `runtime`: only the maintenance purge route reaches `purgeTrace`; Game has no delete route. |
| Omit | `runtime`: exact per-route object validators reject missing fields before delegation. |
| Duplicate | `structural`: one literal route table owns every method/path pair. |
| Reorder | `not_applicable`: E8.1 adds no sequence or page semantics beyond verified E7 operations. |
| Replay | `runtime`: response-loss retry reaches the verified collector identity before current authority/effect evaluation. |
| Conflict | `runtime`: E1/E2/E7 canonical validators and collector transactions reject changed content under retained identity. |
| Concurrency | `runtime`: HTTP handlers delegate to the existing single synchronous SQLite owner and do not add async work inside its transaction. |
| Expiry | `runtime`: purge and ingest receive the collector clock, never a caller timestamp; E2 authority/issuance times remain exact trusted Game inputs until E8.2/E8.3 derive them. |
| Restart | `structural`: credentials are configuration and durable replay remains entirely in the verified E7 store. |
| Dependency failure | `runtime`: malformed, timed-out, closed, or throwing calls return finite HTTP outcomes and do not affect `/live`, Game, State, or audio readiness. |
| Corruption | `runtime`: retained corruption continues through the shared collector degradation boundary; the adapter never constructs a partial read projection. |
| Capacity | `runtime`: 8-KiB body and two-second body deadline precede delegation; E7 retains row/byte/physical admission. |

## E8.1 derived schedules

- missing, wrong, Game-on-maintenance, and maintenance-on-Game credentials;
- equal/malformed/missing startup secrets before collector creation;
- unknown route, wrong method, body on GET, invalid JSON/UTF-8, unknown field,
  exact 8-KiB boundary, 8-KiB+1, incomplete body timeout, and client abort;
- every route delegates exactly once to only its named method;
- trace context by exact trace, active run, and sole-active lookup; restart
  restoration, mismatch, and expiry-at-equality; synchronization context before/equality/after its
  retained boundary and after restart;
- collector contract error, degraded/full/busy result, unexpected throw, and
  response loss after a committed effect;
- Game cannot status/purge, maintenance cannot ingest/read/mutate, and neither
  credential is present in a response or lifecycle record; and
- `/live` remains live while `/ready` and authenticated status report collector
  degradation independently.

## E8.1 exclusions and exit

E8.2 owns State authority truth. E8.3 owns browser/source/relay/host
authentication, Game proxy deadlines, consent UI upload, credential mounts, and
proof that collector calls are outside gameplay/playback transactions. E9 and
E10 still own reporters. E11 owns host comparison rendering. E12 owns real-host
timing and packaging evidence.

E8.1 closes only when the matrix-derived HTTP/process tests pass, the E1/E2/E7
regressions remain green, the local smallest-counterexample pass finds no open
P0/P1, and a targeted independent credential/body/replay review passes.

## E8.1 implementation record

The implementation is deliberately unwired. `http-boundary.mjs` owns the two
credential values, fixed authentication decision, 8-KiB/two-second body
boundary, eleven exact Game request families, and maintenance purge validator.
The existing server can enable that adapter only through its constructor; the
Compose entry point remains in E7.3 status-only mode until E8.3 supplies secret
files and caller wiring. Enabling malformed or equal credentials fails before
collector construction.

The E2 module adds three narrow production byte entry points for
synchronization issuance, operation authority, and canonical uploaded
envelopes. They share the same private provenance sets, exact normalizers, and
canonical checks as the existing E2 reducers; no network, store, State, or later
checkpoint dependency enters E2.

Matrix-derived tests enumerate all eleven Game request families and delegate
operations, both credential scopes, every documented HTTP error family, exact
8-KiB and 8-KiB+1 bodies, invalid UTF-8/JSON/shape, timeout cleanup, unexpected
dependency failure, maintenance status/purge, startup credential failure before
collector creation, and exact HTTP replay/conflict across a real collector
restart. The local counterexample pass found no open P0/P1.

Verification at the implementation worktree:

- E1/E2/E7/E8.1 focused suite: `76/76`;
- full Web production build and suite: `248/248`;
- Web lint: zero errors; and
- syntax and `git diff --check`: pass.

This record claims no deployed secret, State authority response, public Game
route, producer caller, host authorization, or failure isolation across a Game
transaction. Permitted status remains `E8.1 implemented; independent closure
review pending`.

## E8.2 State diagnostic authority

E8.2 adds exactly two read-only Game-scoped State projections. It does not add
a diagnostic credential to State, mint an assertion, write diagnostic state,
or expose these routes to a browser, source, relay, Access, or operator caller.
E8.3 remains responsible for composing these facts with Game authentication and
collector requests.

### Governing invariant

> State returns diagnostic authority only from its durable run-host identity or
> its single current managed-stream lease; a caller supplies only a lookup key,
> and every absent, stale, ended, expired, disabled, local-mode, or quarantined
> stream projects as finite non-authority without mutating State.

### Exact projections

`POST /v1/diagnostics/run-host-authority` uses the existing Game bearer and
Game principal assertion. Its exact request is `{runId}`. `runId` is a lookup,
not a caller-authored authority claim. A successful durable-host projection is:

```json
{
  "authorityVersion": 1,
  "status": "active",
  "runId": "UUID",
  "runGeneration": 1,
  "isHost": true
}
```

`status` is exactly `active` or `ended`. Active requires the run to be
unterminated and still be the lobby's active run in `playing` status at the same
generation. Ended requires the durable run terminal fields and does not depend
on current lobby membership, retained game events, or history lifecycle. A
missing run or a principal other than the durable lobby host returns the
existing finite `404 not_found`; State does not reveal which condition failed.
An inconsistent retained active/terminal relationship fails closed through the
existing State error boundary.

`POST /v1/diagnostics/managed-stream-authority` accepts either the existing
Game bearer or one existing managed-source bearer; it does not accept a
principal assertion. Its exact request is always `{}`. The Game bearer requests
the deployment's sole current managed stream for relay mediation. A source
bearer is resolved against State's existing source credential registry and
requests only that source's current stream. Game never receives the registry
and neither caller may submit a source ID. The exact non-authority response is:

```json
{"authorityVersion":1,"status":"absent"}
```

The exact active response is:

```json
{
  "authorityVersion": 1,
  "status": "active",
  "runId": "UUID",
  "runGeneration": 1,
  "leaseId": "UUID",
  "sourceId": "UUID",
  "leaseExpiresAt": 123
}
```

Active requires one unexpired lease for an enabled source, a `managed` lobby in
`playing` state, the lobby's unterminated active run at the same generation, and
no unresolved handoff for that source. A source-scoped lookup additionally
requires the exact authenticated source. No match returns `absent`; stale or delayed source/relay
work cannot be rebound to another run. More than one qualifying row is
ambiguous for the unscoped relay lookup and fails closed rather than selecting
one. The State clock supplies
the expiry boundary; equality is expired.

Both methods are read-only at the owner boundary. They do not update source
`last_seen_at`, reap leases, create commands, resolve handoffs, touch history,
or consume a request identity.

### E8.2 closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `not_applicable`: both projections are read-only and create no receipt or assertion. |
| Update | `structural`: owner methods contain only bounded `SELECT` statements. |
| Delete | `not_applicable`: expiry projects absent and does not reap the lease. |
| Omit | `runtime`: run host requires exactly `runId`; managed stream accepts exactly zero fields. |
| Duplicate | `structural`: one route and one owner method own each projection; managed-stream cardinality must be zero or one. |
| Reorder | `not_applicable`: neither projection has sequence input or output. |
| Replay | `structural`: repeated reads over unchanged State return the same exact projection without a receipt. |
| Conflict | `runtime`: caller fields outside the exact lookup shape fail; retained authority contradictions fail closed. |
| Concurrency | `structural`: the existing single State owner serializes writes; each projection is one bounded read snapshot. |
| Expiry | `runtime`: `expires_at <= State now` is absent; no caller time is accepted. |
| Restart | `runtime`: projections derive again from the durable State rows and require no diagnostic sidecar. |
| Dependency failure | `structural`: State does not call Game or the collector; collector availability cannot affect either projection or State readiness. |
| Corruption | `runtime`: State startup validation remains the primary retained-data gate and impossible projection cardinality/relationships fail closed. |
| Capacity | `structural`: one indexed run lookup or at most two bounded current-stream rows; no scan or retained output growth. |

### E8.2 derived schedules and exit

- active host, ended host, non-host, missing run, removed non-host membership,
  sealed history, and purged history;
- active managed stream, wrong source, expired-at-equality, disabled source,
  local mode, ended run, released lease, unresolved handoff, and impossible
  duplicate authority;
- malformed/extra request fields, Access/operator/cross-scope denial, unknown
  source credential, forged principal assertion, repeated read, restart, and unchanged State
  validation/report rows before and after reads; and
- collector unavailable is structurally irrelevant because State has no
  collector import, credential, mount, request, or readiness dependency.

E8.2 closes when these matrix schedules and existing State regressions pass and
an independent review finds no open P0/P1. E8.3 remains unauthorized until that
closure record is committed.

### E8.2 implementation record

`StateOwner` now owns the two bounded projections and `server.mjs` exposes them
under the existing Game or managed-source credential. The durable-host route
also requires the existing short-lived Game principal assertion. The
managed-stream route deliberately has no principal: its empty body is either
Game-scoped for relay mediation or source-scoped by State's existing token
registry. State derives every returned run, generation, lease, source, and
expiry field.

Matrix-derived tests cover active and historical hosts through whole-history
purge, non-host concealment, Game-unscoped/source-scoped/ambiguous managed streams,
expiry before/equality/after, release with unresolved handoff, restart,
read-only validation stability, exact request shape, forged/cross-scope denial,
and the published projection version. The local smallest-counterexample pass
found no path that can substitute another run or source while preserving the
checked durable relationships; an ambiguous unscoped stream fails closed.

Verification at the implementation worktree:

- complete State service suite: `64/64`;
- E1/E2 authority regression suite: `32/32`;
- syntax and `git diff --check`: pass.

This record claims no Game caller route, trace composition, consent routing,
collector call, mounted diagnostic credential, or source/relay reporter. Those
remain E8.3 or later work. Permitted status is `E8.2 implemented; independent
closure review pending`.

## E8.3 contained implementation sequence

E8.3 is intentionally split at three authority boundaries. Passing one
increment does not make the later increments production-ready:

1. **E8.3a host trace lifecycle and read:** authenticate one browser principal,
   derive durable host and current managed-stream authority from State, reconcile
   one active collector trace, and expose host-only trace status/read.
2. **E8.3b listener consent and report:** authenticate one current member, issue
   one memory-only listener grant and synchronization sample, and enforce the
   forward-only opt-in/stop/report generation boundary.
3. **E8.3c source and relay mediation:** authenticate the existing source bearer
   through State, add one fixed relay-to-Game credential, bind one relay
   generation, add the bounded maintenance caller, and prove diagnostic
   dependency failure is isolated from gameplay and audio.

E8.3a may be designed while E8.1/E8.2 closure review is pending, but no E8.3
implementation is authorized until that review closes. E8.3a does not add a
listener grant, producer route, relay credential, reporter, or generalized
authorization layer.

## E8.3a host trace lifecycle and read

### Governing invariant

> A host diagnostic trace is created, reconciled, stopped, or read only after
> Access authenticates the browser and State derives the exact durable host and
> current managed-stream facts; retry is deterministic, caller authority labels
> are absent, and collector failure cannot enter a gameplay transaction.

### Exact browser boundary

The existing Game deployment owns two same-origin routes. Both authenticate the
ordinary browser credentials through the existing Access principal endpoint.
They accept at most 8 KiB of exact JSON and use a two-second deadline for each
State or collector request. They never accept `segmentId`, `leaseId`,
`runGeneration`, role, source, server time, or an authority object.

| Route | Exact request | Result |
| --- | --- | --- |
| `POST /api/diagnostics/trace` | `{action:"start",requestId,runId}` | start or exact replay of one active trace |
| `POST /api/diagnostics/trace` | `{action:"stop",requestId,traceId}` | stop or project the already-ended trace |
| `POST /api/diagnostics/trace` | `{action:"status",traceId}` | bounded host-visible active/ended status |
| `POST /api/diagnostics/report` | `{traceId,cursor}` | one E7 snapshot page after durable-host authorization |

`requestId`, `runId`, and `traceId` are canonical lowercase UUIDs. `cursor` is
`null` on the first page and otherwise the exact E7 structured cursor returned
by the immediately preceding page. The host-visible trace projection is exactly
`{traceId,runId,status,startedAtMs,expiresAtMs,ended}`. It deliberately omits
run generation, segment, lease, source, and request receipts. Read pages retain
the verified E7 metadata and E2 report envelopes because E1 privacy already
classifies source/relay evidence as host/operator-visible; they contain no
principal or display-name mapping.

Unauthenticated calls return finite `401 authentication_required`. Missing,
non-host, mismatched, purged, and caller-inaccessible trace/run locators all
return the same `404 diagnostic_not_found`. Active-trace conflict returns
`409 trace_busy`. Malformed input, identity conflict, expired cursor, and
unavailable/degraded/full dependencies use only the existing finite E1/E2/E7
codes; lower-layer text is never forwarded.

### Server-derived transaction flow

Start performs these bounded operations in order and outside every gameplay
mutation handler:

1. Access returns the authenticated principal.
2. State `run-host-authority` proves that principal is the durable host of the
   requested run.
3. Game derives the trace ID from the request ID and queries that exact retained
   trace. If it exists and matches the requested run and derived trace ID, Game
   returns the committed projection as an exact replay without requiring the
   run or stream still to be active. A mismatch is `request_conflict`.
4. Only when the deterministic trace is absent must State project the host run
   as active and the Game-scoped `managed-stream-authority` return the sole
   current stream for the same run and run generation.
5. Game reconciles the collector's sole active trace, then submits the new start
   command with authority derived only from those State results and Game time.

The State response is a bounded authority snapshot, not a distributed lease on
State. A concurrent gameplay transition may make a just-written diagnostic
trace stale, but the trace grants no gameplay or audio authority, and the next
diagnostic status, read, or ingest reconciles it before use. E8.3 does not add a
cross-service lock or hold a State transaction open while calling the optional
collector.

Game uses one fixed deterministic UUID derivation helper over a versioned label
and canonical UUID inputs. For a start request, `issuedTraceId` and
`issuedSegmentId` derive from the browser `requestId`; the collector command
uses that request ID unchanged. A response-loss retry therefore reconstructs
the identical command and authority rather than generating new random IDs.
After every collector result, Game verifies that the returned `traceId` and
`runId` match this public request before projecting it; a newly accepted start
must also contain its derived initial segment. A retained trace may legitimately
have a later current segment, so replay preflight does not require the initial
segment still to be current.
This relation check is essential because the verified E2 command deliberately
keeps server-derived run authority outside caller command parameters: reuse of
one browser request ID with another run therefore becomes `request_conflict`
rather than replaying the first run to the caller.
The trace's version-1 synchronization `timebaseId` is its `traceId`, giving all
samples in that retained trace one stable collector clock identity without a
new key or sidecar.

The shared active-trace reconciler obtains `{active:true}` from the collector
and the current unscoped stream from State. It has one finite transition table:

| Collector trace | State stream | Result before requested operation |
| --- | --- | --- |
| absent | absent | no reconciliation effect |
| absent | active | no reconciliation effect |
| active | absent | deterministic `authority_lost` end |
| active run or generation differs | active | deterministic `run_replaced` end |
| same run/generation and lease | active | unchanged |
| same run/generation, new lease | active | deterministic segment rotation |

Automatic end request IDs derive from `{traceId,reason}`. A replacement segment
ID derives from `{traceId,priorLeaseId,newLeaseId}`. Segment rotation remains the
verified receipt-free exact prior/current lease edge. If reconciliation loses a
response, retry reconstructs the same end command or segment ID. A stale edge,
ambiguous State stream, or mismatched retained trace fails closed; Game never
guesses which authority is current.

Stop first retrieves the exact retained trace, proves durable host authority for
its retained `runId`, and then always submits the browser request ID for
`trace_end`. It does not require a current stream, so authority loss cannot
prevent a host from ending stale diagnostics. An exact retry after response loss
therefore reaches the retained collector receipt before current-state
evaluation. A fresh request against an already-ended trace returns the current
ended projection without a new effect. Status and each read page repeat exact
trace lookup plus durable-host authorization. If the trace is active, they run
the shared reconciler before projection; historical ended reads require
durable-host authority only.

The Game collector client owns the only collector bearer and permits only the
fixed E8.1 methods. The browser never receives that bearer. Calls use an abort
deadline and exact JSON response validator. Timeout, malformed response,
connection failure, collector pressure, or response loss changes only the
diagnostic result. The diagnostic modules are imported only by the two
diagnostic routes; gameplay mutation, State, Access, audio-stream, audio-source,
and readiness code have no collector client import or readiness dependency.

E8.3a activates the authenticated collector adapter by mounting both fixed
collector credentials into the diagnostics service and only the Game credential
into the Game service. No browser-visible environment or response contains
either value. The maintenance credential has no caller yet and is not mounted
into Game, Access, State, or an ordinary app process; E8.3c adds its bounded
operations caller. This is the minimum deployable secret topology for the host
routes and does not wait for source/relay work.

### E8.3a closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: start requires Access principal, State durable-host/current-stream equality, no unreconciled active trace, and deterministic issued IDs. |
| Update | `runtime`: only the shared reconciler may rotate the current segment, using the exact retained prior lease and State's current lease. |
| Delete | `not_applicable`: host stop ends a trace but does not purge reports; maintenance-only purge remains E8.3c. |
| Omit | `runtime`: exact request/response validators reject missing authority facts, fields, and incomplete pages before projection. |
| Duplicate | `structural`: the collector retains one active trace and one current segment; deterministic IDs cannot create a second equivalent edge. |
| Reorder | `runtime`: reconciliation completes before start/status/read projection, and an E7 cursor must be the immediately preceding cursor. |
| Replay | `runtime`: start checks its deterministic retained trace after durable-host authorization but before current-stream authority; stop reconstructs the exact collector command and an ended-stop retry reaches its retained receipt. |
| Conflict | `runtime`: Game checks retained/result trace relationships against the public request; operation reuse reaches the existing collector fingerprint conflict before mutation. |
| Concurrency | `runtime`: the collector's single transaction owner chooses one active trace/segment edge; the losing Game request receives the finite conflict/busy result. |
| Expiry | `runtime`: State decides lease expiry; collector lazy-expiry decides trace expiry; equality is never evaluated from browser time. |
| Restart | `structural`: Game retains no diagnostic authority state; it reconstructs IDs from request/edge inputs and restores trace context from State and collector. |
| Dependency failure | `runtime`: one diagnostic error boundary normalizes bounded client failures; static dependency checks prove those clients have no gameplay/audio transaction or readiness edge. |
| Corruption | `runtime`: exact State response and collector response restoration fails closed; E7 performs whole-trace validation before every page. |
| Capacity | `runtime`: 8-KiB browser body, two-second dependency deadlines, one page per request, and existing E7 fixed trace/page quotas bound work. |

### E8.3a derived schedules and exit

- start success, exact response-loss replay, changed-run conflict, simultaneous
  starts, another active trace, absent stream, wrong run, non-host, and expired
  lease at State equality;
- active reconciliation for absent authority, run replacement, unchanged lease,
  lease rotation, stale rotation response loss, and collector restart;
- stop success/replay, fresh stop of an already-ended trace, authority loss, another principal, and
  delayed stop after automatic expiry;
- host status/read for active, ended, sealed-history, and purged-history runs;
  non-host concealment, malformed/jumped/replayed cursor, and between-page purge;
- Access/State/collector timeout, malformed response, response loss, unavailable,
  degraded, full, and conflict outcomes with unchanged room revision, State
  validation report, audio lease/command/handoff, and Game readiness; and
- static dependency assertions showing gameplay/audio/readiness modules cannot
  reach the collector client and the browser cannot receive collector secrets.

E8.3a implementation may begin only after E8.1/E8.2 independently close and a
local counterexample pass finds no missing P0/P1 in this matrix. Its closure
requires the real composed Game→Access→State→collector schedules above, not
only mocked clients. E8.3b owns listener grants, consent, synchronization, and
listener ingestion. E8.3c owns source/relay routes, the relay and maintenance
caller credentials, maintenance purge, and the final cross-route
failure-isolation rehearsal.
