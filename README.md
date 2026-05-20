# agent-orchestrator (macOS PoC)

> Wire **Claude Code CLI**, **Codex desktop**, **Antigravity**, and **Cursor**
> together through OS-level channels so they can observe each other's streams
> and (eventually) request help from one another — without going through any
> of their HTTP APIs.

This is the cross-app OS-integration PoC described in
`/root/.claude/plans/this-is-a-new-toasty-ladybug.md`. The pitch in one diagram:

```
                  ┌──────────────────────────┐
                  │   broker (TUI, Node)     │
                  │   - Bonjour browser      │
                  │   - routing (@mentions)  │
                  └────────┬───────┬─────────┘
            NDJSON/TCP     │       │      NDJSON/TCP
       (discovered by mDNS)│       │ (discovered by mDNS)
       ┌──────────────┐    │       │    ┌──────────────┐
       │ adapter:     │◄───┘       └───►│ adapter:     │
       │ claude-code  │                 │ codex /      │
       │              │                 │ antigravity /│
       │ hooks ───────┼──► claude CLI   │ cursor       │
       └──────────────┘                 │ CDP ─────────┼──► Electron app
                                        └──────────────┘
```

- **Bonjour** (`mdns` package, with `bonjour-service` fallback) provides
  service discovery — every adapter publishes `_agentbus._tcp.local.`,
  the broker browses for the type.
- **Chrome DevTools Protocol** is the integration channel for the three
  Electron-based GUIs (Codex desktop, Antigravity, Cursor).
- **Claude Code hooks** are the integration channel for the CLI.
- **NDJSON over TCP** is the on-wire event format between any adapter
  and the broker.

## Status

- [x] Phase 0: scaffolding + Bonjour smoke test (`bin/fake-adapter.ts`).
- [x] Phase 1 scaffolding: all four adapters compile; broker TUI works.
- [ ] Phase 1 verification: needs to run on macOS with the real apps
      installed to confirm CDP attach + DOM selectors per app.
- [ ] Phase 2: write path (broker → adapter `prompt` commands). The CDP
      adapter ships `sendPrompt` but adapters advertise `caps=['read']`
      until selectors are verified per app.
- [ ] Phase 3: peer-to-peer (`@codex …` inside a Claude Code stream
      auto-relays).

## macOS bootstrap

```sh
# Prereqs: Node 22+, pnpm 10+, tmux (optional). Apple Silicon strongly recommended.
pnpm install

# Smoke-test the bus without any real apps:
pnpm --filter @ago/broker dev          # window 1
pnpm tsx bin/fake-adapter.ts codex     # window 2
# You should see "codex" go online in the broker, with ticks every 2s.

# Then start the real adapters one at a time:
pnpm adapter:claude-code               # see "Claude Code wiring" below
pnpm adapter:codex                     # launches Codex with --remote-debugging-port=9223
pnpm adapter:antigravity               # port 9224
pnpm adapter:cursor                    # port 9225

# Or, all at once via tmux:
bin/start-all.sh
tmux attach -t agent-orchestrator
```

### Native modules

`mdns` is a native binding to macOS `mDNSResponder` — `pnpm install` will
build it via node-gyp. If the build fails, the bus falls back to
`bonjour-service` (pure JS, same wire protocol) automatically; the
adapter logs which one was loaded in `~/.agent-orchestrator/logs/`.

## Claude Code wiring

The Claude Code adapter does **not** spawn the CLI itself; it observes
the user's own session through hooks. Wire it up:

```sh
# Install the relay script into your home dir:
mkdir -p ~/.agent-orchestrator/hooks
cp adapters/claude-code/hooks/relay.sh ~/.agent-orchestrator/hooks/relay.sh
chmod +x ~/.agent-orchestrator/hooks/relay.sh
```

Then add to `~/.claude/settings.json` (merge with whatever's already there):

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "$HOME/.agent-orchestrator/hooks/relay.sh SessionStart" }
      ]}
    ],
    "UserPromptSubmit": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "$HOME/.agent-orchestrator/hooks/relay.sh UserPromptSubmit" }
      ]}
    ],
    "Stop": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "$HOME/.agent-orchestrator/hooks/relay.sh Stop" }
      ]}
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [
        { "type": "command", "command": "$HOME/.agent-orchestrator/hooks/relay.sh PostToolUse" }
      ]}
    ]
  }
}
```

The relay is `nc`-only and exits 0 if the adapter isn't running, so
leaving the hooks installed is safe even when the orchestrator is off.

## Electron adapter wiring (Codex / Antigravity / Cursor)

Each adapter looks up `selectors.json` in its package, probes the
configured `debugPort`, and if no debugger is listening, relaunches the
app via `open -na "<app>" --args --remote-debugging-port=<n>`.

**The DOM selectors in each `selectors.json` are placeholders.** None of
these apps publish their internal selectors and they change between
releases. To verify on your Mac:

1. Quit the app cleanly.
2. Launch it via the adapter (`pnpm adapter:cursor`) — it'll relaunch
   with the debug flag.
3. Visit `chrome://inspect` in any Chrome and click "inspect" on the
   matching window.
4. Use the inspector to find the actual selectors for the transcript
   root, the message nodes, and the composer input.
5. Update the adapter's `selectors.json` and restart.

`adapters/cursor/selectors.json` also has a note that the chat surface
likely lives in a `vscode-webview://` iframe, in which case
`targetUrlIncludes` may need to be the webview URL instead of
`workbench.html`.

## TUI

```
agent-orchestrator — Bonjour: _agentbus._tcp
● claude-code [read]  ● codex [read]  ● antigravity [-]  ● cursor [read]

 1:all   2:claude-code   3:codex   4:antigravity   5:cursor

┌────────────────────────────────────────────────────────────────┐
│ [codex] assistant: …streamed delta…                            │
│ [claude-code] user: ask @codex what supports top-level await   │
│ [codex] — turn end —                                           │
└────────────────────────────────────────────────────────────────┘
@all › ▮
Tab / 1–5: switch view  ·  Enter: send (needs caps=write)  ·  Ctrl-C: quit
```

Commands typed into the input box:

- `<text>` — sent to the current tab's agent (or `@all` if you're on the
  `all` tab).
- `@agent <text>` — sent to a specific agent. Only delivered if that
  adapter advertises `caps=write`.
- `@all <text>` — fan out.

## Verification checklist

The plan's verification steps, translated to commands:

| # | Step | Command / signal |
|---|---|---|
| 1 | Bonjour smoke | `dns-sd -B _agentbus._tcp .` then `pnpm tsx bin/fake-adapter.ts codex` — service appears within 1s. |
| 2 | Read path | Start each adapter; type a prompt in the corresponding app; watch the broker TUI fill. |
| 3 | Roster | Kill an adapter; broker marks it red within Bonjour TTL (~3s). |
| 4 | Phase 2 write | After verifying selectors, change the adapter's `caps` to `['read','write']`, type `@cursor hi` in the broker. Reply streams back through CDP. |
| 5 | Cross-talk (Phase 3) | TODO: broker doesn't yet auto-route `@<peer>` mentions found in agent streams. |

## Repository layout

```
agent-orchestrator/
  broker/              # Ink-based TUI
  shared/              # protocol types + Bonjour bus + CDP-Electron helper
  adapters/
    claude-code/       # hook-based observation of the user's claude CLI session
    codex/             # CDP attach to OpenAI Codex desktop
    antigravity/       # CDP attach to Google Antigravity
    cursor/            # CDP attach to Cursor
  bin/
    start-all.sh       # tmux launcher
    fake-adapter.ts    # Bonjour smoke test
```

## Risks / open questions

See "Risks / Open Questions" in the plan file. The big ones:

- **Production builds may strip `--remote-debugging-port`.** If
  `lsof -nP -iTCP:9225 -sTCP:LISTEN` shows nothing after the adapter
  tries to relaunch Cursor, the AX-fallback path (deferred) becomes
  required.
- **DOM selectors will rot on every app update.** They're externalized
  to per-adapter `selectors.json` for exactly this reason.
- **Bonjour is link-local broadcast by default.** Fine for a PoC, but
  lock it to loopback before this becomes anything more.

---

## Prior README content

The repository was previously seeded with this paragraph about an
unrelated "Collaborative Development Directives" framework. Kept here
for the record:

> *Collaborative Development Directives* represent a comprehensive,
> hierarchical framework designed to establish consistent, high-quality
> software development practices across multiple technologies and
> languages. …
