import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageText = readFileSync('macos/CannaBeatsHostCore/Package.swift', 'utf8');
const app = readFileSync('macos/CannaBeatsHostCore/Sources/CannaBeatsHost/main.swift', 'utf8');
const runtime = readFileSync(
  'macos/CannaBeatsHostCore/Sources/CannaBeatsHostCore/HostGameRuntimeOwner.swift', 'utf8',
);

test('the Host executable owns one ephemeral fixed-origin web surface', () => {
  assert.match(packageText,
    /\.executableTarget\(name: "CannaBeatsHost", dependencies: \["CannaBeatsHostCore"\]\)/u);
  assert.equal((app.match(/WindowGroup\(/gu) ?? []).length, 1);
  assert.match(app, /CommandGroup\(replacing: \.newItem\)/u);
  assert.equal((app.match(/WKWebView\(/gu) ?? []).length, 1);
  assert.match(app, /websiteDataStore = \.nonPersistent\(\)/u);
  assert.match(app, /url\.scheme == "https"[\s\S]*HostAuthorityProtocol\.productionOrigin\.host/u);
  assert.doesNotMatch(app, /evaluateJavaScript|WKUserScript|applicationSession\(\).*WKWebView/gu);
  assert.doesNotMatch(app, /URLQueryItem|hostTicket/u);
  assert.match(app,
    /"\/api\/host\/web-tickets\/exchange"[\s\S]*request\.httpMethod = "POST"/u);
  assert.match(app, /request\.httpBody = try\? JSONSerialization\.data/u);
  assert.match(app,
    /configuration\.activates = spotify\.applicationState\(\) == \.running/u);
  assert.match(app, /configuration\.addsToRecentItems = false/u);
  assert.match(app,
    /openApplication\(at: url, configuration: configuration\)[\s\S]*await self\.refresh\(\)/u);
  assert.match(app, /\.onDisappear \{ Task \{ await model\.shutdown\(\) \} \}/u);
});

test('production runtime wires shared audio to the playback gate and fences rotation', () => {
  assert.match(app, /HostGameRuntimeReconciler\.directive\(/u);
  assert.match(app, /case \.preserve:\s*return/u);
  assert.match(runtime,
    /guard serverReadinessConfirmed else \{ return \.preserve \}/u);
  assert.match(runtime,
    /guard readiness\.sharedAudioRuntimeEnabled, let game = readiness\.activeGame else/u);
  assert.match(app, /func reconnectAudio\(\) \{[\s\S]*guard readiness\.sharedAudioRuntimeEnabled/u);
  assert.match(app, /\.disabled\(!model\.readiness\.sharedAudioRuntimeEnabled\)/u);
  assert.match(runtime, /SharedAudioOwner\(origin: origin, playbackGate: callback\)/u);
  assert.match(runtime,
    /oldGate\?\.close\(\)[\s\S]*await oldAudio\?\.stop\(\)[\s\S]*PlaybackAudioGate/u);
  assert.match(runtime,
    /operationGeneration &\+= 1[\s\S]*gameID = nil[\s\S]*oldGate\?\.close\(\)[\s\S]*await oldAudio\?\.stop\(\)/u);
  assert.doesNotMatch(runtime, /playbackGate:\s*\{\s*_\s+in\s*\}/u);
});

test('family builds default optional diagnostics off while debug builds default on', () => {
  assert.match(app, /#if DEBUG[\s\S]*diagnosticsPreference: true[\s\S]*#else[\s\S]*diagnosticsPreference: false/u);
  assert.match(app, /guard diagnosticsEnabled,[\s\S]*recordDiagnostic/u);
  assert.match(app, /exportDiagnostics\(gameID:/u);
});
