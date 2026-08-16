import {
  classifyManagedCommandFailure,classifyPlaybackObservation,diagnosticReadinessSnapshot,
  reconcileManagedProviderObservation,
  shouldExecuteManagedControllerCommand,
} from './protocol.mjs';

const REFRESH_KEY = 'cannabeats.managed.spotify.refreshToken';
const VERIFIER_KEY = 'cannabeats.managed.spotify.pkceVerifier';
const STATE_KEY = 'cannabeats.managed.spotify.oauthState';
const SCOPES = 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state';
const state = {
  config: null,
  accessToken: null,
  expiresAt: 0,
  player: null,
  deviceId: null,
  managedLeaseId: null,
  managedCommandId: null,
  managedRecoveryId: null,
  readiness: {
    spotifyAuthorization: 'unknown',
    player: 'not_ready',
    playbackObservation: 'unknown',
  },
  playbackObservedAt: null,
};
const byId = (id) => document.getElementById(id);

function log(value) {
  byId('status').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function reportReadiness() {
  await fetch('http://127.0.0.1:4782/readiness', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(diagnosticReadinessSnapshot(
      state.readiness,state.playbackObservedAt,performance.now(),
    )),
  });
}

function setPlaybackObservation(value) {
  state.playbackObservedAt = value === 'unknown' ? null : performance.now();
  setReadiness('playbackObservation', value);
}

function setReadiness(name, value) {
  if (state.readiness[name] === value) return;
  state.readiness[name] = value;
  void reportReadiness().catch(() => {});
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function render() {
  const connected = Boolean(localStorage.getItem(REFRESH_KEY));
  byId('credential-state').textContent = connected
    ? 'Spotify is connected in this isolated browser profile.'
    : 'Spotify is not connected.';
  byId('verify').disabled = !connected;
  byId('start-player').disabled = !connected;
  byId('disconnect').disabled = !connected;
  byId('play').disabled = !state.deviceId;
  byId('pause').disabled = !state.player;
  byId('resume').disabled = !state.player;
}

async function connect() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
  const randomState = `managed-source.${base64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, randomState);
  location.assign(`https://accounts.spotify.com/authorize?${new URLSearchParams({
    client_id: state.config.spotifyClientId,
    response_type: 'code',
    redirect_uri: state.config.spotifyRedirectUri,
    code_challenge_method: 'S256',
    code_challenge: base64url(new Uint8Array(digest)),
    state: randomState,
    scope: SCOPES,
  })}`);
}

async function handleCallback() {
  if (location.pathname !== '/callback') return;
  const parameters = new URLSearchParams(location.search);
  if (parameters.has('error')) throw new Error(`Spotify authorization failed: ${parameters.get('error')}`);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  if (!expectedState || expectedState !== parameters.get('state') || !verifier) {
    throw new Error('Spotify authorization state did not match this source');
  }
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.config.spotifyClientId,
      grant_type: 'authorization_code',
      code: parameters.get('code'),
      redirect_uri: state.config.spotifyRedirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error(`Spotify token exchange failed (${response.status})`);
  const token = await response.json();
  localStorage.setItem(REFRESH_KEY, token.refresh_token);
  setReadiness('spotifyAuthorization', 'authorized');
  state.accessToken = token.access_token;
  state.expiresAt = Date.now() + token.expires_in * 1000;
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  history.replaceState({}, '', '/');
  log('Spotify connected. The refresh credential exists only in this isolated browser profile.');
}

async function accessToken() {
  if (state.accessToken && state.expiresAt > Date.now() + 60_000) return state.accessToken;
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) throw new Error('Connect Spotify first');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.config.spotifyClientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const token = await response.json();
  if (!response.ok) {
    if (token.error === 'invalid_grant') {
      localStorage.removeItem(REFRESH_KEY);
      setReadiness('spotifyAuthorization', 'not_authorized');
    } else {
      setReadiness('spotifyAuthorization', 'error');
    }
    throw new Error(`Spotify refresh failed: ${token.error || response.status}`);
  }
  if (token.refresh_token) localStorage.setItem(REFRESH_KEY, token.refresh_token);
  state.accessToken = token.access_token;
  state.expiresAt = Date.now() + token.expires_in * 1000;
  setReadiness('spotifyAuthorization', 'authorized');
  render();
  return state.accessToken;
}

async function spotifyApi(path, options = {}) {
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw new Error(`Spotify API request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}

function loadSdk() {
  if (window.Spotify) return Promise.resolve();
  return new Promise((resolve, reject) => {
    window.onSpotifyWebPlaybackSDKReady = resolve;
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.onerror = () => reject(new Error('Could not load Spotify Web Playback SDK'));
    document.head.append(script);
  });
}

async function startPlayer() {
  log('Starting Spotify browser player…');
  setReadiness('player', 'not_ready');
  setPlaybackObservation('unknown');
  await loadSdk();
  state.player?.disconnect();
  const player = new Spotify.Player({
    name: 'CannaBeats Managed Audio Source',
    volume: 0.7,
    getOAuthToken: (callback) => accessToken().then(callback).catch((error) => log(error.message)),
  });
  state.player = player;
  player.addListener('ready', ({ device_id: deviceId }) => {
    state.deviceId = deviceId;
    setReadiness('player', 'ready');
    log({ ready: true, deviceId, note: 'Managed browser player is ready.' });
    render();
  });
  player.addListener('not_ready', () => {
    state.deviceId = null;
    setReadiness('player', 'not_ready');
    setPlaybackObservation('unknown');
    render();
  });
  player.addListener('player_state_changed', (playback) => {
    setPlaybackObservation(classifyPlaybackObservation(playback));
  });
  player.addListener('initialization_error', ({ message }) => {
    setReadiness('player', 'error'); setPlaybackObservation('error');
    log(`Initialization error: ${message}`);
  });
  player.addListener('authentication_error', ({ message }) => {
    setReadiness('spotifyAuthorization', 'error'); setReadiness('player', 'error');
    setPlaybackObservation('error');
    log(`Authentication error: ${message}`);
  });
  player.addListener('account_error', ({ message }) => {
    setReadiness('player', 'error'); setPlaybackObservation('error');
    log(`Account error: ${message}`);
  });
  player.addListener('playback_error', ({ message }) => {
    setReadiness('player', 'error'); setPlaybackObservation('error');
    log(`Playback error: ${message}`);
  });
  player.addListener('autoplay_failed', () => log('Autoplay was blocked. Press Resume once in this private session.'));
  await player.activateElement();
  if (!await player.connect()) {
    setReadiness('player', 'error');
    throw new Error('Spotify browser player could not connect');
  }
  render();
}

async function ensurePlayerReady() {
  if (!state.deviceId) await startPlayer();
  const deadline = Date.now() + 15_000;
  while (!state.deviceId && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!state.deviceId || !state.player) throw new Error('Spotify browser player did not become ready');
}

async function waitForPlaybackState(paused) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const playback = await state.player.getCurrentState();
    if (playback && playback.paused === paused) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(paused
    ? 'Spotify did not confirm that playback paused'
    : 'Spotify did not confirm active playback; browser activation may be required');
}

async function executeManagedCommand(command) {
  if (command.kind === 'play') {
    await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(state.deviceId)}`, {
      method: 'PUT', body: JSON.stringify({ uris: [command.trackUri] }),
    });
    await state.player.resume();
    await waitForPlaybackState(false);
    return 'playing';
  }
  if (command.kind === 'pause') {
    await state.player.pause();
    await waitForPlaybackState(true);
    return 'paused';
  }
  if (command.kind === 'resume') {
    await state.player.resume();
    await waitForPlaybackState(false);
    return 'playing';
  }
  throw new Error('Managed playback command is not supported');
}

async function prepareManagedCommand(command) {
  await ensurePlayerReady();
  if (command.kind === 'play' && !/^spotify:track:[A-Za-z0-9]+$/.test(command.trackUri ?? '')) {
    throw new Error('Managed play command did not contain a valid Spotify track');
  }
  if (!['play', 'pause', 'resume'].includes(command.kind)) {
    throw new Error('Managed playback command is not supported');
  }
}

async function completeManagedCommand(command, ok, playbackStatus, error = null) {
  const response = await fetch('http://127.0.0.1:4782/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commandId: command.id,
      claimGeneration: command.claimGeneration,
      ok,
      playbackStatus,
      error,
      deviceId: state.deviceId,
    }),
  });
  if (!response.ok) throw new Error(`Managed command acknowledgement failed (${response.status})`);
}

async function beginManagedCommand(command) {
  const response = await fetch('http://127.0.0.1:4782/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commandId: command.id,
      claimGeneration: command.claimGeneration,
    }),
  });
  if (!response.ok) throw new Error(`Managed command execution claim failed (${response.status})`);
  const result = await response.json();
  if (result.accepted !== true || result.claimGeneration !== command.claimGeneration) {
    throw new Error('Managed command execution claim was not confirmed');
  }
}

async function reportManagedCommandUnknown(command) {
  const response = await fetch('http://127.0.0.1:4782/unknown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commandId: command.id,
      claimGeneration: command.claimGeneration,
    }),
  });
  if (!response.ok) throw new Error(`Managed unknown outcome was not recorded (${response.status})`);
}

async function inspectManagedCommandOutcome(command) {
  await ensurePlayerReady();
  const playback = await state.player.getCurrentState();
  return reconcileManagedProviderObservation(command,playback ? {
    paused: playback.paused,
    trackUri: playback.track_window?.current_track?.uri ?? null,
  } : null);
}

async function pollManagedController() {
  const response = await fetch('http://127.0.0.1:4782/state', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Managed source controller is unavailable (${response.status})`);
  const controller = await response.json();
  if (controller.commandRecovery) {
    log('A managed command has an unknown provider outcome and requires reconciliation.');
    const recoveryCommand = controller.commandRecovery.command;
    if (recoveryCommand && recoveryCommand.id !== state.managedRecoveryId) {
      state.managedRecoveryId = recoveryCommand.id;
      try {
        const playbackStatus = await inspectManagedCommandOutcome(recoveryCommand);
        if (playbackStatus) {
          await completeManagedCommand(recoveryCommand,true,playbackStatus,null);
          log(`Managed ${recoveryCommand.kind} outcome was reconciled from provider state.`);
        } else {
          log(`Managed ${recoveryCommand.kind} outcome remains unknown; no effect was repeated.`);
        }
      } catch (error) {
        log(`Managed ${recoveryCommand.kind} reconciliation is still pending: ${error.message}`);
      } finally {
        state.managedRecoveryId = null;
      }
    }
  }
  if (!controller.lease) {
    if (state.managedLeaseId && state.player) {
      await state.player.pause().catch(() => {});
      log('Managed session released. Playback and relay output are stopped.');
    }
    state.managedLeaseId = null;
    if (!shouldExecuteManagedControllerCommand(controller)) return;
  } else {
    state.managedLeaseId = controller.lease.id;
  }
  const command = controller.command;
  if (!command || command.id === state.managedCommandId) return;
  state.managedCommandId = command.id;
  try {
    const commandContext = controller.lease?.sessionCode ?? "the prior managed session";
    log(`Managed ${command.kind} command received for ${commandContext}.`);
    // The controller fsyncs the executing phase and the game API accepts the
    // exact claim generation before this browser is allowed to touch Spotify.
    await beginManagedCommand(command);
  } catch (error) {
    if (classifyManagedCommandFailure('begin') === 'outcome_unknown') {
      await reportManagedCommandUnknown(command).catch(() => {});
    }
    log(`Managed ${command.kind} authorization outcome is unknown: ${error.message}`);
    state.managedCommandId = null;
    return;
  }
  try {
    await prepareManagedCommand(command);
  } catch (error) {
    const outcome = { ok: false, playbackStatus: 'error', error: error.message };
    try {
      await completeManagedCommand(command, outcome.ok, outcome.playbackStatus, outcome.error);
    } catch (ackError) {
      log(`Managed ${command.kind} failure acknowledgement pending: ${ackError.message}`);
    } finally {
      state.managedCommandId = null;
    }
    return;
  }
  try {
    const playbackStatus = await executeManagedCommand(command);
    await completeManagedCommand(command, true, playbackStatus, null);
    const commandContext = controller.lease?.sessionCode ?? "the prior managed session";
    log(`Managed ${command.kind} command outcome acknowledged for ${commandContext}.`);
  } catch (error) {
    if (classifyManagedCommandFailure('provider') === 'outcome_unknown') {
      await reportManagedCommandUnknown(command).catch(() => {});
    }
    log(`Managed ${command.kind} provider outcome is unknown: ${error.message}`);
  } finally {
    state.managedCommandId = null;
  }
}

byId('connect').addEventListener('click', () => connect().catch((error) => log(error.message)));
byId('verify').addEventListener('click', () => spotifyApi('/me').then((profile) => {
  setReadiness('spotifyAuthorization', 'authorized');
  log({ displayName: profile.display_name, product: profile.product, country: profile.country });
}).catch((error) => {
  setReadiness('spotifyAuthorization', 'error');
  log(error.message);
}));
byId('start-player').addEventListener('click', () => startPlayer().catch((error) => log(error.message)));
byId('play').addEventListener('click', async () => {
  try {
    const uri = byId('track-uri').value.trim();
    if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) throw new Error('Enter a Spotify track URI');
    await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(state.deviceId)}`, {
      method: 'PUT', body: JSON.stringify({ uris: [uri] }),
    });
    await state.player.resume();
    log({ playing: uri, deviceId: state.deviceId });
  } catch (error) { log(error.message); }
});
byId('pause').addEventListener('click', () => state.player.pause().then(() => log('Paused.')).catch((error) => log(error.message)));
byId('resume').addEventListener('click', () => state.player.resume().then(() => log('Resumed.')).catch((error) => log(error.message)));
byId('disconnect').addEventListener('click', () => {
  state.player?.disconnect();
  localStorage.removeItem(REFRESH_KEY);
  state.accessToken = null;
  state.expiresAt = 0;
  state.player = null;
  state.deviceId = null;
  setReadiness('spotifyAuthorization', 'not_authorized');
  setReadiness('player', 'not_ready');
  setPlaybackObservation('unknown');
  log('Spotify authorization removed from this browser profile.');
  render();
});

async function initialize() {
  state.config = await fetch('/config').then((response) => response.json());
  await handleCallback();
  if (localStorage.getItem(REFRESH_KEY)) {
    try {
      await spotifyApi('/me');
      setReadiness('spotifyAuthorization', 'authorized');
    } catch {
      setReadiness('spotifyAuthorization', 'error');
    }
  } else {
    setReadiness('spotifyAuthorization', 'not_authorized');
  }
  render();
  await reportReadiness().catch(() => {});
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try { await pollManagedController(); } catch {}
    finally { polling = false; }
  };
  await poll();
  setInterval(() => { void poll(); }, 750);
  setInterval(() => { void reportReadiness().catch(() => {}); }, 5_000);
}

initialize().catch((error) => log(error.message));
