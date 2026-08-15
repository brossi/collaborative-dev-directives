# S2-E E8 diagnostic mediation

Status: `E8.1 implemented; independent closure review pending`. E8.2 and E8.3
remain unimplemented and unauthorized until the preceding increment closes.

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
| `/v1/game/trace/start` | POST | Game | `{command,authority}` | `startTrace` |
| `/v1/game/trace/end` | POST | Game | `{command,authority}` | `endTrace` |
| `/v1/game/segment/rotate` | POST | Game | `{authority}` | `rotateSegment` |
| `/v1/game/synchronization/issue` | POST | Game | `{traceId,issuance}` | `putIssuance` |
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
boundary, nine exact Game request families, and maintenance purge validator.
The existing server can enable that adapter only through its constructor; the
Compose entry point remains in E7.3 status-only mode until E8.3 supplies secret
files and caller wiring. Enabling malformed or equal credentials fails before
collector construction.

The E2 module adds three narrow production byte entry points for
synchronization issuance, operation authority, and canonical uploaded
envelopes. They share the same private provenance sets, exact normalizers, and
canonical checks as the existing E2 reducers; no network, store, State, or later
checkpoint dependency enters E2.

Matrix-derived tests enumerate all nine Game request families and delegate
operations, both credential scopes, every documented HTTP error family, exact
8-KiB and 8-KiB+1 bodies, invalid UTF-8/JSON/shape, timeout cleanup, unexpected
dependency failure, maintenance status/purge, startup credential failure before
collector creation, and exact HTTP replay/conflict across a real collector
restart. The local counterexample pass found no open P0/P1.

Verification at the implementation worktree:

- E1/E2/E7/E8.1 focused suite: `75/75`;
- full Web production build and suite: `248/248`;
- Web lint: zero errors; and
- syntax and `git diff --check`: pass.

This record claims no deployed secret, State authority response, public Game
route, producer caller, host authorization, or failure isolation across a Game
transaction. Permitted status remains `E8.1 implemented; independent closure
review pending`.
