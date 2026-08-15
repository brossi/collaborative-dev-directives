# S2-E E8 diagnostic mediation

Status: `E8.1, E8.2, and E8.3a locally verified; E8.3b implemented with
closure review pending`. Independent closure found no open P0/P1 in the
verified increments. E8.3c remains unimplemented and unauthorized until
E8.3b closes.

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
| `/v1/game/trace/start-context` | POST | Game | exactly `{requestId}` | `traceStartReceiptContext` |
| `/v1/game/consent/receipt-context` | POST | Game | exactly `{requestId,operation}` for `consent_opt_in|consent_stop` | `consentReceiptContext` |
| `/v1/game/report/context` | POST | Game | exactly `{traceId,instanceId,sequence}` | `reportIdentityContext` |
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

The three context routes are the only Game restoration seams. A trace lookup returns the
exact retained E2 trace state; an active-run lookup returns that state only when
the deployment's sole active trace belongs to the requested run; and
`{active:true}` returns the deployment's sole active trace without accepting a
caller-authored run locator. Missing, ended-by-run lookup, or mismatched context
returns `trace_absent`. The collector applies deterministic lazy expiry before
the lookup. This route prevents Game
from trusting a caller-returned trace, segment, or lease label after Game or a
producer restarts; it returns no reports, consent rows, or principal data. A
start-context lookup returns only the canonical retained `trace_start` receipt
for that request ID, or `trace_absent`. It is the source of the original
accepted result after response loss; current trace state is never substituted
for that receipt. A synchronization lookup returns the exact retained E2
issuance and its canonically bound stored `traceId` only before its retention boundary; equality returns
`sample_absent`. It lets Game
validate the producer's local send/receive sample without trusting returned
server timestamps or substituting a sample from another trace after either side
restarts.

| HTTP | Finite codes |
| --- | --- |
| 400 | `request_invalid`, `authority_invalid`, `sample_invalid`, `alignment_invalid`, `report_invalid`, `report_too_large` |
| 401 | `authentication_required` |
| 403 | `not_authorized` |
| 408 | `request_timeout` |
| 409 | `request_conflict`, `report_conflict`, `stale_correlation`, `sample_expired`, `read_expired`, `trace_inactive`, `sharing_disabled` |
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

- E1/E2/E7/E8.1 focused suite: `78/78`;
- full Web production build and suite: `248/248`;
- Web lint: zero errors; and
- syntax and `git diff --check`: pass.

This record claims no deployed secret, State authority response, public Game
route, producer caller, host authorization, or failure isolation across a Game
transaction. Because authenticated diagnostic ingress has never been
production-enabled, the trace-bound issuance encoding establishes a pre-enable
disposable-format cutoff rather than a live data migration. Any earlier local
diagnostic volume must be removed with the checked E7.3 disposal operation
before E8.3 enables the adapter; Access and State data are unaffected.

Permitted status is `E8.1 locally verified`.

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

The authority-bearing identity fields they read are checked at every State
startup against existing durable provenance: a runtime lobby host must match
its canonical `create_lobby` request fingerprint (a migrated lobby has exactly
one founding member), and every live lease must match its exact
acquisition event plus an exact lease/source command result. Gameplay selection
persists that binding in the same room transaction. A pre-remediation gameplay
lease without the new binding remains valid for ordinary State compatibility
but projects no diagnostic stream authority; its normal expiry/release clears
the temporary legacy row.
Managed-source credential digests use one canonical lowercase SHA-256 form at
registration, rotation, lookup, service-scope collision checks, and startup
validation. Mixed-case or malformed retained values fail closed before State
serves either projection.

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
| Corruption | `runtime`: host/lease provenance and canonical source-digest startup validation reject authority reassignment or scope collapse; impossible projection cardinality/relationships fail closed. |
| Capacity | `structural`: one indexed run lookup or at most two bounded current-stream rows; no scan or retained output growth. |

### E8.2 derived schedules and exit

- active host, ended host, non-host, missing run, removed non-host membership,
  sealed history, and purged history;
- active managed stream, wrong source, expired-at-equality, disabled source,
  local mode, ended run, released lease, unresolved handoff, and impossible
  duplicate authority;
- malformed/extra request fields, Access/operator/cross-scope denial, unknown
  source credential, forged principal assertion, repeated read, restart, and unchanged State
  validation/report rows before and after reads; host/lease identity rewrite,
  uppercase source-digest rotation, and retained mixed-case digest restart; and
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

- complete State service suite: `67/67`;
- E1/E2 authority regression suite: `32/32`;
- syntax and `git diff --check`: pass.

This record claims no Game caller route, trace composition, consent routing,
collector call, mounted diagnostic credential, or source/relay reporter. Those
remain E8.3 or later work. Permitted status is `E8.2 locally verified`.

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

E8.3a implementation is authorized by the completed E8.1/E8.2 closure review.
That authorization does not extend to E8.3b or E8.3c. E8.3a does not add a
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
3. Game derives the trace ID from the request ID and queries the exact retained
   start receipt by request ID. If it exists, Game verifies the receipt's
   canonical command, requested run, derived trace ID, and derived initial
   segment before returning its original accepted projection. A mismatch is
   `request_conflict`. Current ended or rotated trace state is not replay evidence.
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
and canonical inputs. It hashes the ASCII string
`cannabeats:s2e:e8:v1:<label>:<part>[:<part>...]` with SHA-256, retains the
first 16 bytes, sets the RFC variant and version-5 bits, and emits lowercase
canonical UUID text. The four labels are `trace`, `initial-segment`,
`automatic-end`, and `replacement-segment`; no caller supplies a label or raw
derivation string. Parts are canonical UUIDs except the final automatic-end
part, which is one exact E2 end-reason enum. For a start request, `issuedTraceId` and
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

E8.3a activates the authenticated collector adapter in the state-cutover
deployment overlay by mounting both fixed collector credential files into the
diagnostics service and only the Game credential file into the `game` service.
The exact private configuration is
`CANNABEATS_DIAGNOSTICS_SERVICE_ORIGIN=http://diagnostics:3020`,
`CANNABEATS_DIAGNOSTICS_GAME_TOKEN_FILE`,
`CANNABEATS_DIAGNOSTICS_MAINTENANCE_TOKEN_FILE`, and the diagnostics-side
`CANNABEATS_DIAGNOSTICS_AUTHENTICATED_API_REQUIRED=true`. The required flag
prevents the cutover overlay from silently falling back to E7.3 status-only
mode when either verifier file is absent.
The base E7.3 diagnostics profile remains a status-only development topology.
No browser-visible environment or response contains either value. The
maintenance credential has no caller yet and is not mounted into Game, Access,
State, or an ordinary app process; E8.3c adds its bounded operations caller.
This is the minimum deployable secret topology for the host routes and does not
wait for source/relay work. Diagnostics refuses its authenticated adapter before
opening the store if either file is missing/malformed or the two values compare
equal; Game refuses only its diagnostic routes if its one scoped file is
missing or malformed. Neither service adds diagnostics to Game or State
readiness.

### E8.3a closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: start requires Access principal, State durable-host/current-stream equality, no unreconciled active trace, and deterministic issued IDs. |
| Update | `runtime`: only the shared reconciler may rotate the current segment, using the exact retained prior lease and State's current lease. |
| Delete | `not_applicable`: host stop ends a trace but does not purge reports; maintenance-only purge remains E8.3c. |
| Omit | `runtime`: exact request/response validators reject missing authority facts, fields, and incomplete pages before projection. |
| Duplicate | `structural`: the collector retains one active trace and one current segment; deterministic IDs cannot create a second equivalent edge. |
| Reorder | `runtime`: reconciliation completes before start/status/read projection, and an E7 cursor must be the immediately preceding cursor. |
| Replay | `runtime`: start checks its retained canonical start receipt after durable-host authorization but before current-stream authority; stop reconstructs the exact collector command and an ended-stop retry reaches its retained receipt. |
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

E8.1/E8.2 independently closed and their local counterexample pass found no
missing P0/P1 that blocks this matrix, so E8.3a implementation may begin. Its
closure requires one representative composed production-boundary schedule
through real Access, State, and collector HTTP services and the production Game
mediation handler. It includes commit-then-response-loss, collector restart,
exact retry, read, and non-host concealment. The remaining finite lifecycle branches
may use focused real-owner tests; duplicating every branch through Docker would
not add proportionate evidence for this deployment. E8.3b owns listener grants,
consent, synchronization, and listener ingestion. E8.3c owns source/relay
routes, the relay and maintenance caller credentials, maintenance purge, and
the final local cross-route failure-isolation rehearsal. E12 owns the deployed
credential-path and real-host rehearsal.

### E8.3a implementation checkpoint

The governing invariant is implemented without expanding the boundary into
listener consent or producer mediation. The existing closure-matrix
dispositions remain unchanged. Their enforcement locations are:

- Game request/body/origin and finite error boundary:
  `web/lib/server/diagnostic-routes.mjs` and the two
  `web/app/api/diagnostics` routes;
- Access/State bounded authority lookups, deterministic reconciliation, and
  request replay: `web/lib/server/diagnostic-mediation.mjs`,
  `web/lib/server/access-gateway.mjs`, and
  `web/lib/server/state-client.mjs`;
- fixed Game-scoped collector client and exact read restoration:
  `web/lib/server/diagnostic-collector-client.mjs`;
- authenticated diagnostics startup and scoped deployment mounts:
  `diagnostics-service/src/server.mjs` and
  `spikes/access-spotify-poc/compose.state-cutover.yaml`.

The pre-audit counterexample pass changed two implementation details before
closure review: active request deadlines remain process-owned until settlement,
and host stop bypasses current-stream reconciliation so it records the exact
host command even after stream authority disappears. It also found and fixed a
real composed adapter mismatch that isolated client mocks did not expose.
The first independent audit then found one shared missing boundary: historical
trace lookup could precede Access authentication, and structurally valid
collector output was not always rebound to the authorized request. Remediation
now authenticates before every retained lookup, lazily creates the optional
collector client, and applies one relation validator to trace context,
start/end/rotation results, read metadata, and every returned report context.
The affected authority re-review then found that canonical timestamps could
still be substituted without changing those identities. The same boundary now
binds accepted operation timestamps to the single submitted collector time and
requires every receipt-bearing response to match both its exact command and
returned state; stale stop refreshes retain every immutable trace field.
Receipt-free segment rotation separately returns `accepted` or `replayed`, so
Game requires the submitted timestamp only for a newly applied edge while an
exact replay retains its original segment timestamp. An ended stop replay must
equal the complete preflight state, including its terminal timestamp.

Matrix-derived evidence presently passes:

- Web production build and complete suite: `npm test` in `web` (`273/273`);
- Web lint: `npm run lint` (zero errors; one pre-existing E5 unused-parameter
  warning);
- diagnostics service/store/topology: `node --test --test-concurrency=1
  tests/*.test.mjs` in `diagnostics-service` (`48/48`);
- State authority regression: the equivalent command in `state-service`
  (`67/67`); and
- Access boundary regression: `node --test --test-concurrency=1
  test/server.test.mjs` in `spikes/access-spotify-poc` (`17/17`).

The composed test starts real Access, State, and authenticated diagnostics HTTP
services, drops the first start response after collector commit, restarts the
collector, and proves the browser's exact retry returns the retained original
result before exercising read and non-host concealment. Focused schedules also
cover deterministic changed-run
conflict, simultaneous starts, stream-independent host stop, authority-loss and
lease-rotation reconciliation, malformed/oversized/stalled browser input,
malformed/timeout collector output, credential separation, and absence of a
collector dependency from gameplay, audio, or readiness modules.

The deployed credential path is rendered-Compose plus authenticated-startup
unit evidence at E8.3a; it has not been claimed as a completed state-cutover
rehearsal. E8.3c owns the final local cross-route isolation scenario and E12
owns installation and restart evidence on the real deployment hosts.

Independent affected-perspective closure passed against implementation commit
`504686e6c3e43fe666af5bcdb150c8b047dfe1f0` and tree
`fc563b334c4328054ce3a7a123ed6d4d695c5b50`: authority/replay,
HTTP/privacy, and topology/evidence each found P0 `0`, P1 `0`, P2 `0`.
E8.3a is locally verified. E8.3b retains listener grant, consent,
synchronization, and listener ingest. E8.3c retains
source/relay mediation, the maintenance caller and purge route, and final
cross-route isolation rehearsal. E12 retains real-host/browser timing and
packaging measurements.

## E8.3b listener consent and report

Governing invariant:

> An authenticated current run member may upload only E1 reports created at or
> after one explicit opt-in boundary for one memory-only listener instance; an
> exact retry preserves its original consent/report result, while stop,
> expiry, restart, membership loss, or correlation change can only reduce that
> authority.

This is one browser-to-Game authority boundary. It does not attach source or
relay reporters, add durable Game state, create a general capability system, or
make diagnostics part of gameplay readiness.

### Exact browser and State boundary

E8.3b adds two same-origin browser routes:

| Route | Exact operation families |
| --- | --- |
| `/api/diagnostics/listener` | `opt_in`, `synchronize`, `stop` |
| `/api/diagnostics/listener-report` | one listener report upload |

`opt_in` accepts exactly `{action,requestId,runId,listenerInstanceId,
firstAllowedSequence,localConsentStartedMs}`. `synchronize` accepts exactly
`{action,requestId,grantId}`. `stop` accepts exactly
`{action,requestId,grantId}`. Report upload accepts exactly `{grantId,
measurementCore,sampleObservation}`; the observation contains only
`sampleId`, `instanceId`, `localSendMs`, and `localReceiveMs`. All request,
run, instance, grant, and sample identities are lowercase canonical UUIDs.
Bodies retain the E8.3a bounded-reader, origin, deadline, no-store, and finite
browser-error rules.

State adds one Game-scoped read-only projection
`diagnosticRunMemberAuthority({runId,principalId})`. It returns exactly
`{authorityVersion:1,status:active|ended,runId,runGeneration,role:host|member}`
only when the principal is a durable member of that run. It reveals no lobby
code, membership list, name, score, or song. Opt-in and report require
`status:active`; stop may use the same durable ended membership so authority can
be reduced after a run ends. Missing membership is concealed as
`diagnostic_not_found`.

### Memory-only listener grant

Game keeps at most 32 grant records in one process-local `Map`. A grant ID is a
deterministic version-5 UUID derived from `{traceId,listenerInstanceId,
consentGeneration}` with the new fixed `listener-grant` label. Each record contains only `{grantId,principalId,
runId,runGeneration,traceId,correlationSegmentId,leaseId,listenerInstanceId,
role,generation,status,expiresAtMs,lastStopRequestId,optInRequestId}`. Expiry is exactly the
earlier of `consent.changedAtMs + 15 minutes` and trace expiry, so replay
reconstructs the identical value. Lazy
cleanup runs before grant lookup or insertion. At the fixed cap, a new opt-in
returns `quota_exhausted`; no eviction can transfer or revive authority.

The grant is returned only to that browser response and remains in memory; it
is not placed in a cookie, URL, log, collector row, State row, or local browser
storage. Before collector dispatch, Game retains one bounded memory-only
pending opt-in binding `{requestId,principalId,runId,listenerInstanceId,
expiresAtMs}`. It counts within the same 32-record cap and permits response-loss
reconciliation only for the same authenticated principal in the same Game
process. Page or Game restart loses both pending and accepted grants. A
same-process exact opt-in retry derives
the same grant ID and returns the same binding. E8.1 adds one Game-scoped exact
operation-receipt lookup for `consent_opt_in|consent_stop`; it returns only the
validated retained E2 receipt for that request ID or `receipt_absent`. After a
Game restart, opt-in retry may authenticate and validate the retained receipt
but returns finite `grant_lost`; the browser starts a fresh opt-in request and
consent generation. A receipt contains no principal identity, so it cannot
safely reconstruct member authority after the memory-only binding is gone.
Stop retry likewise derives the original grant generation from its retained
command/result. Conflicting request-ID reuse fails before a new grant is
installed. The receipt lookup is not a report, host-read, or arbitrary request
enumeration API.

Stop retains the grant as `revoked` until its original expiry rather than
deleting it. This permits exact stop replay and lets the collector decide the
required race: a report identity accepted before stop remains `replayed`, while
unseen work from the revoked generation returns `sharing_disabled`. A revoked
grant can authorize only exact stop retry and report replay classification; it
cannot synchronize, opt in another instance, or authorize a new report.

### Synchronization and report composition

Synchronization sample IDs are deterministic UUIDs derived from the browser
request ID with the fixed `synchronization-sample` label. Game records one
`serverReceiveMs`, creates the exact E2 issuance with `timebaseId=traceId` and
the grant's listener instance, records `serverSendMs` immediately before its
bounded collector call, and persists it through the existing Game-scoped
issuance endpoint. An exact duplicate request first asks for the retained
issuance by sample ID and returns it only when trace, timebase, and instance
match the grant. The browser does not use that old issuance to describe a
later exchange after response loss: it creates a fresh request/sample ID and
leaves the abandoned issuance to normal collector cleanup.

For upload, Game authenticates the principal, resolves the exact grant, and
first asks the collector for that grant-bound E1 report identity. A matching
retained core returns its original `replayed` result and changed reuse returns
`report_conflict` before current authority; no report returns `report_absent`.
Only the absent case repeats State membership, reconciles the active trace/current managed stream, and
requires the grant's run generation, trace, segment, and lease still match.
Game restores the retained issuance by caller-supplied `sampleId`, requires its
trace/timebase/instance match the grant, accepts the four-field local timing
observation through E2, validates the E1 measurement core, maps its alignment,
and creates the listener server context itself. The role comes only from State.
The unchanged composed E2 envelope and grant generation are then sent to the
collector. Neither principal nor grant is forwarded. Game accepts only the
finite collector ingest outcomes and verifies an accepted/replayed envelope is
the exact submitted envelope before projecting `{status,receivedAt}`.

Successful opt-in is the upload linearization point. The UI supplies its current
next report sequence and monotonic click time, receives the grant only after the
collector consent commit, then advances its local upload floor again to the
next sequence observed at acknowledgement. It never uploads an entry already
in the local ring at either boundary.
Upload uses one replaceable pending report, no durable browser queue, and no
automatic backfill. Stop becomes visible only after its collector commit; after
acknowledgement the UI disables sharing and discards any unsent report. Lost or
malformed responses keep the operation uncertain and retry the exact request.
Collector failure changes only sharing status; local measurement, copy, audio,
gameplay, and readiness continue unchanged.

### E8.3b closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: opt-in authenticates Access, proves active State membership and current trace/stream correlation, commits E2 consent, then installs the deterministic bounded grant. |
| Update | `runtime`: only `enabled -> revoked` and lazy expiry are permitted; trace/run/instance/generation binding is immutable. |
| Delete | `structural`: grants are memory-only and disappear on process restart; lazy expiry removes only expired records. Revocation is retained until expiry for replay truth. |
| Omit | `runtime`: every report requires grant, membership, active trace, exact segment/lease, retained issuance, E1 validation, and E2 composition before collector dispatch. |
| Duplicate | `runtime`: deterministic grant/sample IDs plus collector request/report identity return exact replay; the 32-grant map has one record per grant ID. |
| Reorder | `runtime`: collector consent generation and first sequence/time boundaries decide stop-versus-report ordering; Game does not backfill or reorder its single pending report. |
| Replay | `runtime`: opt-in/stop use exact E2 request receipts; synchronization reuses the retained issuance; report replay is decided by E7 identity before revoked consent. |
| Conflict | `runtime`: changed reuse of request, sample, grant, instance, or report identity fails before current authority can create another effect. |
| Concurrency | `runtime`: one tail keyed by opt-in request until grant creation and then by grant ID serializes synchronization, stop, and report dispatch; collector transactions remain final consent/report authority. |
| Expiry | `runtime`: grant lookup rejects at `now >= expiresAtMs`; issuance and trace equality retain their verified E7 boundaries. |
| Restart | `structural`: pending and accepted Game grants vanish; a retained receipt cannot recreate member authority and exact opt-in returns `grant_lost`, after which a fresh request/generation is required. |
| Dependency failure | `runtime`: bounded Access/State/collector calls return finite diagnostic failure and cannot mutate playback, room state, or local E5/E6 records. |
| Corruption | `runtime`: grants are closed module records; every collector/State response is exact and rebound to the grant and request before projection. |
| Capacity | `runtime`: 32 grant/request keys, one active plus one queued operation per key (a third returns `collector_busy`), 15-minute lifetime, 8 KiB browser body, and existing E1/E2/E7 byte/report limits. |

### E8.3b derived schedules and authorization

Before closure, tests derive these schedules from the matrix:

- opt-in exact replay, changed-request conflict, response loss after collector
  commit, Game restart `grant_lost` plus fresh generation, cap `31/32/33`, and trace/run/lease
  replacement before grant installation;
- synchronization duplicate replay, fresh sample after response loss, changed instance/trace substitution, expiry
  equality, and delayed old-grant response after restart;
- report accepted/replayed/conflict, report-before-stop versus stop-before-report,
  unseen revoked work, pre-opt-in sequence/time, rate limit, and one pending
  upload replacement;
- membership loss, ended run, segment/lease rotation, trace expiry, malformed or
  oversized E1/sample/collector output, and Access/State/collector timeout; and
- UI opt-in/stop response loss, no pre-opt-in backfill, no durable grant, and
  collector failure with unchanged local measurement/audio/game state.

The local pre-code counterexample question is: what smallest changed grant,
sample, consent generation, report identity, or retained response preserves all
currently checked fields but would authorize a different member, instance,
trace, segment, lease, time interval, or pre-opt-in report? Each valid answer is
added to the matrix-derived tests before closure review.

E8.3b implementation is authorized only within this boundary. E8.3c remains
unauthorized and retains source/relay/maintenance callers and final local
cross-route failure isolation. E12 retains deployed-browser timing, real-host
credential installation, and measured network/resource behavior.

### E8.3b implementation checkpoint

The contained implementation now provides the bounded Game listener grant,
same-origin consent/synchronization/report routes, exact E1/E2 composition,
and a volatile browser controller attached to the existing E5/E6 local panel.
The browser retains no grant or pending report in storage. It advances the
upload floor at opt-in acknowledgement, keeps at most one report pending,
uses a fresh synchronization exchange after response loss, retries the exact
report after report-response loss, and admits no new upload while stop is
uncertain.

Local evidence before independent review:

- full production Web build and suite: `npm test` in `web` (`300/300`);
- focused listener mediation/controller/routes: `32/32`;
- fixed grant capacity: explicit `31/32/33` rows and expiry equality; and
- lint: zero errors, with only the pre-existing E5 `_status` warning.

The pre-closure adversarial pass additionally exercises exact opt-in and
synchronization replay after current correlation changes, post-commit opt-in
response loss, restart `grant_lost`, retained-result rebinding, same-key queue
depth, concurrent browser controls, terminal report outcomes, disposed
completions, bounded dependency JSON, the full pre-opt-in disclosure, and the
structural non-awaited diagnostics retirement edge in production audio start.

This is an implementation checkpoint, not a closure claim. Independent E8.3b
review remains required before E8.3c authorization.
