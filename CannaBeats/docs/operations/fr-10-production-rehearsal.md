# FR-10 production rehearsal

**Status:** In progress. The authorized production Droplet, installation, DNS
cutover, and three-Mac enrollment are complete. System-audio
capture, active-game, game-night schedule, and recovery rehearsal evidence
remain open.

The first release activation failed closed before DNS cutover because the web
container's former `1.50` CPU ceiling exceeded the one-vCPU host's mechanical
per-container maximum. Release authority returned to its empty state and no
container remained. The web ceiling is now `1.00`; Caddy and relay retain their
`0.50` and `0.75` burst ceilings and share the single scheduler. FR-10's real
eight-listener rehearsal remains the performance gate. A CPU/RAM-only Droplet
resize is the reversible fallback and must not expand the root disk.

The first correction candidate after enrollment also failed closed and restored
the prior healthy release. Its web image had inherited Dockerfile's `/game`
development base-path default, so the production `/api/ready` health probe
correctly returned 404. Production web images must be built with
`--build-arg NEXT_PUBLIC_CANNABEATS_BASE_PATH=` (an explicitly empty value).
The corrected isolated image returned ready before activation, and
`release-1.0.0-3-8602528` then activated with the prior release retained.

On 2026-08-23 the GH#6/GH#7 remediation activated as
`release-1.0.0-5-0c144c3`. The transaction retained
`release-1.0.0-4-9bc11af` as its rollback target, preserved the relay container,
and health-gated the replacement web and Caddy containers. Eight consecutive
public readiness probes passed after activation; the first settled resource
sample reported 0.09% web CPU and approximately 96 MiB web memory. Live
Host-to-family-client shared-audio acceptance remains open.

The later Host-authority usability change raises both active Host devices and
outstanding enrollment codes to 100 and makes newly issued enrollment codes
valid for 24 hours. The production operator tree remains intentionally pinned
to its original installation revision, whose status CLI accepts at most eight
active devices. This does not constrain server enrollment or game authority,
but a revision-bounded operator-tree upgrade is required before activating a
ninth Host so the operational status command continues to accept the server's
projection.

That server change activated on 2026-08-23 as
`release-1.0.0-7-ef977c0`, retaining `release-1.0.0-6-a266365` as rollback.
Eight consecutive public readiness probes, the redacted operator status, and
all three container health checks passed. A bootstrap issuance returned an
exact 24-hour lifetime, and notarized Host `1.0.0 (5)` redeemed it to establish
the third active device without disturbing the retained active game.

## Governing invariant

Every production process starts only from the exact retained release artifacts
on one fresh host, with server-generated credentials, valid public HTTPS, and
restart-valid state, or provisioning stops before the origin is exposed.

## Deployment closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: `install-production-host.sh` accepts only Ubuntu 24.04 x86_64, installs one checksum-pinned Node runtime, exports one named Git commit into one immutable source tree, installs fixed units, and creates the FR-8 fixed host domains. |
| Update | `runtime`: a different operator source revision conflicts; application updates use only the retained release transaction. |
| Delete | `deferred`: the FR-10 blank-replacement rehearsal owns destruction of only its named disposable replacement after verified recovery. |
| Omit | `runtime`: missing Git commit/tree, revision, checked runtime, unit, or secret initialization stops before readiness. |
| Duplicate | `structural`: one `/opt/cannabeats/operator` identity and one fixed Compose project exist on the host. |
| Reorder | `runtime`: Docker and the operator tree install before host initialization; DNS changes only after local service readiness. |
| Replay | `runtime`: reinstall of the exact source revision preserves the existing operator tree and FR-8 initializer preserves valid credentials. |
| Conflict | `runtime`: another source revision, platform, architecture, symlinked source, malformed retained path, or credential conflicts before deployment. |
| Concurrency | `runtime`: one process-held installation lock owns package, runtime, operator-tree, unit, and initialization publication; FR-8's shared process-bound lock then owns every release/backup/restore mutation. |
| Expiry | `not_applicable`: deployment identity is revision-bound rather than time-bound; enrollment and invitation expiry remain owned by their existing invariants. |
| Restart | `runtime`: systemd enables reconciliation before backup, Docker uses restart policies, and retained release/SQLite state is validated on startup. |
| Dependency failure | `runtime`: package, checksum, download, Docker, unit, initialization, Compose, and health failure stop with finite results before DNS cutover. |
| Corruption | `runtime`: the operator tree is exported from the retained Git commit, source and installed symlinks are rejected, exact replay compares the complete tree, the checksum-pinned Node binary is reverified, and release/schema/Compose validation fails closed. |
| Capacity | `runtime`: every per-container CPU ceiling fits the one-vCPU host; validated memory/PID limits and application limits remain fixed, and the eight-listener real rehearsal proves the shared scheduler before release closure. |

## Authorized infrastructure

- Droplet: `cannabeats-prod-20260822-01`
- Provider/region/shape: DigitalOcean NYC3, Ubuntu 24.04 x64, Basic 1 vCPU,
  2 GiB RAM, 50 GiB disk
- Protection: DigitalOcean monitoring and daily automated backups
- Public origin: `https://play.cannabeats.social`
- DNS: an exact `play` A record will override the existing wildcard only after
  the release services are locally ready

Credentials, SSH fingerprints, enrollment codes, provider IDs, and tokens are
intentionally omitted from this document.
