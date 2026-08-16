# S2-E E12 real-environment rehearsal and Slice 2 closure

## Identity and status

- Checkpoint: E12 / S2-F — real-environment proof
- Status: `designed; external execution not yet authorized`
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
| Application and relay | one fresh private-only NYC3 host restored from retained image `240743050` |
| Managed source | one fresh private-only NYC3 host restored from retained image `240743052`; a new disposable Spotify browser authorization is performed interactively and is never copied into evidence or an image |
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
`cannabeats-s2f-YYYYMMDD-*` prefix, no public IPv4, no Droplet agent, the
existing NYC3 VPC, and an eight-hour maximum planned lifetime. Resource IDs are
recorded before any mutation and checked again before cleanup. No command may
target a resource by a broad name filter alone.

## Fixed acceptance thresholds

These thresholds are fixed before provisioning:

| Measurement | Pass boundary and owner on failure |
| --- | --- |
| Synchronization | local RTT `<= 2,000 ms`; server receive/send ordered inside the retained exchange; otherwise return to E2/E8/E9/E10 |
| Listener/source/relay windows | accepted windows are positive and `<= 10,000 ms`; delayed browser coverage becomes an explicit local gap, never split or fabricated; otherwise E5/E9/E10 |
| Clock comparison | only E2-mapped intervals sharing the issued timebase may establish precedence; overlap remains insufficient; otherwise E2/E3 |
| Playback non-interference | for one five-minute steady track before and after diagnostics enablement, diagnostics adds zero underrun, overflow, reconnect, or dropped-PCM events and PCM publication/listener continuity does not change; otherwise E4/E5/E9/E10 |
| Browser resources | start, reset, stop, background/wake, and page teardown leave no live diagnostic timer, reader, AudioContext, worklet, observer, or pending action owned by the retired generation; otherwise E5/E6/E11 |
| Producer isolation | stopping, timing out, corrupting, or withholding the collector leaves gameplay readiness, source authority polling, relay publication, listener fan-out, and audio continuation unchanged; otherwise E7-E10 |
| Collector filesystem | database + WAL + SHM remain below `256 MiB`, measured free space remains at least `1 GiB`, replay/read/end/purge remain available under the documented pressure gates, and checked disposal removes only the diagnostic volume; otherwise E7 |
| Capacity | one host, two listeners, one active trace, the fixed reporter slots, and the existing service CPU/memory/PID limits complete without OOM, service restart, or an invented partial result; larger loads are not claimed |
| Recovery | one response-loss retry returns the original result; source reboot, relay interruption, browser refresh/sleep, and network interruption converge to one current run/lease/generation without duplicate game/audio effects; otherwise the owning S2-D/E checkpoint |
| Retention/privacy | stop blocks future listener upload, purge conceals the trace, 48-hour retention is not shortened or extended in the test clock, and reviewed logs/output contain no token, bearer, cookie, member name, IP/peer, filesystem path, native exception, raw PCM, or raw measurement object; otherwise E1/E6-E10 |
| Backup/rollback | encrypted backup verifies and restores into an isolated target; the intentionally failed release restores exact prior image IDs and leaves an unrelated sentinel unchanged; otherwise S2-A/S2-B/Slice 1 protection |

CPU, memory, scheduling latency, database bytes, synchronization RTT, mapping
uncertainty, startup time, and cleanup duration are recorded as observations.
They are not converted into new pass thresholds after the run. Existing
container and protocol limits above remain the gates.

## Closure matrix

| Dimension | Disposition and enforcement |
| --- | --- |
| Create | `runtime`: one reviewed manifest names every disposable Droplet, credential, release, browser session, data copy, Compose project, volume, and evidence file before creation; provider IDs replace requested names immediately after creation. |
| Update | `runtime`: only the exact disposable hosts and rehearsal database may receive the candidate, credentials, faults, or restored data; protected resources are checked by ID before every provider mutation. |
| Delete | `runtime`: cleanup uses exact provider/container/volume identities, revokes disposable source registration and Spotify/Tailscale authorization first, sanitizes hosts, then destroys them and proves absence. |
| Omit | `runtime`: the evidence ledger has one result or named blocker for every threshold and schedule; an unavailable real device or unexecuted destructive schedule remains open rather than being inferred from local tests. |
| Duplicate | `runtime`: unique resource prefixes, exact request IDs, pairwise credential preflight, and provider-ID inventory prevent duplicate authority/resources; response-loss schedules verify one effect. |
| Reorder | `runtime`: inventory and baseline precede faults; faults are cleared and health re-established before the next scenario; backup precedes failed release; credential revocation precedes host destruction. |
| Replay | `runtime`: start/stop, listener consent, source/relay binding, report, and one representative game mutation commit then lose the response and retry the exact identity through the deployed route. |
| Conflict | `runtime`: changed reuse of one retained request ID and all three pairwise diagnostic credential collisions fail before effect during disposable preflight. |
| Concurrency | `runtime`: one duplicate/concurrent game action, one same-key diagnostic request, and two simultaneous listener reads exercise fixed serialization; no generalized load test is claimed. |
| Expiry | `runtime`: before/equality/after remain owner-test evidence; the real run exercises browser sleep beyond one window, issuance/sample expiry, consent stop, and trace expiry or purge without changing wall clocks. |
| Restart | `runtime`: application service restart, collector restart, source reboot, relay restart, and browser refresh restore only their documented durable or volatile state; exact IDs are recorded across each edge. |
| Dependency failure | `runtime`: network interruption, collector stop/timeout/malformed response, Access/State unavailability, and Spotify/browser interruption return finite outcomes while the named unrelated planes remain unchanged. |
| Corruption | `runtime`: real hosts rerun startup validation and one isolated restored-copy corruption check; production or protected data is never corrupted for evidence. |
| Capacity | `runtime`: one manifest fixes two hosts, three browser contexts, two listeners, one trace, existing protocol maxima, the eight-hour lifetime, and cleanup reserve; no fleet extrapolation is made. |

## Ordered rehearsal

### 1. Preflight and authority freeze

1. Require a clean exact candidate commit and record repository/submodule pins,
   image IDs, local build identities, tool versions, browser versions, provider
   account/context, VPC, protected resource IDs, and the intended disposable
   names.
2. Obtain explicit operator authorization for the named provider create/destroy
   actions and temporary Spotify authorization. No Droplet is created before
   that approval.
3. Render Compose/systemd configuration and run the three-way
   Game/relay/maintenance credential preflight without printing values.
4. Run the complete local regression and every recorded Slice 1 protection
   gate. A failure stops the rehearsal before provider mutation.

### 2. Fresh hosts and exact candidate

1. Create the two private-only hosts from the retained images, record IDs and
   private addresses, and verify there is no public IPv4 or Droplet agent.
2. Transfer an archive of the exact candidate rather than the working tree.
3. Generate new disposable credentials off-output, install exact modes/owners,
   register a disposable managed source, and authorize Spotify interactively.
4. Install/start application, State, diagnostics, relay, source controller, and
   reporter units. Validate schema, credentials, topology, readiness, socket
   ownership, and fixed resource limits before creating a game.

### 3. Baseline and enabled measurements

1. Create one host run and two distinct listener sessions. Play one steady
   track for five minutes with upload disabled, then five minutes with one
   trace and both listeners opted in.
2. Record scalar CPU/memory/PID/filesystem observations, source/relay/listener
   counters, startup/re-prime/underrun/overflow deltas, RTT/uncertainty, and
   service restart counts. Do not record raw PCM, cookies, tokens, member names,
   or full user agents.
3. Verify local copy still works with collector stopped and the advanced host
   comparison is host-only and minimized.

### 4. Failure and recovery schedules

Run one schedule at a time, clear it, and prove one coherent owner before the
next:

- commit-and-lose-response for one game action and each deployed diagnostic
  mutation family representative of browser, source, relay, and maintenance;
- duplicate/concurrent action, lease contention, and changed request conflict;
- browser refresh, iPhone background/sleep beyond one window, wake, consent
  stop, diagnostic reset, and trace stop;
- source service restart and full source-host reboot;
- relay interruption, delayed old generation, listener disconnect/reconnect,
  and a bounded shaped-network interval;
- collector timeout/stop/malformed response and Access/State interruption,
  each with the documented unaffected gameplay/audio/readiness assertions;
- host comparison for normal/missing evidence and one real injected
  source/relay/listener fault whose E3 result is checked without hand-authored
  evidence; and
- collector restart, application restart, reconstruction, whole-trace purge,
  and post-purge concealment.

### 5. Backup, failed release, restore, and cleanup

1. Create and verify one encrypted backup, copy it off the disposable host,
   restore it into an isolated target, and compare protected table counts,
   schema identity, catalog identity, integrity, foreign keys, and file mode.
2. Record exact current image IDs and an unrelated sentinel, inject one
   disposable readiness failure, run release, and prove automatic exact-image
   rollback plus unchanged sentinel identity/start time.
3. Stop and remove only the diagnostics container, run checked diagnostic
   volume disposal, and prove authority volumes remain.
4. Stop the trace, revoke listener/source grants, disable the disposable source
   registration, log out of Spotify/Tailscale, remove browser profiles and
   credentials, sanitize both hosts, and scan retained evidence for prohibited
   fields.
5. Destroy only the inventoried disposable Droplet IDs. Verify provider,
   Tailscale, Compose, volume, credential, local temporary-file, and browser
   session inventories are empty. Retain no new image unless a separate review
   explicitly authorizes its sanitized contents.

## Evidence and closure

The execution record is
`docs/operations/slice-2-s2f-rehearsal-YYYY-MM-DD.md`. It contains exact commit,
tree and sibling pins; sanitized resource IDs; timestamps; commands and finite
results; observed scalar measurements; before/after counters; rollback image
IDs; cleanup proofs; and a threshold-by-threshold verdict. Secret values,
account email, public IPs, cookies, device model/serial, Spotify identity, member
names, raw reports, raw measurements, and PCM are excluded.

E12 and Slice 2 close only when the matrix is complete, the local and real
evidence passes, no P0/P1 remains, every failed measurement has returned to and
closed at its owning checkpoint, the evidence scan passes, and all temporary
resources are absent. Otherwise the status remains `rehearsal incomplete` with
the exact blocker named.
