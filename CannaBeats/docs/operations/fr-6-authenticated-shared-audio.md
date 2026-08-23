# FR-6 authenticated shared audio

**Status:** Complete. Independent closure review and narrow remediation
re-audit report no open P0, P1, or P2 findings.

## Governing invariant

Only the active game's Host can publish one bounded audio generation and only
that game's current Host or admitted participants can receive it; every stale,
revoked, interrupted, or malformed stream is fenced before it can cross a game
or generation boundary.

## Product-scale boundary

FR-6 owns one Spotify process tap, one active game, one publisher, the Host
listener, at most eight participant listeners, one small private relay process,
and the unified Next server that mediates both relay directions. It uses fixed
SQLite transitions, plain HTTP streaming inside the Compose network, and
bounded in-process buffers. It does not introduce WebRTC, HLS segmentation,
adaptive bitrate, peer discovery, public relay credentials, a media database,
multi-region failover, or generalized stream orchestration.

FR-6 supports signed 16-bit little-endian stereo PCM at the tap's retained
44.1 kHz or 48 kHz rate. The native tap mutes Spotify while captured and the
Host hears the same relayed stream as participants. FR-10 owns the final audible
Host/phone proof under the notarized application and deployed topology.

## Durable audio-generation contract

An application-authenticated Host opens one `audio_session` for its active game
with caller-generated canonical UUIDs for the session and request. The retained
generation is the next positive per-game integer. Exact open replay returns the
original generation; conflicting request or identity reuse fails before current
state evaluation. A different open session is rejected until the current one is
ended.

The finite states are:

```text
starting -> connecting -> active -> interrupted
    |             |           |          |
    `-------------+-----------+----------+-> ended
                  ^                      |
                  `----------------------'
```

Every state edge is immutable and gap-free. `active` means the unified server
has authenticated the Host, connected the exact session/generation to the
private relay, validated the relay response, and begun forwarding capture.
Dependency loss changes the same current generation to `interrupted`; it does
not invent a successor. Reconnect may return that generation to `active`.
Explicit stop, game completion, abandonment, or Host-device revocation ends it.
Terminal sessions cannot be resumed.

Playback may claim or enter `executing` only while the same game's audio session
is active. An already execution-ambiguous playback command may still be claimed
for readback-only reconciliation while audio is unavailable, but it cannot be
sent to Spotify. This makes confirmed capture and ingest a mechanical
precondition of the first external playback effect.

## Unified streaming boundary

Native traffic uses only:

- `POST /api/games/{gameId}/audio/sessions` to open or exactly replay a session;
- `GET /api/games/{gameId}/audio/sessions/current` to recover its retained state;
- `POST /api/games/{gameId}/audio/sessions/{audioSessionId}/end` to end or
  exactly replay an explicit stop;
- `POST /api/games/{gameId}/audio/sessions/{audioSessionId}/ingest` for PCM; and
- `GET /api/games/{gameId}/audio/sessions/{audioSessionId}/listen` for the Host
  or a participant.

The control routes and ingest require the application bearer and audio contract
header. Listen accepts exactly one authority: the owning application bearer or
the game-scoped participant cookie. No browser can publish. No request supplies
a relay address, relay token, Host identity, participant identity, or generation.
Those values come from retained authority and fixed server configuration.

The unified server reads the ingest and listen relay tokens only from fixed
root-owned secret files, injects them only on the private Compose hop, and never
places them in a native/browser response, redirect, log, or diagnostic. It binds
both upstream requests to the retained session ID and generation, validates the
relay's exact format/generation headers before exposing a success body, and
rechecks current authority during an open stream. Removal, revocation, terminal
game lifecycle, session interruption/end, generation change, timeout, or
readiness failure cancels both directions with a finite result.

## Fixed relay and buffer contract

The private relay accepts one authenticated publisher and nine live listeners
(eight participants plus Host). A publisher handoff or disconnect closes every
listener before another generation can publish. A listener captures the exact
session/generation and format at admission; it can never rebind in place.

The authenticated proxy rechunks coalesced input to at most 16 KiB. The relay
then forwards at most 16 KiB of frame-aligned PCM per write after retaining at
most three carry bytes. A slow listener is disconnected as soon as its one Node response
buffer reports backpressure; the relay never accumulates a user-space per-client
queue. Request/header timeouts and maximum header sizes use fixed Node server
limits. Relay output and counters contain only finite scalar state—never tokens,
cookies, peer addresses, request headers, native errors, or PCM.

The Core Audio callback converts directly into a preallocated single-producer,
single-consumer ring. It performs no Objective-C/Swift object allocation and
never waits on the network or player. Full-ring and oversized-callback loss
increments atomic dropped-packet and dropped-frame counters. A serial non-real-
time drain allocates the bounded `Data` passed to upload and local verification.
The ring owns 64 slots of at most 4,096 stereo frames; maximum resident PCM is
1 MiB. The native upload owner adds no more than 64 fixed-size packets. Buffer
overflow drops oldest unpublished upload data and records the exact count. The
local player schedules at most 64 decoded packets and drops excess packets with
exact packet/frame accounting.

## Readiness, local output, and recovery

Screen & System Audio Recording readiness is explicit and finite: unsupported,
not determined, ready, or failed. The release Info contract contains
`NSAudioCaptureUsageDescription`. Apple exposes no separate Core Audio tap
permission preflight: the system prompt is triggered only by the first tap
recording attempt. CannaBeats therefore never requests broader Screen Capture
access, records readiness only after the tap succeeds or fails, and always
allows an explicit retry after a System Settings change. FR-7 owns the final
readiness presentation and finite recovery wording.

The foreground shared-audio owner starts in this order:

1. recover or open the current retained audio session;
2. locate only Spotify's `com.spotify.client` Core Audio process identity,
   including while Spotify is paused and not yet producing output;
3. create the muted private tap and bounded ring;
4. connect authenticated ingest and receive exact active confirmation;
5. start the Host's authenticated listen connection; and
6. allow the playback polling owner to claim new executable work.

Interruption stops new playback execution, closes local/participant streams,
retains cumulative capture, pre-ingest, upload, player, discontinuity,
reconnect-attempt, and terminal-failure counters, and retries the same
generation at most three times
with fixed 1/2/4-second delays. Exhaustion remains `interrupted` until an
explicit user reconnect. Stop is idempotent and removes the tap, ingest,
listener, timers, and pending packets. Before sending the terminal request it
persists one stable this-device-only Keychain intent. Persistence or response
uncertainty remains truthfully `stopPending`, blocks start and reconnect, and
retries the same identity through explicit stop; no ambiguous external effect
is attempted before the identity is durable.

No virtual audio driver is installed or embedded. macOS 14.2's native private
process tap is the complete release capture boundary; BlackHole is not a
release dependency.

## Enforcement locations

- `web/lib/server/release/schema.mjs` owns session/transition identities,
  finite states, immutability, one open generation, and retained bounds.
- `web/lib/server/release/audio-sessions.mjs` owns open/replay, transition,
  restart reconstruction, active authority, lifecycle ending, and capacity.
- `web/lib/server/release/audio-routes.mjs` owns exact Host/participant
  authentication, bounded streaming contracts, private secret injection, relay
  response validation, and open-stream reauthorization.
- `release/relay/server.mjs` owns one publisher, nine listeners, generation
  fencing, bounded frame carry, backpressure disconnect, and sanitized status.
- `macos/CannaBeatsHostCore/Sources/AudioTapBridge` owns the muted Spotify tap,
  preallocated PCM ring, and atomic overflow accounting.
- `macos/CannaBeatsHostCore` owns durable stop intent, session recovery,
  ingest/listen clients, local relayed playback, fixed reconnect, readiness,
  and playback gating.
- `web/lib/release-audio-browser.mjs` and
  `web/lib/use-release-audio-stream.ts` own the fixed same-origin browser
  contract and user-initiated start, stop, and reconnect behavior required by
  browser autoplay policy.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `schema` + `runtime`: one exact Host request creates one session ID, next game generation, and initial transition atomically; relay admits one matching publisher. |
| Update | `runtime`: one shared transition owner enumerates starting/connecting/active/interrupted/ended edges and compares the mutable head with immutable history. |
| Delete | `structural`: FR-6 deletes no session or transition; stop and lifecycle reduction append `ended`. FR-9 owns physical purge. |
| Omit | `runtime`: startup requires every session's initial transition, contiguous edges, exact head, game binding, and one open head; proxy success requires exact relay format/generation headers. |
| Duplicate | `schema` + `runtime`: session ID, game/request ID, game/generation, transition sequence, one publisher, and nine listener slots are unique or fixed; exact open retry reconstructs its immutable original result and transition retry returns its retained result. |
| Reorder | `schema` + `runtime`: transition sequences are contiguous, times nondecreasing, generations strictly increase by creation order, and a relay listener captures rather than follows a generation. |
| Replay | `runtime`: exact session open reconstructs the original `starting` projection from immutable identity and creation time after any later state, restart, or revocation; end retry uses one retained request identity; stream reconnect targets the same current generation and never replays PCM. |
| Conflict | `runtime`: reused request/session identity with different content, a second open session, mismatched relay generation/format, or incompatible audio contract fails before streaming. |
| Concurrency | `schema` + `runtime`: `BEGIN IMMEDIATE`, one-open-session index, compare-and-update, atomic relay publisher/listener reservation, and post-connect authority recheck select one winner. |
| Expiry | `not_applicable`: active game/audio generations do not expire by clock. Fixed connection/setup timeouts end only the attempted transport, not retained game authority. |
| Restart | `runtime`: SQLite reconstructs the session; any non-ended session without a live ingest resumes as `interrupted`; a Keychain-retained explicit-stop intent is reconciled before another session read; and native recovery reconnects the same generation before playback. |
| Dependency failure | `runtime`: capture permission, tap loss, relay/Node loss, malformed response, response loss, backpressure, and timeout map to finite interrupted/terminal results and bounded retries; explicit stop retains and retries one end identity across response loss and process restart. |
| Corruption | `runtime`: altered game/request/generation/state/head/transition/time relationships fail readiness; malformed headers, misaligned terminal PCM, and wrong relay generation fail closed before cross-game output. |
| Capacity | `schema` + `runtime`: 512 retained sessions/game, 16 transitions/session, one publisher, nine listeners, 16 KiB proxy/relay writes, 64 capture slots, 64 upload slots, 64 scheduled local-player packets, 4,096 frames/slot, and three reconnects have boundary evidence. |

## Matrix-derived verification

The FR-6 suite must prove:

- exact create/replay/conflict, strictly increasing generation, one-open winner,
  replay after every later state/restart/revocation, explicit stop before/after
  response commit and native restart, completion/abandonment end, restart, and
  retained corruption;
- starting/active/interrupted/recovered/ended legal and illegal edges, response
  loss, transition reserve, and session capacity at max-1/max/max+1;
- playback claim/execution denial before audio active, allowance after active,
  and readback-only reconciliation while interrupted;
- ingest rejection for missing/wrong Host, game, session, contract, format,
  generation, secret dependency, or relay response, without reflected content;
- listen rejection for missing/ambiguous/wrong-game participant or Host,
  stale/interrupted generation, terminal game authority, and Host revocation
  during an open stream;
- relay one-publisher, publisher handoff fence, 8/9/10 listener capacity, slow
  listener removal, fixed rechunking, split-frame carry, terminal carry
  rejection, and restart;
- callback overflow at 63/64/65 retained slots and 4,095/4,096/4,097 frames,
  with no callback allocation and exact drop counters;
- native order capture -> confirmed ingest -> Host listen -> playback, plus
  1/2/4-second reconnect, stop during current/open/ingest/listener startup, and
  terminal exhaustion with no credential output;
- browser user-gesture start, stop, reconnect, page teardown, stale-generation
  cancellation, and fixed memory/timer ownership; and
- nine loopback listeners plus publisher remain within the documented process
  buffer bound and measured local CPU/RSS envelope.

## Pre-audit counterexample pass

Before review, ask:

> What smallest mutation can preserve current session and relay checks while
> binding one PCM byte, listener, transition, or callback to the wrong game or
> generation?

The local pass was completed on 2026-08-21. It found and remediated these
relationship-preserving counterexamples before independent review:

- a valid `audio_not_ready` store result was collapsed by the playback route
  and native client into a database/response failure;
- native capture, startup-drop, upload, and player counters disappeared when a
  transport was torn down, and an initial control request failure left explicit
  reconnect unable to reacquire the retained generation;
- the browser session boundary existed without a participant control in the
  release game screen, and a changed session identity did not itself retire an
  old browser player;
- Host recovery omitted the active audio projection and the canonical snapshot
  discriminator used by the strict release client;
- the permission owner used Screen Capture preflight/request calls even though
  Core Audio tap permission has no separate public preflight and is prompted by
  the recording attempt itself;
- a paused Spotify process was excluded by an `isRunningOutput` filter, creating
  a first-song deadlock because playback is gated behind capture; and
- the original nine-listener resource test measured the private relay alone,
  not the authenticated proxy and relay together; and
- an active-then-immediately-interrupted startup callback could be overwritten
  by final activation, while a callback retained by a retired transport could
  interrupt its successor;
- an exact open retry projected the mutable current session instead of its
  immutable original `starting` result;
- explicit stop cleared local ownership and swallowed an outcome-unknown end,
  while stale current/open/ingest/listener continuations could publish resources
  after stop; and
- retained cause validation admitted recovery exhaustion before the reserved
  final transition, Host-revocation evidence was not causally bound, upload
  counter reads raced their writes, and the documented chunk bound lacked an
  explicit proxy/relay mechanism.

The repaired pass now binds exact finite playback failure, retains cumulative
native counters across teardown, supports explicit bootstrap recovery, exposes
participant controls only for participant sessions, fences browser identity
changes, uses the native tap attempt as permission authority, locates paused
Spotify by bundle identity, and paces one Host plus eight participant proxy
streams through the private relay. A per-attempt startup fence and transport
generation now reject both startup-order inversions and callbacks from retired
connections. Exact open replay is reconstructed from immutable creation
identity, and one this-device-only Keychain end intent is reconciled before any
later session read. Operation checks fence every awaited startup boundary.
Cause validation, locked counters, and explicit 16 KiB rechunking now match the
runtime contract. A recovery-current continuation cannot retain state after
stop, and terminal I/O cannot begin before its request identity is durable.
No P0, P1, or P2 remains open after remediation and narrow re-audit.

## GH #6 production ingest isolation remediation

**Invariant:** One authenticated, media-rate Host ingest remains isolated from
ordinary game and readiness traffic within the one-vCPU production boundary.

The first signed-Host production capture exposed a missing deployment-shaped
counterexample. The authenticated proxy ran the complete retained-database
validator once for every PCM chunk as well as on its fixed one-second authority
timer. Independently, the relay's successful ingest response is intentionally
header-only while the upload remains open, but standalone Next flushes route
response headers only after the first body write. Caddy therefore waited for
headers while Next continued forwarding and repeatedly validating PCM until
the web CPU saturated. The direct-route resource test bypassed both the Next
response writer and real SQLite validation, so it did not represent the
production boundary.

The first repair wrapped the relay body with one empty stream item. This
causes Next to flush headers without adding any HTTP body bytes or changing the
native protocol. Stream authority is validated once before forwarding and then
by a fixed timer; it is no longer coupled to PCM packet frequency. The later
GH #6/#7 liveness remediation below supersedes that timer's original one-second
cadence with the production-proven five-second bound.

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: the existing ingest claim authenticates and binds one connection before the private relay hop. |
| Update | `runtime`: activation and interruption remain the only retained stream-state mutations. |
| Delete | `not_applicable`: stream isolation deletes no retained state. |
| Omit | `runtime`: one empty response-stream item starts the HTTP response without wire bytes; the fixed authority timer continues while the stream is open and closes it on any failed check. |
| Duplicate | `structural`: one timer owns periodic authority checks; PCM delivery no longer duplicates the same complete validation per chunk. |
| Reorder | `runtime`: claim precedes relay setup, activation follows the exact relay response, and periodic authorization begins before body forwarding. |
| Replay | `not_applicable`: PCM is intentionally not replayed. |
| Conflict | `runtime`: the retained one-publisher and connection-generation checks are unchanged. |
| Concurrency | `runtime`: standalone-Next HTTP verification holds a native-rate publisher and Host listener open while mixed public-readiness, Host-readiness, and game-snapshot requests remain bounded and successful. |
| Expiry | `runtime`: application-session expiry and revocation remain bounded by the fixed authority recheck. |
| Restart | `structural`: the change retains no process-only authority decision; each new stream repeats claim and setup. |
| Dependency failure | `runtime`: relay, request, and authority failure still cancel the guarded stream and append the finite interruption. |
| Corruption | `runtime`: claim, activation, and every ordinary retained-data operation cross the canonical database validator; the later GH #6/#7 remediation assigns periodic open-stream checks to exact live authority rather than unrelated retained rows. |
| Capacity | `runtime`: packet frequency does not multiply authority validation while mixed ordinary probes remain below their 750 ms bound. |

The smallest relationship-preserving counterexample is one valid publisher
whose packet frequency grows while its identity, generation, format, and
authority remain unchanged. Packet frequency must affect media work only; it
must not multiply whole-database validation work.

## GH #6 and GH #7 production liveness remediation

**Invariant:** A valid media-rate Host session and any transient readiness
failure leave ordinary server traffic responsive and the native Host main
thread available; teardown retires exactly the current audio generation
without holding packet state across AVFoundation calls.

The production failure log joined the two independently useful boundaries.
The one-vCPU web process performed the complete canonical database validation
for both open stream directions every second, and an ordinary Host-readiness
request eventually received a proxy `502`. The native Host treated that
unconfirmed failure as proof that its active game had disappeared and stopped
the runtime. `RelayedAudioPlayer.stop()` held its packet-state lock while
`AVAudioPlayerNode.stop()` synchronously waited for a scheduled-buffer
completion that needed the same lock, permanently blocking the main thread.

The remediation keeps full canonical validation on every stream admission,
every accepted mutation, startup, and ordinary server readiness. Open streams
then check only their exact session, game, connection, and participant/Host
authority at a fixed five-second bound. Fan-out therefore cannot multiply
whole-database work. This remains a small, deterministic bound for expiry and
revocation while leaving unrelated retained-data corruption with the canonical
readiness owner. The single SQLite owner and post-mutation validation mean an
accepted operation cannot create an invalid state between those readiness
checks.
A failed readiness request becomes non-authoritative for runtime lifecycle and
preserves the last confirmed runtime. A successful readiness result can still
start, replace, or stop it. Native packet state is retired under one lock;
AVFoundation stop, disconnect, and detach execute only after that lock is
released, and late completions are rejected by generation.

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: only a successful readiness projection may create or replace the one game runtime; player start creates one new packet generation after prior hardware teardown. |
| Update | `runtime`: every stream is fully validated at admission and exact authority is rechecked every five seconds; packet completion updates only its retained generation. |
| Delete | `runtime`: only confirmed successful readiness, explicit shutdown, or game replacement tears down the runtime; teardown clears the complete current packet generation before hardware calls. |
| Omit | `runtime`: transport/server readiness failure preserves the last confirmed runtime and visible failure projection instead of silently converting unknown state to absence. |
| Duplicate | `structural`: one lifecycle lock serializes player start, append scheduling, and stop; one packet fence owns scheduled counts and generations. |
| Reorder | `structural`: packet retirement happens before hardware teardown, and replacement generation creation happens only after prior hardware teardown. |
| Replay | `runtime`: repeated stop is finite and idempotent; late or duplicate completion for a retired generation has no effect. |
| Conflict | `runtime`: a completion token from an old generation cannot decrement a replacement generation; successful readiness replacement is keyed by exact game ID. |
| Concurrency | `structural` + `runtime`: AVFoundation callbacks take only the packet fence and no AVFoundation call occurs while that fence is held; a scheduled completion racing stop therefore cannot form the observed lock cycle. |
| Expiry | `runtime`: Host/participant stream expiry and revocation are detected by each targeted check at admission or within five seconds, including equality. |
| Restart | `structural`: no player generation survives process loss; server stream admission repeats full retained-state validation after restart. |
| Dependency failure | `runtime`: relay/readiness timeout, malformed response, proxy failure, and response loss expose finite blocked UI while preserving an already confirmed runtime; explicit shutdown remains authoritative. |
| Corruption | `runtime`: stream admission, every accepted mutation, startup, and readiness invoke the one canonical database validator; periodic stream checks cannot authorize a different game/session/connection, and readiness fails closed for unrelated retained corruption. |
| Capacity | `runtime`: open streams add only one bounded targeted authority query set each per five seconds and never add periodic whole-database validation; packet scheduling remains fixed at 64 and `max-1`, `max`, and `max+1` are verified. |

The pre-remediation counterexample is a valid active stream whose ordinary
readiness request fails once while an AVAudio scheduled-buffer completion is
pending. It preserves game, session, generation, and network authority, yet
used to convert uncertainty into teardown and invert the packet/AVFoundation
lock order. The matrix-derived tests exercise that schedule directly.

## Named deferrals

- FR-7 owns the unified permission/readiness UI, production composition of the
  shared-audio playback gate, and sanitized diagnostic export.
- FR-8 owns Compose wiring, secret creation/mounts, deployment health, relay
  restart policy, and operational backup/rollback commands.
- FR-9 owns applying the purpose string and capture entitlement/permission
  contract to the signed production Xcode target.
- FR-10 owns deployed eight-participant-plus-Host load, Node/relay restart,
  network shaping, and audible proof that direct and relayed output are not
  heard twice.

## Closure evidence

Verified on 2026-08-21:

- `node --test --test-concurrency=1 release/tests/*.test.mjs`: 131 passed;
- `(cd web && npm test)`: production build plus 333 tests passed;
- `(cd web && npm run lint)`: passed;
- `(cd macos/CannaBeatsHostCore && swift run CannaBeatsHostAudioVerifier)`:
  75 checks passed;
- `(cd macos/CannaBeatsHostCore && swift run CannaBeatsHostPlaybackVerifier)`:
  20 checks passed;
- `(cd macos/CannaBeatsHostCore && swift run CannaBeatsHostCoreVerifier)`:
  6 checks passed; and
- `git diff --check`: passed.

The independent closure review initially found two P1 and three P2 groups.
After remediation, its affected-perspective re-audit and final two-residual
recheck report `P0=0`, `P1=0`, and `P2=0`. FR-7, FR-8, FR-9, and FR-10 retain
only the named deferrals above. This closure record is included in the FR-6
checkpoint commit.
