# ADR 0001: The lobby orchestrates game runs

- Status: Accepted
- Date: 2026-08-10

## Context

CannaBeats needs a stable place where an authorized family member can create or join a gathering before a game has been configured or started. That place is the lobby. It is the boundary at which CannaBeats authenticates people, assigns host and member roles, coordinates the host's local Spotify connection and audio relay, and supports reconnecting from browser, PWA, or desktop clients.

The existing game engine already has useful configuration, player-seat, phase, playback, placement, and scoring behavior. During the first integration, its `room` was made the public session and the separate lobby API was removed. That made the engine easier to launch, but it collapsed two different lifecycles:

- a family gathering, which may exist before a game and survive the end or replacement of one; and
- a game run, which is configured, played, scored, and ended inside that gathering.

This collapse also made a gameplay seat stand in for an authenticated lobby member and made an engine room code stand in for the durable session identity. Those substitutions prevent the product flow we want: create or select a lobby, invite authorized people, configure a game using the existing engine, play it, and potentially play again without creating a new gathering.

## Decision

The lobby is the durable orchestration and authorization layer. A game run is an attached child of a lobby and is owned by the existing game engine.

The public session code resolves only a lobby. It is a convenient locator, never an authentication credential and never a game-run identifier. Authentication and authorization remain server-side and use the principal established by a passkey-backed browser session, a signed Host app request, or a revocable desktop credential.

Responsibility is divided as follows:

| Lobby owns | Game run owns |
| --- | --- |
| Public session code and lifecycle | Game rules and configured content |
| Host and authenticated membership | Gameplay seats, including screen-controlled players |
| Authorization to view, configure, host, or join | Phase and turn progression |
| Browser, PWA, Host app, and desktop entry/reconnect | Song progression and answer actions |
| Host Spotify and audio-relay coordination | Placements, scoring, and results |
| The active game-run reference | Runtime state for one playthrough |

The intended lifecycle is:

```text
lobby created
    -> authorized members join
    -> host configures a game
    -> game run is prepared and attached
    -> game is played
    -> game run ends
    -> lobby closes or hosts another run
```

The first implementation may support only one active run per lobby, but its data model and API boundaries must not make the lobby and run the same object.

## Required invariants

These invariants are acceptance criteria for the integration and for future cleanup:

1. A lobby can exist without a configured or active game run.
2. A public code resolves a lobby only; knowledge of the code grants no authority.
3. Lobby membership and host role are independent of gameplay seats.
4. Every game run belongs to exactly one lobby.
5. The Host app creates or selects a lobby. It does not create a public engine room.
6. Browser, PWA, and desktop clients enter an authorized lobby before entering its active game run.
7. Game configuration and runtime behavior reuse the existing engine rather than duplicating it in a parallel lobby implementation.
8. Spotify refresh credentials remain local to the host's browser profile. Lobby state may record coordination state, but not those credentials.
9. Audio-relay authority and control are scoped through the lobby and its authorized members, not through possession of a run or room code.
10. Ending or replacing a run does not inherently change the lobby's public identity or membership.

## Explicit anti-patterns

The following are architectural regressions:

- using an engine `rooms.code` value as the public CannaBeats session;
- deleting or bypassing lobby membership APIs because the engine has player seats;
- allowing a join code to authenticate a user;
- making the Host app launch directly into an unattached engine room; or
- reimplementing the game engine inside the lobby service.

## Consequences

The integration needs an explicit lobby-to-run relationship and an adapter between authenticated lobby members and engine player seats. This adds a boundary, but it preserves the product lifecycle and lets the engine remain focused on gameplay.

Existing passkey, Host app signing, desktop credential, one-time web-ticket, local Spotify, and relay-grant work remains valid. The cleanup should change what those credentials enter and authorize: a lobby first, followed by that lobby's game run.

The current public engine-room flow is transitional and must be migrated rather than treated as the canonical model. Existing engine state/actions should be retained beneath the new boundary wherever possible.

## Non-goals

This decision does not require the first implementation to support concurrent game runs, completed-run history, production audio capture, audio synchronization refinements, or a broader Spotify licensing model. It establishes the ownership and lifecycle boundaries those features must respect.
