# S2-D recovery contract

Status: foundational model under implementation. This document defines the
authority and transition boundaries before UI or persistence changes are made.

## Ownership

- Access owns account and same-device guest credentials, credential rotation,
  expiry, and the mapping from an authenticated credential to one opaque
  principal ID.
- State owns lobby membership, host identity, phone-seat control, active run,
  room revision, action reconciliation, managed-source lease, command, and
  handoff authority.
- The browser owns no durable authority. `sessionStorage`, a saved lobby code,
  and a pending-action record are locators that help choose recovery; deleting
  or corrupting them cannot create, transfer, or remove a seat.
- Game composes an Access principal with State projections. It does not infer a
  seat from a player name or create a second lobby to recover host control.

## Session and seat recovery

Recovery resolves in this order:

1. Reject an incompatible client contract before disclosing lobby state.
2. Require a valid Access principal. A recognizable expired same-device
   credential receives `credential_expired`; anonymous traffic receives
   `authentication_required`.
3. Reconcile any durable pending action before enabling a new mutation.
4. Use a saved lobby code only when it is among the principal's current State
   memberships.
5. Resume the only active membership, offer an explicit choice when an account
   has several, or report that there is no recoverable game.

For a phone-controlled seat, the player ID is the guest principal ID. A valid
same-device credential therefore recovers the same seat; it never searches by
display name. An expired guest session does not cause Access to delete the
principal while State still reports the same active lobby membership.
Admission creates a separate 24-hour same-device recovery boundary; ordinary
game calls still stop at the eight-hour active-session boundary. Recovery
revalidates membership through the Access-scoped State projection and refreshes
both boundaries. It does not extend the invite token or make cross-device
transfer implicit. When State no longer reports that lobby, Access revokes the
recovery capability and removes its guest identity records.

An authenticated host resumes a lobby only when State records that account
principal as its host. Recovery cannot replace the host principal or create a
new lobby as a fallback.

## Client cursor recovery

State's `(lobby code, run ID, run generation, revision)` is authoritative. A
saved cursor may select a lobby but cannot overrule State. Recovery returns one
of the finite outcomes published by the State contract. A pending action keeps
mutations blocked until its original request identity becomes accepted,
replayed, or definitively rejected.

## Managed-source handoff

The shared source has five externally meaningful states:

- `available`: no lease and no unresolved prior external effect; acquisition is
  allowed but listening is not yet allowed.
- `owned`: the requesting lobby owns the live lease; listening is allowed.
- `busy`: another lobby owns the live lease; acquisition and listening are
  denied, with local playback offered.
- `recovering`: this lobby has an unresolved prior effect; acquisition and
  listening remain denied until reconciliation.
- `quarantined`: another lobby's prior effect is unresolved after lease loss;
  no new lobby may acquire or hear the relay until the source acknowledges a
  safe terminal result or an operator applies a reviewed recovery action.

Lease ownership alone is not sufficient for listener authorization during a
handoff. The source must cross the unresolved-effect fence before a new owner is
projected as listen-capable. Local playback remains an explicit, non-destructive
fallback in every non-owned state.

State schema generation 3 / managed-source protocol 4 persist the handoff as
an immutable stop obligation. Releasing a source that is playing creates a
State-issued `pause`; releasing it with delivered work first quarantines the
source until that work reaches a definitive outcome, then exposes the pause.
The old lease is removed immediately, but another lobby cannot acquire the
source and cannot listen until the pause completes as `paused`. A source cannot
be disabled across this boundary; token rotation preserves the stop authority.
The real controller accepts protocol 4 commands without a lease only when the
command is the State-marked handoff pause.

Generation-2/protocol-3 State databases were unpublished implementation
checkpoints. They are not upgraded in place or treated as compatible release
artifacts; a drained monolith source must be migrated into a fresh
generation-3 candidate and activated against its exact attestation.

## Non-goals

- Cross-device seat transfer
- Name-based seat recovery
- Automatic host reassignment
- Exactly-once claims for external Spotify effects
- Real-host controller/browser/Spotify and reboot proof, which remains S2-F

## Development order

1. Publish and test the finite recovery/handoff outcomes.
2. Add a read-only principal-to-membership recovery projection.
3. Replace wall-clock-only guest cleanup with run-aware credential recovery.
   Implemented with separate active/recovery expiries, State membership
   revalidation, idempotent admission credentials, and a fail-closed expand
   migration for prior rows.
4. Wire browser startup and stale-client handling to the recovery projection.
   Implemented with an explicit client contract version checked before Access
   or State identity disclosure. A durable pending action supplies its lobby
   target during startup, restores the current projection with controls blocked,
   and then reuses the existing exact-request reconciliation loop.
5. Persist and enforce the source handoff/quarantine fence. Implemented with an
   append-only handoff intent/transition graph, acquisition and listener fences,
   terminal-history reconciliation, and real-controller protocol handling.
6. Add busy/recovering/local-fallback UI and composed recovery scenarios. The
   UI outcomes and explicit local fallback are implemented; the full composed
   scenario matrix remains the next verification task.
