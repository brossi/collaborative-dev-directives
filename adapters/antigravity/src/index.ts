import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startAdapterServer } from '@ago/shared/bus';
import { attachCdp, type CdpSelectorConfig } from '@ago/shared/cdp-electron';
import { createLogger } from '@ago/shared/logger';
import type { AgentId } from '@ago/shared/protocol';

const AGENT: AgentId = 'antigravity';
const log = createLogger(`adapter-${AGENT}`);
const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, '..', 'selectors.json'), 'utf8')) as CdpSelectorConfig;

async function main() {
  const server = await startAdapterServer(AGENT, ['read']);
  log('bus server started');

  const stream = await attachCdp(AGENT, cfg);
  log('cdp attached', { port: cfg.debugPort, target: cfg.targetUrlIncludes });

  stream.onChunk((text, role) => {
    server.emit({ type: 'chunk', agent: AGENT, role, text, ts: Date.now() });
  });
  stream.onTurnEnd(() => {
    server.emit({ type: 'turn_end', agent: AGENT, ts: Date.now() });
  });

  server.onCommand(async (cmd) => {
    if (cmd.type === 'prompt') {
      try {
        await stream.sendPrompt(cmd.text);
      } catch (err) {
        server.emit({ type: 'error', agent: AGENT, message: String(err), ts: Date.now() });
      }
    }
  });

  process.on('SIGINT', async () => {
    await stream.close();
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  log('fatal', { err: String(err) });
  process.exit(1);
});
