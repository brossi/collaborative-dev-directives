# CannaBeats Product Backlog

**Status:** Working document; unprioritized; not published
**Purpose:** Preserve product and technical ideas as a starting point for future discovery and implementation planning.
**Last updated:** 2026-08-23

## How to use this document

- The order of entries does not indicate priority.
- An entry records an idea, not a commitment to build it.
- Do not restate work that is already complete or approaches that were deliberately rejected. Improvements to existing behavior remain valid backlog items when they describe a meaningful unresolved problem or opportunity.
- Validate usefulness and expected behavior before implementation.
- Track immediate playtest blockers in the active testing workflow rather than in this durable product backlog.
- Track ordered, near-term user-facing improvements in the [feature backlog](feature-backlog.md).
- When an idea is selected for work, give it acceptance criteria, dependencies, risks, and an implementation plan in a dedicated issue or design document.

## Intentional private-use scope

CannaBeats is intended for a small, invitation-only group of personally selected family and friends. It is not planned as a public, commercial, or broadly distributed service. The project owner is already aware of Spotify's platform-policy and rebroadcasting constraints and accepts them as a known risk within this private scope. Future reviews should not repeatedly raise this as an implementation blocker.

Revisit licensing or provider approval only if the intended scope materially changes—for example, public enrollment, commercialization, broad distribution, or operation for unrelated third parties. This statement records project scope and a known, accepted risk; it does not assert legal or provider approval.

## Gameplay and mechanics

### First-time player guidance

Teach the listen, place, lock, retract, reveal, and score loop without requiring the host to explain every control. Use concise lobby instructions, contextual prompts during a player's first turn, and an optional practice round or demonstration that cannot affect the real score.

Keep repeat play fast by making guidance dismissible and remembering only a low-risk local preference. Instructions must reflect the selected mode and clearly distinguish private phone actions from shared-screen or host actions.

### Progressive hints

Allow the active player to disclose progressively more useful information before the placement is locked and the year is revealed. Candidate hint types include album, artist, title, decade, or a narrowed placement range; their availability, order, and cost should be configurable by game mode rather than fixed globally.

Questions to resolve:

- Does each hint reduce the score, consume a token, or lower the maximum available reward?
- Can the active player, team, or host request a hint?
- How do disclosed title and artist hints interact with bonuses for identifying them?
- Which hint types and disclosure order work for each mode or audience?

Record every disclosed hint as part of the round so scoring and post-game statistics remain explainable.

### Spoken title and artist answers

Allow a player to submit a song title and artist by speaking into the host or remote client. A likely flow is:

```text
Player starts push-to-talk
  → client captures the spoken answer
  → speech-to-text transcribes it
  → title/artist matching compares it with catalog metadata
  → player confirms or corrects the interpretation
  → game awards identification bonuses
```

A speech-to-text service or local model would transcribe the player's voice; it would not identify the song directly from the shared music stream. Keep the requirement provider-neutral until latency, accuracy, cost, and platform behavior have been tested. Push-to-talk, or temporarily lowering/pausing playback, may be necessary to prevent the song from overwhelming the microphone.

Matching needs to tolerate:

- Optional leading articles such as “The”
- Featured artists and multiple performers
- Alternate, abbreviated, and parenthetical titles
- Soundtrack, cast-recording, cover, and remaster variants
- Homophones and ordinary transcription mistakes

The player should be able to confirm or correct the interpreted answer before it becomes final. Typed answer entry must remain available when microphone access is denied, inappropriate, or unreliable. Before enabling voice capture—particularly for minors—define clear consent, processing location, retention, deletion, and diagnostic-logging behavior.

### Differentiated scoring and game economy

Potential scoring dimensions include:

- Correct timeline placement
- Exact year or closeness to the year
- Correct song title
- Correct artist
- No-hint bonus
- Speed bonus
- Streak multiplier
- Confidence wagers, such as risking a safe placement reward for a larger exact-year reward

Points or earned tokens could fund helpers such as:

- Reveal a hint
- Narrow the possible era
- Remove an implausible placement
- Take a second guess
- Protect a streak
- Ask another player for help

Represent scoring as an explicit policy outside the basic round state machine so modes can compose rules without changing core placement and reveal behavior. Do not assume a separately deployed or generalized scoring engine until more than one validated mode requires it.

#### Streaks, helpers, modifiers, and adaptable difficulty

Explore modifiers and difficulty adjustments that respond to player performance. They should add momentum without creating an unrecoverable advantage for the current leader. Consider both rewards for strong play and catch-up mechanics for struggling players. Difficulty could vary per game or, with evidence that it feels fair, per player using:

- Era familiarity
- Genre familiarity
- Song popularity or obscurity
- Timeline density
- Starting timeline size
- Hint allowance
- Year tolerance
- Decade disclosure or partial credit for identifying the correct decade

Per-player adaptation must remain understandable and feel fair. The interface should explain material differences in song selection, available hints, or scoring opportunities.

Every modifier should have an explicit trigger, visible effect, duration, and interaction with hints and scoring. Validate the combined scoring, helper, streak, and adaptation model through play before building a broad rules framework.

### Additional game modes

Explore intentional-randomization and category mechanics, including:

- Spin the wheel of genres
- Spin the wheel of eras
- Trivial Pursuit-style category collection
- Decade ladder
- Team play
- Cooperative play using one shared timeline and a limited number of mistakes
- Solo play for practice, personal-best scoring, streaks, or relaxed catalog exploration without requiring a separate host participant
- Sudden death
- Simultaneous private placement, where everyone places the same song before a timer expires and all placements are revealed together
- Classic-turn challenges or opportunities to claim a song another player placed incorrectly
- Host-curated rounds
- Mystery themed rounds

Prefer a general round-selection policy and mode configuration over hardcoding each mode into the game engine.

Solo play should retain the normal hidden-answer and reveal loop while removing unnecessary multiplayer ceremony. Explore fixed-round scores, accuracy and streak targets, self-paced play, and optional comparison with the player's own prior sessions. It must remain usable without creating a durable player profile; cross-session personal records require the optional profile and history model.

### Predictable session length

Allow the host to choose a fixed number of rounds, an approximate duration, or a traditional target-score ending. Fixed-length games make party and travel sessions easier to fit into a known amount of time, particularly in simultaneous-placement modes.

### Communal reveal and round cadence

Treat the answer reveal as the shared social payoff of each round, not merely a state transition. The host or group display should clearly present the year, title, artist, artwork when available, placement outcome, and any points or bonuses while player devices update in a coordinated way.

Preserve the host-controlled pace so the group has time to react and discuss before advancing. Explore lightweight, accessible celebrations and—for simultaneous modes—a concise comparison of players' placements without exposing any answer before the reveal barrier. Measure whether transitions, animation, or automatic advancement add energy or interrupt the conversation.

### Optional profiles, familiarity, and replay history

Guests and gameplay seats are ephemeral and should not silently become durable identities. Offer an optional way to link play to a profile or recurring group before retaining cross-session personal history. Linked history could track which songs a player, family, or recurring group has encountered and support:

- Avoiding accidental repetition
- Deliberate callbacks to favorites
- Multi-session or road-trip marathon games with persistent timelines
- Recurring-group playlists and recaps
- Separating demonstrated familiarity from general placement ability in statistics

Define consent, profile claiming and recovery, guest-to-profile conversion, household or group membership, retention, and deletion before using personal history for difficulty or statistics.

### Composable themes and game configuration

Replace the current hard boundary between general presets and the combined stage-and-screen scope with four independently configurable layers.

#### Song pool

Define which recordings are eligible using:

- Minimum and maximum years
- Included and excluded themes
- Included and excluded genres
- Explicit song and artist exclusions
- Explicit-content inclusion or exclusion according to the group's preference
- Previously played-song policy
- Curated family or administrator collections

Selecting multiple themes should normally use inclusive **OR** behavior: choosing Film and Television admits songs belonging to either. Add more complex combinations only when a concrete host need cannot be expressed by the simpler model.

#### Distribution and pacing

Define how frequently eligible material appears using:

- Era or decade proportions
- Theme proportions
- Genre proportions
- Familiarity and difficulty balance
- Artist-repeat spacing
- Deliberate easy, medium, and difficult stretches
- Avoiding runs of obscure tracks, slow openings, or overly similar selections
- Alternating comfortable selections with surprising ones without making the sequence predictable

Evaluate selections as a session rather than as independent random tracks. A weighted shuffle bag or another bounded-distribution policy should make the configured balance perceptible without promising exact quotas across recordings that belong to several overlapping facets.

#### Gameplay rules

Keep gameplay mechanics independent of music selection:

- Target score, fixed round count, or approximate duration
- Retraction rules
- Hints and helpers
- Turn timer
- Scoring method
- Difficulty and handicaps
- Turn-based, simultaneous, cooperative, or team mode

A selected theme should not implicitly determine the winning score or unrelated mechanics.

#### Saved configurations

Treat a preset as a saved combination of song-pool, distribution, and gameplay settings. Support:

- Built-in quick-start presets
- Personal host presets
- Recently used configurations
- Save, duplicate, rename, and modify operations
- Sharing a configuration with another authorized host if recurring use demonstrates a need

Existing opinionated presets remain useful starting points but should not define the limits of the configuration system.

### Theme and catalog taxonomy

Model catalog labels as extensible, overlapping facets rather than forcing every recording into one hierarchy. Initially useful facets may include:

- **Theme:** An editorial idea such as Oscar Winners or One-Hit Wonders
- **Genre:** A musical classification such as rock, country, or hip-hop
- **Collection:** A maintained list such as Rossi Family Favorites
- **Source context:** Film, television, Broadway, chart history, or another origin
- **Mood or occasion:** Road trip, summer, Halloween, or party

A recording may carry multiple values in any applicable facet; not every facet must be populated or exposed in the first configuration UI. Preserve one internal canonical recording identity, with one or more provider-specific mappings such as Spotify track URIs, so membership in several themes or providers does not accidentally increase its draw weight.

Generate available themes from a registry rather than hardcoding them in the game picker. Core registry metadata should be limited to what the picker and validation actually need:

- Stable identifier
- Display name and description
- Playable-song count
- Supported year range
- Catalog version

Add parent groupings, artwork, icons, or default distributions only when a selected interface or preset uses them.

Keep friendly umbrella choices such as Stage and Screen while allowing hosts to select Film, Television, Oscar Songs, and Broadway independently.

### Era configuration

Retain a simple year-range control while offering more flexible distribution controls:

- Decade toggles
- Decade-level weighting
- Friendly grouped eras as quick shortcuts
- Custom ranges for advanced hosts

The interface should make the order of operations explicit: first choose the eligible years, then choose how frequently songs from those years should appear. Friendly eras can adjust several internal decade weights together without making the underlying buckets permanent product constraints.

### Genre enrichment and control

Genre controls require catalog enrichment beyond the current theme and year data. Establish:

- A controlled set of understandable parent genres
- Optional detailed subgenres retained internally
- Multiple genres per recording
- Assignment provenance and confidence where automated enrichment is used
- Administrative correction tools
- Coverage reporting and validation

Do not expose a genre filter until the interface can warn when metadata coverage or the resulting eligible pool is too small. Begin with a manageable parent taxonomy rather than presenting hundreds of overlapping labels.

### Catalog integrity and release quality

Treat playing the wrong recording, revealing the wrong year, or selecting an unavailable track as game-breaking data failures. Before publishing a catalog version:

- Detect conflicting provider identifiers, duplicate recordings, and the same provider track mapped to incompatible metadata
- Apply one documented year convention across year packs, themes, statistics, and answer matching
- Validate title and artist together, with explicit handling for covers, remasters, cast recordings, featured artists, and regional relinking
- Report playable coverage by year, theme, genre, and configured market
- Verify that source catalog data and the deployed web or bundled catalog were generated from the same version
- Retain enough provenance to correct a bad mapping without repeating expensive provider searches
- Make catalog deployment reproducible and allow rollback to the last known-good version

Add automated release gates in proportion to observed failures. Administrative correction and player-reported metadata issues should feed the same source-of-truth workflow rather than patching a deployed copy directly.

### Configuration review and diagnostics

Before a game starts, provide enough feedback to prevent an invalid or surprising configuration. Begin with:

- Eligible-song count
- Warnings about overly narrow or contradictory combinations
- Warnings when the pool is too small for the requested rounds
- A compact summary of the chosen music and gameplay rules

Add histograms, detailed breakdowns, duration estimates, sample tracks, or a multi-step setup flow only when host testing shows that the compact summary is insufficient. Progressive disclosure is a design principle, not a prescribed five-screen wizard.

### In-game song-library adjustment

Start with recovery actions for a bad selection during a session:

- Skip a poor selection without a gameplay penalty
- Avoid the current song or artist for the rest of the session
- Report unavailable playback or inaccurate metadata for later review

Consider live theme, genre, era, or weighting changes only after observing a real need; those changes can make the meaning and fairness of an active game difficult to understand. Distinguish temporary session adjustments from permanent catalog administration.

### Spotify playlist sharing

Support playlist creation from game history, including:

- The complete current session
- Selected songs from a session
- Songs played by a recurring group
- A persistent “Can'naBeats” playlist spanning multiple sessions
- A player's favorites
- Theme- or category-specific playlists

Playlist creation should be an explicit action by the Spotify account performing it. The managed fallback playback account must not silently create playlists on behalf of a host or player. Preserve the selected track list on the server, then let a user connect a personal Spotify account for an explicit export or offer another portable representation. The server may retain provider track identifiers and playlist membership without retaining users' Spotify credentials.

## Host flow and lobby experience

### Productized installed application

Make the game, rather than the original Access Lab, the primary installed PWA experience:

- Launch the installed application into the game or host dashboard
- Move passkeys, authorized applications, invitations, and account controls into dedicated account and administration routes
- Move local Spotify tests and implementation diagnostics out of the normal host journey
- Remove proof-of-concept terminology and stale room-code or Spotify behavior descriptions
- Keep account and device-management functions available without presenting them as required game steps

### Productized desktop client and role convergence

Carry the existing authenticated desktop-player spike into a distributable client that reuses the same server-authoritative lobby and game UI as the PWA. The first useful release should add shared-audio listening, recovery and update behavior, production branding, and signed installers for the platforms actually used by the family.

The longer-term product should not require separate “Host” and “Player” applications. Prefer one CannaBeats desktop application in which any authorized member can join as a player or power a group display, while host capabilities appear only for an account and device authorized to host. Preserve the PWA and phone browser as zero-install paths rather than making the desktop application mandatory.

Resolve the current native Host and Tauri desktop spikes by reusing their proven device authorization, credential-store, handoff, and local-audio components behind one product flow. Do not duplicate the game engine or create incompatible desktop-only session state. Validate Spotify, shared audio, passkeys, OS credential storage, signing, and updates independently on macOS and Windows.

### Focused first-run Host pairing

Present first-run device authorization as a short, explicit sequence:

1. Link this Mac
2. Open a focused browser approval page with the pairing request already selected
3. Complete the passkey check
4. Detect approval automatically
5. Continue directly to hosting the first game

The approval page should hide unrelated account, administration, and Spotify-testing panels while processing a Host pairing. On success it should clearly direct the user back to the Host app.

### Returning Host dashboard

Make hosting the primary task for an already authorized device:

- Prominent **Host a new game** action
- **Resume current game** or **Reopen CannaBeats** when a session exists
- A short recent-lobbies list where useful
- Compact authorization, server, and managed-audio availability indicators
- Manual lobby-code entry as a secondary recovery path

Move server origin, application name, signing-key details, internal application identifiers, identity removal, manual authorization proof, and local Mac audio capture into Settings, Diagnostics, or Advanced sections.

Protected actions should prove the saved device identity automatically. Do not make **Prove authorization** a routine prerequisite; expose an explicit connection test only for troubleshooting.

### Session-scoped Host-to-PWA handoff

Avoid relying on the installed PWA and the browser used for pairing having compatible authentication state. A prospective flow is:

```text
Host app signs a device challenge
  → server creates or validates the lobby
  → server issues a short-lived, single-use web handoff ticket
  → installed PWA consumes the ticket
  → server establishes a scoped HttpOnly host session
  → PWA opens the intended lobby
```

The ticket should be bound to the authorized Host device and intended lobby, expire quickly, be consumed only once, and grant no broader authority than the host already possesses.

### Recoverable session handoff

Make application and window recovery explicit:

- Reopen the active lobby without re-entering its code
- Explain and recover when the installed PWA cannot be opened
- Fall back to the browser without losing the prepared lobby
- Restore clear audio-enablement instructions after a refresh or suspended audio context
- Preserve the roster and configuration when returning from gameplay to the lobby

### Membership and control recovery

Treat ordinary interruptions as recoverable rather than as new participants or abandoned sessions:

- Let a guest reclaim the same seat after refreshing, losing connectivity, or reopening the join link
- Define how a late joiner enters a game already in progress
- Allow an authorized host to move between the Host app, PWA, and another approved device without duplicating the host or losing control
- Provide an explicit, authorized way to transfer or share host control when the original host must leave
- Make repeated commands safe so a retry cannot submit twice, advance two rounds, or toggle playback into the wrong state

Use short-lived recovery credentials and server-side membership state; knowledge of the public lobby code alone must not grant an existing identity or elevated control.

### Lobby information architecture

Let invitations and setup happen in parallel. On larger host screens, consider a two-column layout:

- Configuration, audio, and primary start action
- QR invitation, copyable link/code, player roster, and readiness

Keep the QR code and player roster prominent while the host changes settings. Add a copyable join link in addition to the QR code.

Clarify the distinction between player types:

- **Add a shared-screen player** for someone whose timeline is controlled on the host display
- **Invite phone players** for people joining through the QR code or link
- Use explanatory badges such as **Uses host screen** and **Joined by phone**

### Lobby membership and invitation controls

Keep authenticated lobby membership, guest browser sessions, and gameplay seats visibly distinct. In addition to the existing ability to remove a gameplay seat before starting, let the host understand which devices or guests are connected and manage the invitation boundary when necessary:

- Revoke and regenerate the current guest invitation before play
- Lock or reopen joining without changing the durable lobby identity
- Disconnect a guest session and decide whether its seat is removed, preserved for recovery, or reassigned
- Resolve duplicate names or abandoned phone seats without guessing which device is active
- Explain that the lobby code locates the gathering while the invitation or authenticated session grants entry

Keep these controls lightweight for trusted family use; they are recovery and privacy tools, not a general-purpose moderation system.

### Unified audio readiness

Present the managed source, host listener, and fallback selection as one understandable game-audio state:

```text
Game audio
✓ Managed Spotify source reserved
✓ This screen is listening
[Change audio source…]
```

Keep local-device Spotify and process capture behind an advanced change-source action. Collapse healthy in-game audio into a small status indicator and show the larger recovery interface only when the listener or source needs attention.

Because the managed Spotify source intentionally supports one active lease, distinguish **offline**, **recovering**, and **currently reserved by another game**. A second host should be able to wait and retry or deliberately choose the local-source fallback; the application must not silently steal an active lease or disclose another lobby's private details.

### Room audio behavior and controls

Make the intended listening arrangement explicit because a shared room and geographically remote players have different needs:

- Let each device enable, mute, and set its own shared-audio volume without pausing the game for everyone
- Distinguish local mute or listener suspension from an authorized global play/pause command
- In a shared room, help the group choose a single audible device or warn about likely echo from several nearby devices
- For remote play, communicate buffering, reconnection, and approximate synchronization state without promising sample-perfect playback
- Preserve the current ability for authenticated game members to pause or resume globally, make that shared effect explicit in the interface, and resolve conflicting or repeated requests safely

The host should hear through the same distributed path when practical so host experience reflects what players receive, while retaining a recovery path if local listening fails.

### Explicit lobby readiness

Explain why the game can or cannot begin. A host-facing readiness view should combine authoritative server facts with client-local capabilities:

- At least one gameplay seat
- Valid game configuration
- Selected source available
- Host screen listening to shared audio

The server can authoritatively report membership, configuration, and source availability; each client must report local conditions such as audio permission, AudioContext state, and whether it is actually receiving frames. Do not leave the primary action silently disabled. Show the missing requirement beside it or make the action label explain the next required step.

### Clear game-start semantics

Resolve the ambiguity between **Set up game** and **Start first song**:

- Combine them into one **Start game** action when no meaningful pause is required; or
- Rename the first action to describe the real transition, such as locking configuration and choosing the first player

Preserve a separate ready phase only when it produces a useful social or operational moment.

### Post-game Host continuity

At completion, offer clear next actions:

- Play again with the same group and settings
- Return to the lobby and modify settings
- Start a new lobby
- End the active session
- Create or update a playlist when playlist support exists
- View a concise recap of the songs, placements, results, and memorable moments—and optionally share an intentionally generated summary—when history support exists

## Remote client experience

### Shared game awareness

Expand the remote player view beyond a private input device. Possible information and controls include:

- Current player and turn state
- Scoreboard and other players' progress
- Condensed player timelines
- Round and result history
- Shared-audio connection status
- Hint and helper controls
- Spoken-answer controls
- Reactions or celebrations

Decide how much of other players' timelines should be visible during an active turn. A summarized scoreboard may avoid unintentionally influencing the active player's placement.

### Remote-client recovery and device changes

Make refreshes, temporary disconnections, and phone sleep unsurprising. A returning player should reclaim the same gameplay seat and current round state without seeing hidden answer data or replaying an already accepted action. Provide clear states for reconnecting, waiting for the host, audio unavailable, client update required, and session ended.

Explore moving a player's controls between devices only after the basic reclaim flow is reliable; it must require proof tied to the existing membership rather than just the lobby code.

### Party-like remote presence

Remote play should preserve the conversation, reactions, and sense of sharing a room that make CannaBeats enjoyable in person. Keep two possible approaches open for evaluation:

1. **Integrated presence:** optional live voice and video rooms associated with the lobby, using a managed real-time provider or a deliberately limited WebRTC implementation rather than assuming CannaBeats should reproduce a complete conferencing product.
2. **Group display mode:** a separate laptop, television, or other shared screen presents the game, remote participants, scores, reactions, and shared audio while each player continues using a phone for private controls. Different households could each run a group display for the same lobby.

The approaches may complement each other: a group display could host the shared call while phones remain focused game controllers. Also evaluate a lightweight path that coordinates an external FaceTime, Zoom, Google Meet, or similar call without embedding it.

Questions to validate through remote playtests include:

- Whether voice alone creates enough social presence or video materially improves the game
- Whether households prefer one shared camera and display or individual participant tiles
- How to prevent echo, feedback, and competing playback when game audio and conversation share devices
- Whether communication audio should duck during songs or remain independently adjustable
- How camera and microphone consent, permissions, participant indicators, and host moderation should work
- Whether network and device load remain acceptable while receiving game audio, real-time state, and video
- How the experience degrades when a player declines media access or has a weak connection

Treat this as a valid future opportunity that requires evidence from actual remote sessions. Start by testing the group-display and external-call concepts before committing to owned conferencing infrastructure.

A group display or non-playing observer must not be forced into a gameplay seat or receive private pre-reveal information merely to follow the session.

## Runtime reliability and platform behavior

### Authoritative real-time game actions

Define server-authoritative semantics for actions that can race across clients, particularly simultaneous placement, retraction deadlines, global playback control, and answer reveal. Requirements include:

- Stable action identifiers and idempotent retries
- Server timestamps and explicit acceptance deadlines
- A single authoritative transition into reveal
- Reconnection snapshots that identify which actions were accepted
- Ordering and conflict rules visible enough to explain a rejected action to the player

Choose WebSocket, server-sent events, polling, or another transport according to measured needs; the backlog requirement is consistent game state, not a particular protocol.

### Audio transport quality and resilience

Measure and define acceptable behavior for the managed source and relay:

- Startup latency, end-to-end delay, drift, jitter, and underruns
- Loudness consistency, clipping prevention, and intelligibility across recordings
- Reconnection after browser, network, audio-source, or droplet interruption
- Source health reporting and a clear lease handoff or restart state
- Bandwidth and DigitalOcean transfer cost per listener and game
- Whether raw PCM remains appropriate or a compressed transport is needed
- Credential isolation and log redaction on the managed source
- Capacity limits, including the currently intended single active managed source

Favor recovery to a coherent current state over replaying every missed audio frame or command after a long interruption.

### Per-listener audio profiling and diagnostics

Instrument each listening client so an issue affecting only the host, one browser, or one network can be distinguished from source or relay failure. Record small periodic summaries and state transitions rather than raw audio or per-frame telemetry.

Client measurements should include:

- Time to stream connection, first PCM data, buffer priming, and first audible playback
- Received bytes and audio frames, chunk cadence, longest receive gap, reconnect count, and terminal response or error category
- Current, minimum, maximum, and sampled buffer depth in milliseconds
- Buffer underrun count and duration, re-prime count, overflow or discarded-frame count, and reset count
- Source sample rate, output sample rate, resampling ratio, and buffer-depth trend that can expose source/output clock drift
- AudioContext state, base/output latency where available, visibility or suspension changes, and long main-thread stalls likely to delay PCM delivery to the worklet
- Coarse client context needed for comparison: host/player/group-display role, browser and major version, operating-system family, installed-PWA/browser mode, and listener implementation version

Source and relay summaries should include captured or published frames, dropped upload packets, listener connections, bytes delivered, interruptions, and restarts. Correlate them with the lobby, run, listener instance, and diagnostic event trail so two clients in the same round can be compared.

Report aggregates at a conservative interval such as every five or ten seconds and immediately on underrun, reconnect, or terminal failure. Use an ephemeral listener identifier unless an authenticated device identity is necessary for support. Never transmit PCM samples, credentials, pre-reveal song metadata, or a high-entropy device fingerprint as profiling data.

Provide a small advanced diagnostics view with current buffer health and a copyable session report. This gives a family tester immediate confirmation that a stutter was observed even if server upload fails. Establish and measure instrumentation overhead so profiling does not create the scheduling problem it is intended to diagnose.

Use these measurements to evaluate adaptive jitter buffering or gentle drift correction. Do not implement either solely from one report: repeated underruns with network gaps, a steadily falling or rising buffer, or main-thread stalls imply different remedies.

### Supported clients and update behavior

Define and test the supported matrix across the native macOS application, installed macOS PWA, ordinary desktop browsers, iPhone and iPad home-screen web apps, phone browsers, and any shared or group-display layout. Cover autoplay permission, suspended audio contexts, backgrounding and wake, passkey behavior, browser-storage separation, stale service-worker assets, minimum compatible client versions, and an understandable refresh/update path.

Treat the eventual Windows desktop client as a separate validated target rather than assuming macOS packaging and audio behavior transfer directly.

### Thin observability foundation

Give each service a small, consistent operational contract before adding detailed gameplay or audio telemetry:

- Emit newline-delimited structured logs with timestamp, severity, service, environment, stable event or error code, and safe request context.
- Generate a correlation identifier at the public boundary, return it with the response, and propagate it through trusted service-to-service calls.
- Return user-safe errors with a stable code and correlation reference while preserving useful, redacted server-side context.
- Define and test centralized redaction that excludes credentials, authorization and cookie values, invitation and pairing capabilities, private device identifiers, request bodies, query strings, provider payloads, and pre-reveal track metadata.
- Separate public liveness from dependency readiness and from authorized component diagnostics. An unavailable optional managed source must be reported as degraded rather than making the game application appear dead.
- Keep operational logs bounded and short-lived; record the deployed application/catalog versions so an error can be associated with the running release.

This foundation is not the durable game history. Stable client action identifiers, significant game and managed-audio lifecycle events, and per-listener audio profiling remain separate work with their own privacy, retention, and performance requirements.

### Operational continuity and recoverable deployment

The private scope still depends on persistent account, authorization, lobby, game, and catalog data. Establish a small operational baseline:

- Automated, encrypted backups of application data with an explicit retention policy and a periodically tested restore procedure
- A deployment and database-migration path that preserves the existing `vw-services` workloads and can roll CannaBeats back independently
- Reproducible provisioning for the managed audio-source droplet, while deliberately excluding its persistent Spotify browser profile and credential from broadly accessible images or backups
- A documented source-replacement and Spotify reauthorization procedure for loss of the audio droplet
- Health and capacity checks for the application, database volume, managed source, relay, certificates, disk, memory, and transfer usage
- Secret inventory, least-privilege file ownership, redacted diagnostics, and rotation/revocation procedures
- Clear separation between disposable PoC endpoints or builds and the durable family environment, including an intentional domain and relying-party migration plan

Keep alerting and automation proportional to a small family service. The goal is to prevent a single machine failure, full disk, failed deployment, or forgotten credential from requiring reconstruction by memory—not to build enterprise operations.

## Admin tooling

### Current and recent session diagnostics

Provide an authorized, read-only way to answer whether a game is active and whether its core services are working without querying SQLite manually. Begin with an operator CLI or compact administration view that summarizes:

- Host, lobby and run identifiers, creation time, current phase and round
- Players or seats that joined, their control type, and safe last-seen information
- Last meaningful game action rather than relying only on polling traffic
- Current listener, managed-source lease, and playback-command state
- Recent errors, interruptions, reconnects, and recovery outcomes
- Whether the game completed, was explicitly ended, appears idle, or was abandoned

Define session liveness from meaningful game actions, connected clients, and audio-lease activity. A stale database status such as `playing` must not by itself imply that people are still playing. Use explicit active, idle, stale, completed, and abandoned meanings with conservative cleanup rules.

The diagnostic surface must not expose invitation tokens, credentials, private browser identifiers, or pre-reveal answer data to an unauthorized viewer. A command-line report is sufficient initially; a polished analytics dashboard belongs to later administration work.

### Game logs and play metrics

Retain an auditable sequence of significant game events sufficient to reconstruct results, diagnose failures, and derive selected metrics. This does not require event sourcing or retaining every transient client message. Candidate events include:

- Lobby creation and membership changes
- Audio connection, interruption, and recovery
- Game configuration and start
- Track selection, playback, skip, and failure
- Hint requests
- Answer submission, retraction, and reveal
- Points, tokens, streaks, and helpers
- Playlist actions
- Game completion or abandonment

Each selected event should carry enough safe context to explain its place in the session: lobby and run identifiers, round, server timestamp, actor or actor type, stable action identifier where applicable, accepted or rejected outcome, and a redacted error category. Preserve only the fields needed for reconstruction, support, or a selected metric.

Managed-audio history must be retained independently of the transient command queue and lease rows. Record the meaningful lifecycle—requested, delivered, acknowledged, failed, interrupted, recovered, or expired—without retaining credentials or unnecessary provider payloads.

Use correlation identifiers to connect a user action across the game API, access service, managed-source controller, and relay diagnostics. Operational container logs may remain short-lived, but errors should be structured and correlated so they can be matched to the durable session trail.

Derived reporting could include:

- Accuracy by player, era, genre, and theme
- Hint usage and effectiveness
- Title and artist identification accuracy
- Track failure and skip rates
- Average game and turn duration
- Audio reliability and reconnection behavior
- Songs explicitly favorited or selected for playlists
- Catalog gaps and metadata problems

Choose the events and retention period from concrete reporting and support needs. Privacy controls should support removing a game or player history without unnecessarily destroying anonymous operational aggregates.

Separate the near-term diagnostic trail from later personal analytics. Session reconstruction, audio troubleshooting, and liveness do not require persistent player profiles; cross-session accuracy, familiarity, and adaptive difficulty do.

### Authorized-user management

Start from capability-based authorization rather than hardcoding the initial administrator. Keep authorization principals, account capabilities, and gameplay participation distinct:

- **Principals:** user accounts and authorized applications or devices
- **Account capabilities:** active invited member as the baseline, with additional host and administrative capabilities
- **Gameplay participation:** profile-linked player, unlinked guest, and shared-screen seat

Administration may include:

- Invitation issuance and revocation
- User suspension and restoration
- Device and passkey management
- Host authorization
- Capability assignment
- Active-session review and termination
- Audit history
- Installer and download access

### Account and administrator recovery

Make secure recovery possible without weakening the invitation-only boundary:

- Encourage more than one passkey for important accounts when devices do not share a passkey provider
- Let an authenticated user add and revoke passkeys and applications with clear recent-use information
- Define an administrator-mediated recovery path when a user loses every credential
- Prevent accidental removal of the last administrator or provide a documented operator-level break-glass procedure
- Revoke derived browser, desktop, and Host sessions when a user, device, or credential is disabled

Recovery invitations must be short-lived, single-purpose, auditable, and no more powerful than the role being restored.

## Shared technical foundations

Preserve the accepted lobby/game-run lifecycle and ownership boundaries in [ADR 0001](architecture/0001-lobby-orchestrates-game-runs.md). Existing game behavior and security invariants—including retraction and reveal timing, hidden answer metadata, and authenticated lobby boundaries—belong in implementation tests and architecture records rather than as speculative backlog features.

Many unresolved entries share narrower reusable dependencies:

1. Auditable game-event history sized to validated metrics and support needs
2. Explicit scoring and modifier policies introduced with the first modes that require them
3. Rich catalog metadata, aliases, answer normalization, internal recording identity with provider mappings, and a versioned validation and rollback path
4. Extensible but initially small game-mode and track-selection policies
5. Capability-based user, application, and device authorization kept separate from gameplay seats and guests
6. Server-authoritative game actions and synchronized client snapshots with idempotent retries
7. Session and optional cross-session playlist records
8. Clear separation between the game engine, catalog metadata, playback provider, audio distribution, and reveal metadata
9. A composable configuration model separating eligibility, distribution, mechanics, and saved presets
10. An extensible catalog-facet registry and enough coverage diagnostics to reject unusable configurations
11. A readiness model combining server-authoritative state with client-local audio capability
12. Short-lived, single-use Host-to-PWA handoff tickets scoped to an authorized device and lobby
13. Audio-source, relay, and listener health telemetry sufficient for recovery and support
14. Shared client behavior, compatibility, packaging, and update signaling across native, browser, and installed-PWA surfaces
15. Reproducible deployment, data backup and restore, secret recovery, and service-health checks proportional to the private environment
16. Correlated session diagnostics that preserve significant game and audio outcomes independently of transient queues and container logs

These foundations are not automatically the first implementation tasks. Select and scope them according to the first validated feature that needs them.

## Cross-cutting accessibility

Accessibility is a requirement for every selected experience, not a miscellaneous future feature. At minimum, evaluate:

- Keyboard and switch-friendly operation for host and player actions
- Screen-reader labels, focus order, and live announcements for turns, timers, accepted answers, and reveals
- Color-independent timeline and score cues with sufficient contrast
- Reduced-motion behavior and alternatives to time-sensitive animation
- Captions or text equivalents for spoken prompts, while recognizing that the music itself is central to play
- Configurable text size, timer accommodations, and alternatives to voice input

## Evidence from actual play

For each playtest, record a small, consistent observation set rather than collecting analytics without a decision in mind:

- Group size, device mix, shared-room or remote arrangement, and chosen configuration
- Whether the group completed the game and chose to play again
- Time from opening the Host app to a ready lobby and from **Start game** to audible music
- Join, reconnect, audio, track, and reveal failures that required host intervention
- Moments of confusion, delay, accidental influence, or disengagement
- Features players spontaneously requested or worked around
- Which scoring, hint, mode, playlist, or recap ideas would have changed the session materially

Before promoting an item, state what observation supports it and what a small test would need to establish. Avoid treating a single family's preference as universal; the goal is to choose well for the intentionally small invited group, not to optimize for a hypothetical mass market.

Derive objective timing, completion, reconnect, audio, track, and reveal facts from the diagnostic event trail when available. Keep subjective observations—confusion, delight, discussion, workarounds, and feature requests—as short human notes rather than pretending they can be inferred reliably from telemetry.

## Product-discovery questions

Use observed play rather than assumptions to answer:

- Is the primary enjoyment recognizing songs, debating eras, or competing?
- Do players prefer focused turns or simultaneous participation?
- Are challenges and stealing enjoyable for this group or needlessly contentious?
- Which player ages and group sizes need explicit balancing?
- Do groups prefer short predictable games or timelines that persist across sessions?

## Backlog intake template

Use this template when adding or promoting an idea:

```markdown
### Idea name

**Problem or opportunity:**

**Desired player/host experience:**

**Open questions:**

**Dependencies:**

**Risks or policy considerations:**

**Evidence or test feedback:**

**Acceptance criteria:** _Add only when selected for implementation._
```
