import {
  canonicalLocalDiagnosticExportBytes,
  validateLocalDiagnosticExportJson,
} from './s2e-e1-contract.mjs';

const DISCLOSURE = 'Copies a local-only report containing a temporary diagnostic ID, browser and operating-system family, local timing, buffer and stream behavior, and categorical signal state. It contains no name, account, room code, song, audio, token, IP address, or upload.';
const STATUS = new Set(['idle', 'connecting', 'waiting', 'buffering', 'playing', 'error', 'stopped']);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class E6PanelError extends Error {
  constructor(code) {
    super(code);
    this.name = 'E6PanelError';
    this.code = code;
  }
}

function fail(code = 'panel_invalid') {
  throw new E6PanelError(code);
}

function snapshotReports(lifecycle) {
  if (!lifecycle || typeof lifecycle.instanceId !== 'string'
    || !Array.isArray(lifecycle.windows) || !Array.isArray(lifecycle.transitions)
    || !Array.isArray(lifecycle.localRecords)
    || !Number.isSafeInteger(lifecycle.droppedTransitionCount)
    || lifecycle.droppedTransitionCount < 0) fail();
  const summaries = [...lifecycle.windows, ...lifecycle.transitions]
    .sort((left, right) => left.sequence - right.sequence);
  if (summaries.some((report) => report?.instanceId !== lifecycle.instanceId)) fail();
  return summaries;
}

function latestWindow(summaries) {
  const report = [...summaries].reverse().find((entry) => entry.kind === 'listener_window');
  if (!report) return null;
  const measurements = report.measurements;
  return Object.freeze({
    bufferStatus: measurements.bufferDepth.status,
    bufferCurrentMs: measurements.bufferDepth.status === 'observed'
      ? measurements.bufferDepth.currentMs : null,
    audioContextState: measurements.audioContextState,
    signalPresence: measurements.signalPresence,
    clippingSeverity: measurements.clippingSeverity,
    underrunCount: measurements.underrunCount,
    overflowCount: measurements.overflowCount,
  });
}

export function projectE6LocalPanel({ status, lifecycle }) {
  if (!STATUS.has(status)) fail();
  const summaries = snapshotReports(lifecycle);
  return Object.freeze({
    status,
    uploadState: 'disabled',
    instanceId: lifecycle.instanceId,
    windowCount: lifecycle.windows.length,
    transitionCount: lifecycle.transitions.length,
    gapCount: lifecycle.localRecords.length,
    droppedTransitionCount: lifecycle.droppedTransitionCount,
    copyAvailable: summaries.length > 0,
    latestWindow: latestWindow(summaries),
    disclosure: DISCLOSURE,
  });
}

export function createE6LocalCopy({ lifecycle, generatedAtMonotonicMs }) {
  const summaries = snapshotReports(lifecycle);
  if (summaries.length === 0) fail('copy_unavailable');
  let normalized;
  try {
    normalized = validateLocalDiagnosticExportJson(encoder.encode(JSON.stringify({
      schemaVersion: 1,
      status: 'local_only',
      uploadState: 'disabled',
      generatedAtMonotonicMs,
      instanceId: lifecycle.instanceId,
      summaries,
    })));
  } catch {
    fail('copy_invalid');
  }
  const bytes = canonicalLocalDiagnosticExportBytes(normalized);
  return Object.freeze({
    bytes,
    text: decoder.decode(bytes),
    summaryCount: normalized.summaries.length,
    disclosure: DISCLOSURE,
  });
}

export const E6_COPY_DISCLOSURE = DISCLOSURE;

