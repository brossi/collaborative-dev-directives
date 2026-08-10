# CannaBeats desktop client PoC

This Tauri 2 application proves the player-side desktop flow without embedding the game engine or
Spotify playback:

- it opens the existing CannaBeats site in the default browser for passkey approval;
- the browser approves a particular desktop installation with a short-lived code and a fresh
  passkey assertion;
- the resulting opaque credential is stored in the operating system credential store and is never
  exposed to the bundled HTML/JavaScript UI;
- an approved installation can join a lobby by code, resume active lobbies for that account, and
  observe the authenticated member list;
- disconnecting revokes the server credential and removes the local credential-store entry.

The human-readable pairing and game codes are locators, not credentials. Desktop application
approvals can also be revoked from the account page.

## Build on macOS

The project pins its Rust toolchain. Install JavaScript dependencies and build the application:

```sh
npm install
npm run build -- --bundles app
```

The output is `src-tauri/target/release/bundle/macos/CannaBeats Client.app`.

## Development with live reload

Start the Vite development server and the Tauri application together:

```sh
CANNABEATS_ORIGIN=http://localhost:3002 npm run dev
```

Vite refreshes the webview as files in `ui/` change. CSS updates are applied without restarting the
application; HTML and JavaScript changes reload the webview. Changes in `src-tauri/` continue to
trigger Tauri's normal native rebuild and application restart. The development server listens only
on `127.0.0.1:1420`.

Omit `CANNABEATS_ORIGIN` to use the deployed service. For local server development only, the
environment variable overrides the service origin compiled into the native client.

Non-local origins must use HTTPS. The default is `https://poc.cannabeats.social`.

## Platform notes

The application uses WebKit on macOS and WebView2 on Windows through Tauri. Passkey ceremonies stay
in the user's normal browser, avoiding platform-specific embedded-webview passkey requirements. The
credential store uses macOS Keychain, Windows Credential Manager, or Secret Service on Linux.

Only the macOS bundle has been built in this spike. A distributable family build still needs Apple
Developer ID signing/notarization, and the Windows installer needs a Windows build/signing pass.

## Deliberate limits

This slice stops at authenticated join/resume/lobby behavior. It does not yet contain gameplay,
relay audio listening, Spotify, host controls, automatic updates, or production installer signing.
