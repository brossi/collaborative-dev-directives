# S2-E E6 local diagnostics UI and copy specification packet

## Identity and status

- Checkpoint: E6 — local UI, copy, and rendering isolation
- Scope revision: `E6-spec-v1`
- Status: `implementation-in-progress`
- Risk class: `B — boundary-bearing` because the local copy action discloses a
  privacy-projected diagnostic report
- Required verified checkpoints: E1 at `736a401`; E5 at `087b8ea`
- Explicitly excluded: upload/consent/collector persistence (E7/E8), producer
  diagnostics (E9/E10), diagnosis comparison display (E11), and real-device
  performance measurement (E12)
- Review date: primary bounded design 2026-08-14
- First implementation target: `af61f421e2b4112efd34dcb528eb964db1034d8a`,
  tree `1468935e98e5825323b8077611a4b544bfab634b`

## Boundary and scale

One listener page may expose one closed-by-default advanced panel. It renders
the current E5 instance only, retains no additional history, and offers one
local copy action and one playback-preserving diagnostic reset. There is no
dashboard framework, charting library, worker, upload queue, support account,
or automatic telemetry.

E6 trusts only reports already produced by the verified E5 lifecycle and
revalidates the complete copy through E1. Browser clipboard results and panel
events are untrusted finite outcomes. E6 never constructs measurements, changes
playback policy, or reads room, song, principal, credential, URL, or authority
data into the diagnostic projection.

## Small UI contract

The primary shared-audio row remains unchanged. Its advanced disclosure is a
native `details` element and is closed by default. While closed, it creates no
timer or recurring React update. Opening it takes one snapshot and permits at
most one one-second display refresh; collection remains entirely E5-owned.
Closing it cancels that refresh without stopping E5.

The open panel shows only:

- the existing finite stream status;
- current-instance window, transition, local-gap, and dropped-transition counts;
- the latest window's buffer status/current milliseconds, audio-context state,
  categorical signal/clipping state, and underrun/overflow counts; and
- upload state `disabled`.

No E3 diagnosis or source/relay comparison appears in E6.

Before copy, the panel displays exactly this disclosure in ordinary visible
text:

> Copies a local-only report containing a temporary diagnostic ID, browser and
> operating-system family, local timing, buffer and stream behavior, and
> categorical signal state. It contains no name, account, room code, song,
> audio, token, IP address, or upload.

Copy is enabled only when the current instance has at least one E1 report. The
copied text is exactly the UTF-8 encoding returned by
`canonicalLocalDiagnosticExportBytes`; no React state or ad-hoc wrapper is
serialized. Clipboard failure produces `copy_failed`, retains the report
locally, and never stops audio.

Reset invokes the verified `E5BrowserSession.resetDiagnostics()` operation.
The control is disabled while reset is pending. Success rotates the instance
and clears the displayed E5 rings without changing the stream, attempt, or
playback. Failure shows `reset_failed`; E5 owns any fail-closed session teardown.

## Invariants

| ID | Rule | Required evidence |
| --- | --- | --- |
| E6-READ-001 | The closed panel has no recurring subscription or render loop. | fake-timer/component open-close test |
| E6-COPY-001 | Copy contains only one validated current-instance E1 local export. | E1 boundary and mixed-instance negatives |
| E6-PRIV-001 | The disclosure precedes copy and copied bytes contain no prohibited field. | rendered text and recursive copy test |
| E6-RESET-001 | One reset is pending at a time and acknowledgement precedes UI identity rotation. | held-ack component/controller test |
| E6-ISOLATE-001 | Panel, copy, and clipboard failure cannot mutate or stop playback. | injected failure test |
| E6-BOUND-001 | E6 adds no history beyond E5's 90 windows and 64 transitions. | max-ring snapshot/copy test |

## Lifecycle and failures

| Schedule | Result |
| --- | --- |
| Open/close | Snapshot/refresh begins only while open; close cancels it. |
| Copy success | One E1 canonical local export is written and announced `copied`. |
| Copy unavailable | No clipboard call; finite `copy_unavailable`. |
| Clipboard missing/rejected | Finite `copy_failed`; E5 and playback unchanged. |
| Reset pending | Further reset controls remain disabled; no second request. |
| Reset acknowledgement | Refresh from the new E5 instance, announce `reset`. |
| Reset failure | Finite `reset_failed`; E5 decides whether the session remains active. |
| Stop/page teardown | Cancel UI refresh; E5 owns audio/resource cleanup. |

## Dependency firewall and decision

E6 may import the E1 local-export boundary and consume the exact E5 session.
It may not import E2/E3, a collector, storage, Game/State diagnostic routes, or
producer reporters. The first increment is the pure panel/copy projection with
fixed-table tests. The second attaches the verified E5 browser session and the
small React panel. These two increments may proceed together where a component
test exercises their real seam; implementation discoveries update this packet
unless they change privacy, authority, persistence, or playback ownership.

- Scale fit: yes; one panel and one clipboard action
- Open design P0/P1: none in the primary pass
- Implementation authorized: pure projection/copy and bounded React attachment
- Production attachment remains pending E6 implementation closure

## Implementation record

Increment 1 implements the framework-free current-instance panel projection and
canonical local-copy boundary. The copy is reconstructed through the verified
E1 local-export validator/encoder; empty and mixed-instance rings fail with
finite codes. No React, clipboard call, E5 mutation, upload, persistence, or
network path is attached. Focused E1/E5/E6 verification passes 34/34; lint, the
production build, and the full web suite pass 242/242. The React subscription,
clipboard invocation, reset control, and production E5 attachment remain for
the next increment and no E6 closure claim is made.
