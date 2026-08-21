# FR-4 shared game journey and durable actions

**Status:** Complete; independently reviewed with no open P0/P1/P2.

## Governing invariant

Every accepted Host or participant game command advances exactly one retained
revision at most once, and its authoritative role-filtered result can be
reconstructed and validated from the game-scoped receipt and event history
after restart.

## Product-scale boundary

FR-4 owns one active friends-and-family game, a fixed finite command set,
SQLite transactions, bounded HTTP polling, and the existing browser game
experience. It does not introduce a native Swift game model, a workflow engine,
WebSockets, distributed locks, or generalized multi-game scheduling.

The schema and APIs retain an opaque `game_id`, catalog version, Host owner,
revision, lifecycle, and game-scoped child rows. The release permits one
nonterminal game now, but no command or child identity relies on that fact.
Lifting the partial unique index in a future checkpoint can therefore permit
multiple games without replacing the game model or its APIs.

An unfinished game has no inactivity deadline. Its state and participant
authority survive browser closure, device sleep, process restart, and a
multi-day pause. Only explicit participant removal or terminal game lifecycle
ends participant authority.

## Fixed command contract

All commands are posted to `POST /api/games/{gameId}/actions` with the supported
`x-cannabeats-client-contract` header. The body has exactly:

```json
{
  "requestId": "UUIDv4",
  "expectedRevision": 7,
  "operation": "place_song",
  "payload": { "index": 2 }
}
```

The Host supplies its application bearer session. A participant supplies the
game-scoped HttpOnly cookie. When both valid cookies are present in one browser,
the fixed `x-cannabeats-game-role` header selects exactly one; missing or invalid
role selection fails before dispatch.
Actor identity is derived by the server and is never accepted from the body.

| Operation | Authority | Phase | Exact payload | Resulting event(s) |
| --- | --- | --- | --- | --- |
| `configure_game` | Host | lobby | normalized `rules` | `game_configured` |
| `add_host_player` | Host | lobby | UUIDv4 `playerId`, normalized `name` | `game_configured` with an `add_host_player` detail |
| `remove_host_player` | Host | lobby | UUIDv4 `playerId` | `game_configured` with a `remove_host_player` detail |
| `start_game` | Host | lobby | empty | `game_started` |
| `begin_round` | Host | ready | empty | `track_requested` |
| `place_song` | active player | playing | integer `index` | `placement_locked` |
| `retract_placement` | active player | placed | empty | `placement_retracted` |
| `reveal_answer` | Host | placed | empty | `answer_revealed` |
| `advance_round` | Host | revealed | empty | `round_advanced` and `track_requested`, or `game_completed` |
| `skip_track` | Host | playing or placed | empty | `track_skipped` and `track_requested` |

For a Host-controlled active player, only the Host may place or retract. For a
phone-controlled active player, only that participant may do so. A participant
cannot name another player in a command.

`terminate_game` remains the FR-3 explicit end-game operation. The browser's
post-completion **Play again** choice creates a fresh game through the ordinary
game-creation boundary, prefilled with the prior rules. It deliberately gets a
new `game_id`, revision zero, receipts, roster, invitations, and participant
credentials; no completed game is reopened or mutated. This is sufficient for
one active game and remains compatible with future simultaneous games.

## Deterministic catalog selection

The server filters the retained catalog by the game's immutable catalog
version, year range, catalog scope, unused URI set, and configured era weights.
Starting-player and song draws are derived from SHA-256 over the game ID,
request ID, purpose, and draw ordinal. The draw has no security role; it makes
the accepted command reproducible without retaining an ambient random-source
outcome or calling an external dependency.

`start_game` selects one seed song per player, one starting player, and one
current song. `advance_round` and `skip_track` select one current song. Empty
eligible catalogs fail with the finite `catalog_exhausted` result before any
revision or event is written.

FR-4 records `track_requested` intent only. Creating, claiming, executing, and
reconciling macOS Spotify playback commands is owned by FR-5; FR-4 UI must not
claim that playback occurred.

## State, history, and terminal result

The shared reducer is pure and accepts only a validated prior state, a fixed
command, server-derived actor, and retained catalog. It returns a validated
next state, lifecycle, and exact significant events. The transaction writes:

1. revision `prior + 1` and the canonical next state;
2. one immutable action receipt containing the canonical request and complete
   authoritative result;
3. one or more gap-free significant events at that same revision; and
4. on completion, one immutable compact `game_results` row in the same
   transaction.

The compact result contains exactly the game ID, catalog version, final
revision, winner ID, completed round, final rules, and each player's ID,
control, name, and score. Score is the final timeline length. It contains no
credential, request identity, invite identity, or playback data.
Its row identity is the immutable game ID, so a request UUID reused in a later
game cannot collide with the earlier game's result.

Startup validation distrusts retained rows. It verifies canonical bytes,
catalog binding, complete revision coverage, exact receipt/event linkage, legal
command transitions, deterministic draws, state-chain continuity, lifecycle,
and terminal projection. The same validator runs before reveal and completion;
later export and deletion checkpoints must call it rather than add weaker
variants.

## Projection and client behavior

Host results contain the complete canonical game state. Participant results and
snapshots contain identity, phase, round, roster/timelines, active player,
retraction availability, and winner information. Before reveal they omit the
current song, placement, and result keys entirely. At reveal they include those
three answer fields. Terminal lifecycle ends participant authority; the
already-delivered revealed winner state remains locally displayable while the
Host owns the durable final result.

The browser preserves a command's request ID and exact body while its outcome
is uncertain. It may retry after transport failure or response loss, but it
does not mint a replacement command. Pending controls remain disabled and are
announced through an ARIA live region. A stale revision triggers an
authoritative refresh and asks the user to retry the still-applicable intent;
it never silently changes the retained request. Unsupported client versions,
unauthorized, stale, rejected, catalog exhaustion, game ended, database
unavailable/corrupt, and malformed response each have finite accessible text.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime` + `schema`: only `add_host_player` creates a journey identity; UUID uniqueness is validated before the lobby transaction, while phone players remain owned by FR-3 admission. Completion creates exactly one schema-unique result row. |
| Update | `runtime`: one named reducer enumerates every mutable field and phase transition; game/catalog/player identities and completed results remain immutable. |
| Delete | `structural`: FR-4 deletes no game, receipt, event, result, or participant evidence. Lobby-only Host-player removal changes the current roster through a retained receipt/event. FR-9 owns physical purge. |
| Omit | `runtime`: exact object keys, revision-chain coverage, receipt/event linkage, phase relationships, catalog draws, and terminal projection are required by the shared database validator. |
| Duplicate | `schema` + `runtime`: receipt identity, event sequence, result-per-game, player IDs, and song URIs are unique; exact duplicate commands replay their original result. |
| Reorder | `schema` + `runtime`: events have a game-scoped primary-key sequence; validation requires contiguous order, nondecreasing revisions/times, exact per-revision events, and legal transition order. |
| Replay | `runtime`: retained actor plus request identity is checked before current authority or lifecycle; identical operation and canonical bytes return the original receipt without a second effect. |
| Conflict | `runtime`: reusing a retained request identity with different operation or bytes returns `request_conflict` before authority, phase, or revision evaluation. |
| Concurrency | `schema` + `runtime`: `BEGIN IMMEDIATE`, expected revision, and compare-and-update ensure two commands observing one revision can commit at most one next revision; the loser returns `stale_state`. |
| Expiry | `not_applicable`: accepted game commands and unfinished games have no clock expiry. Host application-session expiry remains FR-2 authority policy; participant authority ends only at removal or terminal lifecycle. |
| Restart | `runtime`: startup restores canonical state and replays the retained command/history relationships before exposing readiness or snapshots. No process-only reducer state exists. |
| Dependency failure | `structural` + `runtime`: gameplay reduction has no network dependency; catalog exhaustion and local database failures normalize to finite codes. Spotify execution is deferred to FR-5 and cannot make FR-4 tests greener. |
| Corruption | `runtime`: malformed canonical bytes, valid-but-impossible state transitions, catalog drift, hidden song substitution, receipt/event gaps, head-timestamp drift, lifecycle mismatch, and terminal-result mismatch fail closed before partial output. |
| Capacity | `runtime`: a fixed eight-phone-seat admission limit remains FR-3; total players are bounded at eight for the first release, catalog selection fails before mutation when no unused eligible song remains, and database readiness retains its cleanup reserve. |

## Matrix-derived verification

The FR-4 suite must prove:

- every command's positive transition and wrong-role/wrong-phase rejection;
- zero, one, seven, and eight-player starts, plus ninth-player rejection;
- placement at zero and timeline length, and rejection at `-1` and
  `length + 1`;
- allowed, disabled, duplicate, wrong-actor, and post-restart retraction;
- correct equal-year boundaries, incorrect placement, score, winner, and one
  terminal result;
- skip, catalog filtering/weighting, exhausted catalog, and deterministic draw
  reconstruction;
- exact replay before revocation/completion, conflicting reuse, response loss,
  and two commands racing at one revision;
- close/reopen after every phase and full history-driven reconstruction;
- deletion, duplication, gap, reorder, and relationship-preserving mutation of
  receipts, events, snapshots, catalog songs, and result projection;
- absence of answer fields in every pre-reveal participant snapshot and action
  response, including rejection and replay paths; and
- incompatible client, pending/retry, stale refresh, reconnect, terminal, and
  finite failure UI behavior with keyboard and screen-reader-visible status.

## Named deferrals

- FR-5 owns durable playback commands, Spotify/macOS dependency outcomes, and
  playback claim-generation fencing.
- FR-6 owns authenticated shared audio and audio-generation reconnect.
- FR-7 owns polished first-run and recovery presentation beyond the finite
  accessible states required here.
- FR-8 owns packaged catalog replacement and release rollback behavior.
- FR-9 owns result export and physical deletion/purge after full validation.
- Supporting more than one simultaneous nonterminal game requires a concrete
  product need and removal of the single-active partial index; game-scoped
  identities and APIs require no redesign.

## Closure evidence

Local verification after the counterexample pass and independent-review
remediation:

- `node --test --test-concurrency=1 release/tests/*.test.mjs` — 86/86 passed.
- `node --test --test-concurrency=1 web/tests/*.test.mjs` — 332/332 passed.
- `node --test release/tests/next-runtime.integration.mjs` — 1/1 standalone
  Next process admission, hidden projection, gameplay, reveal, and recovery
  journey passed.
- `npm run lint` — 0 errors; one pre-existing unused-parameter warning in
  `web/lib/s2e-e5-browser-session.mjs`.
- `NEXT_PUBLIC_CANNABEATS_BASE_PATH=/game npm run build` — production build
  passed.
- Direct production-build browser checks at 390×844 and 1440×900 found no
  horizontal overflow; Host and invitation entry controls exposed the expected
  labels and enabled states.

The local counterexample pass found and closed one head-timestamp reconstruction
gap. Independent review reported one P1 recovery group and two P2s; remediation
retains malformed-success actions as outcome-unknown, resumes saved pending
terminal actions before discovery, scopes result identity to the game, and
executes the complete client recovery schedule through its shared success
reducer. Two narrow independent reaudits closed the affected perspectives with
P0=0, P1=0, and P2=0. Named deferrals remain FR-5 through FR-9 as listed above;
the FR-4 checkpoint commit contains this evidence.
