const invoke = window.__TAURI__.core.invoke;

const state = {
  user: null,
  application: null,
  authorizationTimer: null,
};

const byId = (id) => document.getElementById(id);

function message(text, kind = 'info') {
  const toast = byId('message');
  toast.textContent = text;
  toast.dataset.kind = kind;
  toast.hidden = false;
  clearTimeout(message.timer);
  message.timer = setTimeout(() => { toast.hidden = true; }, 6_000);
}

function errorText(error) {
  return typeof error === 'string' ? error : error?.message || 'Something unexpected happened.';
}

function formatCode(code) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length <= 4) return normalized;
  const midpoint = normalized.length <= 6 ? 3 : 4;
  return `${normalized.slice(0, midpoint)}-${normalized.slice(midpoint)}`;
}

function renderAccount() {
  const authorized = Boolean(state.user);
  byId('connect-card').hidden = authorized;
  byId('client-card').hidden = !authorized;
  if (!authorized) return;
  byId('account-name').textContent = state.user.displayName;
  byId('application-name').textContent = `${state.application.displayName} · ${state.user.role === 'host' ? 'Host-capable account' : 'Player account'}`;
}

async function bootstrap() {
  const result = await invoke('bootstrap');
  byId('service-origin').textContent = new URL(result.origin).hostname;
  state.user = result.user;
  state.application = result.application;
  renderAccount();
}

async function beginAuthorization() {
  const button = byId('connect');
  button.disabled = true;
  try {
    const platform = navigator.userAgent.includes('Windows') ? 'Windows PC' : navigator.userAgent.includes('Mac') ? 'Mac' : 'computer';
    const result = await invoke('begin_authorization', { displayName: `CannaBeats Client on this ${platform}` });
    byId('pairing-code').textContent = result.code;
    byId('connect-start').hidden = true;
    byId('connect-pending').hidden = false;
    await invoke('open_authorization_page');
    clearInterval(state.authorizationTimer);
    state.authorizationTimer = setInterval(pollAuthorization, 2_000);
  } catch (error) {
    message(errorText(error), 'error');
    button.disabled = false;
  }
}

async function pollAuthorization() {
  try {
    const result = await invoke('poll_authorization');
    if (result.status !== 'authorized') return;
    clearInterval(state.authorizationTimer);
    state.user = result.user;
    state.application = result.application;
    byId('pairing-status').textContent = 'Authorization confirmed.';
    renderAccount();
    message(`Connected as ${state.user.displayName}.`);
  } catch (error) {
    clearInterval(state.authorizationTimer);
    byId('pairing-status').textContent = errorText(error);
    message(errorText(error), 'error');
  }
}

async function joinGame(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const code = formatCode(byId('game-code').value);
    await invoke('launch_game', { code });
  } catch (error) {
    message(errorText(error), 'error');
  } finally {
    button.disabled = false;
  }
}

async function openGame() {
  try {
    await invoke('launch_game', { code: null });
  } catch (error) {
    message(errorText(error), 'error');
  }
}

async function disconnect() {
  if (!window.confirm('Disconnect and revoke this desktop installation?')) return;
  try {
    await invoke('disconnect');
    state.user = null;
    state.application = null;
    renderAccount();
    byId('connect-start').hidden = false;
    byId('connect-pending').hidden = true;
    byId('connect').disabled = false;
    message('This desktop installation was revoked.');
  } catch (error) {
    message(errorText(error), 'error');
  }
}

function wireEvents() {
  byId('connect').addEventListener('click', beginAuthorization);
  byId('open-approval').addEventListener('click', () => invoke('open_authorization_page').catch((error) => message(errorText(error), 'error')));
  byId('open-account').addEventListener('click', () => invoke('open_account_page').catch((error) => message(errorText(error), 'error')));
  byId('disconnect').addEventListener('click', disconnect);
  byId('join-form').addEventListener('submit', joinGame);
  byId('open-game').addEventListener('click', openGame);
  byId('game-code').addEventListener('input', (event) => {
    const caretAtEnd = event.target.selectionStart === event.target.value.length;
    event.target.value = formatCode(event.target.value).slice(0, 4);
    if (caretAtEnd) event.target.setSelectionRange(event.target.value.length, event.target.value.length);
  });
}

wireEvents();
bootstrap().catch((error) => {
  byId('service-origin').textContent = 'Service unavailable';
  message(errorText(error), 'error');
});
