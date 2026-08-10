# CannaBeats Product Backlog

**Status:** Working document; unprioritized; not published
**Purpose:** Preserve product and technical ideas as a starting point for future discovery and implementation planning.
**Last updated:** 2026-08-10

## How to use this document

- The order of entries does not indicate priority.
- An entry records an idea, not a commitment to build it.
- Add only ideas that are novel relative to the current product. Do not restate implemented or deliberately discarded approaches unless a genuinely different variation merits future reconsideration.
- Validate usefulness and expected behavior before implementation.
- Keep live-test blockers separate from longer-term enhancements.
- When an idea is selected for work, give it acceptance criteria, dependencies, risks, and an implementation plan in a dedicated issue or design document.

## Live-test blocker lane

The enhancements below are not required for the current end-to-end party test. If a tester reports something that prevents a game from being played, capture it here first and handle it separately from backlog prioritization.

| Report | Impact | Reproduction | Status |
| --- | --- | --- | --- |
| _No blockers recorded_ | | | |

## Gameplay and mechanics

### Progressive hints

Allow the active player to disclose hints through successive actions:

1. Album name
2. Song title
3. Artist
4. The year remains hidden until the placement is locked and the answer is revealed

Questions to resolve:

- Does each hint reduce the score, consume a token, or lower the maximum available reward?
- Can the active player, team, or host request a hint?
- How do disclosed title and artist hints interact with bonuses for identifying them?
- Are hint rules configurable per game mode or difficulty?

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

Whisper or another speech-to-text system would transcribe the player's voice; it would not identify the song directly from the shared music stream. Push-to-talk, or temporarily lowering/pausing playback, may be necessary to prevent the song from overwhelming the microphone.

Matching needs to tolerate:

- Optional leading articles such as “The”
- Featured artists and multiple performers
- Alternate, abbreviated, and parenthetical titles
- Soundtrack, cast-recording, cover, and remaster variants
- Homophones and ordinary transcription mistakes

The player should be able to confirm or correct the interpreted answer before it becomes final.

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

This likely requires a scoring engine that is separate from the basic round state machine, allowing modes to compose rules without changing core placement and reveal behavior.

### Streaks, helpers, and modifiers

Explore modifiers that respond to player performance. They should add momentum without creating an unrecoverable advantage for the current leader. Consider both rewards for strong play and catch-up mechanics for struggling players.

Every modifier should have an explicit trigger, visible effect, duration, and interaction with hints and scoring.

### Adaptable difficulty

Difficulty could vary per game or per player using:

- Era familiarity
- Genre familiarity
- Song popularity or obscurity
- Timeline density
- Starting timeline size
- Hint allowance
- Year tolerance
- Decade disclosure or partial credit for identifying the correct decade

Per-player adaptation must remain understandable and feel fair. The interface should explain material differences in song selection, available hints, or scoring opportunities.

### Additional game modes

Explore intentional-randomization and category mechanics, including:

- Spin the wheel of genres
- Spin the wheel of eras
- Broadway, television, and movie categories
- Trivial Pursuit-style category collection
- Decade ladder
- Team play
- Cooperative play using one shared timeline and a limited number of mistakes
- Sudden death
- Simultaneous private placement, where everyone places the same song before a timer expires and all placements are revealed together
- Classic-turn challenges or opportunities to claim a song another player placed incorrectly
- Host-curated rounds
- Mystery themed rounds

Prefer a general round-selection policy and mode configuration over hardcoding each mode into the game engine.

### Predictable session length

Allow the host to choose a fixed number of rounds, an approximate duration, or a traditional target-score ending. Fixed-length games make party and travel sessions easier to fit into a known amount of time, particularly in simultaneous-placement modes.

### DJ-directed session pacing

Evaluate selections as a sequence rather than as independent random tracks. A session director could:

- Balance eras, genres, familiarity, and difficulty across the full game
- Avoid repeating an artist too closely
- Avoid several obscure tracks or slow-opening songs in succession
- Alternate comfortable selections with surprising ones
- Use family favorites without making the session predictable
- Shape deliberate easy, medium, and difficult stretches

This complements filters and game modes; it does not replace them.

### Persistent familiarity and replay history

Track which songs a player, family, or recurring group has encountered across sessions. That history could support:

- Avoiding accidental repetition
- Deliberate callbacks to favorites
- Multi-session or road-trip marathon games with persistent timelines
- Recurring-group playlists and recaps
- Separating demonstrated familiarity from general placement ability in statistics

### Composable themes and game configuration

Replace the current hard boundary between general presets and the combined stage-and-screen scope with four independently configurable layers.

#### Song pool

Define which recordings are eligible using:

- Minimum and maximum years
- Included and excluded themes
- Included and excluded genres
- Explicit song and artist exclusions
- Previously played-song policy
- Curated family or administrator collections

Selecting multiple themes should normally use inclusive **OR** behavior: choosing Film and Television admits songs belonging to either. Advanced combinations may support intersections where they have a clear meaning.

#### Distribution and pacing

Define how frequently eligible material appears using:

- Era or decade proportions
- Theme proportions
- Genre proportions
- Familiarity and difficulty balance
- Artist-repeat spacing
- Deliberate easy, medium, and difficult stretches

Move toward planned session quotas or a weighted shuffle bag instead of unconstrained independent random draws. A ten-round 50/50 mix should produce approximately five selections from each side rather than occasionally drifting to eight and two.

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
- Administrator-created presets
- Personal host presets
- Recently used configurations
- Save, duplicate, rename, and modify operations
- Sharing a configuration with another authorized host

Existing opinionated presets remain useful starting points but should not define the limits of the configuration system.

### Theme and catalog taxonomy

Distinguish concepts that may overlap on the same recording:

- **Theme:** An editorial idea such as Oscar Winners or One-Hit Wonders
- **Genre:** A musical classification such as rock, country, or hip-hop
- **Collection:** A maintained list such as Rossi Family Favorites
- **Source context:** Film, television, Broadway, chart history, or another origin
- **Mood or occasion:** Road trip, summer, Halloween, or party

A recording may carry multiple values in every category. Preserve one canonical recording per playback URI so membership in several themes does not accidentally increase its draw weight.

Generate available themes from a registry rather than hardcoding them in the game picker. Registry metadata should include:

- Stable identifier
- Display name and description
- Parent or category
- Artwork or icon
- Playable-song count
- Supported year range
- Optional default distribution
- Catalog version

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

### Configuration review and diagnostics

Before a game starts, summarize the effective configuration with:

- Eligible-song count
- Era or decade histogram
- Theme and genre breakdown
- Estimated game duration
- Warnings about overly narrow or contradictory combinations
- Warnings when the pool is too small for the requested rounds
- Optional sample tracks for host review

The setup experience should progressively disclose complexity:

1. Choose a quick-start mix
2. Refine eligible music
3. Balance the distribution
4. Choose gameplay rules
5. Review the resulting game

### In-game song-library adjustment

Allow the host to adjust the usable library during a session:

- Exclude an artist, song, genre, theme, or era
- Mark a track unavailable
- Skip a poor selection without a gameplay penalty
- Favor or suppress a category
- Report or correct inaccurate metadata
- Prevent recently played songs from recurring

Distinguish temporary session adjustments from permanent catalog administration.

### Spotify playlist sharing

Support playlist creation from game history, including:

- The complete current session
- Selected songs from a session
- Songs played by a recurring group
- A persistent “Can'naBeats” playlist spanning multiple sessions
- A player's favorites
- Theme- or category-specific playlists

Playlist creation should be an explicit action by the Spotify account performing it. The server may retain Spotify track URIs and playlist membership without retaining users' Spotify credentials.

## Host flow and lobby experience

### Productized installed application

Make the game, rather than the original Access Lab, the primary installed PWA experience:

- Launch the installed application into the game or host dashboard
- Move passkeys, authorized applications, invitations, and account controls into dedicated account and administration routes
- Move local Spotify tests and implementation diagnostics out of the normal host journey
- Remove proof-of-concept terminology and stale room-code or Spotify behavior descriptions
- Keep account and device-management functions available without presenting them as required game steps

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

### Lobby information architecture

Let invitations and setup happen in parallel. On larger host screens, consider a two-column layout:

- Configuration, audio, and primary start action
- QR invitation, copyable link/code, player roster, and readiness

Keep the QR code and player roster prominent while the host changes settings. Add a copyable join link in addition to the QR code.

Clarify the distinction between player types:

- **Add a shared-screen player** for someone whose timeline is controlled on the host display
- **Invite phone players** for people joining through the QR code or link
- Use explanatory badges such as **Uses host screen** and **Joined by phone**

### Unified audio readiness

Present the managed source, host listener, and fallback selection as one understandable game-audio state:

```text
Game audio
✓ Managed Spotify source reserved
✓ This screen is listening
[Change audio source…]
```

Keep local-device Spotify and process capture behind an advanced change-source action. Collapse healthy in-game audio into a small status indicator and show the larger recovery interface only when the listener or source needs attention.

### Explicit lobby readiness

Explain why the game can or cannot begin. A host-facing readiness model should cover:

- At least one gameplay seat
- Valid game configuration
- Selected source available
- Host screen listening to shared audio

Do not leave the primary action silently disabled. Show the missing requirement beside it or make the action label explain the next required step.

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

## Admin tooling

### Game logs and play metrics

Build an append-only game-event model capable of recording:

- Lobby creation and membership changes
- Audio connection, interruption, and recovery
- Game configuration and start
- Track selection, playback, skip, and failure
- Hint requests
- Answer submission, retraction, and reveal
- Points, tokens, streaks, and helpers
- Playlist actions
- Game completion or abandonment

Derived reporting could include:

- Accuracy by player, era, genre, and theme
- Hint usage and effectiveness
- Title and artist identification accuracy
- Track failure and skip rates
- Average game and turn duration
- Audio reliability and reconnection behavior
- Frequently enjoyed songs
- Catalog gaps and metadata problems

Privacy controls should support removing a game or player history without unnecessarily destroying anonymous operational aggregates.

### Authorized-user management

Start from role-based authorization rather than hardcoding the initial administrator. Candidate roles and entities include:

- Administrator
- Host
- Player or account holder
- Guest
- Authorized device

Administration may include:

- Invitation issuance and revocation
- User suspension and restoration
- Device and passkey management
- Host authorization
- Role assignment
- Active-session review and termination
- Audit history
- Installer and download access

## Shared technical foundations

Many backlog entries depend on a smaller set of reusable foundations:

1. An append-only game-event log
2. A configurable scoring and modifier engine
3. Rich catalog metadata, aliases, and answer normalization
4. Extensible game-mode and track-selection policies
5. Role-based user and device authorization
6. A richer synchronized client view
7. Session and cross-session playlist records
8. Explicit separation between the game engine, catalog metadata, playback provider, audio distribution, and reveal metadata
9. A hidden-information contract ensuring ordinary player clients do not receive track identity or reveal metadata before answers are locked
10. A composable configuration model separating eligibility, distribution, mechanics, and saved presets
11. A generated catalog-facet registry for themes, genres, collections, source contexts, and occasions
12. Catalog-coverage diagnostics that can validate a configuration before a game begins
13. A server-authored lobby-readiness model shared by the native Host app and web client
14. Short-lived, single-use Host-to-PWA handoff tickets scoped to an authorized device and lobby

These foundations are not automatically the first implementation tasks. Select and scope them according to the first validated feature that needs them.

## Additional discovery areas

Ideas worth preserving for later discussion:

- Accessibility and reduced-motion/audio alternatives
- Team and household profiles
- Audio latency calibration and synchronization feedback
- Clearer device-readiness and reconnection UX
- Saved host presets and recurring groups
- Post-game recaps and shareable summaries
- Catalog curation and metadata-quality workflows
- Player privacy, history retention, and data export/deletion

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
