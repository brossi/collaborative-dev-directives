# FR-7 unified Host experience and bounded diagnostics

**Status:** Complete. Implemented, locally verified, and independently audited.

## Governing invariant

> The foreground Mac app exposes one finite readiness projection and gates
> every Host action on it, while bounded diagnostics can fail, expire, corrupt,
> or fill without changing game/audio authority or exposing prohibited data.

FR-7 composes the already-closed Host authority, game, playback, and shared-
audio owners. It does not create another authority store or duplicate their
immutable evidence into optional diagnostics. Significant game, playback, and
audio outcomes remain in `game_events`, `playback_command_transitions`, and
`audio_session_transitions`; the Host export projects a compact sanitized view
of those authoritative trails together with optional finite diagnostic records.

## Finite product boundary

- One foreground Host window and one active game runtime are supported.
- Readiness has exactly seven named checks: server compatibility, device
  enrollment, Spotify, Automation, audio capture, relay, and active-game
  ownership.
- Every check is `checking`, `ready`, or `blocked` with one finite recovery
  code. No native, server, caller-authored, or free-form failure is retained or
  displayed.
- Host release contract `1` is required before issuing a web ticket and is
  retained with that ticket. Every resulting web-session authorization
  rechecks the retained contract, so an incompatible build receives
  `upgrade_required` before creating, recovering, or operating a game.
- The native app exchanges the one-use ticket in an ephemeral `WKWebView` POST
  body before loading the game. It never places the ticket or application
  bearer in a URL, script, persistent WebKit store, or exported diagnostic.
- Optional diagnostics are disabled by default in release builds and enabled
  by default only in debug builds. A game retains at most 256 records for
  exactly seven days.
- A diagnostic record contains only a UUID, finite kind/code, bounded scalar
  count, and server-owned timestamps. It contains no arbitrary string payload.
- Export contains no bearer, cookie, enrollment/invitation code, signature,
  public key, audio/cover bytes, network address, path, raw error, pre-reveal
  answer, or persistent device identifier.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: one authenticated Host may append one exact finite diagnostic identity only for its game; server time derives seven-day expiry. Readiness creates no retained authority. |
| Update | `structural`: diagnostic records and authoritative trail rows are immutable; readiness is a replace-in-place in-memory projection owned by one foreground model. |
| Delete | `runtime`: bounded expiry cleanup deletes only diagnostic rows at or after equality. Authoritative game/playback/audio evidence remains untouched. |
| Omit | `runtime`: one shared readiness builder enumerates all seven checks exactly once; export validates every required field and authoritative sequence before returning anything. |
| Duplicate | `schema` + `runtime`: diagnostic UUID is unique while retained; exact retained replay returns its original projection and different-content retained reuse fails. Readiness check names are a finite enum. |
| Reorder | `runtime`: export sorts authoritative trails by retained sequence and diagnostics by occurred time/UUID; input cannot supply ordering fields. |
| Replay | `runtime`: before expiry, exact diagnostic retry returns its original server timestamp/expiry without another row. At expiry equality the optional identity is purged and reuse is a new record. Web-ticket and game operations retain their existing durable replay boundaries. |
| Conflict | `runtime`: before expiry, diagnostic identity reuse with different finite content fails before capacity/current-state evaluation; at expiry equality the optional identity is no longer retained. Incompatible Host release fails before ticket/game recovery. |
| Concurrency | `schema` + `runtime`: `BEGIN IMMEDIATE`, diagnostic primary key, fixed per-game count, one foreground refresh task, and one active game owner select one result. |
| Expiry | `runtime`: diagnostics are visible before expiry and absent at equality and after; cleanup is idempotent and game/audio state is byte-identical across it. |
| Restart | `runtime`: server reconstructs and validates authoritative trails, retained Host contract, and diagnostics before export; the Mac app rechecks compatibility and recovers at most one active game before opening its web surface. |
| Dependency failure | `structural` + `runtime`: readiness and diagnostics use separate calls from game/audio mutation; their timeout, malformed output, capacity, or storage failure changes only a finite check/export result. Playback polling is synchronously stopped whenever shared audio gates false. |
| Corruption | `runtime`: invalid diagnostic kind/code/count/time/expiry or malformed authoritative trail fails diagnostics/export closed without weakening game/audio validation or returning a partial export. |
| Capacity | `schema` + `runtime`: 256 diagnostics/game, seven checks, one foreground game runtime, fixed response sizes, and an export capped to the same finite retained domain have max-1/max/max+1 evidence. |

## Enforcement locations

- `web/lib/server/release/host-contract.mjs`, `host-routes.mjs`, and
  `host-authority.mjs` own the exact Host contract, ticket retention, and
  revalidation of every web session.
- `web/lib/server/release/diagnostics.mjs` owns finite diagnostic admission,
  exact replay/conflict, expiry cleanup, validation, and sanitized export.
- `web/lib/server/release/host-experience-routes.mjs` owns exact application
  authority, active-game projection, bounded relay probe, Host release headers,
  body bounds, and finite HTTP results.
- `macos/CannaBeatsHostCore/Sources/CannaBeatsHostCore/HostReadiness.swift` owns
  the exact seven-check projection and action-specific finite recovery.
- `HostGameRuntimeOwner.swift` owns one game generation and the non-no-op
  shared-audio-to-playback gate.
- `macos/CannaBeatsHostCore/Sources/CannaBeatsHost/main.swift` owns the single
  SwiftUI window, ephemeral fixed-origin `WKWebView`, first-run enrollment,
  returning-game reopen, Settings, Advanced diagnostics, and shutdown fence.
  FR-9 owns conversion to the signed production Xcode target without changing
  these owners.

## Matrix-derived verification

- Enumerate the seven readiness names once, reject omission/duplication, and
  prove every blocked primary action exposes one finite recovery message.
- Exercise compatible, missing, wrong, and expanded Host release contracts
  before web-ticket issuance and active-game recovery.
- Exercise diagnostic exact replay/conflict; kind/code/count rejection;
  max-1/max/max+1; and before/equality/after expiry.
- Prove diagnostic expiry and capacity do not change the canonical game
  snapshot; reject a cross-kind retained mutation on restart without returning
  a partial export; and normalize malformed, oversized, or timed-out relay
  readiness.
- Scan export bytes for every prohibited category and verify no partial export
  is returned after one relationship-preserving retained mutation.
- Behaviorally prove the shared-audio playback gate starts/stops idempotently
  and closes once. Structurally verify production uses that gate, readiness
  fences runtime creation and reconnect, and stop/game rotation close the old
  gate before awaiting its audio owner. FR-10 retains the live lifecycle drill.
- Build the Swift package Host executable and structurally verify one window,
  one `WKWebView`, fixed navigation policy, and no Web content access to the
  application bearer.

## Pre-audit counterexample question

> What smallest mutation can preserve every current readiness or export check
> while omitting a prerequisite, exposing a prohibited field, changing game or
> audio authority, or retaining a diagnostic outside its finite lifetime?

Apply it to check enumeration, release headers, active-game identity, diagnostic
UUID/content, expiry equality, count bounds, authoritative sequence ordering,
web navigation, playback-gate transitions, export fields, and failure paths.

The local pass found and remediated six valid counterexamples:

1. a web session issued under an older native contract could outlive the ticket
   gate; the contract is now retained and checked on every web authorization;
2. a one-use Host ticket in the initial page query could enter access logs or
   history; WebKit now exchanges it in a POST body before loading `/`;
3. diagnostic identity behavior at expiry depended on whether physical cleanup
   had already run; equality now purges before treating reuse as a new record;
4. overlapping refresh/game-rotation tasks could transiently construct two
   owners; refresh is single-flight and the game runtime uses a generation
   fence while synchronously closing the old playback gate;
5. adding the retention interval to an otherwise valid timestamp could exceed
   JavaScript's exact-integer range; record creation now rejects that boundary
   before writing ambiguous expiry authority; and
6. a relay health endpoint could stream an unbounded or stalled malformed body;
   the Host probe now applies one timeout and a 4,096-byte response limit before
   normalizing the dependency to finite blocked readiness.

No open local P0 or P1 remains.

## Local verification

- `node --test --test-concurrency=1 release/tests/*.test.mjs` — 143/143 passed.
- `npm test` from `web` — build passed and 333/333 tests passed.
- `npm run lint` from `web` — passed without warnings.
- `swift build --package-path macos/CannaBeatsHostCore` — passed, including the
  `CannaBeatsHost` executable.
- `swift run --package-path macos/CannaBeatsHostCore CannaBeatsHostCoreVerifier`
  — 23 checks passed.
- `CannaBeatsHostPlaybackVerifier` — 20 checks passed.
- `CannaBeatsHostAudioVerifier` — 75 checks passed.
- `git diff --check` — passed.

## Independent review

The first audit reported one P1 invariant group: readiness did not yet fence an
existing production audio runtime, reconnect used only game presence, and the
native client accepted an unknown active-game lifecycle. It also reported one
P2 evidence-precision group where this runbook described structural checks as
behavioral proof.

The remediation introduced one explicit readiness-derived runtime/reconnect
gate, fail-closed `lobby`/`active` lifecycle validation, verifier coverage for
both boundaries, and precise structural-versus-behavioral wording. The narrow
independent re-audit passed its Node 7/7 and Swift 23/23 checks with P0=0,
P1=0, and P2=0.

## Named deferrals

- FR-8 owns deployed relay-health wiring, Compose health policy, backup,
  restore, and operator purge commands.
- FR-9 owns the signed Xcode target, hardened runtime, entitlements, notarized
  DMG, and production build configuration that defaults diagnostics off.
- FR-10 owns live first-run family-device proof, deployed failure drills, and
  human verification of the final recovery wording.
