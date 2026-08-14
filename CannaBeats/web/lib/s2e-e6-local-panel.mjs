import {
  canonicalLocalDiagnosticExportBytes, canonicalMeasurementBytes,
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
  const summaries = [...lifecycle.windows, ...lifecycle.transitions];
  try {
    for (const report of summaries) canonicalMeasurementBytes(report);
  } catch {
    fail();
  }
  if (summaries.some((report) => report?.instanceId !== lifecycle.instanceId)) fail();
  summaries.sort((left, right) => left.sequence - right.sequence);
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

const EMPTY_PANEL_STATE = Object.freeze({
  open: false, diagnostics: null, busy: false, notice: '',
});

export class E6PanelController {
  constructor({ read, copy, reset, scheduleInterval, cancelInterval, onChange }) {
    if (![read, copy, reset, scheduleInterval, cancelInterval, onChange]
      .every((value) => typeof value === 'function')) fail('controller_invalid');
    this.read = read;
    this.copyAction = copy;
    this.resetAction = reset;
    this.scheduleInterval = scheduleInterval;
    this.cancelInterval = cancelInterval;
    this.onChange = onChange;
    this.enabled = false;
    this.generation = -1;
    this.timer = null;
    this.actionToken = 0;
    this.disposed = false;
    this.state = EMPTY_PANEL_STATE;
  }

  sync({ enabled, generation }) {
    if (this.disposed || typeof enabled !== 'boolean'
      || !Number.isSafeInteger(generation) || generation < 0) fail('controller_invalid');
    const replaced = generation !== this.generation;
    this.enabled = enabled;
    this.generation = generation;
    if (replaced || !enabled) {
      this.actionToken += 1;
      this.#cancelTimer();
      this.#publish(EMPTY_PANEL_STATE);
    }
  }

  setOpen(open) {
    if (this.disposed || typeof open !== 'boolean') fail('controller_invalid');
    if (!this.enabled || !open) {
      this.#cancelTimer();
      this.#publish({ ...this.state, open: false });
      return;
    }
    this.#publish({ ...this.state, open: true });
    this.#refresh();
    if (this.timer === null) {
      this.timer = this.scheduleInterval(() => this.#refresh(), 1000);
    }
  }

  async copy() {
    if (this.disposed || this.state.busy) return false;
    if (!this.state.diagnostics?.copyAvailable) {
      this.#publish({ ...this.state, notice: 'copy_unavailable' });
      return false;
    }
    return this.#action('copied', this.copyAction, false);
  }

  async reset() {
    if (this.disposed || this.state.busy || !this.state.diagnostics) return false;
    return this.#action('reset', this.resetAction, true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.actionToken += 1;
    this.#cancelTimer();
  }

  async #action(success, action, refresh) {
    const token = ++this.actionToken;
    const generation = this.generation;
    this.#publish({ ...this.state, busy: true, notice: '' });
    try {
      await action();
      if (!this.#current(token, generation)) return false;
      if (refresh) this.#refresh();
      this.#publish({ ...this.state, busy: false, notice: success });
      return true;
    } catch {
      if (!this.#current(token, generation)) return false;
      this.#publish({ ...this.state, busy: false, notice: `${success}_failed` });
      return false;
    }
  }

  #current(token, generation) {
    return !this.disposed && token === this.actionToken
      && generation === this.generation && this.enabled;
  }

  #refresh() {
    if (this.disposed || !this.enabled || !this.state.open) return;
    let diagnostics = null;
    try {
      diagnostics = this.read();
    } catch {
      diagnostics = null;
    }
    this.#publish({ ...this.state, diagnostics });
  }

  #cancelTimer() {
    if (this.timer === null) return;
    this.cancelInterval(this.timer);
    this.timer = null;
  }

  #publish(next) {
    this.state = Object.freeze(next);
    try {
      this.onChange(this.state);
    } catch {
      // Rendering observation never affects collection or playback.
    }
  }
}

export const E6_EMPTY_PANEL_STATE = EMPTY_PANEL_STATE;
