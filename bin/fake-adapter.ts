// Phase-0 smoke test: publishes a fake adapter on the bus that emits a chunk
// every 2 seconds. Lets you verify Bonjour discovery and the broker TUI
// without launching any of the real apps.
//
// Usage:  tsx bin/fake-adapter.ts <agent-id>
//   e.g.  tsx bin/fake-adapter.ts codex

import { startAdapterServer } from '@ago/shared/bus';
import type { AgentId } from '@ago/shared/protocol';

const name = (process.argv[2] ?? 'cursor') as AgentId;

const server = await startAdapterServer(name, ['read']);
let i = 0;
setInterval(() => {
  server.emit({
    type: 'chunk',
    agent: name,
    role: 'assistant',
    text: `tick ${++i} from ${name} at ${new Date().toISOString()}`,
    ts: Date.now(),
  });
}, 2000);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});
