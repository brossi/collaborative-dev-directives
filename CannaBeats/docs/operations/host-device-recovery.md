# Host device enrollment and recovery

This runbook covers the small first-release authority boundary. CannaBeats has
no Host account or password: an authorized Mac is identified by a P-256 key
whose private half stays in that Mac's Secure Enclave or this-device-only
Keychain.

## Add the first Mac

1. On the server, create a random URL-safe enrollment code and invoke the
   `host-admin.mjs bootstrap-enrollment` command with the release database,
   catalog, manifest, a fresh request UUID, and `--code-fd 0`; provide the code
   on standard input. Do not put the code in command arguments, shell history,
   documentation, or logs.
2. Copy the code directly into the CannaBeats Host enrollment screen within 15
   minutes. The Mac creates its local key before redeeming the code; no browser
   account ceremony is involved.
3. After the Host proves its new key and shows the device list, discard the
   plaintext code. The server retains only its SHA-256 hash.

An already authorized Host can create another 15-minute code from the Host
device screen. Share it directly with the person enrolling the other Mac.

## Revoke a lost or replaced Mac

From a remaining authorized Host, open the device list, identify the old Mac by
its label and authorization time, and revoke it. Revocation immediately ends
that device's application sessions, web sessions, pending challenges, web
tickets, and unredeemed enrollment codes it issued.

Do not erase local CannaBeats authority merely to troubleshoot connectivity.
Local reset deletes the private signing key, device ID, and application session
from that Mac and cannot be undone. Revoke the old device first whenever it is
still reachable from another Host, then reset and enroll the Mac as a new
device.

## Recover when every authorized Mac is lost

Use server access to create one new operator bootstrap enrollment exactly as in
“Add the first Mac,” then enroll a clean Mac. Once it has proved its key, inspect
the device list and revoke every lost device. No database edit, emailed link,
recovered private key, or temporary Host password is required.

If the server database is unavailable or fails integrity validation, stop. Do
not bypass validation or manually insert a device. Restore the database using
the FR-8 backup runbook, verify readiness, and only then create the bootstrap
enrollment.
