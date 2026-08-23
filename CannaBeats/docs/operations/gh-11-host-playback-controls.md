# GH#11 Host-global playback controls

**Status:** Implemented and activated in production. Local verification and
independent review report no open P0/P1/P2. Interactive installed-Host
acceptance remains pending.

## Governing invariant

Every accepted Host pause or resume request creates exactly one durable,
game-scoped playback command causally bound to retained Host action, and the
Host UI changes verified playback state only from the authoritative command
projection.

The controls are global Host authority. They remain available during active
phone-controlled and Host-controlled turns, but they do not grant playback
authority to participants.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: `ReleaseStore.applyHostGameAction()` atomically appends one `playback_requested` event and `appendControlPlaybackCommand()` creates its deterministic command. |
| Update | `schema`: command identity and transitions are immutable; `runtime`: the existing finite transition machine alone advances execution state. |
| Delete | `structural`: accepted actions, causal events, commands, and transitions are retained; game termination uses the existing explicit terminal cancellation. |
| Omit | `runtime`: `validatePlaybackCommands()` requires every control event to have its exact command and every command to have its exact causal event. |
| Duplicate | `schema`: action receipt and command primary keys reject duplicate identity; `runtime`: exact action replay returns the retained result without another command. |
| Reorder | `runtime`: game event sequence orders commands, transition sequence orders execution, and supersession must name the immediate next playback event. |
| Replay | `runtime`: retained action and transition identities are checked before current authority or state, preserving response-loss recovery without a second effect. |
| Conflict | `runtime`: request reuse with different action content fails before current-state evaluation. |
| Concurrency | `runtime`: the existing immediate transaction and expected revision allow only one accepted action at a prior revision. |
| Expiry | `not_applicable`: pause and resume commands do not expire; existing Host-session authorization remains independently time-bound. |
| Restart | `runtime`: startup validates causal events and transitions; pending playback survives while restarted shared audio must reconnect before execution. |
| Dependency failure | `runtime`: native failure remains a finite failed command, the projection retains the prior verified state, and the Host may retry. |
| Corruption | `runtime`: canonical event detail, deterministic command identity, causal timestamps, command kind, transitions, outcome hash, and verified player state all fail closed on validation. |
| Capacity | `runtime`: pause, resume, and track commands share `MAX_PLAYBACK_COMMANDS_PER_GAME`; overflow is the finite `playback_capacity` result and rolls back its action event. |

## Enforcement locations

- `web/lib/server/release/game-journey.mjs`: Host-only operations, active-phase
  boundary, and canonical causal event.
- `web/lib/server/release/store.mjs`: active-audio/verified-state precondition,
  atomic command creation, finite errors, and Host-only playback projection.
- `web/lib/server/release/playback-commands.mjs`: durable command lifecycle,
  causal validation, replay, supersession, completion readback, and capacity.
- `web/lib/release-game-client.ts` and `web/app/page.tsx`: exact Host projection
  parsing and pending/verified/failed UI states.

## Verification evidence

The focused local suite passed 44 tests:

```text
node --test release/tests/game-journey.test.mjs \
  release/tests/game-journey-routes.test.mjs \
  release/tests/playback-commands.test.mjs \
  web/tests/release-game-client.test.mjs \
  web/tests/rendered-html.test.mjs
```

`npm --prefix web run lint` also passed. The local counterexample pass covers
participant invocation, exact response-loss replay, restart with interrupted
audio, failed native execution and retry, redundant same-state control, and a
canonical control event mutated to name the opposite command.

The proportional regression gates also passed:

- `npm --prefix web test` — production build plus 338/338 web tests.
- `node --test --test-concurrency=1 release/tests/*.test.mjs
  release/tests/*.integration.mjs` — 265/265 release tests.
- `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift run
  CannaBeatsHostPlaybackVerifier` — 20/20 native playback checks.

## Production activation

On 2026-08-23 commit `a5f5a88` activated as
`release-1.0.0-8-a5f5a88`, retaining `release-1.0.0-7-ef977c0` as the rollback
target. The transaction preserved the retained active game and long-running
relay container while health-gating the replacement web and Caddy containers.
Eight consecutive public readiness probes passed. The public production asset
contains `Pause music`, `Resume music`, `Confirming music`, `pause_playback`,
and `resume_playback`.

## Open findings and deferrals

- P0: none.
- P1: none found by the local pass.
- P2: the independent review found that the control could briefly re-enable
  between action acceptance and authoritative projection refresh. The dedicated
  `playbackControlBusy` fence now remains set through that refresh. Its first
  re-audit found an evidence-precision gap; the strengthened source-contract
  assertions enumerate the complete fence lifecycle. Final narrow re-audit
  reports P0/P1/P2 none.
- Named deferral: interactive installed-Host acceptance remains open. The
  current native Host already executes and verifies the retained `play` and
  `pause` command kinds, so this increment does not require a replacement DMG.
