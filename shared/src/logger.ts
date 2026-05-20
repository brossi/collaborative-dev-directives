import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = join(homedir(), '.agent-orchestrator', 'logs');
mkdirSync(LOG_DIR, { recursive: true });

export function createLogger(tag: string) {
  const file = join(LOG_DIR, `${tag}.log`);
  return (msg: string, meta?: unknown) => {
    const line = JSON.stringify({ ts: Date.now(), tag, msg, meta }) + '\n';
    try {
      appendFileSync(file, line);
    } catch {
      // best-effort
    }
  };
}
