// Claude Code adapter: observes the user's running Claude Code CLI session
// through its hook system, and re-publishes events on the orchestrator bus.
//
// Phase 1 (this file): observe-only. The user's `~/.claude/settings.json`
// is configured to call `hooks/relay.sh <HookName>` on UserPromptSubmit /
// Stop / SessionStart. The relay forwards the hook's stdin JSON to this
// adapter's Unix socket; we translate to AdapterEvent and emit on Bonjour.
//
// Phase 2 (not implemented): adapter-owned mode where we PTY-spawn the
// `claude` CLI ourselves and accept prompts via the bus. See README.

import { createServer, type Socket } from 'node:net';
import { mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startAdapterServer } from '@ago/shared/bus';
import type { AdapterEvent } from '@ago/shared/protocol';
import { createLogger } from '@ago/shared/logger';

const log = createLogger('adapter-claude-code');
const SOCK_DIR = join(homedir(), '.agent-orchestrator');
const SOCK_PATH = join(SOCK_DIR, 'claude-code.sock');

interface ClaudeHookPayload {
  hook: string; // UserPromptSubmit | Stop | SessionStart | PostToolUse | ...
  // Plus arbitrary fields Claude Code passes through stdin; varies by hook.
  prompt?: string;
  message?: { role?: string; content?: string };
  tool_use?: { name?: string; input?: unknown };
  session_id?: string;
}

function translate(payload: ClaudeHookPayload): AdapterEvent | null {
  const ts = Date.now();
  switch (payload.hook) {
    case 'UserPromptSubmit':
      if (!payload.prompt) return null;
      return { type: 'chunk', agent: 'claude-code', role: 'user', text: payload.prompt, ts };
    case 'Stop':
      return { type: 'turn_end', agent: 'claude-code', ts };
    case 'SessionStart':
      return { type: 'heartbeat', agent: 'claude-code', ts };
    case 'PostToolUse': {
      const name = payload.tool_use?.name ?? 'tool';
      return { type: 'chunk', agent: 'claude-code', role: 'tool', text: `[${name}]`, ts };
    }
    default:
      // Pass through assistant-text-bearing hooks as chunks if recognisable.
      if (payload.message?.content) {
        return {
          type: 'chunk',
          agent: 'claude-code',
          role: (payload.message.role === 'user' ? 'user' : 'assistant'),
          text: payload.message.content,
          ts,
        };
      }
      return null;
  }
}

async function main() {
  mkdirSync(SOCK_DIR, { recursive: true });
  if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);

  const server = await startAdapterServer('claude-code', ['read']);
  log('bus server started');

  const unixServer = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
    });
    socket.on('end', () => {
      // Hooks typically write a single JSON object then close.
      try {
        const payload = JSON.parse(buf) as ClaudeHookPayload;
        const event = translate(payload);
        if (event) server.emit(event);
      } catch (err) {
        log('hook payload parse failed', { err: String(err), buf: buf.slice(0, 200) });
      }
    });
  });

  unixServer.listen(SOCK_PATH, () => log('unix socket listening', { path: SOCK_PATH }));

  process.on('SIGINT', async () => {
    log('shutdown');
    unixServer.close();
    if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log('fatal', { err: String(err) });
  process.exit(1);
});
