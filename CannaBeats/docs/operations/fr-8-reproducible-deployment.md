# FR-8 reproducible deployment, backup, and recovery

**Status:** FR-8.1 and FR-8.2 complete. FR-8.3 pending.

FR-8 is intentionally split into three closure-sized boundaries. The product
remains one privately operated Droplet, one public origin, one active game, and
one SQLite owner. There is no orchestrator, remote secret manager, operator web
application, or generalized migration system.

## FR-8.1 — Exact topology and secret boundary

> Every production process starts only from exact release images and validated
> configuration, can reach only its required network, path, and secret, or
> remains unhealthy without exposing secret material.

The fixed topology is Caddy, web, and relay. Only Caddy publishes host ports.
Web and relay share one internal network; relay has no public address. Web alone
mounts the SQLite data directory and the two relay tokens read-only. Relay sees
only its tokens. Caddy sees neither the database nor application secrets.

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: the installer creates only the fixed directories, networks, and two 32-byte token files with explicit owners and modes. |
| Update | `runtime`: configuration preflight accepts only the documented exact keys, digest-pinned images, fixed origin, absolute paths, and finite limits. |
| Delete | `structural`: normal Compose stop/removal does not remove bind-mounted data or server-owned secret files. |
| Omit | `runtime`: preflight rejects every missing required value; Compose uses required-variable expansion for image and host-path inputs. |
| Duplicate | `structural`: one fixed Compose project and one service instance per name; no scale configuration is exposed. |
| Reorder | `runtime`: dependency health gates web and Caddy startup; readiness, rather than container creation order, determines service availability. |
| Replay | `runtime`: directory and secret initialization preserves an existing valid token byte-for-byte and reports the same finite result. |
| Conflict | `runtime`: an existing malformed secret, wrong path type, or changed immutable public identity fails before Compose mutation. |
| Concurrency | `runtime`: initialization and production start hold the same process-bound Linux `flock`; FR-8.2 and FR-8.3 commands must join it before their boundaries close. |
| Expiry | `not_applicable`: server relay tokens have no elapsed-time expiry in the family release; explicit rotation is an offline operator action. |
| Restart | `runtime`: bind mounts and restart policies reconstruct the same database and tokens; health checks re-establish dependency order. |
| Dependency failure | `runtime`: dependency health gates initial Compose startup. After startup, relay failure leaves web gameplay available while the Host readiness projection blocks shared audio; web failure is surfaced by Caddy as a finite proxy failure. |
| Corruption | `runtime`: malformed environment, token bytes, path type, or Compose render fails preflight before starting a candidate. |
| Capacity | `schema`: Compose CPU/memory/PID limits and application/relay fixed limits bound the one-Droplet topology. |

## FR-8.2 — Immutable release and rollback boundary

> A deployment changes the active release only after a compatible candidate is
> healthy, while exact retry is idempotent and every failed or explicit rollback
> returns to the recorded previous images without changing accepted database
> authority.

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: one immutable release directory and one independently retained identity receipt are created from a safe release ID and exact image digests. |
| Update | `runtime`: release records and identity receipts are immutable; only the bounded state authority and its projection change through fsynced atomic rename. |
| Delete | `deferred`: FR-8.3 owns the only prune command and must preserve current, previous, every backup-referenced record, and all 64 identity receipts. FR-8.2 exposes no deletion. |
| Omit | `runtime`: full-domain validation requires the exact record, identity-ledger, identity-file, and state domains; manifest validation requires images, source revision, catalog identity, schema generation, and configuration checksum. |
| Duplicate | `runtime`: a used release ID with identical content replays; different content is `release_conflict`. |
| Reorder | `runtime`: lock, preflight, pre-release backup, durable pending authority, candidate start, schema/health proof, then final authority publication is the only accepted order. |
| Replay | `runtime`: retry of the active identical release returns `already_active` without another backup or restart. |
| Conflict | `runtime`: release-ID reuse with different manifest bytes fails before current-state evaluation. |
| Concurrency | `runtime`: the shared host lock permits one deployment/rollback/restore/backup mutation at a time. |
| Expiry | `not_applicable`: immutable release identity has no time expiry. |
| Restart | `runtime`: monotonic state authority records an exact pending candidate before convergence; reconciliation stops that retained first candidate or restores current, proves its schema, and only then clears pending. |
| Dependency failure | `runtime`: build, backup, Compose, health, or atomic-switch failure leaves or restores the prior active record and services. |
| Corruption | `runtime`: one shared full-domain validator checks every retained record, identity copy, ledger ordinal, state transition, checksum, safe path, and bounded regular file before state use. |
| Capacity | `runtime`: identity history accepts 64 immutable receipts, record storage accepts 16 complete bundles, manifests accept 16 KiB, Caddy configuration 64 KiB, and Compose configuration 128 KiB; FR-8.3 owns safe record pruning. |

### FR-8.2 implementation status

**Status:** Closed; independent re-audit reports P0=0, P1=0, P2=0.

Enforcement:

- `release/scripts/prepare-release.mjs` requires a clean committed source tree
  and constructs one bundle bound to source revision, catalog digest, schema
  generation 1, exact image IDs/digests, and the exact Compose/Caddy bytes.
- `release/scripts/release-state.mjs` owns immutable release identities and
  records, full-domain canonical validation, 64/16 capacity, fixed byte bounds,
  schema/rollback compatibility, pre-change backup ordering, durable pending
  ownership, post-start schema proof, failure reconvergence, rollback, and
  restart reconciliation. A monotonic `state-authority.json` commit precedes
  its `state.json` projection; restart repairs only the one valid interrupted
  transition. File and parent-directory fsyncs precede publication.
- `release/scripts/release-operations.mjs` is the sole deploy/rollback/reconcile
  CLI. It holds the same process-bound operations lock for the full command,
  reads schema generation from the real SQLite owner, uses only the retained
  Compose record and manifest images, and normalizes every failure to a finite
  code. Its fixed backup command intentionally fails closed until FR-8.3
  supplies the complete backup owner.

Local verification:

- `node --test release/tests/release-state.test.mjs
  release/tests/release-operations.test.mjs
  release/tests/prepare-release.test.mjs` — 33/33 passed.
- A disposable Debian container acquired the production Node FD/flock owner;
  a second ordinary `flock` on the same path failed while the callback ran,
  proving the lock persists after the helper subprocess exits.
- `node --test --test-concurrency=1 release/tests/*.test.mjs` — 186/186 passed.
- `git diff --check` — passed.

The local FR-8.2 counterexample pass and first independent review found and
remediated eleven valid mutations:

1. recording image identities without Compose/Caddy bytes could make rollback
   use newer configuration; every record now retains and validates those exact
   deployment files;
2. a fresh candidate could start with an unexpected schema and remain running
   without release authority; post-start schema proof now stops an unrecorded
   first candidate or reconverges the recorded current release;
3. failure of the atomic state rename after healthy convergence could leave
   candidate services ahead of retained authority; publication failure now
   reconverges current (or stops the first candidate);
4. extra or symlinked record files could preserve all checked payload bytes
   while changing the retained record domain; restart validation now requires
   the exact regular-file set; and
5. successful writes without parent-directory fsync could disappear across a
   power-loss boundary; identity, record, and state publication now fsync file
   and directory order before returning success;
6. process loss after first candidate health but before initial state could
   leave unowned services, so pending candidate identity is now durable before
   convergence and restart can stop it from its retained record;
7. validation of only current and previous ignored corrupt older evidence and
   allowed pruned IDs to be reused, so every operation validates every record
   plus a redundant 64-entry identity ledger/file domain;
8. rollback could publish after the target changed SQLite incompatibly, so it
   now proves the exact target generation after convergence and restores the
   recorded current release on mismatch;
9. unbounded or symlinked bundle inputs could escape the advertised finite
   storage boundary, so input and retained domains require exact regular-file
   sets with fixed byte maxima and max-1/max/max+1 evidence; and
10. deleting or resetting the sole state projection could make an initialized
    host appear fresh, so a monotonic authority copy commits first and only one
    valid interrupted projection transition is repairable; and
11. reconstructing an omitted ledger entry could reorder otherwise immutable
    receipt ordinals, so both identity copies now retain ordinal, release ID,
    and manifest digest and permit only exact contiguous-tail reconstruction.

The first independent review reported P0=0, three P1 groups (unowned first
candidate after process loss, incomplete retained-domain validation, and
missing rollback/reconcile schema proof), and two P2 groups (unbounded bundle
shape and stale symlink/capacity documentation). The first narrow re-audit
closed every P1 and left one P2 for identity-ordinal precision. After retaining
and testing the ordinal in both identity copies, the final affected-perspective
re-audit reported P0=0, P1=0, and P2=0 and reran the 33 focused tests. FR-8.2
has no open finding; FR-8.3 remains the named backup/pruning deferral.

## FR-8.3 — Backup, restore, and operator boundary

> Every retained backup is a complete integrity-checked SQLite snapshot bound
> to its exact secrets and release metadata, and restore either installs that
> complete offline set or leaves the prior installation untouched.

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: SQLite `VACUUM INTO` creates a same-filesystem temporary snapshot which is integrity-checked, checksummed, and atomically renamed with its manifest. |
| Update | `structural`: backup payloads and manifests are immutable after publication. |
| Delete | `runtime`: retention removes only complete backup pairs older than the fixed keep count and never the newest verified pair. |
| Omit | `runtime`: restore requires database, manifest, two token files, release record, and matching checksums. |
| Duplicate | `runtime`: one timestamp/request identity creates one pair; exact retry returns the retained manifest and conflicting reuse fails. |
| Reorder | `runtime`: restore validates while services run, stops writers, revalidates, stages every file, atomically replaces, then starts and proves readiness. |
| Replay | `runtime`: exact backup and restore request identities return their retained finite result. |
| Conflict | `runtime`: request reuse with different backup or target identity fails before mutation. |
| Concurrency | `runtime`: the shared host lock excludes deployment, rollback, backup, and restore overlap. |
| Expiry | `runtime`: daily retention is count-bounded; equality is defined by sorted immutable backup identity, not wall-clock deletion races. |
| Restart | `runtime`: restore verification closes and reopens the real release owner before declaring success. |
| Dependency failure | `runtime`: command/Compose/readiness failure restores the staged prior set and emits one finite operator code. |
| Corruption | `runtime`: checksum, `quick_check`, schema generation, secret format, and manifest relationship validation fail before replacement. |
| Capacity | `runtime`: 14 daily pairs plus one pre-release reserve are retained; creation proves free-space reserve before snapshot. |

## Verification and counterexample pass

Matrix-derived tests, enforcement locations, exact commands, counterexamples,
review results, and named deferrals will be recorded as each sub-checkpoint
closes. FR-10 owns the destructive blank-Droplet restore rehearsal and the
DigitalOcean control-plane proof that automated Droplet backups are enabled;
FR-8 owns all local artifacts and a disposable-filesystem restore rehearsal.

The FR-8.1 local counterexample pass found and remediated six valid mutations:

1. root-only host tokens were unreadable by the non-root containers, so the
   server now creates root-owned, container-group-readable `0640` files and
   mounts them read-only;
2. the unified image still contains retired prototype route modules, so Caddy
   now returns a fixed 404 for their complete public path set before dispatch;
3. raw Compose invocation could bypass the exact-image/path library validator,
   so one production start entrypoint now validates before it can dispatch
   render or start;
4. the body-limit exception named a nonexistent audio path, so it now excludes
   only the exact game/audio-session/ingest UUID shape used by the Host;
5. Caddy state was nested beneath the web-writable data mount, so TLS/config
   persistence now uses the disjoint `/var/lib/cannabeats-caddy` root; and
6. a correctly shaped token with wrong ownership or concurrent creation could
   replay or leave a temporary file, so initialization validates UID/GID, holds
   the shared process-bound operations lock, and removes every unpublished
   temporary. Production start now holds that same lock across Compose
   convergence, so two valid digest sets cannot race.

### FR-8.1 enforcement and verification

- `release/deploy/compose.yaml` mechanically defines the only three services,
  two networks, dependency health, non-root application users, read-only
  filesystems, mounts, and CPU/memory/PID/log bounds. Required Compose variable
  expansion rejects omission before container creation.
- `release/scripts/deployment-config.mjs` is the shared validator for exact
  image-digest syntax and the fixed production host paths.
- `release/scripts/start-production.mjs` is the only production render/start
  entrypoint and cannot invoke Compose until that validator succeeds.
- `release/scripts/initialize-host.sh` creates or validates the fixed directory
  and token set. Exact retry preserves token bytes; conflict returns one finite
  code without a path or retained value.
- `release/deploy/Caddyfile` owns HTTPS, fixed security headers, a 1 MB ordinary
  body limit, finite header/upstream timeouts, deletion of URI/header log
  fields, masked client network prefixes, and fixed 404s for retired prototype
  paths. The exact game-scoped audio ingest route is the one deliberate
  long-lived-body exception.
- Both custom Dockerfiles use the same committed Node image digest by default,
  drop to UID/GID 10001, and copy only their runtime artifacts.

Local verification:

- `node --test release/tests/deployment-topology.test.mjs` — 10/10 passed,
  including held-lock and two-start contention.
- Compose render with three synthetic digest references and the fixed host
  paths passed; the production wrapper's validator, exact arguments, and lock
  dispatch are covered by the focused suite. FR-10 owns execution on Linux.
- A disposable Debian container held the production `/run/lock` flock while
  invoking the real initializer; initialization returned exactly
  `host_initialization_busy` with status 1 and made no mutation.
- `node --test --test-concurrency=1 release/tests/*.test.mjs` — 153/153 passed.
- Relay and web image builds from the exact local Node image passed; the web
  build completed its production Next.js build.
- Official Caddy 2.10.2 `validate --adapter caddyfile` — valid configuration.
- `git diff --check` — passed.

### FR-8.1 independent review

The first review reported four P1 groups: bypassable startup validation, the
wrong streaming body-limit exception, overlapping web/Caddy writable paths,
and incomplete token ownership/concurrency enforcement. It also reported one
P2 documentation group for runtime-health and masked-address precision. Narrow
re-audit then found and closed two remaining iterations of the shared-lock
boundary: production start initially did not join the lock, and an environment
sentinel could later bypass initialization locking.

The final narrow re-audit reran the 10 focused tests and reported P0=0, P1=0,
and P2=0. FR-8.1 is closed with no named deferral inside its invariant; only
the explicitly separate FR-8.2/FR-8.3 commands remain to join the shared lock.
