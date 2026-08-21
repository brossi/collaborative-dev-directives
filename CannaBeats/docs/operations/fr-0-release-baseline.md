# FR-0: Release baseline and evidence inventory

- **Status:** Locally verified; no open finding
- **Governing plan:** [CannaBeats first-release plan](../first-release-plan.md)
- **Governing invariant:** The new release can be developed and deployed without
  mutating the retained PoC checkpoint or relying on any destroyed rehearsal
  resource.

## Fixed release identifiers

| Item | Fixed value |
| --- | --- |
| Public origin | `https://play.cannabeats.social` |
| Runtime topology | `unified` |
| macOS bundle identifier | `social.cannabeats.host` |
| Apple Developer Team | `6Z9D2757FY` |
| Minimum macOS | `14.2` |
| Compose project | `cannabeats` |
| Release root | `/opt/cannabeats/releases` |
| Current release path | `/opt/cannabeats/current` |
| SQLite database | `/var/lib/cannabeats/cannabeats.sqlite3` |
| SQLite backups | `/var/backups/cannabeats/sqlite` |
| Server secrets | `/etc/cannabeats/secrets` |
| Internal relay origin | `http://relay:8080` |
| Active-game limit | `1` |
| Participant limit | `8` |
| Diagnostic retention | `7 days` |
| Local SQLite backup retention | `14 days` |

The machine-readable version is
[`release/config/production.env.example`](../../release/config/production.env.example).
The example contains identifiers, limits, paths, and secret **file paths** only.
It contains no credential value and must not be replaced with a populated
production file in Git.

Run the dependency-free, read-only preflight from the repository root:

```sh
node CannaBeats/release/scripts/preflight-config.mjs \
  --env-file CannaBeats/release/config/production.env.example
```

The validator accepts only the complete fixed contract. Missing, duplicate,
unknown, malformed, or changed values fail by finite code, variable name, and
optional line number. It never prints a supplied value, native read error, or
file content.

## Artifact disposition

No artifact is deleted in FR-0. `Retire` means it is excluded from the new
runtime and remains available as historical evidence until a later deliberate
cleanup checkpoint.

| Existing artifact | Disposition | Release use |
| --- | --- | --- |
| `web/lib/game.ts`, `web/lib/rules.ts`, and game contract tests | `reuse` | Shared rules and proven client/action semantics |
| `web/app/page.tsx` and shared browser presentation | `adapt` | Host web view and participant game journey |
| `web/public/pcm-player-worklet.js` and bounded audio tests | `reuse` | Browser relay playback |
| `web/data` and catalog build/status tests | `reuse` | One versioned server catalog artifact |
| State schema, store, invariant, history, and recovery modules/tests | `adapt` | Move proven behavior behind the single Node owner; do not preserve the HTTP service boundary |
| macOS `DeviceSigningKey.swift` | `reuse` | Production device identity and proof |
| macOS `AudioTapBridge` and `RelayAudioSession.swift` | `adapt` | Spotify-only tap, bounded real-time buffer, and authenticated Node audio routes |
| macOS build/notarization scripts | `adapt` | Production Xcode target and Developer ID DMG pipeline |
| Access PoC enrollment, web-ticket, redaction, backup, and release tests | `adapt` | Reuse finite behavior inside the consolidated server and new runbooks |
| Diagnostics collector quota/privacy tests | `adapt` | Bounded records in the main SQLite owner; no diagnostics process |
| `btaudio` pinned runtime and relay behavior | `reuse` | One private Compose relay slot |
| ADRs, closure matrices, rehearsal records, and sanitized evidence | `reference-only` | Counterexamples and acceptance evidence; never runtime dependencies |
| Standalone Access service and database | `retire` | Replaced by the single Node owner and clean schema |
| Standalone State HTTP service and database | `retire` | Its invariants are ported; its process boundary is not |
| Standalone diagnostics service and volume | `retire` | Replaced by bounded rows in the main database |
| Managed Linux Spotify source, controller, VNC, and Tailscale ceremony | `retire` | Replaced by the installed Mac Spotify application |
| Tauri desktop player | `retire` | Replaced by the unified SwiftUI Host and browser participants |
| Native iOS game application | `reference-only` | Catalog/rule evidence only; it is not a first-release client |
| PoC Compose files, Caddyfile, hostnames, and destroyed Droplet identifiers | `reference-only` | May inform tests, but no release command or configuration may address them |

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: `validateReleaseConfig` accepts only the complete fixed release identity before later creation work can use it. FR-0 itself creates no external resource. |
| Update | `runtime`: any changed fixed value fails by variable name; changing the contract requires an explicit reviewed source/test/document update. |
| Delete | `not_applicable`: FR-0 deletes no artifact, state, credential, or external resource. |
| Omit | `runtime`: `validateReleaseConfig` enumerates every required variable and returns `missing` for absence or an empty value. |
| Duplicate | `runtime`: `parseReleaseConfig` rejects a second occurrence of a known variable before validation. |
| Reorder | `structural`: configuration is parsed into a name-keyed map and has no ordering semantics. |
| Replay | `structural`: preflight is read-only and deterministic for identical bytes. |
| Conflict | `runtime`: fixed production values must exactly match `RELEASE_CONFIG`; stale PoC and alternate release identifiers are rejected. |
| Concurrency | `not_applicable`: preflight reads one immutable input and performs no shared mutation. |
| Expiry | `not_applicable`: FR-0 creates no expiring identity, session, or invitation. |
| Restart | `structural`: every invocation reconstructs validation solely from the committed contract and supplied file; no process memory is authoritative. |
| Dependency failure | `runtime`: invalid invocation and unreadable input return `invalid_arguments` or `unreadable` without native error or path disclosure. |
| Corruption | `runtime`: malformed, unknown, duplicate, omitted, or altered entries fail closed and no partial configuration is emitted. |
| Capacity | `runtime`: the active-game, participant, diagnostic-retention, and backup-retention bounds are mandatory fixed values. |

## Matrix-derived verification

The focused tests must prove:

- the committed example enumerates the complete contract;
- omission, duplication, unknown variables, malformed input, and changed values
  fail with finite sanitized issues;
- invalid input values never appear in process output;
- unreadable input and invalid invocation do not expose native errors;
- release identities contain no PoC hostname, S2-F name, or destroyed rehearsal
  locator; and
- active-game and participant capacity remain fixed at one and eight.

Commands:

```sh
node --test CannaBeats/release/tests/preflight-config.test.mjs
node CannaBeats/release/scripts/preflight-config.mjs \
  --env-file CannaBeats/release/config/production.env.example
git diff --check
```

## Local counterexample pass

Ask: what is the smallest configuration mutation that preserves every checked
relationship but could still direct release work at the PoC or an unintended
resource?

The answer for FR-0 is an altered value under a valid required name. The
preflight therefore validates exact values, not merely key presence or value
shape. It also rejects unknown legacy keys so a stale PoC hostname cannot sit
beside an otherwise valid production contract and be consumed accidentally.

## Deferrals

- FR-1 owns the clean SQLite schema and consolidated Node runtime.
- FR-8 owns secret generation, file permission checks, Compose rendering,
  deployment, backup/restore, and rollback. FR-0 records their fixed paths only.
- FR-9 owns the production Xcode target and verifies that its signed bundle
  embeds the identifiers and entitlements recorded here.
- FR-10 proves that the real hostname and resources match this contract.

## Checkpoint handoff — 2026-08-21

- **Invariant:** Satisfied locally. The release configuration is inert,
  deterministic, and contains no PoC or destroyed-resource locator.
- **Matrix dimensions:** All fourteen dimensions were classified above. The
  executable enforcement added in FR-0 covers create/configuration admission,
  update, omit, duplicate, conflict, dependency failure, corruption, and
  capacity; the remaining dimensions are structural or not applicable.
- **Enforcement:** `RELEASE_CONFIG`, `parseReleaseConfig`, and
  `validateReleaseConfig` are the single configuration authority. The CLI adds
  only sanitized finite rendering.
- **Verification:** `node --test
  CannaBeats/release/tests/preflight-config.test.mjs` passed 6/6;
  `node CannaBeats/release/scripts/preflight-config.mjs --env-file
  CannaBeats/release/config/production.env.example` returned
  `release_configuration_valid (19 variables)`; `git diff --check` passed.
- **Counterexample pass:** Altered values under valid names, stale unknown PoC
  keys, malicious value text, unreadable input, and symbolic indirection were
  checked. Exact-value validation rejects the first two, output redaction covers
  the next two, and the committed release tree contains no symbolic links.
- **Findings:** No open P0, P1, or P2.
- **Deferrals:** Clean schema/runtime to FR-1; secret files and deployment to
  FR-8; signed bundle verification to FR-9; real-resource proof to FR-10.
