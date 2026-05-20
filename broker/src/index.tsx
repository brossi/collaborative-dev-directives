import { render, Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import React, { useEffect, useMemo, useState } from 'react';
import {
  startBrokerDiscovery,
  type BrokerClient,
} from '@ago/shared/bus';
import type { AdapterEvent, AgentId } from '@ago/shared/protocol';

const ALL_AGENTS: AgentId[] = ['claude-code', 'codex', 'antigravity', 'cursor'];
const TABS: Array<'all' | AgentId> = ['all', ...ALL_AGENTS];
const MAX_EVENTS = 500;

interface RosterEntry {
  online: boolean;
  caps: string[];
  client?: BrokerClient;
}

function App() {
  const { exit } = useApp();
  const [roster, setRoster] = useState<Record<AgentId, RosterEntry>>(() => {
    const init = {} as Record<AgentId, RosterEntry>;
    for (const a of ALL_AGENTS) init[a] = { online: false, caps: [] };
    return init;
  });
  const [events, setEvents] = useState<AdapterEvent[]>([]);
  const [tab, setTab] = useState<(typeof TABS)[number]>('all');
  const [input, setInput] = useState('');
  const [discovery, setDiscovery] = useState<Awaited<ReturnType<typeof startBrokerDiscovery>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const d = await startBrokerDiscovery();
      if (cancelled) {
        d.stop();
        return;
      }
      d.onAdapterUp((client) => {
        setRoster((r) => ({
          ...r,
          [client.meta.name]: { online: true, caps: client.meta.caps, client },
        }));
      });
      d.onAdapterDown((name) => {
        setRoster((r) => ({
          ...r,
          [name as AgentId]: { online: false, caps: [] },
        }));
      });
      d.onEvent((e) => {
        setEvents((prev) => {
          const next = [...prev, e];
          if (next.length > MAX_EVENTS) next.splice(0, next.length - MAX_EVENTS);
          return next;
        });
      });
      setDiscovery(d);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      discovery?.stop();
      exit();
      return;
    }
    if (key.tab) {
      const i = TABS.indexOf(tab);
      setTab(TABS[(i + 1) % TABS.length]!);
      return;
    }
    const n = Number(ch);
    if (n >= 1 && n <= TABS.length) {
      setTab(TABS[n - 1]!);
    }
  });

  const filtered = useMemo(
    () => (tab === 'all' ? events : events.filter((e) => e.agent === tab)),
    [events, tab],
  );

  function submit() {
    const trimmed = input.trim();
    setInput('');
    if (!trimmed) return;
    // Format: "@agent text" or "@all text" or plain text (sent to current tab)
    let target: AgentId | 'all';
    let text: string;
    const m = trimmed.match(/^@(\S+)\s+(.*)$/);
    if (m) {
      target = (m[1] === 'all' ? 'all' : (m[1] as AgentId));
      text = m[2]!;
    } else {
      target = tab === 'all' ? 'all' : tab;
      text = trimmed;
    }
    const send = (name: AgentId) => {
      const r = roster[name];
      if (r?.online && r.client && r.caps.includes('write')) {
        r.client.send({ type: 'prompt', text });
      }
    };
    if (target === 'all') {
      for (const a of ALL_AGENTS) send(a);
    } else {
      send(target);
    }
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agent-orchestrator </Text>
        <Text dimColor>— Bonjour: _agentbus._tcp</Text>
      </Box>
      <Box>
        {ALL_AGENTS.map((a) => {
          const r = roster[a];
          const color = r.online ? 'green' : 'red';
          const caps = r.caps.length ? r.caps.join(',') : '-';
          return (
            <Box key={a} marginRight={2}>
              <Text color={color}>● </Text>
              <Text>{a}</Text>
              <Text dimColor> [{caps}]</Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        {TABS.map((t, i) => (
          <Box key={t} marginRight={1}>
            <Text inverse={t === tab}>
              {' '}{i + 1}:{t}{' '}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column" borderStyle="single" paddingX={1}>
        {filtered.slice(-20).map((e, i) => (
          <Text key={i}>
            <Text color="cyan">[{e.agent}]</Text>{' '}
            {e.type === 'chunk' && (
              <>
                <Text dimColor>{e.role}: </Text>
                <Text>{e.text.slice(0, 240)}</Text>
              </>
            )}
            {e.type === 'turn_end' && <Text dimColor>— turn end —</Text>}
            {e.type === 'heartbeat' && <Text dimColor>·</Text>}
            {e.type === 'error' && <Text color="red">error: {e.message}</Text>}
          </Text>
        ))}
        {filtered.length === 0 && <Text dimColor>(no events yet — start an adapter)</Text>}
      </Box>
      <Box marginTop={1}>
        <Text>{tab === 'all' ? '@all' : `@${tab}`}{' › '}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} />
      </Box>
      <Box>
        <Text dimColor>Tab / 1–5: switch view  ·  Enter: send (needs caps=write)  ·  Ctrl-C: quit</Text>
      </Box>
    </Box>
  );
}

render(<App />);
