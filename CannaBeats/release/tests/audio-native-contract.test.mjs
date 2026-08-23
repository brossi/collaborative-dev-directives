import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const bridge = readFileSync(new URL(
  '../../macos/CannaBeatsHostCore/Sources/AudioTapBridge/AudioTapBridge.m',
  import.meta.url,
), 'utf8');
const permission = readFileSync(new URL(
  '../../macos/CannaBeatsHostCore/Sources/CannaBeatsHostCore/AudioCapturePermission.swift',
  import.meta.url,
), 'utf8');
const host = readFileSync(new URL(
  '../../macos/CannaBeatsHostCore/Sources/CannaBeatsHost/main.swift',
  import.meta.url,
), 'utf8');
const info = readFileSync(new URL(
  '../../macos/CannaBeatsHostCore/ReleaseResources/CannaBeatsHost-Info.plist',
  import.meta.url,
), 'utf8');

test('native capture is a private muted Spotify tap without a virtual driver or broader permission', () => {
  assert.match(bridge, /@"com\.spotify\.client"/u);
  assert.match(bridge, /description\.privateTap = YES/u);
  assert.match(bridge, /description\.muteBehavior = CATapMutedWhenTapped/u);
  assert.doesNotMatch(bridge,
    /if \(!CBReadUInt32Property\([^\n]+kAudioProcessPropertyIsRunningOutput\)\) continue/u);
  assert.doesNotMatch(`${bridge}\n${permission}`, /BlackHole|CGPreflight|CGRequest/u);
  assert.match(info, /<key>NSAudioCaptureUsageDescription<\/key>/u);
});

test('real-time capture writes only the preallocated ring and signals a non-real-time drain', () => {
  assert.match(bridge, /static const uint32_t CBCaptureSlotCount = 64;/u);
  assert.match(bridge, /static const uint32_t CBCaptureMaximumFrames = 4096;/u);
  const enqueue = bridge.match(
    /- \(BOOL\)enqueueAudioBufferList:[\s\S]+?\n\}(?=\n\n- \(NSData \*\)dequeuePacket)/u,
  )?.[0];
  assert.ok(enqueue);
  assert.doesNotMatch(enqueue, /\b(?:alloc|calloc|malloc|realloc)\b|NSData|dispatch_sync/u);
  const callback = bridge.match(
    /static OSStatus CBAudioTapIOProc[\s\S]+?\n\}\n\n@implementation CBAudioTap/u,
  )?.[0];
  assert.ok(callback);
  assert.doesNotMatch(callback, /\b(?:alloc|calloc|malloc|realloc)\b|NSData|dispatch_sync/u);
  assert.match(bridge, /dispatch_source_merge_data\(_drainSource, 1\)/u);
});

test('initial readiness requests only the bounded local Core Audio permission probe', () => {
  assert.match(host, /await refresh\(requestAudioCapture: true\)/u);
  assert.match(host,
    /if spotifyState == \.running, case \.success = readback, audioCapture != \.ready/u);
  const refresh = host.match(
    /func refresh\(requestAudioCapture:[\s\S]+?\n    \}\n\n    private func requestCapturePermissionIfEligible/u,
  )?.[0];
  assert.ok(refresh);
  assert.ok(refresh.indexOf('requestCapturePermissionIfEligible()')
    < refresh.indexOf('client.hostReadiness()'));
  assert.match(host, /await capturePermission\.requestReadiness\(\)/u);
  assert.match(permission, /let capture = SpotifyProcessCapture\(\)/u);
  assert.match(permission, /try capture\.stopChecked\(\)/u);
  assert.match(permission, /retainedCapture = capture/u);
  assert.match(bridge, /- \(BOOL\)stopAndReturnError:/u);
  assert.match(bridge, /BOOL stopped = !_ioProcID && _aggregateID == kAudioObjectUnknown/u);
  assert.doesNotMatch(permission, /AudioSessionClient|AuthenticatedAudioIngest|gameID/u);
});
