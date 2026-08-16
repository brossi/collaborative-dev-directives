# S2-E E12 real-environment rehearsal and Slice 2 closure

## Identity and status

- Checkpoint: E12 / S2-F — real-environment proof
- Status: `design closed; local evidence tool implemented; independent local
  closure review pending; external execution not authorized`
- Risk class: `C — irreversible/external`, because the rehearsal provisions
  provider resources, installs temporary credentials, exercises real Spotify
  authorization, restores data, and destroys disposable hosts
- Required verified checkpoints: S2-A through S2-D and E1-E11 at their recorded
  closure targets
- Product scale: one disposable application host, one disposable managed-source
  host, one host browser, and two listener browsers; this is not device
  certification or a load-test program

## Governing invariant

> The locally closed Slice 2 contracts remain true on the exact hosts, browsers,
> network paths, and audio outputs used for the rehearsal; any contradictory
> measurement returns to its named owning checkpoint, while every temporary
> credential, data copy, host, socket, volume, and provider resource is either
> explicitly retained as sanitized evidence or removed.

E12 measures and composes existing contracts. It does not weaken authority,
privacy, replay, correlation, routing, or isolation rules and does not invent a
production migration. A failed measurement is evidence, not a waiver.

## Fixed rehearsal boundary

The minimum supported matrix is deliberately small:

| Role | Exact rehearsal target |
| --- | --- |
| Application and relay | one fresh NYC3 host with controlled public egress and no public inbound, restored from retained provider snapshot `240743050` |
| Managed source | one fresh NYC3 host with controlled public egress and no public inbound, restored from retained provider snapshot `240743052`; a new disposable Spotify browser authorization is performed interactively and is never copied into evidence or an image |
| Host browser | current operator Mac, macOS `26.5.1`, Safari `26.5` |
| Listener A | the same Mac in Chrome `151.0.7922.110`, using a separate browser authority/session |
| Listener B | one real iPhone Safari used for a game night; exact device-neutral iOS and Safari major versions are recorded before the first mutation |
| Audio outputs | the Mac's selected output and the iPhone's selected output; names and hardware serials are not recorded |

Firefox and broader desktop/mobile matrices are outside Slice 2. If the iPhone
is unavailable or its version is not recorded before the run, E12 cannot claim
real-device closure. Browser profiles used for different roles must not share
cookies or copied session storage.

The provider context is `cannabeats-p2e1`. Existing Droplets
`559513055` (`bracket-challenge`) and `591348986`
(`cannabeats-audio-source-poc`) are protected and read-only for this rehearsal.
The two retained image IDs above are protected. New resources use a unique
`cannabeats-s2f-YYYYMMDD-*` prefix, size `s-2vcpu-4gb` (two 4-GiB hosts,
currently USD 24/month each; planned eight-hour compute below USD 1 total),
project `6751c1ab-8303-490d-af5b-0f6ecf35d22c`, VPC
`3d117cd8-9efc-4df5-9cc7-8ff1a2ee15f1`, operator SSH-key ID `29645296`, no
public IPv6, no Droplet agent, and a hard eight-hour local-service lifetime.
Public IPv4 exists only
for controlled outbound TCP `80/443` and the DNS/Tailscale UDP traffic required
for enrollment and Spotify. Before either Droplet is created, the operator
creates a unique provider tag and a rehearsal cloud firewall targeting that
tag with exactly one private inbound TCP `22` rule sourced from protected jump
Droplet `559513055`, no public inbound rule, no other inbound rule, and only the
approved outbound rules. Both
Droplets are created with that tag. After creation, the union of every firewall
effectively attached to each Droplet is enumerated and must contain only that
exact jump-sourced private SSH rule and no public or other inbound rule; an
unexpected attachment stops the rehearsal and destroys the new Droplets.
Initial SSH uses the existing protected jump Droplet
`559513055` as an unmodified `ProxyJump` to each new VPC address. The operator's
private key never enters the jump host.

After bootstrap, both disposable hosts enroll as uniquely named, user-owned
ephemeral Tailscale nodes using single-use auth keys. No Tailscale tag, ACL,
grant, or `tagOwners` mutation is intended. Pre-creation checks prove that the
Mac and iPhone are enrolled and record existing MagicDNS, HTTPS, and policy
state. After node enrollment, both devices must positively reach the exact
application node on TCP `443` and must fail to reach the source node or a
non-`443` application port. If that path is not already allowed, or tailnet
HTTPS is not already enabled, execution stops
for a separate exact policy/HTTPS approval rather than changing the tailnet.
Mac and iPhone browsers reach only
an exact `https://<rehearsal-node>.<tailnet>.ts.net/game` origin using a
Tailscale certificate; the Access public origin, WebAuthn RP ID, cookies, Game,
State, collector, source, and relay origins are rendered and checked against
that disposable name before startup. No disposable default may reference the
protected PoC origin. Spotify and package traffic use only the controlled
public egress above. Tailscale node/key creation, provider tag/firewall
creation, public egress, certificate issuance (including the certificate
hostname's public Certificate Transparency publication), Spotify
authorization, and their destructive cleanup are included in the external
approval boundary. Tailnet/account identity is transient operator data and is
not retained in the sanitized ledger.

Before creation, the manifest records requested names, unique tag, provider
context, project, VPC, size, protected IDs, selected public SSH-key ID, and
exact cleanup commands. Each assigned provider ID is appended immediately
after its create call. The encrypted manifest is copied to a second
operator-controlled location before the next mutation; if that handoff cannot
be confirmed, the new resource is destroyed immediately. No command may target
a resource by a broad name filter alone.

## Fixed acceptance thresholds

These thresholds are fixed before provisioning:

| Measurement | Pass boundary and owner on failure |
| --- | --- |
| Synchronization | during each five-minute foreground enabled run, each listener/source/relay producer attempts at least 30 exchanges and at least 27 distinct E2 samples appear in accepted retained reports; HTTP success alone never counts. Every retained accepted local RTT is `<= 2,000 ms` and server receive/send is ordered inside the retained exchange; otherwise return to E2/E8/E9/E10 |
| Listener/source/relay windows | each foreground producer contributes at least 240,000 ms of unioned mapped accepted coverage during five minutes; accepted windows are positive and `<= 10,000 ms`; each listener records at most three explicit local coverage gaps and each source/relay has at most three discontinuities in its role-wide mapped interval union. Finite `coverage_gap` notices and per-instance discontinuities are recorded as supporting observations, not the numerical role gate; delayed browser coverage is one explicit local gap rather than split or fabricated; otherwise E5/E9/E10 |
| Clock comparison | only E2-mapped intervals sharing the issued timebase may establish precedence; overlap remains insufficient; otherwise E2/E3 |
| Playback non-interference | two sequential five-minute steady-track runs—upload disabled, then enabled—each show zero new underrun, overflow, reconnect, or dropped-PCM events and uninterrupted publication/listener playback; this is an observed parity gate, not a causal benchmark; otherwise E4/E5/E9/E10 |
| Real-client usefulness | sampled every five seconds, enabled host CPU p95 may rise by at most 10 percentage points of total two-vCPU host capacity and resident memory by at most 128 MiB relative to the disabled run; neither host may OOM/restart, and the foreground coverage/synchronization gates above must hold. Portable iPhone CPU/RSS is not claimed. |
| Browser lifecycle | the action matrix below binds old and successor instance identities rather than relying on global collector totals. After wake, timing starts after any browser-required explicit resume gesture: the same run/seat is visible within 15 seconds and a valid successor window or explicit gap appears within 20 seconds. Exact timer/reader/worklet enumeration remains E5 owner-test evidence. |
| Producer isolation | collector stop, timeout, malformed response, and response loss leave gameplay readiness, source authority polling, relay publication, listener fan-out, and audio continuation unchanged. Access/State interruption must instead produce finite failure and expected readiness degradation; already-playing audio may continue but no new authority mutation may succeed. |
| Collector filesystem | deployed database + WAL + SHM are measured below `256 MiB`, host free space remains at least `1 GiB`, service tmpfs/log/container caps render exactly, and checked disposal removes only the diagnostic volume. Threshold transition/recovery remains E7's injected owner evidence; E12 does not fill a real filesystem. |
| Capacity | one host, two listeners, one active trace, the fixed reporter slots, and the existing service CPU/memory/PID limits complete without OOM, service restart, or an invented partial result; larger loads are not claimed |
| Recovery | one post-commit response-loss retry returns the original result; browser refresh within 15 seconds, relay restart within 30 seconds, source-service restart within 60 seconds, source-host reboot within 180 seconds, and application/collector restart within 60 seconds converge to one current run/lease/generation. Durable game effects are not duplicated; external audio retains S2-D's at-most-once `outcome_unknown`/quarantine rule rather than being retried blindly. |
| Retention/privacy | listener stop and trace end block unseen/new upload; an exact retained report identity may still return its original replay result until maintenance purge, after which the trace is concealed. Exact 48-hour boundaries remain E7 owner-test evidence because deployed wall time is not altered. Retained logs/output contain no token, bearer, cookie, member name, IP/peer, native exception, raw PCM, or raw measurement object; sanitized command notation may name repository-relative paths while ephemeral encrypted manifests may contain private addresses and absolute paths. |
| Backup/rollback | encrypted backup verifies and restores into an isolated target; the intentionally failed release restores exact prior image IDs and leaves an unrelated sentinel unchanged; otherwise S2-A/S2-B/Slice 1 protection |

Measurements use five-second samples and retain only count, minimum, maximum,
median, and p95 aggregates. Host CPU is computed from deltas in `/proc/stat`
and allowlisted `/proc/<pid>/stat` records as process CPU divided by total host
CPU across both vCPUs, multiplied by 100; RSS bytes come from allowlisted
`VmRSS` fields in `/proc/<pid>/status`. Mapping uncertainty and database bytes are recorded
as observations under the gates above. Cleanup starts within five minutes of a
terminal result or blocker and completes within 30 minutes unless the provider
reports a still-running action; the exact action is then recorded and polled to
a finite result. Thresholds are not changed after the run.

## Closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: one reviewed manifest names every requested disposable Droplet, credential, release, browser session, data copy, Compose project, volume, and evidence file before creation; assigned provider IDs are appended immediately after each successful create. |
| Update | `runtime`: only the exact disposable hosts and rehearsal database may receive the candidate, credentials, faults, or restored data; protected resources are checked by ID before every provider mutation. |
| Delete | `runtime`: cleanup uses exact provider/container/volume identities; listener consent and trace authority end while the owners are live, then source registration and Spotify/Tailscale authority are revoked, data/volumes are disposed, hosts are sanitized/destroyed, and absence is proved. |
| Omit | `runtime`: the evidence ledger has one result or named blocker for every threshold and schedule; an unavailable real device or unexecuted destructive schedule remains open rather than being inferred from local tests. |
| Duplicate | `runtime`: unique resource prefixes, exact request IDs, pairwise credential preflight, and provider-ID inventory prevent duplicate authority/resources; response-loss schedules verify one effect. |
| Reorder | `runtime`: inventory and baseline precede faults; faults are cleared and health re-established before the next scenario; backup precedes failed release; credential revocation precedes host destruction. |
| Replay | `runtime`: start/stop, listener consent, source/relay binding, report, and one representative game mutation commit then lose the response and retry the exact identity through the deployed route. |
| Conflict | `runtime`: changed reuse of one retained request ID and all three pairwise diagnostic credential collisions fail before effect during disposable preflight. |
| Concurrency | `runtime`: one duplicate/concurrent game action, one same-key diagnostic request, and two simultaneous listener reads exercise fixed serialization; no generalized load test is claimed. |
| Expiry | `runtime`: exact 48-hour and issuance equality remain owner-test evidence; the real run exercises browser sleep beyond one window, sample expiry, consent stop, trace end, and purge without changing wall clocks. |
| Restart | `runtime`: application service restart, collector restart, source reboot, relay restart, and browser refresh restore only their documented durable or volatile state; exact IDs are recorded across each edge. |
| Dependency failure | `runtime`: a loopback-only one-shot fault proxy produces post-upstream-response loss, bounded delay, and malformed dependency output without logging bodies. Collector faults preserve unrelated planes; Access/State faults produce their documented readiness degradation; Spotify/browser interruption retains S2-D external-effect semantics. |
| Corruption | `runtime`: real hosts rerun startup validation and one isolated restored-copy corruption check; production or protected data is never corrupted for evidence. |
| Capacity | `runtime`: one manifest fixes two hosts, three browser contexts, two listeners, one trace, existing protocol maxima, the eight-hour lifetime, and cleanup reserve; no fleet extrapolation is made. |

## Ordered rehearsal

### 1. Preflight and authority freeze

1. Require a clean exact candidate commit and record repository/submodule pins,
   image IDs, local build identities, tool versions, browser versions, provider
   account/context, VPC, protected resource IDs, and the intended disposable
   names.
2. Create the encrypted cleanup manifest, exact-ID cleanup script, and rendered
   eight-hour host service-stop/sanitize timer; verify a second
   operator-controlled copy and provider/Tailscale cleanup authority. The timer
   cannot be armed until a host exists: exact provider IDs in the off-machine
   manifest are the fallback during the creation-to-bootstrap interval. Obtain
   explicit operator authorization for Droplets, the unique provider tag and
   firewall, public egress, Tailscale ephemeral node/key/certificate and CT
   publication, temporary Spotify authorization, and final destructive
   cleanup. No external mutation occurs before that approval.
3. Build the checked-in privacy-safe evidence sampler and loopback-only fault
   proxy used by the rehearsal and prove locally
   that its three one-shot modes are body-silent and finite: forward the request
   and discard only after the upstream response (post-commit response loss),
   delay, or replace the upstream response with bounded malformed JSON.
4. Run the complete local regression and every recorded Slice 1 protection
   gate. A failure stops the rehearsal before provider mutation.

### 2. Fresh hosts and exact candidate

1. Create the unique provider tag and private-jump-only inbound firewall first,
   then create
   the two tagged controlled-egress hosts from the retained provider snapshots,
   append IDs/private addresses to the encrypted manifest, copy it off-machine,
   and verify no IPv6, no Droplet agent, the union of all effectively attached
   firewall rules contains only the exact private TCP `22` rule sourced from
   protected jump Droplet `559513055`, has no public or other inbound rule, and
   has only the approved outbound rules. As the first bootstrap action on each host, install, arm, and verify
   its pre-rendered eight-hour stop/sanitize timer. Every exit after this step enters the
   cleanup branch in section 6, including operator-machine or network failure.
2. Transfer an archive of the exact candidate rather than the working tree.
3. Enroll both hosts as the exact ephemeral user-owned Tailscale nodes through
   the VPC jump path; verify Mac and iPhone can reach only the application node
   on TCP `443`, including negative source-node and non-`443` checks, without
   mutating ACLs or tags;
   issue the exact Tailscale HTTPS certificate; render the disposable origin,
   RP ID, internal routes, and firewall; and prove no value references a
   protected PoC endpoint.
4. Install the candidate and generate new disposable credentials off-output.
   Install the checked-in `tools/s2f-host-sample.py` and
   `tools/run-s2f-host-sample.sh` root-owned with mode `0755` on both hosts; invoke the
   wrapper as root so cross-UID `/proc/<pid>/exe` attestation is available.
   This uses the already-required `/usr/bin/python3` and does not add Docker or
   Node to the managed-source host.
   Install their exact modes/owners, run the three-way
   Game/relay/maintenance collision preflight over those actual values, then
   start Access, State, Game, collector, and relay base services with source
   controller/reporter stopped. Validate schema, topology, readiness, socket
   ownership, and fixed resource limits.
5. Create disposable host/browser authority, register the managed source
   through live State, install its once-shown token, and start source
   controller/relay publisher/reporters. Authorize Spotify interactively last.
   Re-run readiness and record only finite status categories.

### 3. Baseline and enabled measurements

1. Create one host run and two distinct listener sessions. In each browser,
   start audio with an explicit user gesture and confirm the selected output by
   hearing it. Play one steady track for five minutes with upload disabled,
   then five minutes with one trace and both listeners opted in.
2. Record five-second scalar samples and retain only aggregates for
   CPU/memory/PID/filesystem, source/relay/listener counters,
   startup/re-prime/underrun/overflow deltas, RTT/uncertainty, coverage, and
   service restart counts. Do not record raw PCM, cookies, tokens, member names,
   full user agents, output-device names, or hardware identifiers.
3. Verify local copy still works with collector stopped and the advanced host
   comparison is host-only and minimized.
4. On the iPhone, separately exercise 30 seconds of app-switch background and
   30 seconds of screen lock. Timestamp foreground/wake, apply only an explicit
   browser-requested resume gesture, and evaluate the lifecycle/coverage
   thresholds rather than inferring internal browser resources.

### Evidence acquisition and browser action matrix

Before external authorization, a checked-in `tools/s2f-evidence.mjs` and its
tests must implement the following bounded observation boundary. The tool is
both the loopback one-shot fault proxy and an allowlisted sampler. The single
classified `collector-sync` profile sits only on Game's multiplexed collector
origin, transparently forwards non-issuance routes, and counts synchronization
attempts only at `/v1/game/synchronization/issue`. Body-silent `passthrough`
profiles may be inserted on the other already-classified mutation paths solely
to inject a one-shot response fault; they never count synchronization attempts.
Each profile records route family, finite outcome/status, and monotonic time,
but never records
request/response bodies, request IDs, trace/instance/sample IDs, credentials,
URLs, addresses, or native errors. It may parse only the exact route identity
fields in memory to bind attempts to the encrypted ephemeral role map. Proxy
request arrival counts as an attempt only when its exact trace ID matches the
encrypted run configuration; a foreign trace fails before forwarding/counting.
HTTP response status never counts as a successful synchronization.

The sampler transiently reads the complete collector trace through the
production Game/E2 restoration seam. A synchronization success is one distinct
restored E2 sample referenced by an accepted retained report for that producer;
this is deliberately conservative when a successful sample produced no report.
The auxiliary input declares exact five-minute mapped, proxy-monotonic, and
per-host-monotonic intervals. Attempts and host samples outside their interval
fail input validation; mapped report intervals are clipped to the declared
mapped interval, and reports outside it remain fully validated but do not
contribute to that run's sample/window/coverage totals.
The sampler aggregates those distinct samples, unioned accepted interval
duration, retained interval discontinuities, and last sequence by ephemeral
producer/instance label. Coverage uses the midpoint of each restored E2 mapped
start/end bound and unions those trace-time intervals first per instance and
then across every instance of the role, so overlapping successor generations
cannot double-count real coverage. Instance labels are restricted to
`instance-01` through `instance-16`; caller/member-authored labels cannot enter
retained output. For each listener, the
operator enters the integer displayed as E6 `gapCount` through the fixed
`browser-gap --role <listener-a|listener-b> --count <safe-integer>` command and
confirms the displayed role before submission. Source and relay numerical gap
counts come from discontinuities in the union of restored mapped windows across
the role; the summary also retains each safe-labeled instance's discontinuity
count. Exact `coverage_gap` finite notices from their allowlisted systemd
journal units are retained only as supporting counts; all other journal text is
ignored. The tool samples only the allowlisted app containers and source
systemd PIDs through the `/proc` formulas above. Each allowlisted process is
rebound on every sample to its exact executable link, cgroup membership, and
start-time field; only a hash of those facts, fixed service label, and
allowlisted scalar counters enter the raw sample. The stable complete roster is
required across the series before the tool emits fixed finite categories and
count/min/max/median/p95 aggregates. Raw samples and the role-to-identity map
remain only in the encrypted manifest and are deleted during cleanup.

The local tool increment is governed by this invariant:

> Every emitted rehearsal result is a bounded aggregate of a complete,
> trace-bound set of restored E2 envelopes and allowlisted scalar observations,
> while each injected fault is one finite loopback transaction that records no
> body, credential, or durable identity.

Its implementation matrix is:

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `structural`: four fixed producer roles and two fixed host roles are the only aggregate keys; the tool creates no authority or durable row. |
| Update | `structural`: inputs are validated into a new frozen summary; retained summary values are not mutated. |
| Delete | `not_applicable`: the tool owns no durable state; encrypted raw-input cleanup remains the mandatory E12 manifest operation. |
| Omit | `runtime`: exact top-level fields, one exact five-minute observation boundary in all three clock domains, all four instance-label maps, trace binding, restored accepted samples, unioned interval coverage/discontinuities, gap inputs, and both host aggregates are required before output. |
| Duplicate | `runtime`: instance ownership is unique and duplicate report identity fails before aggregation; distinct sample IDs alone count as synchronization success. |
| Reorder | `runtime`: proxy attempts must be monotonic within each role; proxy and one-shot host-sample processes use host monotonic time; host samples are ordered by that time and invalid/nonpositive deltas fail; report order does not alter aggregate totals. |
| Replay | `structural`: summarization is pure; a fault profile consumes its one-shot mode once, and later requests pass through normally. |
| Conflict | `runtime`: foreign trace, cross-role instance reuse, wrong route/identity, and unknown profile identity fail before output or forwarding. |
| Concurrency | `structural`: one Node event loop atomically consumes the one-shot fault flag; the tool performs no concurrent durable mutation. |
| Expiry | `not_applicable`: E2 restoration proves sample validity; the tool does not create or extend authority/retention. |
| Restart | `not_applicable`: no tool state is claimed durable; restart re-creates a profile from the encrypted manifest and cannot count as response-loss evidence already in flight. |
| Dependency failure | `runtime`: the deadline starts before inbound-body reading and bounds body, fetch, and response-body completion even when a dependency ignores abort; fault-proxy requests and ordinary responses are capped at 8 KiB, the exact collector trace-read response retains its production 2 MiB cap, delay is capped at ten seconds, redirects/native failures normalize finitely, broken evidence output is contained, and peer disconnect cannot alter authority. |
| Corruption | `runtime`: exact E2 envelope restoration, trace/role relations, report identity, `/proc` scalar parsing, and fixed journal/browser inputs fail closed before a summary. |
| Capacity | `runtime`: 4,096 reports, 16 collector pages, 512 attempts/notices, 512 host samples, at most 32 allowlisted processes in each host sample, 16 instances per role (64 total), an 8 KiB proxy body, a 2 MiB collector page, and a 32 MiB offline summary input are hard maxima. |

Local verification is `node --test tools/s2f-evidence.test.mjs`,
`python3 -m unittest tools/test_s2f_host_sample.py`,
`node --check tools/s2f-evidence.mjs`, and `git diff --check`. Tests derive the
accepted-sample false-pass, mapped successor overlap,
foreign-trace/unmapped/duplicate/cross-role corruption, browser/journal gap
allowlists, stable `/proc` roster projection, loopback/upstream/body/deadline
bounds, exact 16-page cursor progression, nested collector identity and trace
attribution, five-minute observation ownership, multiplexed-route/2-MiB read
transparency, cross-UID host sampling, broken observer output, malformed
output, and post-commit response-loss schedules from this matrix.

The executable surfaces are deliberately small:

- `summarize-live` reads auxiliary evidence from standard input, obtains every
  cursor-bound page with the production collector client and Game credential,
  restores E2 envelopes, and writes only the sanitized summary;
- `summarize` performs the same aggregation over an encrypted-manifest export
  for local/recovery verification;
- `proxy` binds collector issuance identities through
  `S2F_EPHEMERAL_ROLE_MAP`, transparently forwards every other collector route,
  or runs a body-silent `passthrough` mutation profile;
- `host-sample` provides the Node owner seam; the root-only
  `tools/run-s2f-host-sample.sh` invokes the matching bounded Python companion
  on each real host so it can read cross-UID allowlisted `/proc` identities;
  both accept only `S2F_ALLOWLISTED_PIDS_JSON`; and
- `browser-gap` and `coverage-notices` accept only their fixed role/code forms.

The role, trace, and process environment inputs are removed from the tool
process immediately after parsing. They and collector credentials are
transient encrypted-manifest inputs, never command-line arguments or retained
summary fields.

The checked-in attachment is equally narrow. The production Game image copies
the tool and only its E1/E2/collector-client dependencies. The
`spikes/access-spotify-poc/compose.s2f.yaml` overlay runs that exact image in
Game's network namespace, moves only Game's collector origin to loopback, and
mounts only the Game-scoped collector credential; it publishes no port and has
no maintenance credential. The root-only host wrapper and Python companion are
installed directly from the exact candidate on each disposable host and use no
network; stable executable/cgroup/start-time relations are rechecked on every
sample. Other passthrough placements remain explicit
per-schedule client-origin overrides recorded in the encrypted manifest; the
tool is never described as transparently intercepting traffic without one.

The browser action worksheet has one row per action and uses these exact
expectations:

| Action | Required observable result |
| --- | --- |
| Diagnostic reset | the old E5 instance receives no later accepted report; a new acknowledged instance may report, so global totals may increase |
| Listener sharing stop | no unseen/new report is accepted under the stopped grant; exact retained identity replay may return `replayed`; local E5 collection may continue |
| E6 local-panel close | only local UI polling stops; E5 collection and an already-enabled sharing controller may continue |
| E11 host-panel close | comparison reads stop; listener/source/relay upload may continue |
| Page teardown or **Stop listening** | the retired E5 instance receives no later accepted report and no successor exists until a later explicit start |
| Browser refresh | the same seat/run returns within 15 seconds; the old instance retires; sharing is not silently restored; an explicit audio gesture and fresh opt-in may create a successor |
| 30-second app switch or screen lock | the current instance either resumes or records a finite gap; after any browser-requested explicit resume gesture, a valid current/successor window or gap appears within 20 seconds |

Only an action that retires a producer is tested for unchanged per-instance
counts. Panel closure is never treated as producer retirement, and unrelated or
successor activity cannot satisfy or fail an old-instance assertion.

### 4. Failure and recovery schedules

Run one schedule at a time, clear it, and prove one coherent owner before the
next:

- post-commit response loss through the one-shot fault proxy for one game
  action and each deployed diagnostic mutation family representative of
  browser, source, relay, and maintenance; ordinary pre-commit network loss is
  recorded separately and cannot count as replay evidence;
- duplicate/concurrent action, lease contention, and changed request conflict;
- browser refresh, iPhone background/sleep beyond one window, wake, consent
  stop, diagnostic reset, and trace stop;
- source service restart and full source-host reboot;
- relay interruption, delayed old generation, listener disconnect/reconnect,
  and a bounded shaped-network interval;
- collector timeout/stop/malformed response with unchanged
  gameplay/audio/readiness; then separate Access and State interruptions with
  finite route failures, expected readiness degradation, already-playing audio
  observation, and refusal of new authority mutations;
- host comparison for normal/missing evidence and one real injected
  source/relay/listener fault whose E3 result is checked without hand-authored
  evidence; and
- collector restart, application restart, reconstruction, whole-trace purge,
  and post-purge concealment.

The real-host corruption schedule operates only on a copied collector database
inside an isolated disposable container: mutate one relationship, restart that
copy, require finite degraded status, then delete the container and copy. The
real filesystem schedule records deployed DB/WAL/SHM, free-space, tmpfs, log,
memory, CPU, and PID values but does not manufacture pressure; E7's owner tests
remain the threshold-transition evidence.

### 5. Backup, failed release, and restore

1. Create and verify one encrypted backup, copy it off the disposable host,
   restore it into an isolated target, and compare protected table counts,
   schema identity, catalog identity, integrity, foreign keys, and file mode.
2. Record exact current image IDs and an unrelated sentinel, inject one
   disposable readiness failure, run release, and prove automatic exact-image
   rollback plus unchanged sentinel identity/start time.
3. Keep the isolated restore, off-host encrypted backup, and passphrase only
   until their comparisons are recorded. Delete the restored container/volume,
   every host/workstation backup copy, and the passphrase before authority
   volumes or hosts are destroyed.

### 6. Mandatory cleanup on success, failure, or interruption

This branch is entered after every terminal result or blocker once the first
external mutation has occurred. It is pre-rendered before creation and may be
completed by another authorized operator from the off-machine manifest.

1. While collector and State are available, stop listener consent, end the
   trace, stop producer reporters, verify unseen/new source/relay/listener
   uploads fail while an exact retained report identity may still return
   `replayed`, disable the disposable managed-source registration (which
   releases its lease), then purge the trace and verify concealment. There is no
   invented source-grant revoke operation: trace end/expiry and reporter
   restart make that volatile grant unusable.
2. Revoke/remove Spotify authorization and the disposable Tailscale nodes and
   auth keys; deleting a local browser profile alone is not called revocation.
   Remove browser profiles, cookies, credentials, fault-proxy state, temporary
   restore data, backup material, and passphrases.
3. Stop and remove only the diagnostics container, run checked diagnostic
   volume disposal, and prove authority volumes remain. Sanitize both hosts and
   allow the pre-armed local timer to remain a fallback until destruction.
4. Destroy and confirm absence of only the manifest-listed disposable Droplets
   before deleting the rehearsal firewall and provider tag. If a host
   is unreachable, use the provider IDs from the off-machine manifest; host
   cleanup is not a prerequisite for provider deletion. Verify provider,
   Tailscale, Compose, volume, credential, local temporary-file, and browser
   inventories are empty. Host destruction constitutes final timer disarm; if
   destruction is delayed, keep the verified timer armed until absence is
   confirmed.
5. Retain no new provider snapshot unless a separate review explicitly
   authorizes its sanitized contents. Scan the final ledger and repository diff
   before declaring cleanup complete.

## Evidence and closure

The execution record is
`docs/operations/slice-2-s2f-rehearsal-YYYY-MM-DD.md`. It contains exact commit,
tree and sibling pins; sanitized resource IDs; timestamps; commands and finite
results; observed scalar measurements; before/after counters; rollback image
IDs; cleanup proofs; and a threshold-by-threshold verdict. Secret values,
account email, public/private IPs, absolute host paths, cookies, device
model/serial, Spotify identity, member names, raw reports, raw measurements,
and PCM are excluded. Commands are retained only as sanitized repository-
relative notation. Private addresses, absolute paths, full commands, and
temporary scalar samples may exist only in the encrypted manifest during the
run; they are reduced to allowlisted aggregates and deleted during cleanup.

E12 and Slice 2 close only when the matrix is complete, the local and real
evidence passes, no P0/P1 remains, every failed measurement has returned to and
closed at its owning checkpoint, the evidence scan passes, and all temporary
resources are absent. Otherwise the status remains `rehearsal incomplete` with
the exact blocker named.

## Design closure record

The initial design at `18ff7aefb2c9a52ef15a52804760fdbcf25d075d`
received independent authority/lifecycle, topology/evidence, and HTTP/privacy
review. Remediation was recorded through
`2ebef5347a86deebc4815b9d0cde965d4bdf0dda`. Narrow re-review of the affected
seams found `P0=0`, `P1=0`, and `P2=0`: action-specific browser ownership,
accepted-sample evidence, cleanup/timer ordering, private jump-only firewall
bootstrap, and user-owned ephemeral Tailscale verification are design-closed.

This record authorizes only the checked-in local sampler/fault-proxy increment.
It does not authorize provider, firewall, Tailscale, Spotify, browser-profile,
credential, or destructive external mutations. Those remain behind the exact
operator approval described above.
