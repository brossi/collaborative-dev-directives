# Slice 2 S2-F real-environment rehearsal — YYYY-MM-DD

- Status: `rehearsal incomplete`
- Governing specification: [E12 real-environment rehearsal](s2-e-e12-real-environment-spec.md)
- Candidate commit: `REQUIRED`
- Candidate tree: `REQUIRED`
- Pinned btaudio commit/tree: `REQUIRED`
- Application image digest: `REQUIRED`
- Source release identity: `REQUIRED`
- Rehearsal start/end UTC: `REQUIRED`
- Operator: `operator-confirmed` (no account name retained)

This ledger is the sanitized durable record. It must not contain credentials,
cookies, account or member names, public/private addresses, absolute host paths,
raw commands, raw reports/measurements, PCM, device identifiers, or native
errors. Those values may exist only in the encrypted temporary manifest and
must be deleted during cleanup.

## Risk-C authorization

Record one finite authorization result before the first external mutation:

- [ ] two disposable NYC3 `s-2vcpu-4gb` Droplets from the exact retained snapshots;
- [ ] one unique provider tag and private-jump-only firewall;
- [ ] controlled public egress and no public inbound beyond the approved private jump rule;
- [ ] single-use Tailscale keys, two ephemeral nodes, HTTPS certificate, and acknowledged CT publication;
- [ ] temporary Spotify authorization;
- [ ] disposable credentials, browser profiles, backup/restore copies, and evidence inputs; and
- [ ] destructive exact-ID cleanup of every rehearsal-owned resource.

- Authorization UTC: `NOT AUTHORIZED`
- Authorization result: `pending|authorized|refused`
- Interactive Mac/iPhone/Tailscale/Spotify availability: `unconfirmed`

If any item remains pending, stop before provider mutation.

## Preflight

| Gate | Required evidence | Result |
| --- | --- | --- |
| Exact source | clean candidate commit/tree and sibling pin | `pending` |
| Local closure | E12 design/local evidence P0/P1/P2 = 0 | `pending` |
| Images | exact local image IDs and successful production build | `pending` |
| Protected inventory | protected provider resources recorded by ID and read-only | `pending` |
| Private manifest | encrypted primary + second operator-controlled copy | `pending` |
| Cleanup authority | exact-ID provider/Tailscale cleanup access verified | `pending` |
| Eight-hour fallback | timer rendered before creation; off-machine provider fallback ready | `pending` |
| Provider boundary | project/VPC/SSH key/snapshot/size/cost and requested names fixed | `pending` |
| Tailnet boundary | devices enrolled; MagicDNS/HTTPS/policy state recorded; no policy mutation required | `pending` |
| Browser/device boundary | exact browser versions and physical audio availability recorded | `pending` |

## Sanitized resource inventory

Append assigned IDs immediately after each successful creation. Names and IDs
may be retained; addresses, keys, tokens, and provider/account identity may not.

| Resource | Requested identity | Assigned sanitized ID | Created UTC | Removed UTC | Absence verified |
| --- | --- | --- | --- | --- | --- |
| Provider tag | `REQUIRED` | `pending` | `pending` | `pending` | `pending` |
| Rehearsal firewall | `REQUIRED` | `pending` | `pending` | `pending` | `pending` |
| Application Droplet | `REQUIRED` | `pending` | `pending` | `pending` | `pending` |
| Source Droplet | `REQUIRED` | `pending` | `pending` | `pending` | `pending` |
| Application Tailscale node | `REQUIRED` | `pending` | `pending` | `pending` | `pending` |
| Source Tailscale node | `REQUIRED` | `pending` | `pending` | `pending` | `pending` |
| Diagnostics Compose project/volume | `REQUIRED` | `pending` | `pending` | `pending` | `pending` |
| Isolated restore target | `REQUIRED` | `pending` | `pending` | `pending` | `pending` |

## Bootstrap and topology

| Check | Result | Sanitized evidence |
| --- | --- | --- |
| Firewall existed before hosts; effective union has only private jump TCP/22 inbound | `pending` | `pending` |
| Eight-hour stop/sanitize timer was first installed host action | `pending` | `pending` |
| Candidate archive, not working tree, installed | `pending` | `pending` |
| Root-only host sampler installed and real cross-UID `/proc` sample succeeded | `pending` | `pending` |
| Tailscale Mac+iPhone → app:443 positive and source/non-443 negatives | `pending` | `pending` |
| Disposable HTTPS/RP/cookie/internal origins reference no protected endpoint | `pending` | `pending` |
| Three-way Game/relay/maintenance credential collision preflight passed | `pending` | `pending` |
| Access/State/Game/collector/relay/source readiness and fixed limits passed | `pending` | `pending` |

## Fixed threshold results

Thresholds are copied from E12 and cannot be changed after execution begins.

| Threshold | Disabled run | Enabled run | Verdict / owning checkpoint on failure |
| --- | --- | --- | --- |
| Each producer: attempts `>=30`, accepted retained E2 samples `>=27` | `pending` | `pending` | `pending` |
| Each producer: unioned mapped coverage `>=240000 ms` in `300000 ms` | `pending` | `pending` | `pending` |
| Listener local gaps `<=3`; source/relay role discontinuities `<=3` | `pending` | `pending` | `pending` |
| Accepted RTT `<=2000 ms`; ordered server interval; uncertainty recorded | `pending` | `pending` | `pending` |
| New underrun/overflow/reconnect/dropped-PCM events = `0` | `pending` | `pending` | `pending` |
| Host CPU p95 increase `<=10` percentage points of two-vCPU capacity | `pending` | `pending` | `pending` |
| Host RSS increase `<=128 MiB`; no OOM/restart | `pending` | `pending` | `pending` |
| Collector DB+WAL+SHM `<256 MiB`; host free space `>=1 GiB` | `pending` | `pending` | `pending` |
| Browser refresh/wake/resource convergence deadlines | `pending` | `pending` | `pending` |
| Recovery deadlines and one-effect replay results | `pending` | `pending` | `pending` |

## Browser action matrix

| Action | Expected owner/result | Observed result |
| --- | --- | --- |
| Diagnostic reset | old E5 instance retires; acknowledged successor may report | `pending` |
| Listener sharing stop | unseen work refused; exact retained replay may replay | `pending` |
| E6 panel close | local polling stops only | `pending` |
| E11 panel close | comparison reads stop only | `pending` |
| Page teardown / Stop listening | E5 retires with no successor until explicit start | `pending` |
| Browser refresh | old instance retires; sharing is not restored silently | `pending` |
| 30-second app switch / lock | resume or finite gap; valid evidence within 20 seconds after required gesture | `pending` |

## Failure and recovery schedules

Run one row at a time and restore health before the next.

| Schedule | Required result | Result |
| --- | --- | --- |
| Post-commit response loss: representative game mutation | exact retry returns original effect/result | `pending` |
| Post-commit response loss: browser/source/relay/maintenance diagnostic families | exact retry/replay without second effect | `pending` |
| Duplicate/concurrent action, lease contention, changed request conflict | fixed finite owner result | `pending` |
| Source service restart and full source-host reboot | convergence within 60/180 seconds | `pending` |
| Relay interruption, delayed old generation, listener reconnect, shaped network | bounded gap/fence and continued audio | `pending` |
| Collector timeout/stop/malformed/response loss | gameplay/audio/readiness unchanged | `pending` |
| Access interruption | finite failure, readiness degraded, no new authority | `pending` |
| State interruption | finite failure, readiness degraded, no new authority | `pending` |
| Real listener/source/relay fault and E3 comparison | minimized conclusion from retained evidence | `pending` |
| Collector/application restart and reconstruction | one exact durable projection | `pending` |
| Isolated copied-collector relationship corruption | finite degraded result; copy removed | `pending` |
| Whole-trace purge | concealment; unseen uploads refused | `pending` |

## Backup, rollback, and restore

| Check | Result |
| --- | --- |
| Encrypted backup created and copied off-host | `pending` |
| Isolated restore passed schema/catalog/table counts/integrity/FK/mode checks | `pending` |
| Disposable readiness failure triggered exact-image rollback | `pending` |
| Unrelated sentinel identity/start time unchanged | `pending` |
| Restore target, every backup copy, and passphrase removed | `pending` |

## Mandatory cleanup

Cleanup runs on success, failure, or interruption after the first mutation.

| Order | Required proof | Result |
| --- | --- | --- |
| 1 | listener consent stopped; trace ended; reporters stopped; unseen uploads refused; exact replay semantics checked | `pending` |
| 2 | source registration disabled and lease released; trace purged/concealed | `pending` |
| 3 | Spotify authorization and Tailscale nodes/keys revoked | `pending` |
| 4 | browser profiles, cookies, credentials, proxy state, restores, backups, passphrases removed | `pending` |
| 5 | diagnostics container removed; checked diagnostics volume disposal; authority volumes unchanged | `pending` |
| 6 | both Droplets absent before firewall/tag deletion | `pending` |
| 7 | provider, Tailscale, Compose, volume, credential, temp-file, browser inventories empty | `pending` |
| 8 | encrypted manifest copies and raw scalar inputs deleted; timer ended by verified host destruction | `pending` |

## Final privacy and completion audit

- [ ] ledger contains no secret, address, absolute host path, account/member name, device identifier, raw report/measurement, PCM, or native error;
- [ ] repository diff contains only intended sanitized artifacts;
- [ ] every E12 threshold and schedule has a pass or named owning-checkpoint blocker;
- [ ] independent final review reports no open P0/P1;
- [ ] all temporary resources are absent; and
- [ ] Slice 2 status is updated only after the evidence above proves completion.

Final verdict: `rehearsal incomplete`

