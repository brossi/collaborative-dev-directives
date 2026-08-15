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
