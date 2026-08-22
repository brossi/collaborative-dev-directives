import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test, { afterEach } from 'node:test';

const repo = resolve(import.meta.dirname, '../..');
const releaseRoot = join(repo, 'macos/release');
const library = join(releaseRoot, 'release-lib.sh');
const releaseScript = join(releaseRoot, 'release-host.sh');
const verifyScript = join(releaseRoot, 'verify-host-release.sh');
const temporary = [];

afterEach(() => {
  while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true });
});

function temp() {
  const path = mkdtempSync(join(tmpdir(), 'cannabeats-fr9-test-'));
  temporary.push(path);
  return path;
}

function runScript(path, args, env = {}) {
  return spawnSync(path, args, {
    cwd: repo, encoding: 'utf8', env: { ...process.env, ...env },
  });
}

function runLibrary(command, env = {}) {
  return spawnSync('/bin/bash', ['-c', `source "$LIBRARY"; ${command}`], {
    encoding: 'utf8', env: { ...process.env, LIBRARY: library, ...env },
  });
}

const fixtureIdentity = 'Developer ID Application: Family (6Z9D2757FY)';

function executable(path, body) {
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

function verifierFixture() {
  const directory = temp();
  const bin = join(directory, 'bin');
  const scratch = join(directory, 'scratch');
  const app = join(directory, 'fixture', 'CannaBeats Host.app');
  const contents = join(app, 'Contents');
  const macos = join(contents, 'MacOS');
  const signature = join(contents, '_CodeSignature');
  mkdirSync(bin, { recursive: true });
  mkdirSync(scratch);
  mkdirSync(macos, { recursive: true });
  mkdirSync(signature);
  writeFileSync(join(macos, 'CannaBeats Host'), 'universal executable');
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????');
  writeFileSync(join(signature, 'CodeResources'), 'signed domain');
  const revision = 'a'.repeat(40);
  const info = {
    CFBundleDisplayName: 'CannaBeats Host', CFBundleExecutable: 'CannaBeats Host',
    CFBundleIdentifier: 'social.cannabeats.host', CFBundleName: 'CannaBeats Host',
    CFBundlePackageType: 'APPL', CFBundleShortVersionString: '1.0.0', CFBundleVersion: '1',
    CannaBeatsSourceRevision: revision, LSMinimumSystemVersion: '14.2',
    NSAppleEventsUsageDescription: 'Control Spotify for the private family game.',
    NSAudioCaptureUsageDescription: 'Capture Spotify audio for admitted family players.',
  };
  const infoPath = join(contents, 'Info.plist');
  const entitlementPath = join(directory, 'entitlements.plist');
  const writePlist = (path, value) => {
    writeFileSync(path, JSON.stringify(value));
    execFileSync('plutil', ['-convert', 'xml1', path]);
  };
  writePlist(infoPath, info);
  const entitlements = {
    'com.apple.security.automation.apple-events': true,
    'com.apple.security.network.client': true,
  };
  writePlist(entitlementPath, entitlements);
  const dmg = join(directory, 'CannaBeats-Host-1.0.0-1-universal.dmg');
  const checksum = `${dmg}.sha256`;
  const revisionPath = join(directory, 'source-revision.txt');
  writeFileSync(dmg, 'notarized fixture bytes');
  writeFileSync(revisionPath, `${revision}\n`);
  const refreshChecksum = () => {
    const hash = execFileSync('shasum', ['-a', '256', dmg], { encoding: 'utf8' }).split(' ')[0];
    writeFileSync(checksum, `${hash}  ${basename(dmg)}\n`);
  };
  refreshChecksum();
  executable(join(bin, 'codesign'), `
if [[ "$*" == *"--verbose=4"* ]]; then
  printf '%s\\n' 'Authority=${fixtureIdentity}' 'TeamIdentifier=6Z9D2757FY' 'flags=0x10000(runtime)' >&2
elif [[ "$*" == *"--entitlements"* ]]; then
  /bin/cat "$STUB_ENTITLEMENTS"
fi`);
  executable(join(bin, 'xcrun'), 'exit 0');
  executable(join(bin, 'spctl'), 'exit 0');
  executable(join(bin, 'lipo'), "printf '%s\\n' 'x86_64 arm64'");
  executable(join(bin, 'hdiutil'), `
case "$1" in
  verify) exit 0 ;;
  attach)
    previous=''
    for argument in "$@"; do
      if [[ "$previous" == '-mountpoint' ]]; then mount="$argument"; break; fi
      previous="$argument"
    done
    /bin/cp -R "$STUB_APP" "$mount/CannaBeats Host.app"
    /bin/ln -s /Applications "$mount/Applications"
    ;;
  detach)
    /bin/rm -rf "$2/CannaBeats Host.app" "$2/Applications"
    ;;
esac`);
  const env = {
    PATH: `${bin}:${process.env.PATH}`, STUB_APP: app, STUB_ENTITLEMENTS: entitlementPath,
    TMPDIR: scratch,
  };
  const run = () => runScript(
    verifyScript, [dmg, checksum, revisionPath, '1.0.0', '1', fixtureIdentity], env,
  );
  return {
    app, contents, dmg, entitlementPath, entitlements, info, infoPath, macos, refreshChecksum,
    revisionPath, run, scratch, writePlist,
  };
}

test('production Xcode target has one macOS app identity and only the local Host core product', () => {
  const project = readFileSync(join(repo, 'macos/CannaBeatsHost.xcodeproj/project.pbxproj'), 'utf8');
  assert.match(project, /productType = "com\.apple\.product-type\.application";/u);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = social\.cannabeats\.host;/u);
  assert.match(project, /MACOSX_DEPLOYMENT_TARGET = 14\.2;/u);
  assert.match(project, /ARCHS = "arm64 x86_64";/u);
  assert.match(project, /ENABLE_HARDENED_RUNTIME = YES;/u);
  assert.match(project, /relativePath = CannaBeatsHostCore;/u);
  assert.match(project, /productName = CannaBeatsHostCore;/u);
  assert.doesNotMatch(project, /SpotifyiOS|social\.cannabeats\.app/u);
  assert.match(readFileSync(releaseScript, 'utf8'), /-scheme CannaBeatsHostRelease/u);
});

test('release metadata declares exact privacy, version, and capability boundary', () => {
  const infoPath = join(
    repo, 'macos/CannaBeatsHostCore/ReleaseResources/CannaBeatsHost-Info.plist',
  );
  const entitlementsPath = join(
    repo, 'macos/CannaBeatsHostCore/ReleaseResources/CannaBeatsHost.entitlements',
  );
  const info = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', infoPath]));
  const entitlements = JSON.parse(execFileSync(
    'plutil', ['-convert', 'json', '-o', '-', entitlementsPath],
  ));
  assert.deepEqual({
    bundle: info.CFBundleIdentifier,
    executable: info.CFBundleExecutable,
    version: info.CFBundleShortVersionString,
    build: info.CFBundleVersion,
    revision: info.CannaBeatsSourceRevision,
    minimum: info.LSMinimumSystemVersion,
  }, {
    bundle: 'social.cannabeats.host', executable: '$(EXECUTABLE_NAME)',
    version: '$(MARKETING_VERSION)', build: '$(CURRENT_PROJECT_VERSION)',
    revision: '$(CANNABEATS_SOURCE_REVISION)', minimum: '14.2',
  });
  assert.ok(info.NSAppleEventsUsageDescription.length > 20);
  assert.ok(info.NSAudioCaptureUsageDescription.length > 20);
  assert.deepEqual(entitlements, {
    'com.apple.security.automation.apple-events': true,
    'com.apple.security.network.client': true,
  });
});

test('version and build bounds reject omission and malformed or expanded input', () => {
  for (const args of [[], ['1.0'], ['01.0.0', '1'], ['1.0.0', '0'], ['1.0.0', '1000000000']]) {
    const result = runScript(releaseScript, args, {
      CANNABEATS_CODESIGN_IDENTITY: 'Developer ID Application: Family (6Z9D2757FY)',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^fr9_(invalid_arguments|invalid_version|invalid_build)\n$/u);
  }
  const accepted = runLibrary(
    'fr9_validate_version "$VALUE"; fr9_validate_build "$BUILD"; printf accepted',
    { VALUE: '999.999.999', BUILD: '999999999' },
  );
  assert.equal(accepted.status, 0);
  assert.equal(accepted.stdout, 'accepted');
});

test('release identity accepts only the bounded Developer ID Application team', () => {
  for (const identity of [
    '', 'Apple Development: Family (6Z9D2757FY)',
    'Developer ID Application: Family (WRONGTEAM)',
    `Developer ID Application: Family (6Z9D2757FY)\nexpanded`,
  ]) {
    const result = runLibrary('fr9_validate_identity "$IDENTITY"', { IDENTITY: identity });
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'fr9_invalid_identity\n');
  }
});

test('release lock admits one owner and rejects a duplicate without entering work', () => {
  const directory = temp();
  const lock = join(directory, 'release.lock');
  const first = runLibrary('fr9_acquire_lock "$LOCK"', { LOCK: lock });
  assert.equal(first.status, 0);
  const second = runLibrary('fr9_acquire_lock "$LOCK"; printf entered', { LOCK: lock });
  assert.equal(second.status, 2);
  assert.equal(second.stdout, '');
  assert.equal(second.stderr, 'fr9_release_busy\n');
});

test('failed PID publication removes every unowned lock artifact', () => {
  const directory = temp();
  const lock = join(directory, 'release.lock');
  const failed = runLibrary(
    'fr9_write_pid() { : >"$1"; return 1; }; fr9_acquire_lock "$LOCK"',
    { LOCK: lock },
  );
  assert.equal(failed.status, 2);
  assert.equal(failed.stderr, 'fr9_lock_unavailable\n');
  assert.equal(runLibrary('[[ ! -e "$LOCK" ]]', { LOCK: lock }).status, 0);
  assert.equal(runLibrary('fr9_acquire_lock "$LOCK"', { LOCK: lock }).status, 0);
});

test('clean-source validator rejects an untracked mutation before release dependencies', () => {
  const directory = temp();
  execFileSync('git', ['init', '-q', directory]);
  assert.equal(runLibrary('fr9_require_clean_source "$REPO"', { REPO: directory }).status, 0);
  writeFileSync(join(directory, 'mutation'), 'changed');
  const dirty = runLibrary('fr9_require_clean_source "$REPO"; printf entered', {
    REPO: directory,
  });
  assert.equal(dirty.status, 2);
  assert.equal(dirty.stdout, '');
  assert.equal(dirty.stderr, 'fr9_source_dirty\n');
  const absent = runLibrary('fr9_require_clean_source "$REPO"; printf entered', {
    REPO: join(directory, 'not-a-repository'),
  });
  assert.equal(absent.status, 2);
  assert.equal(absent.stdout, '');
  assert.equal(absent.stderr, 'fr9_source_unavailable\n');
});

test('checksum and artifact identity conflict before signature or mount evaluation', () => {
  const directory = temp();
  const name = 'CannaBeats-Host-1.0.0-1-universal.dmg';
  const dmg = join(directory, name);
  const checksum = `${dmg}.sha256`;
  const revision = join(directory, 'source-revision.txt');
  writeFileSync(dmg, 'not a disk image');
  writeFileSync(checksum, `${'0'.repeat(64)}  ${basename(dmg)}\n`);
  writeFileSync(revision, `${'a'.repeat(40)}\n`);
  const result = runScript(verifyScript, [
    dmg, checksum, revision, '1.0.0', '1',
    'Developer ID Application: Family (6Z9D2757FY)',
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'fr9_checksum_conflict\n');
});

test('release publication order is archive sign notarize staple verify checksum evidence', () => {
  const script = readFileSync(releaseScript, 'utf8');
  const stages = [
    'source-revision.txt', 'xcodebuild archive', 'codesign --verify --deep', 'hdiutil create',
    'codesign --force --sign', 'notarytool submit', 'stapler staple',
    'shasum -a 256', 'verify-host-release.sh', 'fr9_publish_release',
  ];
  let previous = -1;
  for (const stage of stages) {
    const current = script.indexOf(stage);
    assert.ok(current > previous, `${stage} must follow its predecessor`);
    previous = current;
  }
  assert.match(script, /\[\[ ! -e "\$final_dir" \]\] \|\| fr9_fail output_conflict/u);
});

test('read-only verifier enumerates every accepted artifact relationship', () => {
  const script = readFileSync(verifyScript, 'utf8');
  for (const required of [
    'checksum_conflict', 'codesign --verify --strict', 'stapler validate',
    'spctl --assess --type open', 'hdiutil verify', 'hdiutil attach -nobrowse -readonly',
    'dmg_domain_invalid', 'codesign --verify --deep --strict',
    'flags=0x10000(runtime)', 'CFBundleIdentifier', 'CFBundleShortVersionString',
    'CFBundleVersion', 'LSMinimumSystemVersion', 'NSAppleEventsUsageDescription',
    'NSAudioCaptureUsageDescription', 'lipo -archs',
    'com.apple.security.automation.apple-events', 'com.apple.security.network.client',
    'entitlement_keys', 'CannaBeatsSourceRevision', 'CFBundleExecutable',
    'CFBundlePackageType', 'privacy_keys', 'contents_entries', 'executable_entries',
  ]) assert.ok(script.includes(required), `missing verifier relationship: ${required}`);
});

test('dependency output is contained behind finite release stage codes', () => {
  const script = readFileSync(releaseScript, 'utf8');
  assert.match(script, /archive\.log" 2>&1/u);
  assert.match(script, /notary\.log"/u);
  assert.match(script, /fr9_fail archive_failed/u);
  assert.match(script, /fr9_fail notarization_failed/u);
});

test('checksum is published only after notarization and source evidence', () => {
  const publication = readFileSync(library, 'utf8').slice(
    readFileSync(library, 'utf8').indexOf('fr9_publish_release'),
  );
  assert.ok(publication.indexOf('notary-result.json') < publication.indexOf('.sha256'));
  assert.ok(publication.indexOf('source-revision.txt') < publication.indexOf('.sha256'));
});

test('release builds a detached clean commit and verifies its signed revision', () => {
  const script = readFileSync(releaseScript, 'utf8');
  const stages = [
    "rev-parse --verify 'HEAD^{commit}'", 'worktree add --detach',
    'source-revision.txt', 'CANNABEATS_SOURCE_REVISION="$source_revision"',
    'verify-host-release.sh',
  ];
  let previous = -1;
  for (const stage of stages) {
    const current = script.indexOf(stage);
    assert.ok(current > previous, `${stage} must follow its predecessor`);
    previous = current;
  }
  assert.match(script, /project "\$source_path\/macos\/CannaBeatsHost\.xcodeproj"/u);
});

test('lock cleanup is installed before fallible staging and source snapshot work', () => {
  const script = readFileSync(releaseScript, 'utf8');
  assert.ok(script.indexOf('trap cleanup EXIT') < script.indexOf('mktemp -d'));
  assert.ok(script.indexOf('trap cleanup EXIT') < script.indexOf('worktree add --detach'));
  assert.match(script, /if \[\[ "\$source_attached" == true \]\]/u);
});

test('stubbed accepted artifact traverses the complete read-only verifier and cleans staging', () => {
  const fixture = verifierFixture();
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'fr9_release_verified 1.0.0 1\n');
  assert.deepEqual(readdirSync(fixture.scratch), []);
});

test('relationship-preserving executable privacy and entitlement expansion fail closed', () => {
  const privacy = verifierFixture();
  privacy.info.NSMicrophoneUsageDescription = 'Expanded microphone access';
  privacy.writePlist(privacy.infoPath, privacy.info);
  writeFileSync(privacy.dmg, 'mutated then checksummed notarized fixture');
  privacy.refreshChecksum();
  assert.equal(privacy.run().stderr, 'fr9_privacy_domain_invalid\n');
  assert.deepEqual(readdirSync(privacy.scratch), []);

  const executableDomain = verifierFixture();
  writeFileSync(join(executableDomain.macos, 'UnexpectedHelper'), 'signed helper');
  assert.equal(executableDomain.run().stderr, 'fr9_executable_domain_invalid\n');

  const entitlementDomain = verifierFixture();
  entitlementDomain.entitlements['com.apple.security.device.microphone'] = true;
  entitlementDomain.writePlist(
    entitlementDomain.entitlementPath, entitlementDomain.entitlements,
  );
  assert.equal(entitlementDomain.run().stderr, 'fr9_entitlements_conflict\n');
});

test('signed bundle source revision must equal the retained clean-commit evidence', () => {
  const fixture = verifierFixture();
  writeFileSync(fixture.revisionPath, `${'b'.repeat(40)}\n`);
  assert.equal(fixture.run().stderr, 'fr9_source_identity_conflict\n');
  assert.deepEqual(readdirSync(fixture.scratch), []);
});

test('partial publication retains evidence without publishing the checksum marker', () => {
  const directory = temp();
  const final = join(directory, 'release');
  const dmg = join(directory, 'artifact.dmg');
  const checksum = join(directory, 'artifact.dmg.sha256');
  const source = join(directory, 'source-revision.txt');
  writeFileSync(dmg, 'artifact');
  writeFileSync(checksum, 'checksum');
  writeFileSync(source, `${'a'.repeat(40)}\n`);
  const result = runLibrary(
    'fr9_publish_release "$FINAL" "$DMG" "$CHECKSUM" "$MISSING" "$SOURCE" artifact.dmg',
    { FINAL: final, DMG: dmg, CHECKSUM: checksum, MISSING: join(directory, 'missing'), SOURCE: source },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'fr9_publication_failed\n');
  assert.deepEqual(readdirSync(final), ['artifact.dmg']);
  const retry = runLibrary(
    'fr9_publish_release "$FINAL" "$DMG" "$CHECKSUM" "$MISSING" "$SOURCE" artifact.dmg',
    { FINAL: final, DMG: dmg, CHECKSUM: checksum, MISSING: join(directory, 'missing'), SOURCE: source },
  );
  assert.equal(retry.stderr, 'fr9_output_conflict\n');
});
