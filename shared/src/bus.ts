import { createServer, createConnection, type Socket } from 'node:net';
import { hostname } from 'node:os';
import {
  BONJOUR_PROTOCOL,
  BONJOUR_SERVICE_TYPE,
  type AdapterEvent,
  type AdapterMeta,
  type BrokerCommand,
  type Capability,
} from './protocol.ts';

// We prefer the native `mdns` binding (talks to macOS mDNSResponder directly)
// and fall back to pure-JS `bonjour-service` if the native build is missing.
// Both packages speak the same wire protocol; this only affects local
// reliability on the broker host.
type Discovery = {
  publish(meta: Omit<AdapterMeta, 'host'>): () => void;
  browse(onUp: (m: AdapterMeta) => void, onDown: (name: string) => void): () => void;
};

async function loadDiscovery(): Promise<Discovery> {
  try {
    // mdns ships no types; we use it untyped behind a try/catch fallback.
    const mdns = (await import('mdns' as string)) as any;
    return makeMdnsDiscovery(mdns);
  } catch {
    const { Bonjour } = await import('bonjour-service');
    return makeBonjourServiceDiscovery(new Bonjour());
  }
}

function makeMdnsDiscovery(mdns: any): Discovery {
  return {
    publish(meta) {
      const ad = mdns.createAdvertisement(
        mdns.tcp(BONJOUR_SERVICE_TYPE),
        meta.port,
        {
          name: meta.name,
          txtRecord: { name: meta.name, caps: meta.caps.join(','), pid: String(meta.pid) },
        },
      );
      ad.start();
      return () => ad.stop();
    },
    browse(onUp, onDown) {
      const browser = mdns.createBrowser(mdns.tcp(BONJOUR_SERVICE_TYPE));
      browser.on('serviceUp', (svc: any) => {
        const txt = svc.txtRecord ?? {};
        const host = svc.addresses?.find((a: string) => a.includes('.')) ?? '127.0.0.1';
        onUp({
          name: txt.name,
          caps: (txt.caps ?? '').split(',').filter(Boolean) as Capability[],
          pid: Number(txt.pid ?? 0),
          host,
          port: svc.port,
        });
      });
      browser.on('serviceDown', (svc: any) => onDown(svc.name));
      browser.start();
      return () => browser.stop();
    },
  };
}

function makeBonjourServiceDiscovery(bonjour: any): Discovery {
  return {
    publish(meta) {
      const svc = bonjour.publish({
        name: meta.name,
        type: BONJOUR_SERVICE_TYPE,
        protocol: BONJOUR_PROTOCOL,
        port: meta.port,
        txt: { name: meta.name, caps: meta.caps.join(','), pid: String(meta.pid) },
      });
      return () => svc.stop(() => {});
    },
    browse(onUp, onDown) {
      const browser = bonjour.find({ type: BONJOUR_SERVICE_TYPE, protocol: BONJOUR_PROTOCOL });
      browser.on('up', (svc: any) => {
        const txt = svc.txt ?? {};
        const host = svc.referer?.address ?? svc.host ?? '127.0.0.1';
        onUp({
          name: txt.name,
          caps: (txt.caps ?? '').split(',').filter(Boolean) as Capability[],
          pid: Number(txt.pid ?? 0),
          host,
          port: svc.port,
        });
      });
      browser.on('down', (svc: any) => onDown(svc.name));
      browser.start();
      return () => browser.stop();
    },
  };
}

// NDJSON framing helpers.
export function frameNdjson(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

export function parseNdjson<T>(buf: string): { events: T[]; rest: string } {
  const lines = buf.split('\n');
  const rest = lines.pop() ?? '';
  const events: T[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as T);
    } catch {
      // ignore malformed line, keep the stream alive
    }
  }
  return { events, rest };
}

// ----- Adapter side: serve events, accept commands -----

export interface AdapterServer {
  emit(event: AdapterEvent): void;
  onCommand(handler: (cmd: BrokerCommand) => void): void;
  close(): Promise<void>;
}

export async function startAdapterServer(
  name: AdapterMeta['name'],
  caps: Capability[],
): Promise<AdapterServer> {
  const discovery = await loadDiscovery();
  const sockets = new Set<Socket>();
  const commandHandlers: Array<(cmd: BrokerCommand) => void> = [];

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const { events, rest } = parseNdjson<BrokerCommand>(buffer);
      buffer = rest;
      for (const ev of events) {
        for (const h of commandHandlers) h(ev);
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const unpublish = discovery.publish({
    name,
    caps,
    pid: process.pid,
    port,
  });

  return {
    emit(event) {
      const line = frameNdjson(event);
      for (const s of sockets) {
        if (!s.destroyed) s.write(line);
      }
    },
    onCommand(handler) {
      commandHandlers.push(handler);
    },
    async close() {
      unpublish();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ----- Broker side: browse and connect -----

export interface BrokerClient {
  meta: AdapterMeta;
  send(cmd: BrokerCommand): void;
  close(): void;
}

export interface BrokerDiscovery {
  onAdapterUp(handler: (client: BrokerClient) => void): void;
  onAdapterDown(handler: (name: string) => void): void;
  onEvent(handler: (event: AdapterEvent) => void): void;
  stop(): void;
}

export async function startBrokerDiscovery(): Promise<BrokerDiscovery> {
  const discovery = await loadDiscovery();
  const upHandlers: Array<(c: BrokerClient) => void> = [];
  const downHandlers: Array<(name: string) => void> = [];
  const eventHandlers: Array<(e: AdapterEvent) => void> = [];
  const connections = new Map<string, BrokerClient>();

  const stop = discovery.browse(
    (meta) => {
      const socket = createConnection({ host: meta.host || '127.0.0.1', port: meta.port });
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        const { events, rest } = parseNdjson<AdapterEvent>(buffer);
        buffer = rest;
        for (const ev of events) for (const h of eventHandlers) h(ev);
      });
      const client: BrokerClient = {
        meta,
        send(cmd) {
          if (!socket.destroyed) socket.write(frameNdjson(cmd));
        },
        close() {
          socket.destroy();
        },
      };
      connections.set(meta.name, client);
      socket.on('connect', () => {
        for (const h of upHandlers) h(client);
      });
      socket.on('close', () => {
        connections.delete(meta.name);
        for (const h of downHandlers) h(meta.name);
      });
      socket.on('error', () => {
        // discovery may publish before the listener is ready; just drop
      });
    },
    (name) => {
      const c = connections.get(name);
      if (c) {
        c.close();
        connections.delete(name);
      }
    },
  );

  // ensure last-resort emitter; hostname() may matter on multi-NIC macs
  void hostname();

  return {
    onAdapterUp(h) {
      upHandlers.push(h);
    },
    onAdapterDown(h) {
      downHandlers.push(h);
    },
    onEvent(h) {
      eventHandlers.push(h);
    },
    stop() {
      stop();
      for (const c of connections.values()) c.close();
    },
  };
}
