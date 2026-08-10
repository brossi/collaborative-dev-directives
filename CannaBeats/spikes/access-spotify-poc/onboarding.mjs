import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInvitation, normalizeInvitationCode, sha256 } from './db.mjs';

function cleanRecipientName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 60) throw new Error('Recipient name must be 1-60 characters');
  return name;
}

export function createHostOnboarding(db, {
  recipientName,
  origin,
  releasePath,
  releaseName = 'CannaBeats-Host-universal.dmg',
  ttlHours = 48,
  maxDownloads = 5,
} = {}) {
  const name = cleanRecipientName(recipientName);
  const appOrigin = new URL(origin).origin;
  if (!releasePath || !existsSync(releasePath)) {
    throw new Error('The notarized CannaBeats Host release is not installed on this server');
  }
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
    throw new Error('Onboarding lifetime must be between 1 and 168 hours');
  }
  if (!Number.isInteger(maxDownloads) || maxDownloads < 1 || maxDownloads > 20) {
    throw new Error('Maximum downloads must be between 1 and 20');
  }
  const safeReleaseName = String(releaseName).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.dmg$/.test(safeReleaseName)) {
    throw new Error('Release filename must be a safe DMG filename');
  }

  const downloadToken = randomBytes(32).toString('base64url');
  let invitation;
  db.exec('BEGIN IMMEDIATE');
  try {
    invitation = createInvitation(db, { role: 'host', note: name, ttlHours });
    const invitationHash = sha256(normalizeInvitationCode(invitation.code));
    db.prepare(`
      INSERT INTO host_release_downloads
        (token_hash, invitation_hash, recipient_name, release_name,
         created_at, expires_at, max_downloads)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sha256(downloadToken), invitationHash, name, safeReleaseName,
      Date.now(), invitation.expiresAt, maxDownloads,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return {
    recipientName: name,
    invitationCode: invitation.code,
    expiresAt: invitation.expiresAt,
    maxDownloads,
    releaseName: safeReleaseName,
    accountSetupUrl: `${appOrigin}/#invite=${encodeURIComponent(invitation.code)}`,
    downloadUrl: `${appOrigin}/host-download#token=${encodeURIComponent(downloadToken)}`,
  };
}

export function renderHostOnboardingEmail(onboarding, { senderName = 'CannaBeats' } = {}) {
  const firstName = onboarding.recipientName.split(' ')[0];
  const expires = new Date(onboarding.expiresAt).toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
  });
  return `Subject: Your private CannaBeats Host invitation

Hi ${firstName},

I'd like to authorize you to host our private CannaBeats games. This invitation and installer link expire on ${expires}.

1. Download CannaBeats Host
${onboarding.downloadUrl}

Open the downloaded DMG, then drag CannaBeats Host into Applications.

2. Create your private host account
${onboarding.accountSetupUrl}

The page will fill in your one-time invitation automatically. Enter your name, choose Create passkey, and approve the normal Touch ID or macOS security prompt.

Invitation code if you need to enter it manually: ${onboarding.invitationCode}

3. Link your Mac

Open CannaBeats Host from Applications and choose Pair this Mac. It will open a ten-minute approval request in your browser. Sign in with your new passkey and authorize the named Mac.

4. Confirm managed Spotify

The game selects the private CannaBeats Linux Spotify source by default. Confirm that the lobby says the managed source is reserved; you do not need the managed Spotify account's password or credential. "Spotify on this device" remains an advanced fallback and requires your own eligible Spotify account.

5. Optional: install the web client as a PWA

In Safari on macOS, open CannaBeats and choose File > Add to Dock. You can also keep using the normal browser. The installed app and browser may keep separate local settings, but the normal managed Spotify source does not store a Spotify credential in either one.

6. Host a game

Start CannaBeats Host first and choose Create new lobby & open CannaBeats. Configure the game, confirm the Linux Spotify source is selected, ask phone players to scan the private guest QR, then start the game. The guest QR stops admitting new players when the game begins. Screen & System Audio Recording is not required unless you deliberately use the advanced local-Mac audio fallback.

For each round, start the song, let the active player place it on their timeline, allow any configured retraction window, reveal the answer, and advance to the next player. The game lobby and playback controls report the managed source's current status.

If anything fails during setup, send me the exact status shown in CannaBeats Host before resetting or removing the local identity.

—${String(senderName).trim() || 'CannaBeats'}
`;
}
