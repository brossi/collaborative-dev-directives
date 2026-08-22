# FR-8 reproducible deployment, backup, and recovery

**Status:** FR-8.1 and FR-8.2 complete. FR-8.3 is implemented locally and
awaiting its independent closure audit.

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
mounts the SQLite data directory, the two relay tokens, and the server-local
operator token read-only. Relay sees only its two tokens. Caddy sees neither
the database nor application secrets.

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: the installer creates only the fixed directories, networks, two 32-byte relay-token files, and one independent 32-byte server-local operator-token file with explicit owners and modes. |
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
| Capacity | `runtime`: identity history accepts 64 immutable receipts, record storage accepts 18 complete bundles, manifests accept 16 KiB, Caddy configuration 64 KiB, and Compose configuration 128 KiB. FR-8.3 raises the provisional 16-record bound to 18 so 15 backup-referenced releases, current, previous, and one candidate all fit, and owns safe pruning. |

### FR-8.2 implementation status

**Status:** Closed; independent re-audit reports P0=0, P1=0, P2=0.

Enforcement:

- `release/scripts/prepare-release.mjs` requires a clean committed source tree
  and constructs one bundle bound to source revision, catalog digest, schema
  generation 1, exact image IDs/digests, and the exact Compose/Caddy bytes.
- `release/scripts/release-state.mjs` owns immutable release identities and
  records, full-domain canonical validation, 64/18 capacity, fixed byte bounds,
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
had no open finding; FR-8.3 was its named backup/pruning deferral. FR-8.3 now
implements that boundary and reopens only the affected record-capacity and
operator-secret perspectives for its closure audit.

## FR-8.3 — Backup, restore, and operator boundary

> Every retained backup is a complete integrity-checked SQLite snapshot bound
> to its exact stateful relay secrets and release metadata, and restore either
> installs that complete offline set or leaves the prior installation
> untouched.

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: Node's SQLite online-backup API creates a private temporary database while the live owner remains available; database, two stateful relay secrets, exact release record, canonical manifest, and redundant receipt evidence are fsynced before publication. |
| Update | `structural`: published backup payloads, manifests, and receipts are immutable. Restore replaces the complete live database/relay-secret set rather than editing a retained backup. |
| Delete | `runtime`: `pruneBackups` first verifies every available bundle, then retains the newest 14 routine daily/manual bundles plus the newest `pre_release`/`pre_rollback` reserve. `pruneReleaseRecords` preserves current, previous, pending, every available-backup release, and one candidate slot; identity receipts are never deleted. |
| Omit | `runtime`: one shared verifier requires the exact database, canonical manifest, both relay-token files, and exact four-file release record; backup payload/receipt/index reconstruction permits only one fully published tail, while sequenced restore receipt files and their redundant index repair either missing copy and expose internal gaps. |
| Duplicate | `schema` + `runtime`: backup IDs, request IDs, receipt ordinals, restore receipt names, and release identities are unique; duplicate token values or duplicate authority evidence fail closed. |
| Reorder | `runtime`: backup publishes payload before redundant receipt evidence. Restore verifies, retains a prepared journal before staging, records pending release authority, stops writers, re-verifies, installs, starts/proves, publishes release authority, records redundant completion evidence, durably removes rollback files, and only then removes the journal. Recovery stops both exact retained release configurations before mutating any live file. |
| Replay | `runtime`: exact backup and restore request identities return the original retained result before current state, bundle retention, or authority evaluation. A published bundle can reconstruct a response-lost backup receipt tail. |
| Conflict | `runtime`: request reuse with a different reason/state transition or backup ID fails before current-state evaluation or mutation. |
| Concurrency | `runtime`: one FD-held Linux `flock` excludes deployment, rollback, backup mutation, restore, and reconciliation. Mutating backup maintenance refuses to run while a restore journal exists. |
| Expiry | `runtime`: retention is count-based. Immutable creation time plus backup ID provides the equality tiebreak; no caller cutoff or deletion clock is accepted. |
| Restart | `runtime`: the restore journal retains exact prior release state, existence bits, target release, request, backup, phase, and original completion time. Boot reconciliation either completes the exact authorized target or restores the prior file and release-authority set before ordinary backup runs. |
| Dependency failure | `runtime`: snapshot, fsync, journal, Compose, schema/readiness, and response-loss failures normalize to finite codes. A journal-write failure removes every unowned staged file; failure after target authority publication performs a retained rollback transition before reconverging prior. |
| Corruption | `runtime`: exact directory domains, canonical bytes, SHA-256, SQLite quick/full integrity and foreign-key checks, canonical schema digest, catalog/release binding, token shape/distinctness, journal shape/state schedule, and complete live-set comparison fail closed. |
| Capacity | `runtime`: 14 routine daily/manual plus one pre-change payload are retained with one publication slot; backup receipts accept 1,024, restore receipts 64, database copies 1 GiB, and creation requires at least 256 MiB or twice the live database size. Eighteen release records fit the 15 backup references, current, previous, and one candidate. |

### Operator route invariant

> Every operator command is authorized by one automatically managed
> server-local credential, executes inside the unified SQLite owner, and
> returns only its fixed redacted result or a finite failure.

The initializer creates a third independent 256-bit token at
`/etc/cannabeats/secrets/operator-token`. It is mounted read-only into the web
service only. Caddy and relay cannot read it, the CLI loads it locally, and the
family operator never copies or stores it. Operator HTTP paths remain behind
HTTPS and require the exact bearer before reading a body or entering the
owner. Caddy deletes request URIs and headers from access logs.

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: bootstrap enrollment uses the existing operator receipt transaction and stores only the code hash; no operator route creates another identity type. |
| Update | `runtime`: device revocation uses one retained operator receipt and the shared revocation cascade. Revoking the owner of a nonterminal game atomically abandons that game with a system receipt/event so the one-game slot cannot become ownerless. |
| Delete | `runtime`: diagnostic purge validates the complete database before and after one transaction and deletes only `diagnostic_records`; retained game, audio, playback, and authority evidence are untouched. |
| Omit | `runtime`: every request and success/failure envelope has exact keys; status and active-game summaries validate every field against fixed types, bounds, and enums before rendering. |
| Duplicate | `runtime`: one exact bearer header is required; enrollment/revocation receipt identities are unique, and purge is structurally idempotent. |
| Reorder | `runtime`: token-file validation and constant-time bearer comparison precede body parsing, request dispatch, and retained-state evaluation. |
| Replay | `runtime`: enrollment and revocation return their retained original result after response loss; status/summary are reads and repeated purge returns the same result without another retained effect. |
| Conflict | `runtime`: mutation request-ID reuse with different canonical content fails before current enrollment/device state. |
| Concurrency | `runtime`: commands execute in the existing synchronous owner; mutating commands use `BEGIN IMMEDIATE`. |
| Expiry | `runtime`: bootstrap enrollment retains the FR-2 15-minute equality boundary; the server-local operator token has no clock expiry and is rotated only as an offline host action. |
| Restart | `runtime`: enrollment/revocation receipts, revocation cascades, and system game-abandonment history pass the ordinary complete startup validator. Diagnostic purge has no process-only state. |
| Dependency failure | `runtime`: missing/malformed token file, request timeout, malformed response, unknown remote failure, or owner failure maps to a whitelisted finite operator code without paths, native messages, or credentials. Enrollment and response streams stop as soon as their byte bounds are crossed. |
| Corruption | `runtime`: every command enters the shared database validator; a malformed token path/type/value fails before dispatch. |
| Capacity | `runtime`: operator bodies and responses are 4 KiB, calls time out after 15 seconds, Host receipt reserves remain available for revocation, and existing enrollment/diagnostic fixed limits remain authoritative. |

### FR-8.3 implementation status

**Status:** Closed. The first independent audit reported P0=0, five P1 groups,
and one P2 group. Remediation and the two narrow affected-perspective re-audits
closed every finding with final P0=0, P1=0, and P2=0.

Enforcement locations:

- `release/scripts/backup.mjs` owns online snapshot, exact bundle/receipt
  validation, response-loss repair, fixed retention, free-space proof, and the
  daily/manual/verify/prune CLI.
- `release/scripts/restore.mjs` owns exact restore receipts, the durable
  three-phase journal, complete file staging/replacement, release-state
  switching, rollback/forward repair after interruption, and the restore CLI.
- `release/scripts/operations-lock.mjs` is the shared process-bound lock used
  by release, backup, restore, and reconciliation commands.
- `release/scripts/release-state.mjs` retains 64 immutable release identities,
  at most 18 materialized records, and the backup-aware one-slot prune.
- `release/scripts/operator.mjs` calls only the fixed authenticated operator
  routes. `web/lib/server/release/operator-routes.mjs` owns bearer/body/output
  bounds; the existing store owns transactions and full validation.
- `cannabeats-reconcile.service` runs restore reconciliation before release
  reconciliation once per boot. `cannabeats-backup.timer` schedules the exact
  daily backup only after that successful boot boundary.

Operator commands installed at `/opt/cannabeats/operator` by FR-10 are:

```text
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs status
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs active-game
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs bootstrap-enrollment --request-id UUIDv4 --code-fd 0
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs revoke-device --request-id UUIDv4 --device-id UUIDv4
sudo node /opt/cannabeats/operator/release/scripts/operator.mjs purge-diagnostics
sudo node /opt/cannabeats/operator/release/scripts/backup.mjs verify --backup-id BACKUP_ID
sudo node /opt/cannabeats/operator/release/scripts/restore.mjs restore --backup-id BACKUP_ID --request-id sha256:64-lowercase-hex
```

The bootstrap code is supplied through an already-open descriptor, never an
argument. The CLI reads the operator token itself and never prints it. Restore
selects a deliberate backup, stops/restarts the exact recorded release, and
needs no remembered relay secret or editable environment file.

The complete operational and blank-host procedure is
[FR-8 backup, restore, and operator runbook](fr-8-backup-restore-runbook.md).

The local counterexample pass has closed these schedules before audit:

1. bundle publication followed by receipt/index response loss reconstructs
   only the exact contiguous tail;
2. response loss after either backup or restore receipt publication converges
   cleanup before returning the original retained result;
3. loss of the prepared-journal write removes every staged file;
4. request reuse with another backup conflicts before journal recovery or
   target lookup, while an unrelated retained journal blocks replay;
5. failure after restored release authority is published returns both live
   files and release authority to the prior release, and a second crash during
   either rollback transition resumes from its exact retained schedule;
6. a blank host whose authorized restored files are damaged repairs forward
   only from the still-verified backup;
7. prune/daily/create refuse an interrupted restore, and restart completes
   only payload deletion that first crossed the safe rename boundary;
8. a symlinked live database or retained receipt namespace is rejected before
   snapshot or restore mutation;
9. backup and restore receipt limits prove max-1, max, and max+1;
10. the record bound is 18 rather than the provisional 16 so every advertised
    retained reference plus one candidate fits; and
11. operator revocation of the active game's owner atomically abandons the game
    rather than retaining an inaccessible global slot;
12. a newer manual backup displaces only the oldest routine backup and cannot
    consume the retained pre-release/pre-rollback reserve;
13. restore intent is durable before any staged file exists, recovery stops
    both exact release configurations before live-file mutation, and rollback
    cleanup fsyncs each affected parent before journal removal;
14. an initializer-created empty release root is initialized and restored while
    any nonempty malformed release domain still fails closed;
15. sequenced restore receipt files and their index repair either omitted copy,
    including a missing non-tail file, before exact replay; and
16. the operator CLI rejects malformed private fields, unknown failure codes,
    and over-bound input or response streams with fixed local codes; and
17. a different valid database retained at a request-scoped rollback path is
    rejected before journal publication without changing the live database,
    either token, or the stale evidence; dangling symlinks are occupied too.

The first independent audit reported P0=0, P1=5, and P2=1. The affected local
suite then passed 82/82. Its first narrow re-audit closed all six groups but
found one P1 staging-collision regression introduced by the journal-order fix.
Pre-journal and repeated staging preflight plus the valid-stale-database test
closed it; the final narrow re-audit reported P0=0, P1=0, and P2=0. The final
affected command passes 83/83.

Final local verification:

- `node --test --test-concurrency=1 release/tests/backup.test.mjs release/tests/operator.test.mjs release/tests/deployment-topology.test.mjs release/tests/release-state.test.mjs release/tests/release-operations.test.mjs` — 83/83 passed;
- `node --test --test-concurrency=1 release/tests/*.test.mjs` — 227/227 passed;
- `(cd web && npm test)` — production build and 333/333 tests passed;
- `(cd web && npm run lint)` — passed;
- `(cd macos/CannaBeatsHostCore && swift build)` — passed;
- `node --check` for the backup, restore, and operator scripts — passed; and
- `git diff --check` — passed.

Open findings: P0=0, P1=0, P2=0.

Named deferrals: FR-10 installs the immutable operator tree and systemd units,
enables the timer and DigitalOcean automated Droplet backups, and performs the
destructive blank-Droplet restore rehearsal. FR-8.3 owns and locally verifies
all artifacts and disposable-filesystem restore schedules; it does not claim
those external proofs early.

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
