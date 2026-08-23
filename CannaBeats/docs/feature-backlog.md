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
| 1 | FB-001 | Proposed | Add the authenticated host as an account-linked player by default |
| 2 | FB-002 | Proposed | Let the host add previously authenticated players |

## FB-001 — Add the authenticated host as an account-linked player by default

### User outcome

When creating a new game, the host is included automatically as a
host-controlled player linked to the host's user account. Their results can
therefore contribute to the same personal statistics as games in which they
join through another client. The host can remove that player before the game
begins when they want to facilitate without playing.

### Expected behavior

- New-game setup presents an editable host player name and defaults **Play in
  this game** to on.
- Accepting setup with that choice on creates exactly one host-controlled
  player using the existing `add_host_player` journey operation and associates
  that seat with the current authenticated host account's stable player
  identity. It does not create a browser participant, phone credential, or
  second host authority.
- Editing the display name changes how the player appears in this game; it does
  not break or replace the underlying account association.
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
   default is accepted, and that player is linked to the authenticated host's
   account identity.
2. The host can edit the player's name before play.
3. The host can remove that player and start or resume the game solely as host.
4. Repeating a successful create request cannot duplicate the host player.
5. Lobby capacity, readiness, roster, and game-start validation treat the host
   player as an ordinary gameplay seat while keeping host authority separate.
6. Completed-game statistics are attributed to the host's account exactly once
   even after request retry, application restart, or game resume.

### Implementation note

The server journey already exposes `add_host_player` and `remove_host_player`.
The feature should extend that seat with an optional immutable account/profile
association rather than introducing a new player type or authentication path.
The Host application's device enrollment is not itself the player's identity;
the association must come from the authenticated host account.

## FB-002 — Let the host add previously authenticated players

### User outcome

While building the roster, the host can select a family member or friend who
has previously authenticated with CannaBeats and add a player linked to that
person's account. Their results then contribute to their existing statistics
without requiring them to repeat authentication merely to use the host screen.

### Expected behavior

- The host can search or choose from previously authenticated players who are
  eligible within the private CannaBeats group.
- Selecting a person creates one host-controlled gameplay seat associated with
  that person's stable account/player identity. The person does not receive
  host authority, and the host receives no access to their credentials,
  account settings, or private authentication data.
- The roster displays enough information to confirm the intended person while
  avoiding disclosure of email addresses, passkeys, or other credential data.
- A player may still join through their own phone instead. The same account
  cannot occupy both an account-linked host-controlled seat and a phone seat in
  the same game.
- Removing the seat removes that person's participation from the game but does
  not delete or alter their account or prior statistics.
- Retry, refresh, process restart, and multi-day resume preserve the association
  without creating duplicate seats or duplicate statistical attribution.
- Account suspension, deletion, or loss of eligibility fails closed for new
  additions. Existing historical results retain the documented identity or
  anonymization outcome defined by the profile-retention policy.

### Acceptance intent

1. An eligible previously authenticated player can be selected and added
   without authenticating again on the Host Mac.
2. The resulting seat is linked to the selected stable account identity and
   completed-game statistics are attributed exactly once.
3. Two seats in one game cannot be linked to the same account.
4. Selecting or retrying the same addition cannot create a duplicate seat.
5. The host cannot obtain account authority or credential information by adding
   the player.
6. Removing the player changes only the current game's roster.

### Implementation note

The smallest first version is an account-linked host-controlled/shared-screen
seat. Pre-creating a seat that a phone later claims is a separate lifecycle and
should be added only if an actual game-night need justifies its handoff and
recovery rules. Persistent statistics also require the optional profile/history
model described in the [product backlog](product-backlog.md); these two features
should not invent a parallel identity store.
