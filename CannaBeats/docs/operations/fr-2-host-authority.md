# FR-2: Host device authority and web-view sessions

- **Status:** Complete; independently reviewed with no open P0/P1/P2
- **Governing plan:** [CannaBeats first-release plan](../first-release-plan.md)
- **Governing invariant:** Only possession of an enrolled device key can create
  Host authority, and every code, challenge, session, and web ticket is
  single-purpose, bounded, revocable, and replay-safe.

## Boundary

FR-2 adds Host authority directly to the consolidated Node owner. It has no
Host password, passkey, email flow, account table, external identity provider,
or Access service. A Host identity is one server-authorized P-256 public key;
its private key remains in the Secure Enclave or this-device-only Keychain.

The production Swift source is introduced as reusable macOS Host code in FR-2.
FR-7 owns its complete SwiftUI journey and FR-9 owns the Xcode target, signing,
notarization, and DMG. FR-2 does not revive the PoC application/account model.

## Fixed secrets, lifetimes, and limits

All bearer values are URL-safe base64 without padding and contain at least 128
bits of caller-generated randomness. Only lowercase SHA-256 hashes are stored.
The native Host generates a value once and retains it across an ordinary retry;
the server never returns or persists its plaintext. An unacknowledged enrollment
request and an unacknowledged signed proof intent are retained temporarily in
this-device-only Keychain so relaunch can repeat the same canonical request.
Each is erased immediately after acknowledgment, its terminal finite failure,
or an explicit local-authority reset.

| Identity | Lifetime/capacity |
| --- | --- |
| Enrollment code | 24 hours; one redemption |
| Signing challenge | 2 minutes; one proof attempt |
| Application session | 30 days; eight live sessions per device |
| Web-view ticket | 1 minute; one exchange |
| Web-view session | 12 hours and never beyond its parent application session |
| Authorized devices | 100 non-revoked devices |
| Active enrollment codes | 100 globally |
| Active challenges | Four per device |
| Active web tickets | Four per application session |
| Host action receipts | 3,840 ordinary slots plus 256 authority-reducing reserve slots |

At `now == expires_at`, authority is expired. `max-1`, `max`, and `max+1`
refer to the advertised maximum number of already-live records: issuance is
accepted below the maximum and rejected when the maximum is already present.

## Canonical proof

The server validates a DER SubjectPublicKeyInfo for exactly a P-256 signing key
before enrollment. The challenge signature covers the UTF-8 canonical JSON
bytes of:

```json
{
  "audience": "cannabeats-host-proof",
  "challenge": "caller-generated bearer",
  "deviceId": "UUID",
  "origin": "https://play.cannabeats.social",
  "version": 1
}
```

The challenge is bound to the device before proof. Verification consumes it
whether the signature is valid or invalid, so a guessed or altered signature
cannot be retried against the same challenge. A successful proof atomically
creates the caller-supplied application-session hash and immutable receipt.

## Retained representation

- `host_devices` retains immutable device ID/public key/authorization time,
  bounded mutable label, last-proof time, and monotonic revocation time.
- `host_enrollments` retains the code hash, optional issuing device, fixed
  expiry, and exactly one redemption device/time.
- `host_challenges` retains the challenge hash, device, expiry, and one
  consumption time/outcome.
- `host_sessions` distinguishes `application` and `web` sessions. A web session
  references its parent application session and cannot outlive it.
- `host_web_tickets` binds one hash to its issuing application session and
  records its single exchange and resulting web-session hash.
- `host_action_receipts` stores only canonical requests containing hashes, IDs,
  labels, and expiry metadata. No plaintext bearer or signature is retained.

Later-checkpoint tables remain empty. FR-2 startup validation covers every Host
row, receipt/effect relationship, expiry relationship, and revocation cascade
before readiness.

## Atomic operations

### Enrollment

- `issueEnrollment`: operator bootstrap has actor `operator`; later issuance
  authenticates a live application session. The caller supplies the code and
  request UUID. Exact replay is resolved before issuer revocation, expiry, or
  capacity; conflicting reuse fails first.
- `redeemEnrollment`: receives the original code, caller-generated device UUID,
  DER public key, label, and request UUID. Exact replay returns the original
  authorization. Otherwise expiry equality, prior redemption, duplicate key,
  and device capacity are checked before atomically creating the device and
  redemption evidence.

### Proof and sessions

- `issueChallenge`: receives a device UUID, caller-generated challenge, and
  request UUID. It reveals no device details: unknown/revoked/capacity outcomes
  are the same finite `unauthorized` result.
- `proveChallenge`: receives the challenge, DER ECDSA signature, a
  caller-generated application-session token, and request UUID. Exact replay
  is resolved first. The transaction consumes the challenge before returning
  `proof_rejected`; valid proof creates one 30-day application session.
- Repeating proof with a fresh challenge/session token renews authority. It
  does not extend, mutate, or silently revoke an older session.
- Device revocation atomically sets `revoked_at` and revokes every live session,
  challenge, ticket, and unredeemed enrollment issued by that device. Exact
  revocation replay returns the original result; unseen post-revocation work is
  unauthorized. If the device owns the one nonterminal game, the same
  transaction retains a system `terminate_game` receipt/event, closes its
  invitation, ends playback/audio authority, and abandons it so the global
  game slot cannot remain inaccessible.

### Web view

- `issueWebTicket`: a live application session supplies a caller-generated
  ticket and request UUID. The one-minute ticket is bound to that session.
- `exchangeWebTicket`: the first valid exchange consumes the ticket and creates
  a web session whose bearer is the same supplied ticket value. The response
  sets `__Host-cannabeats-host` with `Secure`, `HttpOnly`, `SameSite=Strict`,
  `Path=/`, and no `Domain`. A second exchange fails `ticket_used`; the native
  application can issue a new ticket after response loss.
- Host-cookie authorization validates the web session, parent application
  session, and device on every request. Revocation or either expiry ends it.

## Finite results

Accepted codes are `enrollment_issued`, `device_enrolled`, `challenge_issued`,
`session_created`, `ticket_issued`, `ticket_exchanged`, and `device_revoked`.
Failures are limited to `invalid_request`, `unauthorized`, `request_conflict`,
`expired`, `already_used`, `capacity_reached`, `proof_rejected`,
`database_unavailable`, and `database_corrupt`. Public routes never return a
native crypto/SQLite error, public key, stored hash, signature, path, or SQL
text. The sole returned bearer is the deliberate HttpOnly Host cookie created
from the exchanged ticket. Failure envelopes never reflect caller-authored
values; successful authorized device projections may return the normalized
label and device ID.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime` + `schema`: named owner transactions validate finite inputs and create code/device/challenge/session/ticket rows under PK, FK, and uniqueness constraints. |
| Update | `schema` + `runtime`: identity/key/issuance fields are immutable; only label, proof/consumption, and monotonic revocation fields change through named transactions. |
| Delete | `schema`: FR-2 deletes no Host authority row or receipt; immutable delete triggers retain replay evidence within the fixed 4,096-receipt bound. A later cleanup design requires its own explicit invariant. |
| Omit | `runtime`: startup enumerates every Host row and requires each accepted receipt to have its exact effect or terminal finite result. |
| Duplicate | `schema`: hashes, device IDs, public keys, receipt identities, redemption devices, and resulting session links are unique. |
| Reorder | `runtime`: issuance, consumption, expiry, proof, and revocation timestamps are monotonic and parent-bounded. |
| Replay | `runtime`: exact retained receipt is evaluated before current authority, expiry, use, or capacity; ticket exchange is explicitly one-use and replaced after lost response. |
| Conflict | `runtime`: scoped request reuse with another canonical hash fails before state evaluation; altered key/code/challenge/session content cannot claim prior success. |
| Concurrency | `runtime` + `schema`: the one synchronous owner and `BEGIN IMMEDIATE` serialize checks; unique constraints decide final-slot and one-use races. |
| Expiry | `runtime`: every operation uses expired when `now >= expires_at`; child expiry never exceeds its parent. New enrollment codes use exactly 24 hours; the validator also recognizes the formerly issued 15-minute lifetime so retained production evidence remains restart-valid. |
| Restart | `runtime`: the shared release validator reconstructs every Host authority and receipt/effect relationship before publishing readiness. |
| Dependency failure | `runtime`: malformed DER/signature, crypto failure, unavailable database, and response loss map to finite results without partial authority. Store errors carry a process-global symbol brand so production module duplication cannot collapse a finite result into `database_unavailable`; unbranded/native errors still fail closed. |
| Corruption | `runtime`: canonical receipts, hashes, parentage, timestamps, consumption, session kinds, and revocation cascades fail closed. |
| Capacity | `schema` + `runtime`: 100 active devices, 100 live codes, and the fixed challenge/session/ticket limits and receipt cleanup reserve are checked inside the mutation transaction. Revoked-device history does not consume the active-device limit; redeemed, revoked, and expired codes do not consume the live-code limit. |

## Matrix-derived verification

- Operator bootstrap and authorized-device issuance; unknown/revoked issuer.
- Code interception without key possession, altered-key redemption, double
  redemption, exact response-loss retry, and conflicting request reuse.
- Enrollment/challenge expiry immediately before, at, and after equality.
- Valid P-256 proof; malformed DER, wrong curve, wrong key, altered canonical
  proof, malformed signature, proof response loss, and challenge reuse.
- Application renewal, eight-session boundary, restart, session expiry, and
  device revocation cascading to application/web sessions and tickets.
- Ticket issue/exchange, cookie attributes, one-minute equality, second
  exchange, parent expiry, and four-ticket boundary.
- Device/code/challenge/session/ticket `max-1`, `max`, and `max+1`, including
  simultaneous final-slot schedules.
- Receipt ordinary/reserve boundaries and authority-reducing revocation when
  ordinary capacity is full.
- Corrupt each retained parent, hash, timestamp, consumption link, result, and
  revocation projection while preserving other checked relationships; restart
  and readiness must fail closed.
- Scan every finite failure envelope for reflected secrets, hashes, public
  keys, signatures, native errors, paths, SQL, and supplied labels; scan the
  cookie for every bearer or attribute except its one intended exchanged ticket.

## Pre-audit counterexample question

What is the smallest mutation that preserves a valid signature or valid child
row but moves its authority elsewhere? Apply it to challenge device binding,
application-to-web parentage, ticket result links, enrollment redemption,
request hashes, expiry equality, and revocation cascades before review.

The local pass found and closed: malformed signatures that did not consume the
challenge; deletable retained Host rows; proof results not bound back to their
device; web sessions without an inverse ticket; unreceipted revocation; mutable
last-proof projection; noncanonical uppercase UUIDs from Swift; and enrollment
response loss that did not survive native-client restart.

The 2026-08-22 production enrollment pass found and closed a duplicated-module
error-identity counterexample: a malformed bearer was correctly rejected by
the store, but the route did not recognize the other bundled instance's
`ReleaseStoreError` and reported `database_unavailable`. The shared symbol
brand now preserves the finite result across bundled module identity while an
unbranded object with the same public-looking fields still fails closed. The
native verifier also retains, persists through its injected restart boundary,
and re-emits an enrollment code ending in `-` byte-for-byte; no client code
trims or normalizes the field.

The first independent audit found no P0, five P1, and one P2. The remediation
canonicalizes SPKI bytes, resolves session-token collisions before verification,
keeps revocation valid across expired challenges, requires exact nullable child
revocation projection, retains proof retry intent across native restart, and
reads bootstrap codes from a caller-selected file descriptor rather than argv.

## Enforcement and local evidence

- SQLite tables, uniqueness, foreign keys, and immutable/delete triggers:
  `web/lib/server/release/schema.mjs`.
- Shared mutation owner, canonical proof, limits, replay ordering, cascade, and
  full retained validator: `web/lib/server/release/host-authority.mjs`, composed
  by `store.mjs` and `runtime.mjs`.
- Bounded public HTTP boundary and thin Next routes:
  `web/lib/server/release/host-routes.mjs` and `web/app/api/host/`.
- Operator bootstrap: `release/scripts/host-admin.mjs`.
- Secure Enclave/Keychain identity, durable enrollment retry, native transport,
  and reusable enrollment/device views: `macos/CannaBeatsHostCore/`.
- Matrix tests: `release/tests/host-authority.test.mjs`,
  `host-routes.test.mjs`, `host-admin.test.mjs`, and
  `next-runtime.integration.mjs`.

Local verification before audit:

- `node --test release/tests/*.test.mjs` — 55 tests passed.
- `node --test release/tests/next-runtime.integration.mjs` — 1 test passed.
- `npm test` in `web/` — production build and 337 tests passed.
- `swift run CannaBeatsHostCoreVerifier` — 6 protocol/client checks passed.
- `npm run lint` in `web/` — no errors; one pre-existing unused-variable
  warning in `s2e-e5-browser-session.mjs`.
- `git diff --check` — passed.

The narrow independent re-audit reran all six original counterexamples and
found no directly introduced regression. Final open findings: P0 0, P1 0,
P2 0.

The 2026-08-22 production correction was verified with:

- `node --test release/tests/host-routes.test.mjs release/tests/runtime.test.mjs release/tests/operator-routes.test.mjs release/tests/audio-routes.test.mjs release/tests/playback-routes.test.mjs release/tests/game-admission-routes.test.mjs release/tests/game-journey-routes.test.mjs release/tests/host-experience-routes.test.mjs` — 32 passed.
- `node --test release/tests/*.test.mjs` — passed.
- `node --test release/tests/next-runtime.integration.mjs` — the standalone production build passed its complete integration, including the observed malformed enrollment.
- `swift run CannaBeatsHostCoreVerifier` — 23 passed, including terminal-hyphen retention across restart/replay.
- `npm test` in `web/` — production build and 333 tests passed.
- `npm run lint` in `web/` and `git diff --check` — passed.

## Deferrals

- FR-3 is the first consumer of Host authority for game invitation and roster
  operations.
- FR-7 owns the complete SwiftUI setup/settings/readiness experience and
  diagnostic presentation.
- FR-8 owns operator CLI packaging, deployment secrets, backup/restore, and
  all-devices-lost execution in production. It may add receipt cleanup only if
  a concrete deployment need establishes a safe retained retry boundary.
- FR-9 owns the Xcode target, entitlements, signing, notarization, DMG, and clean
  Mac acceptance. FR-2 supplies reusable production source and protocol tests.
