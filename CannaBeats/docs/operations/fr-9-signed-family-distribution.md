# FR-9 signed family distribution

**Status:** Local implementation and independent review are closed with no open
P0/P1/P2. The real Developer ID/notarization artifact and interactive install
evidence remain.

## Governing invariant

Every distributed Host artifact is one reproducible, Developer-ID-signed and
notarized macOS application whose declared identity and capabilities match its
runtime, whose upgrade preserves Keychain authority, and whose verification
fails closed if any signed or stapled component differs.

The release remains a manually delivered DMG for a small family game. It does
not add an updater, installer package, download service, privileged helper, or
third-party audio driver.

## Closure matrix

| Dimension | Disposition |
| --- | --- |
| Create | `runtime`: one release command captures a clean commit, builds from a detached worktree of that commit, embeds its revision in the signed app, and creates an archive and versioned DMG only in a new empty staging directory after validating the semantic version, positive build number, exact Developer ID identity, and fixed project/scheme. |
| Update | `structural`: upgrade is replacement of the same `social.cannabeats.host` application bundle; device authority remains in the same this-device-only Keychain labels and is not stored in the app bundle. |
| Delete | `structural`: the release pipeline deletes only its own newly created temporary directories through a bounded trap. Application uninstall and device revocation are explicit family actions; neither is performed by the DMG. |
| Omit | `runtime`: release verification requires the app; exact Contents and executable domains; exact Info.plist identity/version/source/usage keys and privacy-key domain; exact entitlements; two architectures; Developer ID signature; hardened runtime; notarization ticket; Gatekeeper acceptance; DMG signature; and checksum. |
| Duplicate | `runtime`: an existing output for the same version/build fails before archive or DMG mutation; release filenames bind version and build. |
| Reorder | `runtime`: archive and sign app, validate app, create and sign DMG, submit, require accepted notarization, staple, validate, assess, then publish checksum is the only release order. |
| Replay | `runtime`: verification is read-only and deterministic; release creation refuses an already retained output rather than replacing evidence. |
| Conflict | `runtime`: caller version/build, retained plist values, bundle ID, team identity, executable name, entitlements, architectures, and checksum must agree before an artifact is accepted. |
| Concurrency | `runtime`: an exclusive release lock spans archive through checksum publication; a second release attempt returns a finite busy result without entering Xcode or notarization. |
| Expiry | `not_applicable`: the DMG has no application-defined elapsed-time expiry. Apple certificate, notarization, and revocation validity are evaluated by the platform at verification and launch. |
| Restart | `runtime`: a process loss leaves no accepted checksum; a later run refuses the retained partial output for inspection or explicit operator removal instead of treating it as a completed release. Keychain authority is outside the replaceable bundle. |
| Dependency failure | `runtime`: Xcode, signing identity, notary authentication/submission, stapling, Gatekeeper, mounting, or checksum failure stops before accepted release publication and emits one finite stage code without credential material. |
| Corruption | `runtime`: the shared verifier mounts the retained DMG read-only and revalidates its app, signature, hardened flags, entitlements, metadata, architectures, notarization, Gatekeeper result, and checksum without trusting the filename. |
| Capacity | `runtime`: one application, one Applications link, one DMG, one checksum, bounded version/build strings, and an explicit free-space preflight keep the family release finite. |

## Enforcement plan

- `macos/CannaBeatsHost.xcodeproj` owns the production macOS application target
  and links only the local `CannaBeatsHostCore` Swift package product.
- `macos/CannaBeatsHostCore/ReleaseResources` owns the exact bundle metadata and
  entitlements. The target enables Hardened Runtime and contains no runtime
  exception entitlement other than Apple Events resource access.
- `macos/release` owns the bounded build, notarize, verify, checksum, and manual
  family-install boundary. Credentials remain in Keychain and are named only by
  a profile argument.
- Matrix-derived tests must exercise omitted metadata, conflicting identity,
  wrong architecture, reordered publication, held lock, existing output,
  malformed version/build input, and verification of a mutated artifact.

Apple requires a Developer ID application signature, Hardened Runtime, secure
timestamp, valid entitlements, and notarization for this direct-distribution
path. Apple Events and system-audio usage are declared because the Host controls
Spotify and captures only Spotify's process audio through the native Core Audio
tap.

## Implementation and local evidence

- `macos/CannaBeatsHost.xcodeproj` is a dedicated macOS application project. It
  links the local `CannaBeatsHostCore` product and contains no reference to the
  retired iOS target or Spotify iOS framework. Its unsigned Release build
  produces one `social.cannabeats.host` app with `arm64` and `x86_64` slices.
- `release-host.sh` captures one clean commit, installs cleanup immediately
  after acquiring the lock, builds only from a detached worktree of that
  commit, and embeds its revision in the signed plist. It also validates the
  exact Developer ID team identity, bounded version/build/profile, output
  nonexistence, and free space. It contains Xcode/notary output, emits only
  finite stage codes, publishes checksum last, and never reads credentials.
- `verify-host-release.sh` is the shared read-only acceptance boundary. It
  rechecks the DMG checksum before and after validation, signatures, ticket,
  Gatekeeper results, read-only mounted domain, exact Contents/executable and
  privacy-key domains, app metadata including embedded source revision, exact
  entitlement key domain, hardened-runtime flag, team identity, and both
  architectures.
- [Family install instructions](../family-host-install.md) cover checksum,
  install, upgrade, consent, Keychain persistence, revocation, and exact stale
  release-lock/partial-output recovery.

Local verification:

- `node --test --test-concurrency=1 release/tests/macos-distribution.test.mjs`
  — 18/18 passed after final audit remediation;
- `node --test --test-concurrency=1 release/tests/*.test.mjs` — 251/251 passed
  after the main audit remediation; the final added PID-failure test then passed
  in the 18-test focused suite;
- `swift build --package-path macos/CannaBeatsHostCore` — passed;
- unsigned universal production-target build with Xcode 26.6 and explicit
  `CODE_SIGNING_ALLOWED=NO` — passed, with `x86_64 arm64` executable slices;
- `bash -n macos/release/*.sh`, plist/XML validation, and `git diff --check` —
  passed.

The local adversarial pass found and remediated three counterexamples: an
additional entitlement could survive verification; Xcode/notary failure could
emit lower-layer detail; and the DMG could change after its first checksum but
before mounted-app verification completed. Xcode also exposed a name collision
between the application scheme and package executable scheme. Exact
entitlement-domain comparison, contained dependency logs, a final checksum
comparison, and the unique `CannaBeatsHostRelease` scheme now close those
schedules. No local P0/P1 is open.

The first real signing attempt reached macOS `SecurityAgent` while using the
installed Developer ID Application private key. It was intentionally cancelled
without entering or automating user credentials. After local review closes, the
operator must authorize that private-key use and the Keychain-backed notary
profile must authenticate before FR-9 can claim a distributable artifact.
The default profile name `cannabeats-notary` did not authenticate during the
read-only preflight, so the actual retained profile name or a one-time profile
setup is also required; Keychain contents were not enumerated.

## Initial independent review

The initial review reported P0=0, P1=3, and P2=2. Its P1 groups were source
revision sampled after a mutable build, incomplete executable/capability-domain
verification, and non-finite Git/temp/signature failures with a possible stale
lock. The P2 groups were overly structural mutation evidence and documentation
that attributed Keychain continuity to bundle ID alone.

All five groups are remediated locally. The detached worktree and signed plist
field bind the build to its pre-build clean commit. The verifier enumerates the
top-level bundle and executable domains, package/executable identity, exact
privacy usage-key domain, and source evidence. Git, temp, signature inspection,
and publication failures now map to finite codes; cleanup is installed before
fallible staging. Command-stubbed tests traverse accepted verification, then
reject recomputed-checksum privacy expansion, a second executable, an extra
entitlement, and source mismatch; they also prove staging cleanup and partial
publication without a checksum acceptance marker. Upgrade documentation now
names the Developer ID team/designated requirement and keeps real upgrade proof
pending. A narrow affected-perspective re-audit was then performed.

The affected-perspective re-audit reported P0=0, P1=0, and P2=1. It confirmed
all five original groups closed and found only that a failed PID write could
leave its empty file and prevent lock-directory cleanup. The failure branch now
removes any partial PID file before the directory, and its forced-failure test
proves the next acquisition succeeds. A final review of that single P2 was
then performed.

The final one-perspective review reported P0=0, P1=0, and P2=0. Its targeted
PID-publication test passed 1/1, and shell syntax and diff checks passed. Local
FR-9 is therefore closed; only the explicitly unclaimed real signing,
notarization, install/upgrade, consent, revocation, and Spotify evidence remains.

## Named external evidence

FR-9 owns production signing, notarization, stapling, and local Gatekeeper
verification. A clean second-Mac install, first Automation/system-audio consent,
upgrade-in-place Keychain preservation, uninstall/reinstall, revocation, and
real Spotify playback/readback are interactive evidence. They will be recorded
here when run; FR-10 may reuse the same signed artifact but cannot substitute an
unsigned or differently identified build.
