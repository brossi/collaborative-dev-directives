# FR-1: Consolidated Node owner and clean schema

- **Status:** Complete; independently reviewed with no open finding
- **Governing plan:** [CannaBeats first-release plan](../first-release-plan.md)
- **Governing invariant:** One Node owner atomically validates every accepted
  mutation and can reconstruct the exact authoritative game state from one
  restart-validated SQLite database.

## Boundary

FR-1 creates a new release owner under `web/lib/server/release`. It does not migrate a
PoC database, preserve the Access/State HTTP split, or reuse the old managed
source schema. The production Next process imports this owner directly; no
other process opens the live database read-write.

FR-1 owns:

- clean schema creation and canonical schema verification;
- exclusive process ownership of the SQLite path;
- catalog artifact verification and immutable catalog registration;
- game creation and the one-active-game capacity policy;
- one shared atomic mutation/receipt/event transaction;
- complete startup/restart validation;
- finite health and readiness projections; and
- direct integration of health/readiness with the Next process.

Enrollment, participant admission, full game commands, Spotify commands,
audio, diagnostics collection, deployment, and backup behavior remain with
their named later checkpoints. Their tables exist now only where the fixed
foreign-key representation is needed to prevent later identity rework. Except
for structurally validated Host and participant identities used by FR-1 tests,
rows owned by later checkpoints must remain empty until their shared owner is
implemented; startup rejects premature rows as retained corruption.

## Fixed representation

### Identity and lifecycle

- `game_id`, actor IDs, request IDs, device IDs, participant IDs, command IDs,
  audio-session IDs, and result IDs are canonical UUIDs.
- A game lifecycle is `lobby`, `active`, `completed`, or `abandoned`.
- One partial unique index over the constant expression `1` applies while a
  game is `lobby` or `active`. This is the only global single-game mechanism.
  No API or state object exposes a global current-game singleton.
- FR-1 accepts `lobby → active`, `lobby → abandoned`, and
  `active → abandoned`. The schema reserves `active → completed`, but the owner
  returns `operation_rejected` until FR-4 can atomically write and validate the
  terminal result projection. Terminal games never reopen.
- Every game-owned table has a non-null foreign key to `games.game_id`.

### Canonical game state

The stored `games.state` is canonical JSON with this release-one envelope:

```json
{
  "schemaVersion": 1,
  "gameId": "UUID",
  "catalogVersion": "sha256:…",
  "revision": 0,
  "phase": "lobby",
  "players": [],
  "activePlayerId": null,
  "activePlayerIndex": 0,
  "round": 0,
  "currentSong": null,
  "placement": null,
  "retractionUsed": false,
  "result": null,
  "winnerId": null,
  "rules": {},
  "usedUris": []
}
```

The shared validator requires exact keys, canonical encoding, game/catalog/
revision agreement with columns, unique player and song identities, valid
phase-dependent relationships, normalized rules, and no non-finite numeric or
unrecognized free-form field. Every `usedUris` identity must belong to the
game's catalog, and every retained song must exactly match its canonical
catalog metadata. FR-4 supplies command reducers over this fixed envelope; it
does not introduce a second representation.

### Clean tables

| Table | FR-1 enforcement |
| --- | --- |
| `schema_generations` | One immutable generation/digest row proving exact schema objects |
| `catalog_releases` | Immutable catalog version, artifact and ordered-entry digests, song count, and source version |
| `catalog_entries` | Immutable canonical URI/metadata membership for every retained catalog release |
| `host_devices` | Immutable UUID/public-key identity with bounded label and revocation fields |
| `host_enrollments` | Hashed one-use enrollment identity, issuer, expiry, and redemption linkage |
| `host_challenges` | Hashed one-use challenge bound to device and expiry |
| `host_sessions` | Hashed bounded session bound to one device |
| `games` | Canonical state, lifecycle, revision, catalog FK, timestamps, and one-active index |
| `game_invites` | Hashed game-bound invite, expiry, capacity, and close state |
| `participants` | UUID seat, game binding, normalized name, unique join order, and removal state |
| `participant_sessions` | Hashed game/participant-bound session with expiry and revocation |
| `action_receipts` | Game/actor/request identity, operation, canonical request hash, original result, revision |
| `game_events` | Immutable contiguous sequence, revision, finite type/outcome/actor, request linkage, canonical detail |
| `playback_commands` | Game-scoped immutable intent and current finite state/claim generation |
| `playback_command_transitions` | Immutable contiguous command state history |
| `audio_sessions` | Game-scoped generation and finite relay lifecycle |
| `game_results` | One immutable terminal result projection per game |
| `diagnostic_records` | Game-scoped finite type and sanitized canonical payload with expiry |

Hashes are lowercase SHA-256 hex. Secrets and bearer values are never stored
directly. JSON columns have `json_valid` constraints and are re-parsed by the
shared validator after restart.

## Atomic owner operations

### Create game

`createGame` receives a caller-generated `gameId` and `requestId`, authenticated
Host actor ID, explicit catalog version, initial rules, and timestamp.

1. Begin `IMMEDIATE`.
2. Look up the receipt by `(game_id, actor_type, actor_id, request_id)`.
3. If found, compare operation and canonical request hash. Conflict fails before
   any active-game evaluation; an exact match returns its original result.
4. If not found, require the submitted catalog version to equal the current
   release, then validate UUIDs, rules, and timestamp.
5. Insert the canonical lobby state. The partial unique index enforces capacity.
6. Insert sequence-one `game_created` evidence at revision zero.
7. Insert the receipt containing the original finite result.
8. Run the accepted-state validator inside the transaction, then commit.

Losing the response after commit and retrying the same explicit catalog request
therefore returns the created game even after the server loads a newer catalog.
Reuse with different content returns `request_conflict`.
A distinct create request while a game is active returns `active_game_exists`
with the authorized existing `game_id` and no second effect.

### Mutate game

`mutateGame` receives `gameId`, actor identity/type, request ID, operation,
canonical payload, expected revision, timestamp, and one named reducer.

1. Begin `IMMEDIATE` and resolve exact replay/conflict first.
2. Load and validate the current game and all retained evidence used by the
   decision.
3. Check the reducer's authority predicate and expected revision.
4. Apply the reducer in memory. The owner assigns revision `current + 1`.
5. Validate the complete next state and lifecycle transition.
6. Insert one or more same-request events with contiguous sequences and
   nondecreasing revisions.
7. Update the game through a compare-and-swap on prior revision.
8. Insert the immutable original receipt and validate the retained projection
   before commit.

The owner returns finite result codes; reducers cannot commit raw exceptions,
unvalidated state, unlinked events, or a receipt without its effect.

## Startup, health, and readiness

- Empty database: create the complete schema in one `IMMEDIATE` transaction,
  register its canonical digest, register the verified current catalog, run
  full validation, and publish the owner only after commit.
- Non-empty database without the exact generation ledger: fail
  `database_incompatible` without adding or changing objects.
- Existing exact generation: acquire the path/inode ownership locks, verify the
  canonical schema digest, verify the current catalog artifact, run SQLite
  integrity and foreign-key checks, and validate every retained relationship.
- `/api/health` proves only that the Node process can answer. It does not claim
  database or relay readiness.
- `/api/ready` invokes the owner validator and database-filesystem reserve check.
  Its only public results are `ready`, `database_unavailable`,
  `database_incompatible`, `database_corrupt`, `database_capacity`, or
  `catalog_incompatible`. It includes no path, SQL, row, native error, or
  supplied content.
- The minimum database-filesystem reserve is 256 MiB. Equality is ready;
  one byte below is `database_capacity`.
- Relay readiness remains a separate later-checkpoint state and cannot make
  the FR-1 database projection appear corrupt.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `schema` + `runtime`: FKs/unique one-active index constrain identity and capacity; `createGame` atomically validates state, event, and receipt. |
| Update | `schema` + `runtime`: immutable identity triggers and lifecycle checks constrain columns; `mutateGame` is the named compare-and-swap transaction and validator. |
| Delete | `schema`: game/evidence rows use `RESTRICT` and immutable triggers. FR-1 exposes no delete; later deliberate retention owns deletion. |
| Omit | `runtime`: `validateReleaseDatabase` enumerates schema objects and requires one receipt per revision, at least one receipt-owned event per accepted action, contiguous events, canonical state fields, and required child links. |
| Duplicate | `schema`: PK/unique constraints cover identities, names per game, join/event order, result per game, receipt scope, and one active game. |
| Reorder | `runtime`: validator requires contiguous game-event sequences, nondecreasing revisions/timestamps, and agreement with the game head. Later transition rows remain empty until their checkpoint validators exist. |
| Replay | `runtime`: both owner operations resolve the immutable receipt before current authority/revision/capacity evaluation and return the original result. |
| Conflict | `runtime`: same scoped request identity with another operation or canonical hash returns `request_conflict` before state evaluation. |
| Concurrency | `schema` + `runtime` + `structural`: OS path/inode ownership excludes a second process; the one synchronous Node owner serializes calls; `BEGIN IMMEDIATE`, compare-and-swap revision, unique constraints, and receipt PK permit one effect. |
| Expiry | `runtime`: retained expiry columns are safe integers; behavior is deferred to FR-2/FR-3. Their equality rule will be expired when `now >= expires_at`. |
| Restart | `runtime`: open verifies schema/catalog digests, SQLite integrity/FKs, and every canonical cross-row projection before publishing the owner. |
| Dependency failure | `runtime`: unreadable database/catalog, lock contention, disk reserve, and malformed artifacts map to finite readiness results without partial owner publication. |
| Corruption | `runtime`: full validation rejects schema drift, invalid JSON/canonical bytes, off-catalog identities/songs, ordered catalog-entry digest drift, orphan receipts, unowned events, Host actor substitution, relationship mutation, event gaps/reordering, premature later-checkpoint rows, and invalid terminal projections. |
| Capacity | `schema` + `runtime`: one active game is a partial unique index; participant capacity is stored as eight and checked structurally now, with admission behavior in FR-3; filesystem reserve is 256 MiB. |

## Matrix-derived test requirements

- Clean creation, exact schema digest, and refusal of any non-empty legacy DB
  without modification.
- Two owners for one path, aliases to the same inode, and a real second-process
  attempt while the first owner retains the database.
- Exact create/mutation replay after response loss and conflicting request-ID
  reuse before active-game or revision checks.
- One active game, terminal transition release, and a new game afterward.
- Compare-and-swap at revision zero and later revisions.
- Event deletion, duplication, gap, reordering, revision drift, timestamp drift,
  and detail mutation while other relationships remain valid.
- State game/catalog/revision mismatch, noncanonical JSON, duplicate players or
  used URIs, and phase-specific relationship corruption.
- Receipt without event, event without receipt, extra receipt at one revision,
  wrong actor/request link, Host actor substitution, wrong request hash, and
  altered original result.
- Catalog file digest, manifest version, song count, and registered-row drift.
- Exact song membership/metadata, catalog rotation, and replay of a request
  bound to the prior catalog after that rotation.
- Filesystem reserve at 256 MiB minus one, exactly 256 MiB, and plus one using
  an injected stat provider.
- Close/reopen around an accepted create, accepted mutation, response loss,
  terminal game, and representative retained corruption.
- Health stays live while readiness returns each finite degraded result.
- A completion attempt is finitely rejected without changing a valid active
  game until FR-4 owns the result projection.
- Error/output scans prove no native error, path, SQL, catalog row, state row,
  or request payload crosses the public readiness boundary.

## Pre-audit counterexample question

Before review, mutate the smallest value that preserves the already-checked
counts and maxima: swap two event timestamps, replace canonical JSON with
semantically equivalent noncanonical bytes, move a receipt to another actor,
alter the registered catalog digest while keeping its version, or point a
state envelope at the correct game with the wrong catalog. Each must fail the
same shared validator used at startup, reads, mutation commit, readiness,
terminal sealing, and later export.

## Deferrals

- FR-2 implements device, enrollment, challenge, Host-session, and web-ticket
  mutations over the fixed tables.
- FR-3 implements invitation, participant, and participant-session mutations.
- FR-4 supplies the complete game reducer set and terminal result projection.
- Until FR-4, the schema's `completed` value is reserved but FR-1 rejects the
  transition with `operation_rejected`; it never reports valid caller intent as
  database corruption.
- FR-5 owns playback-command transitions; FR-6 owns audio-session transitions;
  FR-7 owns diagnostic insertion and cleanup.
- FR-8 owns Compose, secret/file permissions, backup, restore, and release
  rollback. FR-1 must remain runnable in temporary local directories.

## Checkpoint handoff — 2026-08-21

- **Invariant:** Satisfied. The production Next process owns one clean SQLite
  database; every accepted FR-1 mutation is atomically receipt/event-backed,
  and restart/readiness use the same complete validator.
- **Matrix changes:** FR-1 adds enforcement for all fourteen dimensions. The
  remediation specifically tightened omit, reorder, replay, concurrency,
  restart, corruption, and capacity through receipt/event bijection, immutable
  Host authority, catalog-entry membership/digests, child-process ownership,
  and explicit completion deferral.
- **Enforcement locations:** `web/lib/server/release/schema.mjs` owns mechanical
  constraints; `catalog.mjs`, `game-state.mjs`, and `store.mjs` own canonical
  artifacts/state and the shared transaction/restart validator; `runtime.mjs`,
  Next instrumentation, and the health/readiness routes own process projection.
- **Verification:** `node --test CannaBeats/release/tests/*.test.mjs` passed
  30/30; `npm test` in `CannaBeats/web` built successfully and passed 337/337;
  `node --test ../release/tests/next-runtime.integration.mjs` passed 1/1 after
  rebuilding its own neutral standalone artifact from a preceding `/game`
  build; release preflight returned `release_configuration_valid (19
  variables)`; `npm run lint` reported zero errors and one pre-existing
  warning; `git diff --check` passed.
- **Counterexample pass:** Unowned events, orphan/extra receipts, creation and
  later Host actor substitution, revision/time reordering, canonical-but-forged
  state/request/result bytes, unknown used URIs, invented song metadata,
  historical catalog-entry drift, response loss, catalog rotation, premature
  future rows, and completion without a result projection all fail closed.
- **Independent review:** The initial targeted review found four P1 groups and
  one P2 evidence issue; the first narrow re-audit found two residual P1 groups.
  All were remediated. The final narrow re-audit reproduced the four residual
  schedules, passed its ordinary-path checks 5/5, and reported P0 0 / P1 0 /
  P2 0.
- **Open findings:** None.
- **Deferrals:** Enrollment/session mutations to FR-2; invitation/participant
  mutations to FR-3; completion/result projection and the full reducer set to
  FR-4; playback/audio/diagnostic rows to FR-5/FR-6/FR-7; deployment and
  backup/restore to FR-8.
- **Worktree:** This handoff is committed by the FR-1 checkpoint commit; no
  boundary-bearing FR-1 work is intentionally left uncommitted.
