# CannaBeats first-release plan

- **Status:** FR-0 through FR-8 complete; FR-9 is in progress
- **Created:** 2026-08-21
- **Branch:** `feature/slice-2-macos-host`
- **Purpose:** Replace the proof-of-concept deployment with the smallest complete
  friends-and-family release: one macOS Host application, one small DigitalOcean
  server, and browser participants.

This is the active end-to-end execution plan. The earlier Slice 1 and Slice 2
work remains implementation evidence and a source of proven invariants, but its
multi-service deployment and managed Linux Spotify source are not release
requirements.

## Release outcome

A family host can install a signed and notarized CannaBeats application on a
Mac, authorize that Mac with a one-time enrollment code, use the Spotify desktop
application where they are already signed in to Premium, create and run one
game, and share an expiring link with at most eight browser participants. Every
participant hears the same relayed Spotify output and can refresh, close the
browser, or resume a multi-day game without duplicating a seat or corrupting
the game.

The release is complete when that journey succeeds on the production-shaped
DigitalOcean deployment, the server and Mac both survive their defined restart
boundaries, backup and restore are rehearsed, and the distributable DMG passes
Apple signing, notarization, stapling, and Gatekeeper checks.

## Fixed architecture and product limits

### Deployment

- `play.cannabeats.social` is the new release hostname. Existing PoC hostnames
  and retained snapshots remain untouched until release acceptance.
- One DigitalOcean Droplet runs exactly three Compose services: Caddy, one
  Node.js web/API process, and one small private Node PCM relay.
- The Node process serves the Next.js browser application, is the only writable
  SQLite owner, and implements access, game, command, diagnostic,
  and operator routes. There is no separately deployed Access, State,
  diagnostics, source-controller, VNC, or Tailscale-dependent service.
- SQLite and coherent local backup files live on the Droplet's persistent root
  disk. Only the Node service mounts the live database. DigitalOcean automated
  backups protect the Droplet; application backup uses SQLite's online backup
  operation before releases and on a daily timer.
- Caddy terminates HTTPS and exposes only the Node service. The relay is private
  to the Compose network. Its generated ingest/listen credentials remain in
  root-readable server files and are never returned to a Mac or browser.

### macOS Host

- The supported Host is a universal `arm64`/`x86_64` SwiftUI application for
  macOS 14.2 or later, distributed manually as a Developer ID-signed,
  notarized, and stapled DMG.
- SwiftUI owns onboarding, Spotify and audio readiness, native settings,
  diagnostics export, and release compatibility. A `WKWebView` loads the
  shared hosted Host/game interface; no second native game engine is created.
- The official Spotify desktop application is required. The host signs into
  Spotify Premium there. CannaBeats has no Spotify OAuth flow, client secret,
  access token, refresh token, Web Playback SDK, or developer-mode user list.
- CannaBeats controls Spotify locally through its scriptable Apple Events
  interface and captures only the Spotify process through the existing Core
  Audio process-tap approach. The release requests macOS Automation and Screen
  & System Audio Recording consent with explicit purpose strings and finite
  recovery instructions.
- The Host hears the same server relay stream as participants. Spotify's direct
  process output remains muted while tapped, preventing doubled local audio.
- The application is foreground-only. There is no login item, helper daemon,
  background agent, automatic updater, or App Store dependency.

### Identity, invitations, and games

- A Host Mac generates a P-256 signing key. Secure Enclave is preferred and a
  this-device-only Keychain key is the fallback. Only the public key leaves the
  Mac.
- Initial recovery/bootstrap enrollment is created by a server CLI. An
  authorized Host can create subsequent enrollment codes from the application.
  A code contains at least 128 bits of randomness, expires after 15 minutes,
  is stored only as a hash, and can authorize exactly one device key.
- There are no Host passwords, passkeys, emailed links, participant accounts,
  or cross-device participant profiles in the first release. Loss of every
  Host device is recovered with a new operator-created enrollment code.
- A Host creates an expiring game invitation and shares it with the macOS Share
  sheet. The secret is carried in the URL fragment, submitted once by the join
  page, stored hashed on the server, and exchanged for an HttpOnly secure
  browser session. It never appears in request paths or server logs.
- One invitation admits up to eight display-name participants until the game
  starts. Existing participant sessions may reclaim their original seat after
  start; the invitation cannot create a new seat then.
- Exactly one game may be active globally. This is enforced as a removable
  capacity constraint, not encoded as a singleton representation.

### Future-compatible game identity

- Every game has an immutable, opaque `game_id`; every game-owned row, retained
  event, request receipt, playback command, diagnostic record, and audio
  session references it.
- All public game and audio routes are scoped under `/api/games/{gameId}`. No
  client or service uses a global `currentGame` or a fixed singleton row.
- The Node audio boundary validates the requesting Host or participant and maps
  the one active `game_id` to the private relay. Clients do not know that the
  first relay has only one source slot.
- Future concurrent-game support consists of removing the one-active-game
  constraint, allocating an isolated relay channel or instance per game, and
  applying a configured capacity limit. It must not require changes to device
  identity, participant sessions, game APIs, game state, or retained results.
- Do not build dormant relay allocation, distributed coordination, or
  multi-game scheduling in this release.

## Minimal retained model

The clean release database is created from a new schema; no PoC database is
migrated. Existing catalog source data and proven game rules are imported as
release inputs, not by copying retained application rows.

| Record | Required purpose and limits |
| --- | --- |
| `host_devices` | Immutable device public key, label, authorization and revocation state |
| `host_enrollments` | Hashed one-use code, issuer, 15-minute expiry, and redemption result |
| `host_challenges` | Hashed one-use signing challenge with two-minute expiry |
| `host_sessions` | Hashed bounded bearer session derived from a valid device proof |
| `games` | Immutable `game_id`, lifecycle, configuration, catalog version, revision, and one-active-game constraint |
| `game_create_decisions` | Immutable replay evidence when a create request resolves to the already-active game without creating a row |
| `game_invites` | Hashed join secret, game binding, six-hour expiry, capacity, and closed state |
| `participants` | Game-scoped seat, normalized display name, and join order |
| `participant_sessions` | Hashed HttpOnly-session token, game/seat binding, and explicit lifecycle revocation |
| `action_receipts` | Actor/game/request identity, canonical request hash, and original finite result |
| `game_events` | Ordered significant mutations sufficient for restart validation and reconstruction |
| `playback_commands` | Game-scoped desired operation, track URI where required, claim generation, and finite outcome |
| `audio_sessions` | Game-scoped relay lifecycle and generation; initially maps only the active game to the private relay |
| `game_results` | Compact final game and score projection retained until deliberate operator deletion |
| `diagnostic_records` | Sanitized, bounded per-game evidence with seven-day expiry |

Foreign keys, uniqueness constraints, immutable triggers, and one shared
restart validator enforce local relationships. Cleanup never deletes the
receipt or event evidence required to resolve an already accepted game action.

## Public contract baseline

Exact request and response schemas are fixed during the owning checkpoint, but
the following interfaces and authority direction are not optional:

- `/api/host/enrollments/*` creates, redeems, and recovers one-time Host codes.
- `/api/host/challenges/*` proves possession of an enrolled device key and
  establishes a bounded Host session.
- `/api/host/web-tickets/*` exchanges a fresh Host proof for a one-use ticket;
  the embedded web view consumes it into an HttpOnly Host cookie.
- `/api/games/{gameId}/*` owns lifecycle, invitations, participants, snapshots,
  actions, playback commands, results, and bounded diagnostics.
- `/api/games/{gameId}/audio/sessions/*` owns the retained audio generation;
  its ingest route accepts only the Host application session owning the active
  game, and its listen route accepts only that Host or an admitted participant.
  Both proxy the private relay without exposing either relay token.
- Every retryable mutation carries a UUID request ID. Conflicting reuse fails
  before current-state evaluation; exact replay returns the original finite
  result without a second effect.
- Host and participant clients use bounded HTTP polling. The Host app polls for
  durable playback commands, and browsers poll authoritative game snapshots.
  WebSockets and push infrastructure are deferred until measurements require
  them.
- Finite client-visible failures include unauthorized, expired, revoked,
  conflict, stale state, capacity reached, incompatible client, Spotify
  unavailable, macOS permission required, relay unavailable, and outcome
  unknown. Native, SQLite, AppleScript, relay, and caller-authored errors are
  never returned directly.

## Execution checkpoints

Each checkpoint begins by recording its one-sentence invariant and a closure
matrix using the dimensions in `AGENTS.md`. Matrix-derived tests and the local
counterexample pass precede any independent review. A checkpoint is committed
before the next boundary-bearing checkpoint begins.

### FR-0 — Preserve evidence and establish the new baseline

**Invariant:** The new release can be developed and deployed without mutating
the retained PoC checkpoint or relying on any destroyed rehearsal resource.

Checkpoint specification and closure matrix:
[FR-0 release baseline](operations/fr-0-release-baseline.md).

Tasks:

- Inventory reusable code and tests from the web game, State invariants,
  macOS Host spike, relay client, catalog, release scripts, and backup scripts.
- Label each artifact `reuse`, `adapt`, `reference-only`, or `retire`; do not
  carry services forward merely because they already exist.
- Record the new application bundle identifier, Developer Team identifier,
  release hostname, Compose project name, database path, and secret-file paths.
- Add a configuration preflight that reports missing production values by
  name without printing secrets.
- Confirm the checkpoint branch and repository are clean before structural
  work begins.

Gate: a fresh-clone developer can identify the release components and no
release command addresses a PoC hostname or destroyed Droplet.

### FR-1 — Consolidate the server and clean schema

**Status:** Complete; independently reviewed with no open P0/P1/P2.

**Invariant:** One Node owner atomically validates every accepted mutation and
can reconstruct the exact authoritative game state from one restart-validated
SQLite database.

Checkpoint specification and closure matrix:
[FR-1 consolidated owner](operations/fr-1-consolidated-owner.md).

Tasks:

- Create the single production Node/Next entry point and remove runtime calls
  across the former Access, State, and diagnostics HTTP boundaries.
- Define the clean schema above, including immutable game ownership,
  foreign-keyed child rows, ordered event identity, atomic action receipts, and
  the removable one-active-game constraint.
- Port the proven canonical request hashing, replay-before-authority behavior,
  event sequencing, restart validation, corruption normalization, and bounded
  cleanup semantics into shared transactions and validators.
- Load catalog data through one versioned release artifact and persist the
  selected catalog version on every game.
- Provide liveness and readiness endpoints. Readiness fails for an invalid
  schema, corrupt retained relationships, insufficient database reserve, or an
  incompatible release; relay availability remains a separate finite status.

Matrix focus: create, update, delete, omit, duplicate, reorder, replay,
conflict, concurrency, restart, corruption, and capacity.

Gate: schema, transaction, API, restart, corruption, `max-1`/`max`/`max+1`,
and response-loss tests pass with no open P0/P1.

### FR-2 — Host device enrollment and web-view session

**Status:** Complete; independently reviewed with no open P0/P1/P2.

**Invariant:** Only possession of an enrolled device key can create Host
authority, and every code, challenge, session, and web ticket is single-purpose,
bounded, revocable, and replay-safe.

Checkpoint specification and closure matrix:
[FR-2 Host authority](operations/fr-2-host-authority.md).
Operator and device recovery procedure:
[Host device enrollment and recovery](operations/host-device-recovery.md).

Tasks:

- Adapt the existing Secure Enclave/Keychain P-256 implementation and signed
  challenge protocol into the production macOS target.
- Implement operator bootstrap and authorized-device issuance of 15-minute
  one-time enrollment codes, including share/copy and paste-to-enroll UI.
- Implement challenge exchange, revocation, clock-boundary behavior, and
  application session renewal without storing a Host password.
- Issue one-minute, one-use web-view tickets and exchange them for Secure,
  HttpOnly, SameSite Host cookies scoped to the release hostname.
- Provide a Host-device list, revoke action, local reset warning, and explicit
  all-devices-lost recovery runbook.

Matrix focus: duplicate, replay, conflict, concurrency, expiry equality,
response loss, restart, revocation, and capacity.

Gate: interception, double redemption, altered-key redemption, challenge
replay, post-revocation use, ticket replay, restart, and lost-response tests
fail closed; a clean Mac can enroll without a browser account ceremony.

### FR-3 — Game invitation, participant admission, and recovery

**Status:** Complete; independently reviewed with no open P0/P1/P2.

**Invariant:** An unexpired game invitation creates at most one bounded seat
whose participant credential remains valid for that game's lifecycle, while
refresh and reconnect restore that same seat without revealing hidden game
data.

Checkpoint specification and closure matrix:
[FR-3 game admission](operations/fr-3-game-admission.md).

Tasks:

- Implement Host game creation and the database-enforced single-active-game
  result, returning the conflicting active game for an authorized Host to
  reopen instead of creating another.
- Create six-hour, multi-use, hashed game invitations and fragment-token join
  URLs; close admission on game start, expiry, revocation, or eight seats.
- Exchange the fragment token and normalized display name for a Secure,
  HttpOnly, SameSite participant cookie. The server credential has no clock
  expiry, whether absolute or inactivity-based. The browser receives a
  persistent cookie with the browser-supported 400-day `Max-Age`, refreshed on
  authenticated snapshots; that value controls local browser retention only
  and is not a game timeout or an authority boundary. Reject empty,
  unsafe-length, and duplicate normalized names.
- Restore the same game-scoped seat after refresh, browser sleep, or a
  multi-day disconnect. Never use a display name as identity.
- Provide bearer-authenticated Host recovery and game-scoped snapshots with
  the complete canonical roster/state; participant snapshots remain
  answer-filtered until reveal.
- Implement Host invitation regeneration/revocation, roster removal before
  start, lobby readiness, explicit game termination, and bounded abandoned-game
  recovery.

Matrix focus: create, duplicate, replay, conflict, concurrency, expiry,
restart, capacity, and deletion of invitation versus retention of seat/event
evidence.

Gate: simultaneous final-seat joins admit exactly one, refresh never creates a
second seat, a post-start link cannot admit a new participant, and participant
snapshots contain no pre-reveal answer fields.

### FR-4 — Shared game journey and durable actions

**Status:** Complete; independently reviewed with no open P0/P1/P2.

**Invariant:** Every accepted Host or participant action advances one game
revision at most once and returns a role-filtered authoritative snapshot that
can be reconstructed after restart.

Checkpoint specification and closure matrix:
[FR-4 shared game journey](operations/fr-4-shared-game-journey.md).

Tasks:

- Reuse the current lobby/game-run rules and browser UI behind the new
  game-scoped APIs; do not create a native Swift game model.
- Implement the minimum complete journey: Host launch/reopen, configuration,
  invite, readiness, start, turns, placement, retraction, reveal, advance,
  skip, score, completion, replay choice, and end game.
- Preserve client request IDs across bounded retries and return atomic receipts
  plus the resulting authoritative revision.
- Retain ordered significant events and a compact final result. Validate the
  projection on startup and before reveal, completion, export, or deletion.
- Add incompatible-client handling and accessible pending, retry, stale,
  reconnect, and finite failure states for the changed UI.

Matrix focus: every mutation dimension in `AGENTS.md`, particularly exact
replay before current authority, concurrent actions at one revision, event
gaps/reordering, restart, and hidden-data projection.

Gate: the full game can be reconstructed after close/reopen; response loss does
not duplicate an effect; and all participant responses remain reveal-safe.

### FR-5 — Local Spotify control and readiness

**Status:** Complete; independently reviewed with no open P0/P1/P2.

Checkpoint specification and closure matrix:
[FR-5 local Spotify playback](operations/fr-5-local-spotify-playback.md).

**Invariant:** CannaBeats can command only the installed Spotify application
with explicit macOS consent and always reports a finite playback outcome
without storing or transmitting Spotify credentials.

Tasks:

- Add a narrow `SpotifyController` protocol and production Apple Events
  implementation for application discovery, play-track URI, play, pause,
  current track, position, and player state.
- Add the hardened-runtime Apple Events entitlement and
  `NSAppleEventsUsageDescription`; request Automation only when the user starts
  Spotify setup.
- Detect Spotify missing, not running, signed out, permission denied, command
  timeout, unexpected current track, and lost response. Give one actionable
  recovery route for each, including the correct System Settings pane where
  macOS permits it.
- Have the native app poll, claim, execute, and acknowledge game-scoped
  playback commands. A claim generation prevents an old app instance from
  acknowledging a newer owner.
- Use catalog metadata for the game UI. Do not add Spotify Web API metadata or
  cover-art calls to the runtime release path.

Matrix focus: duplicate, reorder, replay, conflict, concurrency, dependency
failure, response loss, restart, and command-generation fencing.

Gate: a fake driver proves every finite outcome, timeout serialization, strict
native response handling, and foreground polling through sequential commands;
the core and server contain no Spotify OAuth credential. FR-9 owns signed-app
consent and restart proof because that evidence requires its production bundle.

### FR-6 — Authenticated shared-audio path

**Status:** Complete. Independent closure review and narrow remediation
re-audit report no open P0, P1, or P2 findings.

Checkpoint specification and closure matrix:
[FR-6 authenticated shared audio](operations/fr-6-authenticated-shared-audio.md).

**Invariant:** Only the active game's Host can publish Spotify audio and only
its admitted clients can listen; interruption or reconnect never exposes relay
credentials or binds a client to another game generation.

Tasks:

- Productionize the Core Audio Spotify process tap, replacing allocation on the
  real-time callback with a preallocated bounded buffer and explicit overflow
  accounting.
- Add the required Screen & System Audio Recording purpose string and readiness
  flow. Start capture and confirmed relay ingest before issuing the first play
  command.
- Implement Node streaming proxies for authenticated game-scoped ingest and
  listen routes. Node injects private relay credentials on the Compose network
  and validates game/audio generation before piping bytes.
- Keep Spotify direct output muted while captured and play the relayed stream
  locally in the Host app. Provide participant audio start/reconnect controls
  compatible with browser autoplay rules.
- Bound buffers, reconnect attempts, timeouts, and memory. Record sanitized
  counters for startup, discontinuity, dropped upload data, reconnect, and
  terminal failure without retaining audio or peer addresses.

Matrix focus: concurrency, restart, dependency failure, corruption/malformed
stream headers, capacity, stale generation, and revocation during an open
stream.

Gate: unauthorized ingest/listen and stale generations fail; a paced local
composition carries eight participants plus the Host within measured
CPU/memory bounds; relay restart drops all prior publisher/listener authority;
and native recovery retains one fenced generation. FR-10 owns deployed
Node/relay restart recovery and audible proof that direct and relayed audio are
not heard twice.

### FR-7 — Unified Host experience and bounded diagnostics

**Status:** Complete. Independent closure review and narrow remediation
re-audit found P0=0, P1=0, and P2=0.

Checkpoint specification and closure matrix:
[FR-7 unified Host experience and bounded diagnostics](operations/fr-7-unified-host-diagnostics.md).

**Invariant:** The foreground Mac application presents one truthful readiness
and game journey, and optional diagnostics can fail or expire without changing
gameplay or audio authority.

Tasks:

- Build the production SwiftUI shell around the authenticated `WKWebView` with
  first-run setup, returning-game reopen, Spotify readiness, audio readiness,
  game status, and Settings/Advanced surfaces.
- Compose `SharedAudioOwner.playbackGate` with `PlaybackPollingOwner` in the
  production app owner so playback cannot claim work until shared audio is
  active and is fenced synchronously on interruption or stop; the default
  no-op callback is never a production wiring choice.
- Expose one readiness checklist with finite states for server compatibility,
  device enrollment, Spotify availability, Automation permission, audio-capture
  permission, relay reachability, and active-game ownership. Every disabled
  primary action names the missing condition.
- Store compact significant game/audio outcomes in the main event trail. Store
  optional sanitized diagnostic records in the same SQLite database, disabled
  by default in notarized family builds and enabled by default only in debug
  builds.
- Limit diagnostics to a fixed per-game count and seven-day expiry. Add a
  sanitized export from the Mac application; omit credentials, audio samples,
  raw free-form errors, pre-reveal answers, paths, and persistent device
  fingerprints.
- Add a compatibility check so an old Host build receives an upgrade-required
  result before it can create or resume a game it cannot safely operate.

Matrix focus: omission, expiry, dependency failure, corruption, capacity, and
the structural independence of diagnostic failure from game/audio operations.

Gate: a first-time Host can identify and resolve each missing prerequisite;
deleting or filling diagnostics leaves gameplay and audio unchanged; exported
diagnostics pass secret and privacy scans.

### FR-8 — Reproducible deployment, backup, and recovery

**Status:** Complete. FR-8.1 topology/secrets, FR-8.2 immutable
release/rollback, and FR-8.3 backup/restore/operator are independently closed.
The aggregate interaction audit and affected-perspective re-audits are also
closed with no open P0/P1/P2. See
[FR-8 reproducible deployment, backup, and recovery](operations/fr-8-reproducible-deployment.md).
The operator procedure is
[FR-8 backup, restore, and operator runbook](operations/fr-8-backup-restore-runbook.md).

**Invariant:** A clean Droplet can be built, updated, backed up, restored, and
rolled back from documented inputs without reconstructing secrets or state from
memory.

Tasks:

- Build the three-service Compose deployment with pinned images, health checks,
  resource limits, an internal-only relay network, and explicit persistent
  paths. The deployment generates two relay tokens and one server-local
  operator token directly on the server with restrictive permissions; browser
  and application sessions remain caller-generated opaque credentials stored
  only as hashes.
- Configure Caddy and DNS for `play.cannabeats.social`, including HTTPS,
  security headers, body/time limits, redacted access logs, and no PoC routes.
- Add schema compatibility preflight, immutable release identifiers, atomic
  application switch-over, and an exact previous-release rollback command.
- Schedule daily SQLite online backups with bounded retention and verify that
  DigitalOcean automated Droplet backups are enabled. Create an on-demand
  pre-release backup and checksum before every deployment.
- Provide redacted health/status, active-game summary, host-device revocation,
  bootstrap enrollment, diagnostic purge, backup verification, and restore
  commands. Avoid a separate operator web application.

Matrix focus: restart, dependency failure, corruption, capacity/reserve,
partial deployment, schema compatibility, backup completeness, and rollback
after admission.

Gate: a blank replacement Droplet restores the database and secrets through
the documented procedure; a failed release rolls back without losing an
accepted action; logs and support output contain no credentials.

### FR-9 — Signed family distribution

**Status:** In progress. Local implementation and independent review are closed
with no open P0/P1/P2. The real Developer ID/notarization artifact and
interactive install evidence remain. See
[FR-9 signed family distribution](operations/fr-9-signed-family-distribution.md).

**Invariant:** Every distributed Host build has one durable bundle identity,
declared permissions, verified release origin, and a server compatibility
contract.

Tasks:

- Convert or organize the Swift package as the production Xcode macOS target
  with bundle ID `social.cannabeats.host`, macOS 14.2 minimum, universal
  architectures, hardened runtime, Apple Events, network-client, and required
  privacy usage descriptions.
- Reuse the existing Developer ID Application identity and Keychain-backed
  notarization profile; do not add an Installer certificate because the
  release artifact is a DMG, not a signed installer package.
- Produce a versioned DMG, submit it for notarization, staple the ticket, run
  `codesign`, `spctl`, and stapler validation, and publish its SHA-256 checksum.
- Deliver the DMG and checksum directly to family recipients with manual
  install and upgrade instructions. The app checks the server's minimum
  supported version; there is no download service or automatic update framework
  in this release.
- Test installation, first consent, upgrade-in-place, local device-key
  preservation, uninstall/reinstall behavior, and revocation on a second Mac.
- With a real Spotify Premium desktop session, prove play-track, pause, resume,
  verified readback, fresh Automation consent, and Host restart under the
  signed production bundle identity.

Gate: a clean supported Mac accepts the downloaded DMG through Gatekeeper,
permissions remain associated with the durable code identity across an
upgrade, real Spotify control and readback survive Host restart, and an
incompatible build fails before operating a game.

### FR-10 — Production-shaped rehearsal and release closure

**Invariant:** The exact release artifacts and topology complete one real
family game and recover from the bounded failures claimed by the release.

Tasks:

- Deploy the clean release stack at `play.cannabeats.social`; enroll the first
  Host using the operator bootstrap code and install the notarized DMG.
- Run a complete game with the Mac Host, its signed-in Spotify Premium desktop
  app, an iPhone Safari participant, and enough additional browser clients to
  exercise the eight-listener capacity separately from normal play.
- Exercise Host app restart, Spotify restart, participant refresh/sleep,
  duplicate action, response loss, Node restart, relay restart, full final-seat
  race, invite expiry/revocation, device revocation, incompatible client,
  backup/restore, and application rollback.
- Confirm audible output at the Host and remote device, single playback, bounded
  recovery, reveal privacy, final result reconstruction, and sanitized
  diagnostic export.
- Record exact release versions, commands, results, known P2 limitations, and
  named deferrals. Remove temporary enrollment/invitation material and test
  sessions; retain the real release deployment and reviewed evidence.

Gate: no open P0/P1, every release outcome has local and real-environment
evidence, restore and rollback pass, the worktree is committed and clean, and
the family release runbook matches the deployed system.

## Required ordering and review depth

The critical path is:

```text
FR-0 → FR-1 → FR-2 → FR-3 → FR-4 → FR-5 → FR-6 → FR-7 → FR-8 → FR-9 → FR-10
```

Small UI mockups, fake Spotify-driver tests, Compose scaffolding, and packaging
experiments may be prepared earlier only when inert and clearly marked
unverified. They do not satisfy a later gate.

- FR-1 through FR-6 and FR-8 change authority, persistence, external effects,
  or recovery boundaries. Each receives a completed closure matrix, local
  counterexample pass, and one targeted independent review.
- FR-7 and FR-9 receive focused privacy/UX and packaging reviews respectively.
- FR-10 is the one broad closure audit. After remediation, rerun only affected
  perspectives and the proportionate regression suite unless a representation
  or authority boundary changes.
- Every checkpoint handoff records the invariant, matrix dispositions,
  enforcement locations, exact commands/results, findings, deferrals, commit,
  and clean-tree status required by `AGENTS.md`.

## Explicitly deferred

- More than one simultaneously active game and per-game relay allocation
- Participant accounts, passkeys, durable profiles, or cross-device seat transfer
- Spotify OAuth, Web Playback SDK, Spotify Web API runtime calls, or a managed
  Linux Spotify account/source
- Universal links, custom URL schemes, emailed enrollment, and server-driven mail
- WebSockets, push notifications, background helpers, login items, and automatic updates
- Separate Access, State, diagnostics, analytics, or operator services
- Windows, iOS, or Mac App Store distribution
- General observability dashboards, raw audio capture, or long-term device telemetry
- New game modes, voice answers, advanced catalog configuration, and broad visual redesign

These deferrals do not weaken device authority, role-filtered game state,
idempotency, restart validation, relay isolation, secret handling, backup, or
fail-closed correctness. A later change reopens only the owning boundary.
