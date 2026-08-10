# CannaBeats managed audio-source PoC

This spike isolates a persistent graphical Spotify Web Playback SDK source from
the existing CannaBeats game and access services. The source node captures its
own virtual audio output and publishes it to the existing audio relay. Game
hosts and members receive session-scoped controls, never the Spotify account's
credential.

## Why this is a separate node

The game, account, invitation, and lobby services stay on the existing
`vw-services` host. The managed audio source is intentionally separate because
it has a different security and operational profile:

- its persistent Chrome profile will contain a Spotify refresh credential;
- Chrome, Xvfb, PulseAudio, VNC, and audio encoding consume substantially more
  memory than the game API;
- it may need interactive recovery or replacement without interrupting games,
  invitations, or account access; and
- the spike supports one leased source at a time, while the game remains free
  to support sessions that use a host's local player.

This is an isolation boundary, not a new home for the CannaBeats application.

## Infrastructure boundary

- Dedicated DigitalOcean Droplet; do not colocate with `vw-services`.
- No public application or remote-desktop ports.
- Initial public SSH is restricted to an operator IP by both the DigitalOcean
  firewall and UFW. It is removed only after private SSH has been verified from
  an operator device on the tailnet.
- DigitalOcean backups and snapshots remain disabled because the node will
  contain a persistent Spotify authorization.
- Start with `s-1vcpu-2gb`; resize only if measured browser or capture load
  proves that configuration insufficient.

The checked-in `infra/cloud-init.yaml` establishes the baseline only. Spotify,
graphical-browser, audio, and source-agent configuration are layered on after
the node has completed cloud-init and joined the private management network.

## Current spike deployment

| Item | Value |
| --- | --- |
| Droplet | `cannabeats-audio-source-poc` (`591348986`) |
| Region / size | NYC3 / `s-1vcpu-2gb` (1 vCPU, 2 GiB RAM) |
| Public IP | `45.55.139.37` |
| Tailscale | `cannabeats-audio-source-poc.tailce7074.ts.net` / `100.112.225.109` |
| OS | Ubuntu 24.04 LTS |
| Backups | Disabled |

The public IP is operational data, not an application dependency. The managed
source calls the public CannaBeats and relay hostnames.

## Runtime topology

```text
Xvfb :20
  ├── Chrome + persistent profile
  │     ├── loopback source UI :4781
  │     └── lease commands from controller :4782
  └── x11vnc 127.0.0.1:5900

CannaBeats game API
  → authenticated source poll/ack
  → cannabeats-source-controller :4782
  → Chrome play/pause/resume

Chrome audio
  → PulseAudio sink cannabeats_source
  → cannabeats_source.monitor
  → btaudio-push (started only while a session owns the lease)
  → cannaudio.cannabeats.social
```

The services are:

- `cannabeats-display`: the virtual graphical display;
- `cannabeats-audio`: the isolated virtual sink and monitor source;
- `cannabeats-source-agent`: the loopback-only setup/control page;
- `cannabeats-source-controller`: the device-authenticated lease poller and
  loopback command broker;
- `cannabeats-browser`: graphical Chrome using the persistent source profile;
- `cannabeats-vnc`: loopback-only interactive access; and
- `cannabeats-relay-push`: the relay publisher, deliberately disabled until a
  game-session lease controller starts it.

The source device token is readable by `cannabeats-controller`, and only its
SHA-256 hash is stored by the game server. The controller has sudo permission
for exactly two commands: starting and stopping `cannabeats-relay-push`. The
relay credential is readable by `cannabeats-relay`, not by either the
controller or Chrome user.
The Spotify credential is held in Chrome's local storage under
`/var/lib/cannabeats-source/chrome-profile`; it is not sent to the CannaBeats
server or exposed to a game host.

## Operator access

Install and join Tailscale on the operator Mac before removing the temporary
public SSH exception. Verify private access first:

```bash
ssh root@100.112.225.109
```

For initial Spotify authorization or interactive recovery, forward the
loopback VNC endpoint and open macOS Screen Sharing:

```bash
ssh -N -L 5901:127.0.0.1:5900 root@100.112.225.109
open vnc://127.0.0.1:5901
```

VNC also uses a local password file at
`/etc/cannabeats-managed-source/vnc.pass`, even though it cannot accept a
network connection. SSH/Tailscale remains the primary authentication and
encryption layer. Never publish port 5900 or replace `-localhost` in the VNC
unit.

## Spotify setup

1. Connect through the VNC tunnel and select **Connect Spotify** in Chrome.
2. Sign in to the dedicated Premium account and approve the existing CannaBeats
   Spotify application.
3. Spotify returns to `https://poc.cannabeats.social/spotify/callback`. For an
   OAuth state beginning with `managed-source.`, that page hands the callback
   to `http://127.0.0.1:4781/callback` in the same browser.
4. Select **Verify account**, then **Start browser player**. If Chrome blocks
   autoplay, select **Resume** once in the private session.
5. Play a test track and confirm activity on the virtual monitor before
   starting the relay publisher.

The callback bridge avoids registering a loopback redirect URI and does not put
the refresh credential on the CannaBeats server. The loopback agent also strips
OAuth query strings from its logs.

## Lease and command lifecycle

1. An authenticated host selects **Use managed Spotify source** in an existing
   CannaBeats lobby.
2. The game server atomically reserves one online source for that session. A
   source and a session can each have only one active lease.
3. The host's normal room polling renews the lease. If the host disappears, the
   90-second lease expires and its pending commands are deleted.
4. The source controller sees the lease, starts the relay publisher, and
   exposes only that lease's oldest pending command to Chrome.
5. Beginning, advancing, or skipping a round queues the selected track from the
   canonical game state. The browser cannot choose a different URI.
6. Any authenticated member of that game may queue pause or resume. Only the
   host may acquire/release a source or cause a track-selection command.
7. Chrome acknowledges a command only after the Web Playback SDK confirms its
   paused/playing state. The game UI receives that status through its existing
   room polling.
8. Release, game completion, or lease expiry makes the browser pause and the
   controller stop the relay publisher.

Chrome is launched with `--autoplay-policy=no-user-gesture-required` on this
dedicated, noninteractive source. This avoids a silent autoplay failure after
a browser restart. The source UI still reports SDK state before acknowledging
success.

The PulseAudio device presents to PortAudio as 44.1 kHz stereo. The repeater
negotiates and reports that source-defined format to listeners.

## Proof status

- [x] Dedicated low-cost node without changes to `vw-services`.
- [x] Graphical Chrome starts with Widevine present.
- [x] PulseAudio monitor captures non-silent synthetic audio.
- [x] The existing repeater delivered that audio to a remote listener.
- [x] A Premium account authorized successfully and the Web Playback SDK became
  ready in graphical Chrome.
- [x] Real Spotify audio reached the virtual monitor and a listener on the
  separate game droplet (44.1 kHz stereo; nonzero peak and RMS).
- [x] The Spotify authorization survived a browser restart.
- [x] Browser, relay, and Spotify credentials have separate Unix access.
- [x] Tailscale enrollment and Tailscale SSH are enabled.
- [x] Authenticated single-owner lease and ordered command queue are deployed.
- [x] A host can reacquire an expired source during an active game.
- [x] Play, pause, and resume were driven through the production CannaBeats API;
  SDK state and relayed PCM independently confirmed the results.
- [x] Explicit release and lease expiry both pause playback and stop the relay.
- [ ] Verify private administration from an operator device, then remove the
  temporary public SSH allowlist.
- [x] A full droplet reboot restored Chrome, the controller, Tailscale, the
  Spotify credential, leased playback, and non-silent relay delivery.

## Rebuild notes

`infra/install-runtime.sh` installs the graphical and audio runtime and copies
the systemd units when run from this directory as root. The `btaudio-learning`
package is a separate spike dependency and must be installed into
`/opt/btaudio-venv`; its source is not duplicated here. The relay ingest token
must be transferred out of band to
`/etc/cannabeats-managed-source/relay-ingest-token` with owner
`cannabeats-relay` and mode `0400`. Never commit it, print it, or put it in a
snapshot. The source device token belongs at
`/etc/cannabeats-managed-source/source-token`, owned by
`cannabeats-controller` with mode `0400`; register only its SHA-256 hash in
`managed_audio_sources`.
