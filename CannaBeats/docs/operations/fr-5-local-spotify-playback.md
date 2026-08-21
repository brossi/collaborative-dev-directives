# FR-5 local Spotify control and durable playback commands

**Status:** Complete; independently reviewed with no open P0/P1/P2.

## Governing invariant

Every retained playback intent is executed or reconciled at most once by the
currently claimed native generation, and Spotify or macOS ambiguity is retained
as a finite non-success outcome rather than inferred away.

## Product-scale boundary

FR-5 owns one foreground CannaBeats Host process, the installed Spotify desktop
application, and the active game's fixed playback-command queue. It uses plain
SQLite transitions, bounded HTTP polling, and Spotify's scriptable Apple Events
interface. It does not introduce Spotify OAuth, a Web API token, the Web Playback
SDK, a background daemon, distributed leases, generalized job scheduling, or a
second native game model.

FR-5 does not capture or relay audio. FR-6 owns process-tap capture, authenticated
ingest/listen proxies, and shared-audio generation. A playback result therefore
claims only the local Spotify command and verified readback described here.

## Fixed playback intent and transition contract

A `track_requested` event creates one `play_track` command in the same game
transaction. Its identity is a deterministic UUID derived from the game ID,
action request ID, and event ordinal; it is not the action request ID itself.
The native controller implements `pause` and `play`, but FR-5 creates server
commands only from retained `track_requested` events. The schema reserves those
two command kinds for a later fixed control surface; startup deliberately rejects
such a row until that surface supplies an equally durable causal owner. There is
at most one nonterminal command for a game.

Commands use this finite state machine:

```text
queued -> claimed -> executing -> completed
                    |           -> failed
                    |           -> outcome_unknown
                    |              |-> completed
                    |              `-> failed
                    `-> claimed by a newer generation

queued/claimed/executing/outcome_unknown -> cancelled
```

`completed`, `failed`, and `cancelled` are terminal. Exact transition retry with
the same command, generation, target state, canonical outcome projection, outcome
hash, and reason returns the retained result without another transition.
Conflicting reuse fails before current-state evaluation.

The native app's foreground polling owner generates one UUID claim generation
per foreground process and claims the oldest nonterminal command. A generation
may claim sequential commands in that process; its fencing identity is the
command/generation pair. Reclaim of one command with a new generation fences
every later transition from its old generation and returns `reconcileRequired`.
The native process always reads Spotify before execution. A command whose
durable `executionAmbiguous` bit is false may execute when the desired state
does not hold. Once a retained transition reaches `executing` or
`outcome_unknown`, that monotonic bit remains true across takeover and restart;
the command becomes reconciliation-only and is never sent to Spotify again.

The transition API accepts no device, game owner, desired track URI, or
caller-authored error text. Host identity comes from the application bearer;
desired operation and URI come from the retained command. A completed transition
retains exactly `playerState`, `positionMilliseconds`, and `trackUri`. The server
canonicalizes that projection, verifies its SHA-256 hash, and requires it to
satisfy the retained command before accepting completion.

Native traffic uses only:

- `GET /api/games/{gameId}/playback/commands/next`; and
- `POST /api/games/{gameId}/playback/commands/{commandId}/transitions`.

Both require the application bearer and
`x-cannabeats-playback-contract: 1`. Browser cookies cannot call them.

## Native Spotify boundary

`SpotifyController` exposes exactly:

- application discovery and running state;
- current track URI, player state, and position;
- play one retained Spotify track URI;
- play/resume; and
- pause.

The production implementation targets bundle ID `com.spotify.client` through
Apple Events. It never shells out to `osascript`, reads Spotify files, or accepts
arbitrary script text. Automation consent is requested only when the user starts
Spotify setup or executes the first command.

The release resource contract includes only the Apple Events entitlement and
the required `NSAppleEventsUsageDescription`; FR-9 applies those files to the
signed app target and enables Hardened Runtime. Apple documents that the
entitlement permits the app to ask for Apple Events authority and that the usage
description is required for APIs that send Apple Events:
[Apple Events entitlement](https://developer.apple.com/documentation/BundleResources/Entitlements/com.apple.security.automation.apple-events),
[usage-description key](https://developer.apple.com/documentation/bundleresources/information-property-list/nsappleeventsusagedescription).
There is no relied-upon private System Settings URL. Denial guidance names the
publicly visible **Privacy & Security → Automation** pane; FR-7 owns its polished
presentation.

Every call returns one finite result:

- `accepted` with exact verified readback;
- `spotify_missing`;
- `spotify_not_running`;
- `spotify_signed_out`;
- `automation_denied`;
- `command_timeout`;
- `unexpected_track`;
- `response_lost`; or
- `unrecognized`.

Native AppleScript, process, path, and localized error text remain local and are
not placed in server transitions or browser responses. A successful command
callback is not enough: `play_track` completes only after readback reports the
expected URI and playing state; pause/play complete only after the corresponding
player state. A timeout or lost callback is `outcome_unknown` until readback
reconciles it. The production controller serializes actual script invocations:
after returning `command_timeout`, no later script starts until the timed-out
invocation itself returns.

## Restart, lifecycle, and cancellation

The command owner reconstructs every command from its immutable, gap-free
transition history at startup and compares the projection with the mutable head.
Claim generations are UUIDs and may be reused by one foreground process across
sequential commands; transition identity and fencing remain command-scoped.
Completion or explicit game termination cancels the current nonterminal command.
A newer `track_requested` intent cancels its immediate predecessor in the same
transaction only while that predecessor is not execution-ambiguous. If an Apple
Event could still complete, the game mutation fails atomically with the finite
`operation_rejected` result until native readback reconciles the command. This
restart-valid barrier prevents a successor from racing a late old Apple Event.
Startup binds `superseded` to the immediate next track event and requires a
`game_ended` cancellation to have no successor.

Host application-session expiry prevents new claims and transitions but does not
erase retained commands. Exact retry is evaluated after retained Host identity
resolution and before current session authority when an effect may already have
committed.

The fixed retained bounds are 512 commands per game and eight transitions per
command. An open-state transition cannot consume transition eight; completion,
failure, or lifecycle cancellation can use it, so cleanup remains available at
the advertised boundary.

## Enforcement locations

- `web/lib/server/release/schema.mjs` owns immutable identities and transitions,
  one open command, legal finite fields, and retained-row nondeletion.
- `web/lib/server/release/playback-commands.mjs` owns deterministic identity,
  event binding, state/generation transitions, exact replay, causal cancellation,
  canonical readback/hash validation, bounds, and restart reconstruction.
- `web/lib/server/release/store.mjs` owns atomic coupling to game events,
  replacement, completion, explicit termination, and shared readiness.
- `web/lib/server/release/playback-routes.mjs` owns the application-only HTTP
  contract and finite response taxonomy.
- `macos/CannaBeatsHostCore` owns the serialized Apple Events controller, strict
  native client, foreground polling owner, per-process claim generation,
  readback-first execution, recovery mapping, and deterministic verifier.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime` + `schema`: each retained `track_requested` event creates exactly one deterministic game-scoped command and initial transition in the game transaction. Server-side play/pause creation is rejected until a later checkpoint supplies a retained causal owner. |
| Update | `runtime`: one named transition owner enumerates the finite state graph, claim takeover, outcome projection, and mutable head update. |
| Delete | `structural`: FR-5 deletes no command or transition. Lifecycle reduction appends `cancelled`; FR-9 owns physical purge. |
| Omit | `runtime`: startup requires an initial queued transition, gap-free sequence, exact head projection, required generation/outcome fields, one command for every playback-producing event, and no causally unowned command. |
| Duplicate | `schema` + `runtime`: command ID, game/request identity, transition sequence, and command/generation transition identity are unique; one process generation may own sequential commands, and exact transition retry returns the retained result. |
| Reorder | `schema` + `runtime`: transition primary-key order is contiguous, times are nondecreasing, and every adjacent state/generation pair must follow the fixed graph. |
| Replay | `runtime`: same transition identity and canonical outcome replays before current authority/state; the monotonic ambiguity bit, serialized Apple Event invocation, retained desired state, and Spotify readback prevent executing/unknown work from being re-executed. |
| Conflict | `runtime`: same command/generation transition target with different outcome or reason fails before state evaluation; an old generation cannot resolve after takeover. |
| Concurrency | `schema` + `runtime`: `BEGIN IMMEDIATE`, compare-and-update, and one-open-command enforcement permit one claim/transition winner; a newer explicit generation takeover fences the prior process, and ambiguous work blocks successor creation until reconciliation. |
| Expiry | `not_applicable`: playback commands and claims have no clock expiry. Host application-session expiry is the existing FR-2 authority boundary; restart takeover is explicit, not time inferred. |
| Restart | `runtime`: server reconstructs command heads and monotonic ambiguity from transitions; native process retains no authority outside its command-scoped claim and reconciles ambiguous Spotify work before post-restart execution or supersession. |
| Dependency failure | `runtime`: missing/not-running/signed-out Spotify, denied Automation, timeout, unexpected readback, and response loss map to the finite results without native text. |
| Corruption | `runtime`: missing/duplicate/reordered transitions, altered desired URI, impossible generation change, canonical readback/hash mismatch, invalid cancellation cause, or event-command mismatch fails readiness closed. |
| Capacity | `schema` + `runtime`: one nonterminal command per game, 512 retained commands per game, and eight transitions per command cover the friends-and-family release; an open edge cannot consume the final lifecycle/terminal slot. |

## Matrix-derived verification

The FR-5 suite must prove:

- one command per begin/advance/skip track event and atomic rollback on insertion
  failure;
- queued claim, exact lost-response replay, conflicting generation, explicit
  takeover, reuse of one process generation across sequential commands, and
  rejection of every late old-generation transition;
- legal and illegal adjacent transitions, duplicate/gap/reorder, canonical
  outcome hash, and head/history mismatch after restart;
- completion and termination cancellation, plus replacement by a newer track;
- exact replay after Host session expiry/revocation and denial of unseen work;
- missing, not-running, signed-out, denied, timeout, unexpected-track,
  response-loss, and unrecognized fake-driver outcomes without native text;
- play-track, play, and pause verified readback, including equality and mismatch;
- native restart reconciliation when the desired state already holds and when it
  does not, including proof that executing/unknown work is readback-only;
- timeout, attempted supersession, late callback completion, and successful
  supersession only after retained readback reconciliation;
- fixed command/transition capacity at max-1, max, and max+1 with cancellation
  reserve intact.

## Named deferrals

- FR-6 owns Spotify process-tap capture, relay ingest/listen, audio generation,
  and audible shared-output evidence.
- FR-7 owns the final unified readiness presentation and diagnostics export.
- FR-8 owns production deployment configuration and server backup/rollback.
- FR-9 owns applying the checked-in entitlement/Info contract to the production
  Xcode target, enabling Hardened Runtime, Developer ID packaging, notarization,
  live Spotify Premium control after fresh consent and Host restart, and physical
  result/command purge.

## Closure evidence

Local verification completed on 2026-08-21:

- `node --test release/tests/playback-commands.test.mjs release/tests/playback-routes.test.mjs`
  passed 14/14 after audit remediation.
- `node --test --test-concurrency=1 release/tests/*.test.mjs` passed 100/100.
- `swift build`, `swift run CannaBeatsHostPlaybackVerifier`, and
  `swift run CannaBeatsHostCoreVerifier` passed; the playback verifier currently
  reports 20 checks and the Host authority verifier reports six.
- `plutil` validates both release resource files, and the locally installed
  Spotify scripting dictionary confirms `play track`, `play`, `pause`, player
  state, position, and Spotify URL under bundle ID `com.spotify.client`.
- The production Next build includes both playback routes.
- `npm test` passed the production build and 332/332 web tests;
  `node --test release/tests/next-runtime.integration.mjs` passed 1/1 against
  the standalone Next process.
- `npm run lint` completed with zero errors and one pre-existing unused-variable
  warning in `web/lib/s2e-e5-browser-session.mjs`.

The independent review reported P0 0, four P1 invariant groups, and one P2.
Remediation now permits process-generation reuse across commands, serializes
timed-out Apple Events and blocks ambiguous supersession, binds cancellation to
the immediate successor, validates ambiguity cross-fields, adds the production
foreground owner, and makes native failures and nested outcomes exact and finite.
The affected narrow re-audits also closed same-generation historical replay and
multi-controller Apple Event serialization. Final findings: P0 0, P1 0, P2 0.
The only named evidence deferral is the signed-bundle live Spotify proof owned by
FR-9; no FR-5 implementation finding remains open.
