const byId = (id) => document.getElementById(id);
const capability = 'manage_host_invitations';

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}

async function initialize() {
  try {
    const [{ user }, configuration] = await Promise.all([
      api('/api/me'),
      api('/api/admin/host-invitations'),
    ]);
    if (!user.capabilities.includes(capability)) throw new Error('Administrative capability required');
    byId('admin-name').textContent = user.displayName;
    byId('ttl-hours').value = String(configuration.defaults.ttlHours);
    byId('max-downloads').value = String(configuration.defaults.maxDownloads);
    const releaseDescription = configuration.installerChannel === 'interim'
      ? 'interim ad-hoc universal Mac installer'
      : 'notarized universal Mac installer';
    byId('release-status').textContent = configuration.installerAvailable
      ? `The ${releaseDescription} is ready. Each generated link will be limited and expiring.`
      : `The ${releaseDescription} has not been published yet. Invitation generation is disabled.`;
    byId('generate-invitation').disabled = !configuration.installerAvailable;
  } catch (error) {
    byId('release-status').textContent = error.message;
    byId('generator-status').textContent = 'Return to CannaBeats and sign in with an authorized administrator account.';
  }
}

byId('invitation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = byId('generate-invitation');
  button.disabled = true;
  byId('generator-status').textContent = 'Generating invitation…';
  try {
    const result = await api('/api/admin/host-invitations', {
      method: 'POST',
      body: JSON.stringify({
        recipientName: byId('recipient-name').value,
        ttlHours: Number(byId('ttl-hours').value),
        maxDownloads: Number(byId('max-downloads').value),
      }),
    });
    byId('invitation-email').value = result.email;
    byId('email-card').hidden = false;
    byId('generator-status').textContent = `Invitation created for ${result.recipientName}. It expires ${new Date(result.expiresAt).toLocaleString()}.`;
    byId('email-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    byId('generator-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

byId('copy-email').addEventListener('click', async () => {
  const email = byId('invitation-email');
  try {
    await navigator.clipboard.writeText(email.value);
  } catch {
    email.select();
    document.execCommand('copy');
  }
  byId('copy-email').textContent = 'Copied';
  setTimeout(() => { byId('copy-email').textContent = 'Copy email'; }, 2_000);
});

initialize();
