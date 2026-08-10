const state = {
  config: null,
  user: null,
  gameSession: null,
  gameSessionTimer: null,
  desktopApproval: null,
  spotify: { accessToken: null, expiresAt: 0, player: null, deviceId: null },
};

const SPOTIFY_REFRESH_KEY = 'cannabeats.spotify.refreshToken';
const SPOTIFY_VERIFIER_KEY = 'cannabeats.spotify.pkceVerifier';
const SPOTIFY_STATE_KEY = 'cannabeats.spotify.oauthState';
const GAME_SPOTIFY_AUTH_KEY = 'cannabeats-spotify-authorization';
const GAME_SPOTIFY_RETURN_KEY = 'cannabeats.spotify.gameCallbackReturn';
const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const byId = (id) => document.getElementById(id);

function showMessage(message, kind = 'info') {
  const element = byId('message');
  element.textContent = message;
  element.dataset.kind = kind;
  element.hidden = false;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => { element.hidden = true; }, 6_000);
}

function errorMessage(error) {
  if (error?.name === 'NotAllowedError') return 'The device canceled or could not complete the passkey prompt.';
  return error?.message || 'Something unexpected happened.';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function renderAccount() {
  const signedIn = Boolean(state.user);
  const isHost = state.user?.role === 'host';
  byId('guest-panel').hidden = signedIn;
  byId('account-panel').hidden = !signedIn;
  byId('spotify-card').hidden = !signedIn || !isHost;
  byId('host-agent-panel').hidden = !signedIn || !isHost;
  byId('game-session-card').hidden = !signedIn || !isHost;
  if (signedIn) {
    byId('account-name').textContent = state.user.displayName;
    byId('account-role').textContent = `${state.user.role === 'host' ? 'Host' : 'Player'} account`;
    byId('host-proof').hidden = !isHost;
  }
  renderDesktopApproval();
}

async function loadSession() {
  try {
    const result = await api('/api/me');
    state.user = result.user;
    await loadPasskeys();
    await loadDesktopApplications();
    if (state.user.role === 'host') await loadHostAgents();
    state.gameSession = null;
  } catch {
    state.user = null;
    state.gameSession = null;
  }
  renderAccount();
  renderGameSession();
  if (state.user && state.desktopApproval) await loadPendingDesktopApproval();
}

async function loadDesktopApplications() {
  if (!state.user) return;
  const { applications } = await api('/api/desktop-applications');
  const list = byId('desktop-application-list');
  list.replaceChildren();
  for (const application of applications) {
    const item = document.createElement('li');
    const description = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = application.displayName;
    const metadata = document.createElement('span');
    metadata.textContent = application.revokedAt
      ? `Revoked ${new Date(application.revokedAt).toLocaleString()}`
      : `Last connected ${new Date(application.lastSeenAt).toLocaleString()}`;
    description.append(title, metadata);
    item.append(description);
    if (!application.revokedAt) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'text-button';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`Revoke “${application.displayName}”?`)) return;
        try {
          await api(`/api/desktop-applications/${encodeURIComponent(application.id)}`, {
            method: 'DELETE', body: '{}',
          });
          await loadDesktopApplications();
          showMessage('Desktop application revoked.');
        } catch (error) { showMessage(errorMessage(error), 'error'); }
      });
      item.append(revoke);
    }
    list.append(item);
  }
}

function normalizeDesktopPairingCode(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function formatDesktopPairingCode(value) {
  const code = normalizeDesktopPairingCode(value);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

function setupDesktopApprovalRoute() {
  const url = new URL(location.href);
  const legacyCode = url.searchParams.get('client_pair');
  if (url.pathname === '/' && legacyCode) {
    location.replace(`/desktop/approve?code=${encodeURIComponent(legacyCode)}`);
    return;
  }
  if (url.pathname !== '/desktop/approve') return;
  const code = normalizeDesktopPairingCode(url.searchParams.get('code'));
  state.desktopApproval = {
    code,
    application: null,
    approved: false,
    error: code.length === 8 ? null : 'This desktop approval link does not contain a valid code.',
  };
  document.body.classList.add('desktop-approval-mode');
  byId('hero-lede').textContent = 'Select and authorize the desktop installation that opened this page.';
  renderDesktopApproval();
}

function renderDesktopApproval() {
  const approval = state.desktopApproval;
  byId('desktop-approval-card').hidden = !approval;
  if (!approval) return;
  const signedIn = Boolean(state.user);
  byId('desktop-approval-code').textContent = formatDesktopPairingCode(approval.code) || 'Invalid code';
  byId('desktop-approval-guest').hidden = signedIn;
  byId('desktop-approval-account').hidden = !signedIn;
  byId('desktop-approval-result').textContent = approval.error ?? '';
  if (!signedIn) return;
  byId('desktop-approval-account-name').textContent = state.user.displayName;
  byId('desktop-approval-app-name').textContent = approval.application?.displayName ?? 'Loading pending application…';
  byId('desktop-approval-description').textContent = approval.approved
    ? 'This desktop installation is now authorized. You can return to CannaBeats Client.'
    : approval.error
      ? approval.error
      : approval.application
        ? 'Confirm this named installation with your passkey. No Spotify credential is shared.'
        : 'Checking this authorization request.';
  const button = byId('approve-pending-desktop-application');
  button.disabled = !approval.application || Boolean(approval.error) || approval.approved;
  button.hidden = approval.approved;
}

async function loadPendingDesktopApproval() {
  if (!state.user || !state.desktopApproval || state.desktopApproval.error) return;
  try {
    const result = await api(`/api/desktop/authorizations/pending?code=${encodeURIComponent(state.desktopApproval.code)}`);
    state.desktopApproval.application = result.application;
    state.desktopApproval.approved = result.approved;
  } catch (error) {
    state.desktopApproval.error = errorMessage(error);
  }
  renderDesktopApproval();
}

async function completeDesktopApproval(code, { confirmApplication = false } = {}) {
  const result = await api('/api/desktop/authorizations/approve/options', {
    method: 'POST', body: JSON.stringify({ code }),
  });
  if (confirmApplication
    && !window.confirm(`Authorize “${result.application.displayName}” for your CannaBeats account?`)) return null;
  const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: result.options });
  return api('/api/desktop/authorizations/approve/verify', {
    method: 'POST', body: JSON.stringify({ response }),
  });
}

async function approveDesktopApplication(event) {
  event.preventDefault();
  try {
    const verified = await completeDesktopApproval(byId('desktop-application-code').value, {
      confirmApplication: true,
    });
    if (!verified) return;
    byId('desktop-application-result').textContent = verified.message;
    byId('approve-desktop-application-form').reset();
    await loadDesktopApplications();
    showMessage('Desktop application approved.');
  } catch (error) {
    showMessage(errorMessage(error), 'error');
  }
}

async function approvePendingDesktopApplication() {
  const button = byId('approve-pending-desktop-application');
  button.disabled = true;
  try {
    const verified = await completeDesktopApproval(state.desktopApproval.code);
    state.desktopApproval.approved = true;
    byId('desktop-approval-result').textContent = verified.message;
    await loadDesktopApplications();
    renderDesktopApproval();
  } catch (error) {
    state.desktopApproval.error = errorMessage(error);
    renderDesktopApproval();
  } finally {
    if (!state.desktopApproval.approved) button.disabled = false;
  }
}

function renderGameSession() {
  const details = byId('game-session-details');
  const session = state.gameSession;
  details.hidden = !session;
  if (!session) return;
  byId('game-session-code').textContent = `${session.code.slice(0, 3)}-${session.code.slice(3)}`;
  byId('game-session-status').textContent = `${session.status === 'lobby' ? 'Waiting in lobby' : session.status} · ${session.members.length} connected account${session.members.length === 1 ? '' : 's'}`;
  const list = byId('game-session-members');
  list.replaceChildren();
  for (const member of session.members) {
    const item = document.createElement('li');
    const description = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = member.displayName;
    const metadata = document.createElement('span');
    metadata.textContent = member.id === session.host.id ? 'Session host' : 'Desktop client';
    description.append(name, metadata);
    item.append(description);
    list.append(item);
  }
}

function requestedGameCode() {
  const rawCode = new URLSearchParams(location.search).get('game');
  if (!rawCode) return null;
  const code = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    throw new Error('The Host app supplied an invalid game code.');
  }
  return code;
}

function startGameSessionPolling() {
  clearInterval(state.gameSessionTimer);
  if (!state.gameSession) return;
  state.gameSessionTimer = setInterval(async () => {
    try {
      const result = await api(`/api/game-sessions/${encodeURIComponent(state.gameSession.code)}`);
      state.gameSession = result.session;
      renderGameSession();
    } catch {
      clearInterval(state.gameSessionTimer);
    }
  }, 2_000);
}

async function loadRequestedOrCurrentGameSession() {
  const requestedCode = requestedGameCode();
  if (requestedCode) {
    const result = await api(`/api/game-sessions/${encodeURIComponent(requestedCode)}`);
    state.gameSession = result.session;
  } else {
    const result = await api('/api/game-sessions/current');
    state.gameSession = result.sessions[0] ?? null;
  }
  renderGameSession();
  startGameSessionPolling();
  if (requestedCode) showMessage(`Game session ${requestedCode} selected.`);
}

async function createGameSession() {
  const result = await api('/api/game-sessions', { method: 'POST', body: '{}' });
  state.gameSession = result.session;
  renderGameSession();
  startGameSessionPolling();
  showMessage(`Game session ${result.session.code} is ready.`);
}

async function loadHostAgents() {
  if (state.user?.role !== 'host') return;
  const { agents } = await api('/api/host-agents');
  const list = byId('host-agent-list');
  list.replaceChildren();
  for (const agent of agents) {
    const item = document.createElement('li');
    const description = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = agent.displayName;
    const metadata = document.createElement('span');
    metadata.textContent = agent.revokedAt
      ? `Revoked ${new Date(agent.revokedAt).toLocaleString()}`
      : agent.lastSeenAt
        ? `Last proved ${new Date(agent.lastSeenAt).toLocaleString()}`
        : 'Authorized; awaiting first device proof';
    description.append(title, metadata);
    item.append(description);
    if (!agent.revokedAt) {
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'text-button';
      revoke.textContent = 'Revoke';
      revoke.addEventListener('click', async () => {
        if (!window.confirm(`Revoke “${agent.displayName}”?`)) return;
        try {
          await api(`/api/host-agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE', body: '{}' });
          await loadHostAgents();
          showMessage('Host application revoked.');
        } catch (error) { showMessage(errorMessage(error), 'error'); }
      });
      item.append(revoke);
    }
    list.append(item);
  }
}

async function approveHostAgent(event) {
  event.preventDefault();
  try {
    const code = byId('host-agent-code').value;
    const result = await api('/api/host-agents/pair/approve/options', {
      method: 'POST', body: JSON.stringify({ code }),
    });
    if (!window.confirm(`Authorize “${result.application.displayName}” for your host account?`)) return;
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: result.options });
    const verified = await api('/api/host-agents/pair/approve/verify', {
      method: 'POST', body: JSON.stringify({ response }),
    });
    byId('host-agent-result').textContent = verified.message;
    byId('approve-host-agent-form').reset();
    const url = new URL(location.href);
    url.searchParams.delete('pair');
    history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    await loadHostAgents();
    showMessage('Host application approved.');
  } catch (error) {
    showMessage(errorMessage(error), 'error');
  }
}

function prefillHostAgentPairingCode() {
  const code = new URLSearchParams(location.search).get('pair');
  if (!code) return;
  byId('host-agent-code').value = code.toUpperCase();
}

async function loadPasskeys() {
  if (!state.user) return;
  const { passkeys } = await api('/api/passkeys');
  const list = byId('passkey-list');
  list.replaceChildren();
  for (const passkey of passkeys) {
    const item = document.createElement('li');
    const description = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = passkey.label;
    const metadata = document.createElement('span');
    metadata.textContent = `${passkey.deviceType === 'multiDevice' ? 'Synced/multi-device' : 'Single-device'} · ${passkey.backedUp ? 'backed up' : 'not reported backed up'}`;
    description.append(title, metadata);
    item.append(description);
    if (passkeys.length > 1) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        if (!window.confirm(`Remove “${passkey.label}”?`)) return;
        try {
          await api(`/api/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
          await loadPasskeys();
          showMessage('Passkey removed.');
        } catch (error) {
          showMessage(errorMessage(error), 'error');
        }
      });
      item.append(remove);
    }
    list.append(item);
  }
}

async function enroll(event) {
  event.preventDefault();
  try {
    const result = await api('/api/auth/enroll/options', {
      method: 'POST',
      body: JSON.stringify({
        displayName: byId('display-name').value,
        invitationCode: byId('invitation-code').value,
      }),
    });
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: result.options });
    const verified = await api('/api/auth/enroll/verify', {
      method: 'POST',
      body: JSON.stringify({ response }),
    });
    state.user = verified.user;
    renderAccount();
    await loadPasskeys();
    byId('enroll-form').reset();
    showMessage('Passkey created and account authorized.');
  } catch (error) {
    showMessage(errorMessage(error), 'error');
  }
}

async function signIn() {
  try {
    const followUpErrors = [];
    const result = await api('/api/auth/sign-in/options', { method: 'POST', body: '{}' });
    const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: result.options });
    const verified = await api('/api/auth/sign-in/verify', {
      method: 'POST',
      body: JSON.stringify({ response }),
    });
    state.user = verified.user;
    renderAccount();
    await loadPasskeys();
    await loadDesktopApplications();
    if (state.user.role === 'host') await loadHostAgents();
    if (state.user.role === 'host') {
      try {
        await loadRequestedOrCurrentGameSession();
      } catch (error) {
        state.gameSession = null;
        renderGameSession();
        followUpErrors.push(errorMessage(error));
      }
    }
    if (state.desktopApproval) await loadPendingDesktopApproval();
    showMessage(
      followUpErrors[0] ?? 'Signed in with your passkey.',
      followUpErrors.length ? 'error' : 'info',
    );
  } catch (error) {
    showMessage(errorMessage(error), 'error');
  }
}

async function addPasskey(event) {
  event.preventDefault();
  try {
    const result = await api('/api/auth/passkeys/options', {
      method: 'POST',
      body: JSON.stringify({ label: byId('passkey-label').value }),
    });
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: result.options });
    await api('/api/auth/passkeys/verify', {
      method: 'POST',
      body: JSON.stringify({ response }),
    });
    await loadPasskeys();
    showMessage('Additional passkey authorized.');
  } catch (error) {
    showMessage(errorMessage(error), 'error');
  }
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function spotifyRefreshToken() {
  return localStorage.getItem(SPOTIFY_REFRESH_KEY);
}

function renderSpotifyState() {
  const configured = Boolean(state.config?.spotifyClientId);
  const connected = Boolean(spotifyRefreshToken());
  byId('spotify-connect').disabled = !configured;
  byId('spotify-verify').disabled = !configured || !connected;
  byId('spotify-refresh').disabled = !configured || !connected;
  byId('spotify-disconnect').disabled = !connected;
  byId('spotify-player-start').disabled = !configured || !connected;
  byId('spotify-play-track').disabled = !state.spotify.deviceId;
  byId('spotify-state').textContent = !configured
    ? 'Spotify is disabled until a public client ID is configured on the server.'
    : connected
      ? 'A Spotify refresh credential is stored only in this browser profile.'
      : 'Spotify is not connected in this browser.';
}

function spotifyLog(value) {
  byId('spotify-log').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function connectSpotify() {
  if (!state.config.spotifyClientId) throw new Error('Spotify client ID is not configured');
  const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(64)));
  const stateValue = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const challengeBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  sessionStorage.setItem(SPOTIFY_VERIFIER_KEY, verifier);
  sessionStorage.setItem(SPOTIFY_STATE_KEY, stateValue);
  const parameters = new URLSearchParams({
    client_id: state.config.spotifyClientId,
    response_type: 'code',
    redirect_uri: state.config.spotifyRedirectUri,
    code_challenge_method: 'S256',
    code_challenge: bytesToBase64Url(new Uint8Array(challengeBytes)),
    state: stateValue,
    scope: SPOTIFY_SCOPES,
  });
  location.assign(`https://accounts.spotify.com/authorize?${parameters}`);
}

async function exchangeSpotifyCode(code) {
  const verifier = sessionStorage.getItem(SPOTIFY_VERIFIER_KEY);
  if (!verifier) throw new Error('Spotify PKCE verifier is missing; start the connection again');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.config.spotifyClientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: state.config.spotifyRedirectUri,
      code_verifier: verifier,
    }),
  });
  if (!response.ok) throw new Error(`Spotify token exchange failed (${response.status})`);
  const token = await response.json();
  if (!token.refresh_token) throw new Error('Spotify did not return a refresh token');
  localStorage.setItem(SPOTIFY_REFRESH_KEY, token.refresh_token);
  state.spotify.accessToken = token.access_token;
  state.spotify.expiresAt = Date.now() + token.expires_in * 1000;
  sessionStorage.removeItem(SPOTIFY_VERIFIER_KEY);
  sessionStorage.removeItem(SPOTIFY_STATE_KEY);
}

async function refreshSpotifyToken(force = false) {
  if (!force && state.spotify.accessToken && state.spotify.expiresAt > Date.now() + 60_000) {
    return state.spotify.accessToken;
  }
  const refreshToken = spotifyRefreshToken();
  if (!refreshToken) throw new Error('Connect Spotify on this device first');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.config.spotifyClientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!response.ok) {
    if (response.status === 400 || response.status === 401) disconnectSpotify();
    throw new Error(`Spotify refresh failed (${response.status}); reconnect if authorization expired`);
  }
  const token = await response.json();
  state.spotify.accessToken = token.access_token;
  state.spotify.expiresAt = Date.now() + token.expires_in * 1000;
  if (token.refresh_token) localStorage.setItem(SPOTIFY_REFRESH_KEY, token.refresh_token);
  renderSpotifyState();
  return state.spotify.accessToken;
}

async function spotifyApi(path, options = {}) {
  const token = await refreshSpotifyToken();
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw new Error(`Spotify API request failed (${response.status})`);
  if (response.status === 204) return null;
  return response.json();
}

function disconnectSpotify() {
  state.spotify.player?.disconnect();
  state.spotify = { accessToken: null, expiresAt: 0, player: null, deviceId: null };
  localStorage.removeItem(SPOTIFY_REFRESH_KEY);
  sessionStorage.removeItem(SPOTIFY_VERIFIER_KEY);
  sessionStorage.removeItem(SPOTIFY_STATE_KEY);
  renderSpotifyState();
  spotifyLog('Spotify authorization removed from this browser.');
}

function loadSpotifySdk() {
  if (window.Spotify) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Spotify SDK did not become ready within 15 seconds'));
    }, 15_000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    window.onSpotifyWebPlaybackSDKReady = () => finish(resolve);
    const script = document.createElement('script');
    script.src = 'https://sdk.scdn.co/spotify-player.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => finish(() => reject(new Error('Could not load Spotify Web Playback SDK')));
    script.onload = () => {
      if (window.Spotify) finish(resolve);
    };
    document.head.append(script);
  });
}

async function startSpotifyPlayer() {
  spotifyLog('Loading Spotify Web Playback SDK…');
  await loadSpotifySdk();
  if (state.spotify.player) return state.spotify.deviceId;
  spotifyLog('Spotify SDK loaded. Creating the private browser player…');
  const player = new Spotify.Player({
    name: 'CannaBeats Access Lab',
    volume: 0.65,
    getOAuthToken: (callback) => refreshSpotifyToken().then(callback).catch((error) => spotifyLog(errorMessage(error))),
  });
  player.addListener('ready', ({ device_id: deviceId }) => {
    state.spotify.deviceId = deviceId;
    renderSpotifyState();
    spotifyLog({ ready: true, deviceId, note: 'Browser player is ready.' });
  });
  player.addListener('not_ready', ({ device_id: deviceId }) => spotifyLog({ ready: false, deviceId }));
  player.addListener('player_state_changed', (playbackState) => {
    if (!playbackState) {
      spotifyLog('Spotify player state is unavailable.');
      return;
    }
    spotifyLog({
      paused: playbackState.paused,
      positionMs: playbackState.position,
      track: playbackState.track_window?.current_track?.name || null,
      artist: playbackState.track_window?.current_track?.artists?.map((artist) => artist.name).join(', ') || null,
    });
  });
  player.addListener('initialization_error', ({ message }) => spotifyLog(`Spotify initialization error: ${message}`));
  player.addListener('authentication_error', ({ message }) => spotifyLog(`Spotify authentication error: ${message}`));
  player.addListener('account_error', ({ message }) => spotifyLog(`Spotify account error: ${message}`));
  player.addListener('playback_error', ({ message }) => spotifyLog(`Spotify playback error: ${message}`));
  player.addListener('autoplay_failed', () => spotifyLog('Spotify autoplay was blocked; press Play test track again.'));
  player.activateElement().catch(() => {});
  spotifyLog('Browser player created. Connecting to Spotify…');
  const connected = await Promise.race([
    player.connect(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('Spotify player connection timed out after 20 seconds')),
      20_000,
    )),
  ]);
  if (!connected) throw new Error('Spotify browser player could not connect');
  state.spotify.player = player;
  spotifyLog('Spotify browser player connected; waiting for its device ID…');
}

async function handleSpotifyCallback() {
  if (location.pathname !== '/spotify/callback') return;
  const parameters = new URLSearchParams(location.search);
  if (!parameters.has('code') && !parameters.has('error')) return;
  try {
    if (parameters.has('error')) throw new Error(`Spotify authorization failed: ${parameters.get('error')}`);
    const expectedState = sessionStorage.getItem(SPOTIFY_STATE_KEY);
    if (!expectedState || !constantState(expectedState, parameters.get('state'))) {
      throw new Error('Spotify authorization state did not match');
    }
    await exchangeSpotifyCode(parameters.get('code'));
    history.replaceState({}, '', '/');
    renderSpotifyState();
    spotifyLog('Spotify connected. The refresh credential exists only in this browser profile.');
    showMessage('Spotify connected locally.');
  } catch (error) {
    spotifyLog(errorMessage(error));
    showMessage(errorMessage(error), 'error');
  }
}

function constantState(left, right) {
  if (typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

function wireEvents() {
  byId('enroll-form').addEventListener('submit', enroll);
  byId('sign-in').addEventListener('click', signIn);
  byId('add-passkey-form').addEventListener('submit', addPasskey);
  byId('approve-host-agent-form').addEventListener('submit', approveHostAgent);
  byId('approve-desktop-application-form').addEventListener('submit', approveDesktopApplication);
  byId('desktop-approval-sign-in').addEventListener('click', signIn);
  byId('approve-pending-desktop-application').addEventListener('click', approvePendingDesktopApplication);
  byId('create-game-session').addEventListener('click', () => createGameSession()
    .catch((error) => showMessage(errorMessage(error), 'error')));
  byId('sign-out').addEventListener('click', async () => {
    try {
      await api('/api/auth/sign-out', { method: 'POST', body: '{}' });
      state.user = null;
      state.gameSession = null;
      clearInterval(state.gameSessionTimer);
      renderAccount();
      renderGameSession();
      showMessage('Signed out.');
    } catch (error) { showMessage(errorMessage(error), 'error'); }
  });
  byId('prove-host').addEventListener('click', async () => {
    try {
      const result = await api('/api/host/prove', { method: 'POST', body: '{}' });
      byId('host-result').textContent = result.message;
    } catch (error) { showMessage(errorMessage(error), 'error'); }
  });
  byId('spotify-connect').addEventListener('click', () => connectSpotify().catch((error) => showMessage(errorMessage(error), 'error')));
  byId('spotify-verify').addEventListener('click', async () => {
    try {
      const profile = await spotifyApi('/me');
      spotifyLog({ displayName: profile.display_name, product: profile.product, country: profile.country });
    } catch (error) { spotifyLog(errorMessage(error)); }
  });
  byId('spotify-refresh').addEventListener('click', async () => {
    try {
      await refreshSpotifyToken(true);
      spotifyLog('Access token refreshed. Any rotated refresh credential was saved locally.');
    } catch (error) { spotifyLog(errorMessage(error)); }
  });
  byId('spotify-disconnect').addEventListener('click', disconnectSpotify);
  byId('spotify-player-start').addEventListener('click', () => startSpotifyPlayer().catch((error) => spotifyLog(errorMessage(error))));
  byId('spotify-play-track').addEventListener('click', async () => {
    try {
      if (!state.spotify.player) throw new Error('Start the browser player first');
      await state.spotify.player.activateElement();
      const uri = byId('spotify-track').value.trim();
      if (!/^spotify:track:[A-Za-z0-9]+$/.test(uri)) throw new Error('Enter a Spotify track URI');
      await spotifyApi(`/me/player/play?device_id=${encodeURIComponent(state.spotify.deviceId)}`, {
        method: 'PUT', body: JSON.stringify({ uris: [uri] }),
      });
      await state.spotify.player.resume();
      const volume = await state.spotify.player.getVolume();
      spotifyLog({ commandAccepted: true, playing: uri, browserVolume: volume });
    } catch (error) { spotifyLog(errorMessage(error)); }
  });
}

async function initialize() {
  if (location.pathname === '/spotify/callback'
      && localStorage.getItem(GAME_SPOTIFY_AUTH_KEY)) {
    const returnPath = localStorage.getItem(GAME_SPOTIFY_RETURN_KEY) ?? '';
    if (returnPath === '/game' || returnPath.startsWith('/game/')) {
      const target = new URL(returnPath, location.origin);
      target.search = location.search;
      location.replace(target);
      return;
    }
  }
  wireEvents();
  prefillHostAgentPairingCode();
  setupDesktopApprovalRoute();
  try {
    state.config = await api('/api/config');
    byId('connection-status').textContent = state.config.rpID;
    byId('connection-status').dataset.ready = 'true';
    renderSpotifyState();
    await loadSession();
    await handleSpotifyCallback();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  } catch (error) {
    byId('connection-status').textContent = 'Server unavailable';
    showMessage(errorMessage(error), 'error');
  }
}

initialize();
