# CannaBeats Feature Backlog

**Status:** Active delivery backlog
**Purpose:** Keep a small, ordered queue of user-facing improvements that are
not part of the current first-release checkpoint.
**Last updated:** 2026-08-23

## How to use this document

- The [first-release plan](first-release-plan.md) remains the active execution
  plan. A backlog entry is not authorization to interrupt its current
  checkpoint.
- Order entries by the value of doing them next. Reorder the queue when product
  priorities change rather than treating the identifier as a priority.
- `Proposed` means the behavior is worth retaining but has not been selected
  for implementation. Move selected work into the release plan or a focused
  implementation document with its governing invariant, closure matrix, and
  acceptance tests.
- Keep unprioritized or exploratory ideas in the broader
  [product backlog](product-backlog.md).

## Queue

| Order | ID | Status | Feature |
| --- | --- | --- | --- |
| 1 | FB-001 | Proposed | Add the host as a player by default |

## FB-001 — Add the host as a player by default

### User outcome

When creating a new game, the host is included automatically as a
host-controlled player. The host can remove that player before the game begins
when they want to facilitate without playing.

### Expected behavior

- New-game setup presents an editable host player name and defaults **Play in
  this game** to on.
- Accepting setup with that choice on creates exactly one host-controlled
  player using the existing `add_host_player` journey operation. It does not
  create a browser participant, phone credential, or second host authority.
- Turning the choice off, or removing the player from the lobby, uses the
  existing host-player removal behavior and leaves the Mac authorized to host.
- The host player counts toward the same eight-player game limit as every other
  gameplay seat.
- Retry, refresh, process restart, and multi-day game resume never add a second
  host player. Removing the player is durable for that game; reconnecting the
  Host application must not silently add it again.
- The automatic default applies only when a new game is created. Existing games
  keep their persisted roster unchanged.

### Acceptance intent

1. A newly created game has one, and only one, host-controlled player when the
   default is accepted.
2. The host can edit the player's name before play.
3. The host can remove that player and start or resume the game solely as host.
4. Repeating a successful create request cannot duplicate the host player.
5. Lobby capacity, readiness, roster, and game-start validation treat the host
   player as an ordinary gameplay seat while keeping host authority separate.

### Implementation note

The server journey already exposes `add_host_player` and `remove_host_player`.
This feature should therefore remain a lobby/defaulting change unless the
implementation uncovers a concrete missing invariant; it does not justify a
new player type or authentication path.
