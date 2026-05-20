// Shared CDP helper for the three Electron adapters (Codex / Antigravity / Cursor).
// Responsibilities:
//   1. Probe whether the app is exposing a remote-debugging port; if not,
//      relaunch it with `open -na "<app>" --args --remote-debugging-port=<n>`.
//   2. Attach to the right webContents target (by URL substring).
//   3. Install a MutationObserver bridge that streams transcript deltas
//      back to Node via Runtime.addBinding / Runtime.bindingCalled.
//   4. Provide a sendPrompt() that types into the composer (Phase 2).
//
// Selector config lives next to each adapter in `selectors.json`.

import CDP from 'chrome-remote-interface';
import { execa } from 'execa';
import { setTimeout as delay } from 'node:timers/promises';
import type { AgentId } from './protocol.ts';

export interface CdpSelectorConfig {
  appName: string; // for `open -na`
  bundleId?: string; // optional alternative launch path
  debugPort: number;
  targetUrlIncludes: string; // pick the right webContents
  transcriptSelector: string;
  messageSelector: string;
  roleAttribute?: string; // e.g. data-role; falls back to inferring from class
  promptInputSelector: string;
  submitKey: 'Enter' | 'Cmd+Enter';
}

const BINDING_NAME = 'agoEmit';

export interface CdpStream {
  onChunk(handler: (text: string, role: 'user' | 'assistant' | 'tool') => void): void;
  onTurnEnd(handler: () => void): void;
  sendPrompt(text: string): Promise<void>;
  close(): Promise<void>;
}

async function isPortListening(port: number): Promise<boolean> {
  try {
    const { stdout } = await execa('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { reject: false });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function launchWithDebugPort(cfg: CdpSelectorConfig): Promise<void> {
  await execa('open', ['-na', cfg.appName, '--args', `--remote-debugging-port=${cfg.debugPort}`], {
    reject: false,
    detached: true,
  });
}

async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortListening(port)) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for CDP port ${port}`);
}

async function pickTarget(port: number, urlIncludes: string): Promise<string> {
  const targets = (await CDP.List({ port })) as Array<{ type: string; url: string; webSocketDebuggerUrl: string; title: string }>;
  const match = targets.find((t) => t.type === 'page' && t.url.includes(urlIncludes));
  if (!match) {
    const summary = targets.map((t) => `${t.type} ${t.url}`).join('\n  ');
    throw new Error(`No CDP target matched "${urlIncludes}". Targets:\n  ${summary}`);
  }
  return match.webSocketDebuggerUrl;
}

export async function attachCdp(
  agent: AgentId,
  cfg: CdpSelectorConfig,
): Promise<CdpStream> {
  if (!(await isPortListening(cfg.debugPort))) {
    await launchWithDebugPort(cfg);
    await waitForPort(cfg.debugPort);
  }

  const target = await pickTarget(cfg.debugPort, cfg.targetUrlIncludes);
  const client = await CDP({ target });
  const { Page, Runtime, Input } = client;
  await Page.enable();
  await Runtime.enable();
  await Runtime.addBinding({ name: BINDING_NAME });

  const chunkHandlers: Array<(text: string, role: 'user' | 'assistant' | 'tool') => void> = [];
  const turnHandlers: Array<() => void> = [];

  Runtime.bindingCalled(({ name, payload }) => {
    if (name !== BINDING_NAME) return;
    try {
      const evt = JSON.parse(payload) as
        | { type: 'chunk'; text: string; role: 'user' | 'assistant' | 'tool' }
        | { type: 'turn_end' };
      if (evt.type === 'chunk') {
        for (const h of chunkHandlers) h(evt.text, evt.role);
      } else if (evt.type === 'turn_end') {
        for (const h of turnHandlers) h();
      }
    } catch {
      // ignore
    }
  });

  // Install the observer in the page context. We poll the transcript on
  // any DOM mutation, diff against the last snapshot, and emit the delta.
  // For Phase 1 we keep it dumb: each message is reported as a single
  // chunk once it stops changing for 250ms (debounced).
  const installScript = `
    (() => {
      if (window.__agoInstalled) return;
      window.__agoInstalled = true;
      const cfg = ${JSON.stringify({
        transcriptSelector: cfg.transcriptSelector,
        messageSelector: cfg.messageSelector,
        roleAttribute: cfg.roleAttribute ?? null,
      })};
      const emit = (obj) => window.${BINDING_NAME}(JSON.stringify(obj));
      const seen = new WeakMap();
      const debounceTimers = new WeakMap();
      function flush(node) {
        const text = (node.innerText || node.textContent || '').trim();
        if (!text || seen.get(node) === text) return;
        seen.set(node, text);
        let role = 'assistant';
        if (cfg.roleAttribute) {
          const r = node.getAttribute(cfg.roleAttribute);
          if (r) role = r;
        } else if (node.className && /user|human/i.test(node.className)) {
          role = 'user';
        }
        emit({ type: 'chunk', text, role });
      }
      function schedule(node) {
        clearTimeout(debounceTimers.get(node));
        debounceTimers.set(node, setTimeout(() => flush(node), 250));
      }
      function attach() {
        const root = document.querySelector(cfg.transcriptSelector);
        if (!root) { setTimeout(attach, 500); return; }
        const obs = new MutationObserver((muts) => {
          for (const m of muts) {
            const target = (m.target.nodeType === 1 ? m.target : m.target.parentElement);
            if (!target) continue;
            const msg = target.closest(cfg.messageSelector);
            if (msg) schedule(msg);
          }
        });
        obs.observe(root, { childList: true, subtree: true, characterData: true });
        // emit initial snapshot
        root.querySelectorAll(cfg.messageSelector).forEach(flush);
      }
      attach();
    })();
  `;
  await Runtime.evaluate({ expression: installScript, awaitPromise: true });

  return {
    onChunk(h) {
      chunkHandlers.push(h);
    },
    onTurnEnd(h) {
      turnHandlers.push(h);
    },
    async sendPrompt(text) {
      const modifiers = cfg.submitKey === 'Cmd+Enter' ? 4 : 0;
      const expr = `
        (async () => {
          const el = document.querySelector(${JSON.stringify(cfg.promptInputSelector)});
          if (!el) throw new Error('prompt input not found');
          el.focus();
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
              ?? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            setter?.call(el, ${JSON.stringify(text)});
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            // Contenteditable composer (most Electron IDEs use ProseMirror or similar)
            el.textContent = ${JSON.stringify(text)};
            el.dispatchEvent(new InputEvent('input', { bubbles: true }));
          }
        })();
      `;
      await Runtime.evaluate({ expression: expr, awaitPromise: true });
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', modifiers });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', modifiers });
    },
    async close() {
      await client.close();
    },
  };
}
