# Slice 1 P2-E real-environment rehearsal — 2026-08-11

- Status: Slice 1 gates complete; sanitized reusable images verified; powered-off rehearsal hosts retained pending operator-approved retirement
- Candidate: `b79beb3` (`feature/slice-1-baseline-protection`)
- Observation window: `2026-08-11T17:58:04Z` through `2026-08-11T20:13:21Z`
- DigitalOcean CLI context: `cannabeats-p2e1`
- Related runbook: [Baseline protection](baseline-protection.md)

This is an evidence record, not a claim that the candidate has been deployed to
production. Secret values, browser credentials, and provider-account details
are deliberately omitted.

## Deployment boundary and temporary resources

The running PoC uses its own `cannabeats-poc` Compose project on the same
Droplet as the unrelated `vw-services` and `retool-rule-api` projects. The
durable target is a dedicated CannaBeats Droplet. The rehearsal therefore used
fresh private-only hosts and transferred only the named release, inventoried
CannaBeats configuration, and encrypted application data. It did not snapshot
or clone the shared host.

The managed-source host was also built fresh. Its production Droplet was never
imaged or copied because doing so would copy the explicitly excluded Spotify
browser profile.

| Temporary resource | Provider ID | Network exposure | State at record close |
| --- | ---: | --- | --- |
| `cannabeats-p2e-dedicated-20260811` | `591671238` | NYC3 VPC only, `10.108.0.4`; no public IP | Sanitized, powered off, and retained pending retirement approval |
| `cannabeats-p2e-source-20260811` | `591679940` | NYC3 VPC only, `10.108.0.5`; previously Tailscale `100.106.119.76`; no public IP | Sanitized, logged out of Tailscale, powered off, and retained pending retirement approval |

The application host is reachable through the existing SSH jump host. The
source host was initially reached the same way and then enrolled in the
operator tailnet. Its private Tailscale SSH path was verified from the operator
workstation. The disposable source registration was disabled and its active
lease released before application data was destroyed.

| Retained reusable image | Provider image ID | Region | Minimum disk | Recorded size |
| --- | ---: | --- | ---: | ---: |
| `cannabeats-p2e-app-base-b79beb3-20260811` | `240743050` | NYC3 | 50 GiB | 5.85 GiB |
| `cannabeats-p2e-source-base-b79beb3-20260811` | `240743052` | NYC3 | 50 GiB | 5.46 GiB |

## Existing-environment inventory and public preflight

The live application images were
`sha256:e6eed67d19eeb4ca2c085a18cd1476aa41e91c4e40a28b142c9e89c26a3983bb`
for access and
`sha256:bd3ded12dd434d3bcd8a7dc13ab976fc65eee89b25971d41798938737e4609a0`
for game. That deployment predates release identity and the checked-in catalog
manifest, so its application/catalog metadata is unavailable rather than
inferred.

| Check | Direct observation | Result |
| --- | --- | --- |
| Access public liveness | `GET https://poc.cannabeats.social/api/health` | HTTP 200 with valid TLS in 0.222 seconds |
| Game public liveness | `GET https://poc.cannabeats.social/game/api/health` | HTTP 200 with valid TLS in 0.061 seconds |
| Application certificate | Let's Encrypt `YE1`; valid through `2026-11-07T14:42:08Z` | Verification and SAN match passed |
| Relay certificate | Let's Encrypt `YE1`; valid through `2026-11-07T15:10:12Z` | Verification and SAN match passed |

The old access liveness response includes `spotifyConfigured`; candidate
`b79beb3` returns only the minimal liveness contract. This remains a production
deployment verification item, not a defect in the rehearsed candidate.

## Clean-host build and Compose validation

The application rehearsal host began as Ubuntu 24.04 with no CannaBeats data.
It installed Docker `29.7.2` and Compose `5.4.0`. An archive of exact commit
`b79beb3` was transferred to `/opt/cannabeats/CannaBeats`.

- Production and isolated-restore Compose definitions rendered successfully
  with the host Compose implementation.
- The exact candidate build completed in 192 seconds.
- The catalog release gate passed with 3,424 songs and catalog identity
  `sha256:fcf6e2006c70f0a424823c7d4728573b3f2bc6ad5a4030fc95aeaba2af43ea2f`.
- The named known-good release was `p2e-good-b79beb3`.
- Its immutable access image is
  `sha256:0988e79df0d798383f7efae1ef7884851fda0426b5c4924af35dc4ab24282131`.
- Its immutable game image is
  `sha256:f7be4845d7ebd7bde524176de0ab85784927aa2e64220f02bb291fd9d1d7e2f1`.

## Encrypted backup and isolated restore

The live writer remained online while the production-shaped database was
snapshotted. The artifact was copied off the application host to the operator
workstation and then to the isolated rehearsal host. The workstation `/tmp`
copy is off-host rehearsal evidence only; it is not an approved durable backup
destination.

| Evidence | Observation |
| --- | --- |
| Artifact | `cannabeats-2026-08-11T182249Z.cbbackup`, mode `0600` |
| Recovery point | `2026-08-11T18:22:49.967Z` |
| Create duration | 1 second |
| Plaintext/encrypted size | 380,928 / 382,001 bytes |
| Plaintext SHA-256 | `a479566fc0028de2ac3f4ab5ecd5b3ec017ce53c91766642ca8096d701fe3227` |
| Artifact SHA-256 | `44bd91b7e6adbdb3b34d30fb6dbf8a4658c79a037bcf4d7f26bdbf9060b22a98` |
| Recorded schema | 0; the old deployment had no catalog identity to record |
| Candidate verify duration | 2 seconds |
| Candidate restore duration | 1 second |

The restore targeted a new bind-mounted directory and never referenced the
live named volume. Access and game became ready immediately and migrated the
copy from schema 0 to schema 1. `PRAGMA integrity_check` returned `ok`,
`PRAGMA foreign_key_check` returned zero violations, and the restored file was
mode `0600`.

Every protected table retained the same pre/post row count:

| Table | Rows | Table | Rows |
| --- | ---: | --- | ---: |
| `audit_events` | 51 | `desktop_authorizations` | 0 |
| `desktop_sessions` | 1 | `desktop_web_sessions` | 0 |
| `desktop_web_tickets` | 0 | `game_guest_invites` | 3 |
| `game_guest_sessions` | 7 | `game_guest_users` | 7 |
| `game_run_player_identities` | 7 | `game_runs` | 5 |
| `game_session_members` | 15 | `game_sessions` | 8 |
| `host_agent_challenges` | 0 | `host_agent_pairings` | 0 |
| `host_agents` | 2 | `host_release_downloads` | 1 |
| `invitations` | 2 | `managed_audio_commands` | 0 |
| `managed_audio_leases` | 0 | `managed_audio_sources` | 1 |
| `passkey_credentials` | 2 | `room_player_identities` | 0 |
| `rooms` | 0 | `sessions` | 3 |
| `user_capabilities` | 1 | `users` | 9 |
| `webauthn_challenges` | 0 |  |  |

The read-only operator summary reported the candidate identity and one current
session. A scan of logs and restored data found no secret sentinel or account
display name. The isolated Compose project was stopped after verification. The
encrypted backup was retained through the rehearsal and securely removed from
the application host and operator workstation during final sanitization.

## Release failure and exact rollback

A production-shaped named volume was seeded from the rehearsed restore. A
separate sentinel container represented an unrelated workload. Its container
ID and `2026-08-11T18:37:24.066310437Z` start time were recorded before release.

1. Release `p2e-good-b79beb3` completed in 12 seconds after a schema-1 backup
   and verification.
2. A disposable server-only readiness fault was enabled for versions prefixed
   `p2e-fail-`.
3. Release `p2e-fail-b79beb3` failed readiness after 72 seconds and exited 1.
4. The release script restored the exact prior access and game image IDs listed
   above. Readiness recovered, and release state still named
   `p2e-good-b79beb3` current.
5. The unrelated sentinel retained the same container ID and start time. It was
   not restarted or replaced.
6. The injected source change was removed after the failure.

This demonstrates failed-candidate rollback, exact-image restoration,
schema-compatible data, and workload isolation on a real Docker host.

## Component, scheduler, and alert evidence

The real component command produced independent, bounded results rather than a
single aggregate liveness claim:

- database: healthy;
- database volume: healthy, 88.49% available;
- game: healthy;
- managed source: degraded/offline in the restored production data;
- certificates: healthy, 87 days remaining at observation time;
- relay: degraded with safe reason `http_503` because no publisher held a
  lease; and
- old production access readiness: unavailable with safe reason `http_404`
  because that live version predates `/api/ready`.

For scheduler-mechanics validation only, a disposable-host environment removed
external relay and certificate origins while retaining local access, game,
database, and volume checks. The checked-in backup and operations systemd units
were installed and enabled. A backup service run completed successfully in 3
seconds; an operations-check run completed successfully in 3 seconds. Both
timers have future schedules, and backup artifacts are mode `0600`.

Stopping only the disposable access container forced the operations service to
exit 1 and created a root-owned mode-`0600` local alert. Its content was
secret-free and included inspect, retry, and clear instructions. After access
was restarted, the retry succeeded and the alert was cleared. No failed alert
file remains.

## Managed-source capacity and fresh replacement

The existing managed-source node was inspected read-only. Its agent,
controller, and browser were active; the relay publisher was correctly inactive
without a lease and VNC was inactive. Disk use was 5.9 GiB of 48 GiB (13%). It
had 1.9 GiB RAM with about 1.2 GiB available and 2 GiB swap almost unused. It
predates the P2-C health checker.

DigitalOcean monitoring returned 402 inbound and 402 outbound public-bandwidth
samples for the observation interval. Integrating the documented Mbps samples
estimated 0.500 GiB inbound and 0.741 GiB outbound, with peaks of 0.430 Mbps
and 1.486 Mbps respectively. These are observed-rate estimates, not provider
billing totals.

The replacement rehearsal used a new private-only Ubuntu 24.04 Droplet and no
snapshot. Installing the checked-in runtime downloaded about 303 MB and
completed in 150 seconds. It installed Chrome, Tailscale, audio/display
dependencies, 2 GiB swap, the service units, and the P2-C health checker.
Because the temporary hosts had no public interfaces or configured VPC egress
gateway, dependency downloads and the public configuration probe used an
operator-held SSH/SOCKS tunnel. Authenticated controller polling used a
temporary VPC-only TCP bridge to the disposable game container. Neither bridge
was added to the candidate release or exposed publicly.

- VNC initially remained disabled because no off-host password file was
  installed.
- The browser created a new local profile; no production profile, cookie, or
  Spotify refresh credential was copied.
- A disposable source registration was created in the disposable database.
  Its once-shown token and the relay ingest token were transferred without
  printing them and installed with their documented service owners and mode
  `0400`. The temporary registration output was then removed.
- All five core source services became active.
- The health checker reported `configuration_valid` and
  `authenticated_poll_succeeded`.
- Overall source state was correctly `degraded`: Spotify was not authorized,
  the player was not ready, and the relay publisher was idle with
  `no_active_lease`.
- Capacity checks reported 89.15% disk and 69.91% memory available.
- A literal scan found zero source-token or relay-token matches in system logs.

## Operator-controlled source and relay gates

The remaining source gates were completed without copying production browser
state:

- The source and operator workstation joined the operator tailnet. Direct SSH
  over the Tailscale address succeeded. The observed path used a DERP relay;
  direct UDP connectivity was not available in this private-only rehearsal
  topology.
- A VNC password created and retained off-host was installed mode `0400` for
  the source service account. VNC remained loopback-only and was reached through
  an operator tunnel.
- `btaudio` `0.3.0` was installed from exact sibling-repository commit
  `c0dfb32ebef35abed70a77e8f2a3e71f0ef8a89a`.
- The operator completed Spotify Premium authorization in the fresh browser
  profile, verified the account, and started the browser player. The source
  health check then reported `spotify_authorized`, `player_ready`, and overall
  `healthy` with all five services active.
- A controlled relay tone produced 1,411,200 bytes over 8.287 seconds, 357,564
  non-zero samples, peak amplitude 12,006, and RMS -14.68 dBFS.
- A real Spotify lease produced 1,411,200 bytes over 8.230 seconds, 705,520
  non-zero samples, peak amplitude 22,622, and RMS -17.33 dBFS.
- A bounded second lease completed `play`, `pause`, `resume`, and `release`.
  Game status and source state agreed at each transition. The controller started
  the relay publisher for the lease and stopped it on release; the final relay
  state was `idle` with `no_active_lease`.

The first lease expired while extended evidence was being inspected. Its lease
and pending commands were cleaned up, demonstrating the intended fail-closed
timeout behavior. The immediately repeated bounded lifecycle completed.

## Remaining deployment gates and resource preservation

The implementation and non-interactive Slice 1 gates are rehearsed. The
operator-controlled source and relay gates are complete. The following are
durable deployment decisions rather than additional implementation evidence:

- Provision the durable dedicated application Droplet and protected backup
  destination before moving production. The temporary rehearsal host was not
  durable infrastructure, and the workstation `/tmp` backup copy was removed
  during sanitization.
- Deploy the named candidate before expecting production minimal liveness and
  readiness behavior.

Sanitization and reusable-image preservation completed with the checked-in
`tools/sanitize-rehearsal-host.sh` utility, SHA-256
`e4f21d2eb0b2e1a5548cc700982cf6a6f8f5e60ac2ae992869878b8a3b9b2215`.
It is dry-run by default, requires an exact hostname for execution, uses fixed
role-specific allowlists, overwrites credential-bearing files before removal,
cleans machine/SSH identity, and discards freed filesystem blocks.

The application role disabled the source registration, stopped only rehearsal
services, and removed the copied database volume, containers, backups,
passphrase, secret directory, environment, release/session state, restore
artifacts, and temporary bridges. It retained the exact candidate source and
immutable application/game image IDs. The source role removed the Chrome
profile and service homes, source/relay/VNC credentials, tailnet state,
environment, and temporary proxy configuration. It retained the checked-in
runtime, source template, and `btaudio` installation. Both hosts received clean
cloud-init and SSH identity state before they were powered off and imaged.
The matching workstation backup/passphrase pair and the named disposable VNC
Keychain entry were also securely removed after their evidence was recorded.

Private-only verification Droplets restored from both image IDs, generated new
hostnames, machine IDs, SSH host keys, and operator authorization, and passed
the excluded-path and retained-runtime assertions. The restored source reported
Tailscale `NeedsLogin`; no prior tailnet identity survived. The first pair
(`591693556`, `591693555`) also showed that DigitalOcean's default monitoring-
agent installer waits for public egress during cloud-init. A second pair
(`591694429`, `591694430`) created with `--droplet-agent=false` reached
`cloud-init status: done` while remaining private-only. All four verification
Droplets were destroyed and verified absent.

Retain provider images `240743050` and `240743052`. Original rehearsal
Droplets `591671238` and `591679940` remain powered off; retire them only after
a separate operator confirmation, then verify they are absent. The images are
provisioning accelerators, not application-data backups or credential recovery
artifacts. A private-only restore must use `--droplet-agent=false` or provide
controlled public egress for the provider's agent installer.
