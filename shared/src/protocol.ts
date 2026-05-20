export const BONJOUR_SERVICE_TYPE = 'agentbus';
export const BONJOUR_PROTOCOL = 'tcp';

export type AgentId = 'claude-code' | 'codex' | 'antigravity' | 'cursor';

export type Capability = 'read' | 'write';

export interface AdapterMeta {
  name: AgentId;
  caps: Capability[];
  pid: number;
  host: string;
  port: number;
}

export interface ChunkEvent {
  type: 'chunk';
  agent: AgentId;
  text: string;
  role: 'user' | 'assistant' | 'tool';
  ts: number;
}

export interface TurnEndEvent {
  type: 'turn_end';
  agent: AgentId;
  ts: number;
}

export interface HeartbeatEvent {
  type: 'heartbeat';
  agent: AgentId;
  ts: number;
}

export interface ErrorEvent {
  type: 'error';
  agent: AgentId;
  message: string;
  ts: number;
}

export type AdapterEvent = ChunkEvent | TurnEndEvent | HeartbeatEvent | ErrorEvent;

export interface PromptCommand {
  type: 'prompt';
  text: string;
}

export type BrokerCommand = PromptCommand;
