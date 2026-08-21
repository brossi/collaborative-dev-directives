# FR-3: Game invitation, participant admission, and recovery

- **Status:** Complete; independently reviewed with no open P0/P1/P2
- **Governing plan:** [CannaBeats first-release plan](../first-release-plan.md)
- **Governing invariant:** An unexpired game invitation creates at most one
  bounded seat whose participant credential remains valid for that game's
  lifecycle, while refresh and reconnect restore that same seat without
  revealing hidden game data.

## Boundary

FR-3 makes Host sessions the only authority for game creation, invitation,
roster removal, and termination. Participants have no account: admission
atomically creates one opaque game-scoped participant ID and one hashed browser
session. A normalized display name is presentation and uniqueness data, never
identity or recovery authority.

The release retains one-active-game only as the existing removable partial
index. Every route and row remains scoped by opaque `game_id`; no API introduces
a global current-game identity.

## Fixed lifetimes and capacities

| Identity | Lifetime/capacity |
| --- | --- |
| Game invitation | Six hours; multi-use until closed |
| Active invitation | One per game; regeneration closes the prior invitation |
| Participant session | Until participant removal or game termination; one initial session per seat in FR-3 |
| Active participants | Eight per game |
| Display name | 1–24 Unicode scalar values after NFKC, trim, and whitespace collapse |
| Retained participants | Removed rows remain evidence; growth is bounded operationally by the database free-space readiness reserve, not an invented row count |
| Recoverable game | The one nonterminal game referenced by a live Host or unrevoked participant session |

At `now == expires_at`, an invitation is expired. Participant authority has no
absolute or inactivity-based expiration: an unfinished game can remain paused
indefinitely, and participant authority ends only when the participant is
removed or the game terminates. Secrets are
caller-generated unpadded URL-safe base64 with at least 128 bits of randomness;
only SHA-256 hashes are retained. The participant cookie is
`__Host-cannabeats-participant` with `Secure`, `HttpOnly`, `SameSite=Strict`,
`Path=/`, and no `Domain`. HTTP responses refresh a long-lived persistent cookie
with the browser-supported 400-day `Max-Age`. This is a rolling local-storage
retention setting, not a game timeout or an authority lifetime; browser/user
eviction can still remove the local credential.

## Admission and recovery

- Host game creation derives `host_device_id` from a live application session.
  Exact replay precedes current authority. If another lobby/active game exists,
  the finite result returns that opaque game ID for reopening and creates no
  game row. A dedicated immutable create-decision receipt retains this no-op
  result so an exact retry cannot become a later creation.
- Invitation issue/regeneration is a game mutation. It closes any prior open
  invitation as `revoked`, stores the new hash, and returns only expiry metadata;
  the native caller already holds the plaintext fragment token. A full roster
  cannot issue or retain a new open invitation.
- Share URLs use
  `https://play.cannabeats.social/join/{gameId}#invite={token}`. The fragment is
  submitted once in a JSON body and never appears in a request path, query,
  redirect, retained row, response envelope, or log.
- Admission receives the fragment token, caller-generated participant UUID,
  caller-generated session token, display name, and request UUID. Exact replay
  is checked before invite use, expiry, lifecycle, name, or capacity.
- Admission does not require a client revision: a newly linked browser cannot
  know it, and the synchronous owner serializes joins before applying the
  active-name and eight-seat constraints. Host mutations remain revision-bound.
- Successful admission atomically creates the seat, session, receipt, event,
  lobby player projection, and cookie result. Simultaneous last-seat attempts
  serialize under the one owner; exactly one commits.
- A valid participant cookie always resolves its retained game/seat directly.
  Refresh, browser sleep, and reconnect are reads and create no second seat.
  Session revocation is finite `unauthorized`; names cannot reclaim seats.
- Removing a participant is permitted only in the lobby. The row/session are
  revoked and retained, the player leaves the lobby projection, and its seat
  number becomes available to a later admission. Historical rows may therefore
  share a seat number, while active rows may not.
- Transition from lobby to active atomically closes every open invitation as
  `started`. Host termination closes it as `revoked`, abandons the game through
  the ordinary retained mutation/event path, and releases the one-active-game
  constraint. Nonterminal games survive restart and are reopened by opaque ID;
  terminal games are not reopened as new mutable games.

## Role-filtered snapshot

Host and participant reads authenticate before projection. The Host recovery
and game-scoped snapshot surfaces return the complete canonical Host state.
Participant output
contains game lifecycle/revision, the participant's own ID, public roster, turn
identity, and already-revealed timeline/score information. Before the
`revealed` phase it omits current-song title, artist, year/release year, correct
placement, result, and any equivalent answer-bearing field. Unknown game,
wrong-game session and removed seat are concealed as
`unauthorized`.

## Finite results

Accepted codes are `created`, `active_game_exists`, `invitation_issued`,
`participant_admitted`, `participant_removed`, `game_terminated`, and
`snapshot`. Failures are limited to `invalid_request`, `unauthorized`,
`request_conflict`, `expired`, `already_used`, `capacity_reached`,
`duplicate_name`, `game_started`, `game_ended`, `stale_state`,
`catalog_incompatible`, `database_unavailable`, and `database_corrupt`. Failure envelopes never echo
tokens, hashes, display names, paths, SQL, or native errors.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime` + `schema`: named owner transactions create games, invites, participants, sessions, receipts, and events under game-scoped PK/FK/unique constraints. |
| Update | `runtime` + `schema`: identities, hashes, join evidence, and issue times are immutable; write-once triggers make close/removal/revocation terminal. |
| Delete | `structural`: FR-3 deletes no invitation, participant, session, receipt, or event; removal is a retained timestamp and active seat-number reuse is explicitly represented. |
| Omit | `runtime`: startup enumerates every row and requires reciprocal create-decision/game, invite/receipt, participant/session, player/participant, receipt/event, lifecycle/closure, and removal/revocation relationships. |
| Duplicate | `schema`: one open invite, active normalized name, active seat number, participant ID, session hash, and action identity are unique in their scopes. |
| Reorder | `runtime`: join/removal/session/invite timestamps, seat order, revisions, and event sequence remain monotonic and parent-bounded. |
| Replay | `runtime`: exact receipts are evaluated before current Host authority, invitation expiry/closure, lifecycle, name, capacity, or removal state. Reads reuse the same session and seat without mutation. |
| Conflict | `runtime`: request-ID reuse with different canonical hashes and token/ID reuse with different content fail before current-state evaluation. |
| Concurrency | `runtime` + `schema`: the synchronous owner and `BEGIN IMMEDIATE` serialize the two-request last-seat, duplicate-name, regeneration, removal, and one-active-game schedules; unique constraints decide any residual race. |
| Expiry | `runtime`: invitation equality is expired; participant authority has no clock expiry and is bounded by explicit removal or terminal game lifecycle. |
| Restart | `runtime`: readiness reconstructs all reciprocal authority, receipt/event, roster/player, lifecycle, closure, and historical-capacity relationships before serving. |
| Dependency failure | `runtime`: bounded malformed bodies, database failures, and response loss return finite results without partial seat or credential creation. |
| Corruption | `runtime`: changed hashes, parents, normalized names, seat numbers, timestamps, lifecycle closure, session links, projections, and canonical results fail closed. |
| Capacity | `schema` + `runtime`: eight active seats and one open invite are checked in the mutation transaction and on restart; removal frees only the active slot. Retained evidence uses the database free-space readiness reserve rather than an unimplemented row limit. |

## Matrix-derived verification

- Host game create response loss, conflicting reuse, revoked/expired Host, and
  active-game reopen without a second game.
- Invitation issue/regeneration/revocation, before/equality/after expiry,
  fragment-only URL, start/termination closure, and retained hash-only scan.
- Admission exact replay and response loss; token/participant/request conflict;
  intercepted invite without a retained session; duplicate normalized names;
  malformed/unsafe names; and unknown/revoked/expired invite.
- Seat `max-1`, `max`, `max+1`, a two-request final-seat owner schedule, middle-seat
  removal/reuse, removal replay, removed-session rejection, and no deletion of
  retained evidence.
- Refresh/reconnect/restart and a multi-day pause return the same participant
  and create no row; removal and game termination revoke further authority.
- Post-start and terminal admission rejection, active invitation closure, Host
  reopening of the same nonterminal game, and explicit termination.
- Corrupt each reciprocal hash, parent, normalized name, seat, timestamp,
  session, receipt, event, player projection, and lifecycle/closure relation
  while preserving the other checked relationships; readiness fails closed.
- Scan every participant snapshot before reveal for song metadata, correct
  placement, result, and equivalent answer fields; scan failures/cookies for
  every secret except the intended participant cookie bearer.

## Pre-audit counterexample question

What is the smallest mutation that keeps the participant row, game player, and
session individually valid but moves one of them to another seat, game, invite,
revision, or lifecycle? Apply the same question to normalized-name aliases,
removed-seat reuse, response-loss receipts, invitation regeneration,
invitation-expiry equality, lifecycle-bound participant authority, and
pre-reveal projection before review.

## Closure evidence

Verified on 2026-08-21:

- `node --test release/tests/game-admission.test.mjs release/tests/game-admission-routes.test.mjs release/tests/store.test.mjs`
  passed 33/33 after remediation.
- `node --test --test-concurrency=1 release/tests/*.test.mjs` passed 68/68.
- `npm test` in `web/` completed the production Next.js build and passed
  337/337 browser/server tests.
- `npm run lint` in `web/` completed with zero errors and one pre-existing
  warning in `web/lib/s2e-e5-browser-session.mjs`.
- The initial independent review found P0 0, P1 4, and P2 2. The narrow
  remediation re-audit reproduced the affected schedules and reported P0 0,
  P1 0, and P2 0.

Open findings: P0 0, P1 0, P2 0.

## Deferrals

- FR-4 owns configuration/start UI, full gameplay reducers, durable ordinary
  actions, final results, and complete shared browser journey. FR-3 only makes
  an eventual lobby-to-active transition close admission atomically.
- FR-6 owns audio authorization using the Host/participant session boundaries.
- FR-7 owns polished native sharing/navigation and browser reconnect UX.
- FR-8 owns deployment cleanup scheduling and operational recovery packaging.
