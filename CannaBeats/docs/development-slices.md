# CannaBeats Development Slices

**Status:** Working document; not yet scheduled; not published
**Purpose:** Group the validated product backlog into coherent development slices that maximize useful delivery while respecting dependencies and avoiding premature platform work.
**Last updated:** 2026-08-11

## Relationship to other project artifacts

- [Product backlog](product-backlog.md) records unresolved product and technical opportunities without implying priority.
- [ADR 0001](architecture/0001-lobby-orchestrates-game-runs.md) defines the accepted lobby/game-run lifecycle and ownership boundaries.
- [Slice 1 plan](slice-1-baseline-protection.md) turns the first recommended slice into implementation checkpoints and acceptance criteria, including the thin observability foundation.
- This document groups backlog work by shared implementation seams and describes an efficient delivery shape. It does not replace feature-level acceptance criteria or implementation plans.

Before starting a slice, confirm its current scope against playtest evidence and create a focused issue or design note with exact acceptance criteria. Completing a slice does not require implementing every future idea in its associated workstream.

## Grouping principles

1. Deliver vertical improvements that produce a testable family experience.
2. Preserve the lobby as the durable gathering and authorization boundary and the game run as its gameplay child.
3. Reuse the existing game engine and shared web client rather than creating native-only state or behavior.
4. Establish only the reusable foundation required by the selected slice.
5. Keep recovery and failure behavior inside the slice that introduces the corresponding happy path.
6. Prefer measured improvements to polling, audio transport, and deployment over speculative infrastructure replacement.
7. Keep immediate playtest blockers in the active testing workflow rather than expanding a development slice opportunistically.

## Workstreams

### 1. Runtime safety and operations

Protect the persistent family service and make routine deployment recoverable.

Includes:

- Application-data backup and tested restore
- Deployment and database-migration rollback
- Application, database-volume, relay, certificate, and managed-source health checks
- Managed audio-source replacement and Spotify reauthorization procedures
- Secret inventory, redaction, rotation, and revocation
- Client compatibility and minimum-version signaling
- Separation of disposable PoC endpoints and builds from the durable family environment
- Structured, redacted service errors with request or action correlation identifiers
- A read-only operator summary of current and recent sessions using the best available liveness evidence

This workstream protects every later change and should remain proportional to a small private service.

### 2. Session and audio resilience

Make temporary interruptions, retries, and the single managed-source constraint understandable and safe.

Includes:

- Idempotent game and playback actions
- Server-authoritative action deadlines and reveal transitions
- Reconnection snapshots and accepted-action reporting
- Guest seat reclaim and host-control recovery
- Explicit managed-source states: available, busy, offline, and recovering
- Local listener enablement, mute, and volume distinct from global pause/resume
- Audio startup, latency, drift, loudness, clipping, underrun, and reconnection measurement
- Per-listener buffer, network-delivery, AudioContext, suspension, and main-thread-stall profiling with bounded overhead
- Graceful behavior after browser, network, relay, or audio-droplet interruption
- Durable significant-action outcomes sufficient to reconstruct a game without treating snapshots as history
- Managed-audio lifecycle history retained independently of transient leases and command queues
- Session liveness and conservative stale or abandoned-session handling
- End-to-end correlation among game actions, access-service requests, source commands, and relay diagnostics

This workstream does not require replacing the current polling transport. Choose a new realtime transport only when measured behavior or a selected mode requires one.

### 3. Host and lobby experience

Make creating, preparing, running, recovering, and ending a family game feel like one product journey.

Includes:

- Focused first-run Host pairing
- Returning Host dashboard and active-lobby reopening
- Short-lived Host-to-PWA handoff
- Lobby readiness combining server and client-local facts
- Clear distinctions among members, guest sessions, and gameplay seats
- Invitation revocation, regeneration, locking, and recovery
- Clear audio selection, source contention, and fallback behavior
- Unambiguous game-start semantics
- Post-game replay, reconfiguration, lobby reuse, and session-ending choices

Diagnostics, signing-key details, server configuration, and local Mac capture remain available through Settings or Advanced paths rather than dominating the normal journey.

### 4. Player and shared-screen experience

Improve the social game loop across phones, the host screen, and future group displays.

Includes:

- First-time instructions and an optional non-scoring practice experience
- Clear turn, placement, retraction, waiting, and reconnect states
- A communal answer reveal with artwork, outcome, and deliberate host-controlled pacing
- Scoreboard, round progress, and appropriate awareness of other players
- Shared-audio state and local listener controls
- Accessible keyboard, screen-reader, contrast, motion, text-size, and timing behavior
- Post-game recap and intentionally generated sharing
- Non-playing observer and group-display behavior without creating a gameplay seat

Ordinary player clients must continue to receive no hidden answer metadata before the reveal barrier.

### 5. Desktop product convergence

Turn the existing desktop-player and native Host spikes into one coherent installed-product direction.

Includes:

- Shared-audio listening in the desktop player
- Production-quality pairing, launch, reconnect, and revocation
- Branding, platform packaging, signing, and update behavior
- Reuse of the shared server-authoritative game client
- Player and group-display operation for an ordinary authorized member
- Conditional Host capabilities for an authorized host account and device
- Reuse of proven credential-store, device-signing, handoff, and local-audio components
- Independent validation on macOS and Windows

The PWA and phone browser remain supported zero-install paths. The desktop application must not acquire a separate game engine or incompatible session model.

### 6. Catalog and configuration

Make catalog correctness and host choice flexible without exposing invalid or misleading configurations.

Includes:

- Internal canonical recording identity and provider mappings
- Catalog collision, metadata, playability, provenance, and release validation
- Versioned catalog generation and rollback
- Extensible theme and facet registries
- Era, theme, genre, collection, source-context, and occasion metadata as justified
- Explicit-content preference
- Song-pool eligibility separate from distribution and gameplay rules
- Compact eligible-pool diagnostics
- Bounded distribution and artist-repeat spacing
- Built-in, recent, and personal saved configurations
- In-session skip, avoid, and metadata-report recovery actions

Start with the facets and diagnostics needed by one useful configuration slice. Do not require the complete future taxonomy before improving the current opinionated presets.

### 7. History, profiles, and administration

Retain useful history and manage the invitation-only community without confusing accounts, devices, guests, and gameplay seats.

Includes:

- Longitudinal reporting over the significant diagnostic events retained by session resilience work
- Game reliability and play metrics derived from explicit event fields rather than inferred from final snapshots
- Optional claimed player and recurring-group profiles
- Consent, retention, deletion, recovery, and guest-to-profile conversion
- Session and cross-session playlist records
- Explicit playlist export through a user's connected personal provider account
- Account, capability, passkey, application, invitation, and installer administration
- Last-administrator protection and operator-level recovery

Stable recording identity and explicit identity rules should precede durable personal statistics or adaptive difficulty. This workstream consumes and selectively extends the near-term diagnostic trail; it does not postpone basic session reconstruction or operational inspection.

### 8. New mechanics and remote-party modes

Explore differentiated game experiences after the basic shared game is reliable and observable.

Includes:

- Progressive hints and title/artist answer entry
- Explicit scoring policies, bonuses, helpers, streaks, and handicaps
- Solo, simultaneous, team, cooperative, category, curated, and other validated modes
- Predictable session length and richer selection pacing
- Group displays across multiple households
- External-call coordination and, only if justified, integrated voice/video presence
- Voice-input consent, privacy, fallback, matching, and retention behavior

These features require evidence from actual play. A general scoring engine, WebRTC stack, or realtime rewrite is not a prerequisite for discussing or prototyping one bounded mode.

## Recommended delivery slices

The workstreams above describe ownership and affinity. The slices below describe useful increments to deliver and test.

### Slice 1: Baseline protection

**Outcome:** Existing accounts, authorizations, catalog state, deployment, and managed audio service can be recovered without reconstructing them from memory, and an operator can distinguish failures without manually inspecting SQLite or uncorrelated container output.

**Implementation plan:** [Slice 1: Baseline protection](slice-1-baseline-protection.md)

Candidate scope:

- Automate encrypted backup of persistent application data
- Perform and document a restore rehearsal
- Document and exercise application rollback independently of unrelated `vw-services` workloads
- Add health and capacity checks for the game service, database volume, relay, and managed source
- Add a read-only operator command that summarizes recent sessions, participants, phase, last meaningful state change, client activity, lease state, and known errors without exposing secrets
- Emit structured, redacted service errors and establish correlation identifiers that later session events can carry across components
- Record a known-good deploy and catalog version
- Add catalog release checks for conflicting mappings, wrong-track risk, year conventions, coverage, and source/deployed drift
- Document audio-source replacement and Spotify reauthorization without broadly backing up its browser credential

Acceptance outcomes:

- A backup can restore accounts, capabilities, device authorizations, lobby/game data intended to survive, and operational configuration to a clean test location.
- A failed application deployment can be rolled back without disturbing unrelated services.
- A bad catalog build is rejected before deployment, and the previous catalog can be restored.
- Operators can distinguish an application failure, relay failure, and managed-source failure.
- An operator can determine which sessions were recently created, how far their current snapshots progressed, when meaningful state last changed, whether clients still appear connected, and whether an audio lease is active.
- The session report distinguishes confirmed facts from unavailable history instead of treating a stale `playing` status or an open polling tab as proof of active play.

Boundaries:

- Do not add enterprise orchestration or broad monitoring platforms without evidence they simplify this environment.
- Do not snapshot or broadly distribute the managed Spotify browser profile.
- Do not build the long-term analytics dashboard or persistent player-statistics model in this slice.
- Keep operational logs short-lived. Durable game/audio events, action idempotency, and per-listener profiling belong to Slice 2.

### Slice 2: Game-night resilience

**Outcome:** A short network interruption, refresh, duplicate command, or managed-source interruption does not corrupt or ambiguously advance a game.

Working plan: [Slice 2: Game-night resilience](slice-2-game-night-resilience.md)

Structural resilience contract: [ADR 0002](architecture/0002-resilience-protocols-are-persisted-state-machines.md)

The amended Slice 2 foundation separates identity/access storage from a
single-writer game-night state store. A versioned state service is the only
read-write owner of lobby, run, receipt, history, lease, and command state;
other services use its idempotent API or read-only projections. The controlled
migration and rollback floor are defined in the Slice 2 working plan.

Candidate scope:

- Add stable action identifiers and idempotent handling for placement, retraction, reveal, advance, skip, and playback commands
- Return authoritative action acceptance and current-state snapshots
- Reclaim a guest's existing seat after refresh, phone sleep, or temporary disconnection
- Recover Host control without creating a duplicate host or lobby
- Present managed-source states and provide wait/retry or explicit local fallback when it is busy or recovering
- Add per-device listener enablement, mute, and volume
- Measure audio startup, interruption, recovery, loudness, clipping, and underruns
- Add periodic per-listener summaries for stream timing, chunk gaps, buffer depth and trend, underruns, re-primes, overflows, resets, AudioContext state, and coarse platform/client context
- Add correlated source and relay summaries for published frames, dropped uploads, listener delivery, interruption, and restart behavior
- Provide an advanced local audio-diagnostics view and copyable report that remains useful if telemetry upload fails
- Add stale-client and incompatible-version responses where necessary
- Persist selected game events with lobby, run, round, server time, actor type, action ID, outcome, and redacted error context
- Persist requested, delivered, acknowledged, failed, interrupted, recovered, and expired audio outcomes independently of command-queue cleanup
- Carry correlation identifiers across the game API, access service, managed-source controller, and relay diagnostics
- Derive active, idle, stale, completed, and abandoned session states from meaningful actions, client presence, and lease activity

Acceptance outcomes:

- Retrying a command cannot submit twice, skip two tracks, reveal twice, or invert playback unexpectedly.
- A returning guest resumes the same seat and round without receiving hidden data.
- A managed-source reboot or temporary network loss returns clients to one coherent game and playback state.
- A second host cannot steal the managed source and receives an actionable explanation.
- Local mute or volume changes never pause playback for the group.
- A completed or abandoned game can be reconstructed chronologically through joins, start, track requests, placements, retractions, reveals, advances, skips, audio outcomes, and termination without relying on container logs.
- The operator summary can explain whether playback was requested and acknowledged, why a command failed when known, and whether the session recovered.
- Objective playtest timing and reliability facts can be derived from the event trail without requiring persistent player profiles.
- Two listeners in the same session can be compared to determine whether a stutter originated at the source, relay, network delivery, browser feed, jitter buffer, resampling clock, or local audio output path.
- Profiling transmits no audio samples, credentials, pre-reveal metadata, or persistent device fingerprint and has measured negligible effect on playback scheduling.

Boundaries:

- Keep polling if it meets the acceptance outcomes.
- Do not add cross-device player transfer until same-device recovery is reliable.
- Do not add personal accuracy dashboards, cross-session profiles, or broad analytics aggregation to this resilience slice.

### Slice 3: Core game-night UX

**Outcome:** A host and first-time players can move from launching CannaBeats through a complete game and useful post-game choice without PoC knowledge or unexplained disabled controls.

Candidate scope:

- Make the game or Host dashboard the primary installed entry point
- Streamline first-run pairing and returning-host actions
- Implement the session-scoped Host-to-PWA handoff
- Reopen the active lobby directly
- Present invitations, roster, configuration, audio, readiness, and primary action coherently
- Add lightweight membership and invitation controls
- Add first-turn guidance and optional practice
- Improve communal reveal and remote scoreboard awareness
- Clarify start, advance, completion, replay, and return-to-lobby actions
- Apply accessibility checks to each changed surface

Acceptance outcomes:

- An authorized returning host can create or reopen a lobby and reach a ready state without manually proving authorization or copying a code.
- Every disabled primary action identifies the missing requirement.
- A new phone player can join and complete a first turn without separate technical instruction.
- The host and player clients show a coordinated reveal while protecting pre-reveal metadata.
- A finished game offers clear continuation choices without discarding the lobby accidentally.

Boundaries:

- Keep diagnostics and local-source capture available but outside the primary path.
- Do not combine this slice with a complete visual redesign or new game mode.

### Slice 4: Desktop player release

**Outcome:** A family member can install the desktop client, authorize it, join a lobby, hear shared audio, play a complete game, and recover from ordinary interruptions.

Candidate scope:

- Add authenticated shared-audio listening to the existing Tauri client
- Reuse the game-night recovery and version contracts from Slices 2 and 3
- Finish player-focused pairing, lobby entry, launch, reconnect, and revocation
- Apply production naming, iconography, and packaging
- Produce the current practical macOS distribution and prepare the Developer ID path
- Validate the Windows build separately when a Windows test and signing environment is available
- Record the convergence design for adding Host capabilities to the same application later

Acceptance outcomes:

- The desktop application never exposes its long-lived credential to the web UI or URL.
- The installed player receives the same authoritative game state and audio as the PWA.
- Revocation invalidates the application and its derived web sessions.
- The package has clear install, update, and recovery instructions for its supported platform.
- No desktop-only lobby or gameplay implementation is introduced.

Boundaries:

- Player reliability is the first milestone; full Host convergence is a following slice.
- Do not embed Spotify playback in an unsupported webview merely to unify packaging.

### Slice 5: Composable configuration proof

**Outcome:** A host can create, understand, save, and reuse one configuration that goes materially beyond the current fixed presets without producing a broken or misleading song pool.

Candidate scope:

- Establish internal recording identity and versioned catalog generation
- Expose an extensible theme registry backed by current catalog data
- Separate song-pool eligibility, distribution, and gameplay rules in persisted configuration
- Add an explicit-content preference
- Provide era and independent stage/screen theme controls
- Show eligible count, effective settings, and too-small or contradictory-pool warnings
- Save and reopen one personal Host configuration
- Use a bounded distribution policy without exact quotas across overlapping facets

Acceptance outcomes:

- A recording appearing in multiple packs or facets does not gain unintended draw weight.
- The host can predict which music is eligible and why a configuration is rejected.
- Theme choice does not silently alter unrelated gameplay rules.
- A saved configuration can be reused after a restart and refers to a compatible catalog version.
- The selected game draws only playable, validated recordings from the effective pool.

Boundaries:

- Do not require full genre enrichment, complex facet intersections, shared presets, or advanced session pacing in this proof.
- Do not create a second configuration model outside the existing game engine.

## Dependency and sequencing notes

### Required sequence

1. Slice 1 should precede schema-heavy or deployment-heavy changes from later slices.
2. Slice 2 establishes recovery and action contracts used by the polished Host/player flow.
3. Slice 3 should stabilize shared behavior before the desktop client packages it.
4. Slice 4 depends on the session, audio, and client-version contracts from Slices 2 and 3.
5. Slice 5 can proceed independently after its catalog-release protections from Slice 1 are available.

### Useful parallelism

After Slice 1 establishes protection:

- Session/API resilience and Host/player interaction design can be developed in parallel if their request/response contracts are agreed first.
- Catalog/configuration work can proceed independently of Host UX when it avoids overlapping changes in the shared game page and rules model.
- Desktop packaging and branding can proceed while web UX is refined, but final integration should wait for the shared session and audio contracts.
- Managed-source observability can proceed independently of player visual work.

### Likely code-ownership seams

- **Game session and shared UI:** `web/app/page.tsx`, `web/app/api/game/route.ts`, `web/lib/session.ts`, and related tests
- **Configuration and selection:** `web/lib/rules.ts`, catalog build inputs and scripts, game selection logic, and configuration UI
- **Identity and authorization:** access service, database authorization tables, invitation/account UI, and security tests
- **Native applications:** macOS Host source and `clients/desktop-client`, coordinated through server contracts rather than shared native state
- **Managed audio:** source agent/controller, relay integration, audio-stream client, and infrastructure units
- **Deployment and operations:** compose configuration, Caddy routing, DigitalOcean resources, secrets, backup, restore, and runbooks

Avoid simultaneous unrelated edits to the large shared game page or game API route. Extract stable components or contracts as part of a selected slice when doing so reduces real merge and testing risk.

## Combinations to avoid

- Do not combine desktop convergence with the complete Host UX overhaul in one implementation task.
- Do not combine statistics, persistent profiles, adaptive difficulty, and playlists into one database migration.
- Do not replace polling solely to prepare for a hypothetical simultaneous mode.
- Do not build integrated conferencing before testing group-display mode with an external call.
- Do not build a generalized scoring/modifier engine before one validated alternate scoring policy requires it.
- Do not build the complete genre taxonomy alongside the first configuration improvement.
- Do not fold immediate party-test defects into a broad experience slice; fix and verify blockers separately.
- Do not let operational cleanup change or interrupt unrelated `vw-services` tooling.

## Deferred slices after the initial five

Later slices should be selected from evidence rather than assumed now. Likely candidates include:

- Desktop Host-capability convergence
- Game history, statistics, and post-game recap
- Personal playlist export and persistent Can'naBeats playlists
- Optional profiles and recurring groups
- One validated alternative scoring or hint mode
- Solo-play mode for practice, personal challenges, or self-paced catalog exploration
- Simultaneous placement and its realtime/reveal requirements
- Advanced themes, genre enrichment, and DJ-directed pacing
- Multi-household group-display experiment
- Voice-assisted title and artist entry
- Integrated remote voice/video only if lighter alternatives prove insufficient

## Slice planning template

Use this template when promoting a slice into active development:

```markdown
## Slice name

**Player or operator outcome:**

**Included backlog items:**

**Explicitly excluded:**

**Current-state evidence:**

**Dependencies and contracts:**

**Data or migration impact:**

**Failure and recovery behavior:**

**Acceptance criteria:**

**Verification plan:**

**Deployment and rollback plan:**
```
