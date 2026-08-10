const button = document.getElementById('download-host');
const status = document.getElementById('download-status');
const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';

if (/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
  button.disabled = false;
  button.textContent = 'Download CannaBeats Host';
} else {
  button.textContent = 'Installer link unavailable';
  status.textContent = 'This private installer link is missing or invalid. Ask the sender for a new invitation.';
}

button.addEventListener('click', async () => {
  button.disabled = true;
  button.textContent = 'Downloading…';
  status.textContent = '';
  try {
    const response = await fetch('/api/host-release/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Download failed (${response.status})`);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'CannaBeats-Host-universal.dmg';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    button.textContent = 'Download again';
    button.disabled = false;
    status.textContent = 'Download started. Open the DMG and drag CannaBeats Host to Applications.';
  } catch (error) {
    button.textContent = 'Try download again';
    button.disabled = false;
    status.textContent = error.message || 'Download failed.';
  }
});
