#!/usr/bin/env node

import http from 'node:http';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { TextEncoder } from 'node:util';
import { restoreUploadedEnvelopeFromTrustedStore } from '../web/lib/s2e-e2-correlation.mjs';
import { createDiagnosticCollectorClient } from '../web/lib/server/diagnostic-collector-client.mjs';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROXY_BODY_BYTES = 8192;
const MAX_REPORTS = 4096;
const MAX_ATTEMPTS = 512;
const MAX_SAMPLES = 512;
const ROLES = new Set(['listener-a', 'listener-b', 'source', 'relay']);
const LISTENERS = new Set(['listener-a', 'listener-b']);
const PRODUCERS = Object.freeze(['listener-a', 'listener-b', 'source', 'relay']);
const KINDS = Object.freeze({
  'listener-a': 'listener_window',
  'listener-b': 'listener_window',
  source: 'source_window',
  relay: 'relay_window',
});
const ROUTES = new Set(['collector-sync', 'listener-sync', 'source-sync', 'relay-sync', 'passthrough']);
const HOP_HEADERS = new Set([
  'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'accept-encoding',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

export class S2FEvidenceError extends Error {
  constructor(code) {
    super(code);
    this.name = 'S2FEvidenceError';
    this.code = code;
  }
}

function fail(code) {
  throw new S2FEvidenceError(code);
}

function record(value, code = 'evidence_invalid') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function exact(value, keys, code = 'evidence_invalid') {
  record(value, code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) fail(code);
  return value;
}

function safeInteger(value, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail('evidence_invalid');
  return value;
}

function finite(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
    fail('evidence_invalid');
  }
  return value;
}

function role(value) {
  if (!ROLES.has(value)) fail('role_invalid');
  return value;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(fraction * ordered.length) - 1];
}

function aggregate(values) {
  if (values.length === 0) return Object.freeze({ count: 0, min: null, max: null, median: null, p95: null });
  return Object.freeze({
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  });
}

function validateRoleInstances(value) {
  exact(value, PRODUCERS);
  const owner = new Map();
  for (const producer of PRODUCERS) {
    record(value[producer]);
    const entries = Object.entries(value[producer]);
    if (entries.length < 1 || entries.length > 16) {
      fail('evidence_invalid');
    }
    for (const [label, instanceId] of entries) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(label)
        || typeof instanceId !== 'string' || owner.has(instanceId)) fail('evidence_invalid');
      owner.set(instanceId, Object.freeze({ producer, label }));
    }
  }
  return owner;
}

function validateAttempts(values) {
  if (!Array.isArray(values) || values.length > MAX_ATTEMPTS) fail('evidence_invalid');
  const counts = Object.fromEntries(PRODUCERS.map((producer) => [producer, 0]));
  let previous = -1;
  for (const value of values) {
    exact(value, ['role', 'routeFamily', 'action', 'monotonicMs']);
    const producer = role(value.role);
    if (!ROUTES.has(value.routeFamily) || value.routeFamily === 'passthrough'
      || value.action !== 'synchronize') fail('evidence_invalid');
    const expected = `${producer.startsWith('listener') ? 'listener' : producer}-sync`;
    if (value.routeFamily !== expected && value.routeFamily !== 'collector-sync') fail('evidence_invalid');
    finite(value.monotonicMs);
    if (value.monotonicMs < previous) fail('evidence_invalid');
    previous = value.monotonicMs;
    counts[producer] += 1;
  }
  return counts;
}

function validateBrowserGaps(value) {
  exact(value, ['listener-a', 'listener-b']);
  return Object.freeze({
    'listener-a': safeInteger(value['listener-a']),
    'listener-b': safeInteger(value['listener-b']),
  });
}

function validateCoverageNotices(values) {
  if (!Array.isArray(values) || values.length > MAX_ATTEMPTS) fail('evidence_invalid');
  const counts = { source: 0, relay: 0 };
  for (const value of values) {
    exact(value, ['role', 'code']);
    if (!Object.hasOwn(counts, value.role) || value.code !== 'coverage_gap') fail('evidence_invalid');
    counts[value.role] += 1;
  }
  return Object.freeze(counts);
}

function validateReports(values, owners, traceId) {
  if (!Array.isArray(values) || values.length > MAX_REPORTS) fail('evidence_invalid');
  const samples = Object.fromEntries(PRODUCERS.map((producer) => [producer, new Set()]));
  const windows = Object.fromEntries(PRODUCERS.map((producer) => [producer, 0]));
  const lastSequence = Object.fromEntries(PRODUCERS.map((producer) => [producer, null]));
  const identities = new Set();
  const instances = Object.fromEntries(PRODUCERS.map((producer) => [producer, Object.create(null)]));
  for (const { producer, label } of owners.values()) {
    instances[producer][label] = {
      acceptedSampleIds: new Set(), acceptedWindowCount: 0,
      lastSequence: null, intervals: [],
    };
  }
  for (const raw of values) {
    let envelope;
    try {
      envelope = restoreUploadedEnvelopeFromTrustedStore(encoder.encode(JSON.stringify(raw)));
    } catch {
      fail('report_invalid');
    }
    if (envelope.serverContext.traceId !== traceId) fail('report_invalid');
    const core = envelope.measurementCore;
    const owned = owners.get(core.instanceId);
    if (!owned) continue;
    const { producer, label } = owned;
    if (core.kind !== KINDS[producer]) fail('report_invalid');
    const identity = `${core.instanceId}:${core.sequence}`;
    if (identities.has(identity)) fail('report_duplicate');
    identities.add(identity);
    samples[producer].add(envelope.alignment.sample.sampleId);
    windows[producer] += 1;
    const prior = lastSequence[producer];
    lastSequence[producer] = prior === null ? core.sequence : Math.max(prior, core.sequence);
    const instance = instances[producer][label];
    instance.acceptedSampleIds.add(envelope.alignment.sample.sampleId);
    instance.acceptedWindowCount += 1;
    instance.lastSequence = instance.lastSequence === null
      ? core.sequence : Math.max(instance.lastSequence, core.sequence);
    instance.intervals.push([core.monotonicStartMs, core.monotonicStartMs + core.durationMs]);
  }
  return Object.fromEntries(PRODUCERS.map((producer) => {
    let retainedCoverageGapCount = 0;
    let acceptedCoverageMs = 0;
    const projectedInstances = Object.freeze(Object.fromEntries(Object.entries(instances[producer]).map(
      ([label, value]) => {
        const ordered = [...value.intervals].sort((left, right) => left[0] - right[0]);
        let instanceGapCount = 0;
        let instanceCoverageMs = 0;
        let currentStart = null;
        let priorEnd = null;
        for (const [start, end] of ordered) {
          if (priorEnd !== null && start > priorEnd) {
            instanceGapCount += 1;
            instanceCoverageMs += priorEnd - currentStart;
            currentStart = start;
          } else if (currentStart === null) {
            currentStart = start;
          }
          priorEnd = priorEnd === null ? end : Math.max(priorEnd, end);
        }
        if (priorEnd !== null) instanceCoverageMs += priorEnd - currentStart;
        retainedCoverageGapCount += instanceGapCount;
        acceptedCoverageMs += instanceCoverageMs;
        if (!Number.isSafeInteger(acceptedCoverageMs)) fail('evidence_invalid');
        return [label, Object.freeze({
          acceptedSampleCount: value.acceptedSampleIds.size,
          acceptedWindowCount: value.acceptedWindowCount,
          acceptedCoverageMs: instanceCoverageMs,
          retainedCoverageGapCount: instanceGapCount,
          lastSequence: value.lastSequence,
        })];
      },
    )));
    return [producer, Object.freeze({
      acceptedSampleCount: samples[producer].size,
      acceptedWindowCount: windows[producer],
      acceptedCoverageMs,
      retainedCoverageGapCount,
      lastSequence: lastSequence[producer],
      instances: projectedInstances,
    })];
  }));
}

function validateHostSamples(values) {
  if (!Array.isArray(values) || values.length > MAX_SAMPLES) fail('evidence_invalid');
  const byHost = new Map();
  for (const value of values) {
    exact(value, ['hostRole', 'monotonicMs', 'totalCpuTicks', 'processes']);
    if (!['application', 'source'].includes(value.hostRole)) fail('evidence_invalid');
    finite(value.monotonicMs);
    safeInteger(value.totalCpuTicks);
    if (!Array.isArray(value.processes) || value.processes.length < 1 || value.processes.length > 32) {
      fail('evidence_invalid');
    }
    const names = new Set();
    let cpuTicks = 0;
    let rssBytes = 0;
    for (const processValue of value.processes) {
      exact(processValue, ['service', 'cpuTicks', 'rssBytes']);
      if (typeof processValue.service !== 'string' || processValue.service.length < 1
        || processValue.service.length > 64 || names.has(processValue.service)) fail('evidence_invalid');
      names.add(processValue.service);
      cpuTicks += safeInteger(processValue.cpuTicks);
      rssBytes += safeInteger(processValue.rssBytes);
      if (!Number.isSafeInteger(cpuTicks) || !Number.isSafeInteger(rssBytes)) fail('evidence_invalid');
    }
    const list = byHost.get(value.hostRole) ?? [];
    list.push({ monotonicMs: value.monotonicMs, totalCpuTicks: value.totalCpuTicks, cpuTicks, rssBytes });
    byHost.set(value.hostRole, list);
  }
  const output = Object.create(null);
  for (const hostRole of ['application', 'source']) {
    const samples = byHost.get(hostRole) ?? [];
    if (samples.length < 2) fail('evidence_invalid');
    samples.sort((left, right) => left.monotonicMs - right.monotonicMs);
    const cpu = [];
    const rss = [];
    for (let index = 0; index < samples.length; index += 1) {
      const current = samples[index];
      rss.push(current.rssBytes);
      if (index === 0) continue;
      const prior = samples[index - 1];
      const totalDelta = current.totalCpuTicks - prior.totalCpuTicks;
      const processDelta = current.cpuTicks - prior.cpuTicks;
      if (current.monotonicMs <= prior.monotonicMs || totalDelta <= 0 || processDelta < 0
        || processDelta > totalDelta) fail('evidence_invalid');
      cpu.push((processDelta / totalDelta) * 100);
    }
    output[hostRole] = Object.freeze({ cpuPercent: aggregate(cpu), rssBytes: aggregate(rss) });
  }
  return Object.freeze(output);
}

export function summarizeEvidence(input) {
  exact(input, ['version', 'traceId', 'roleInstances', 'attempts', 'reports', 'browserGaps', 'coverageNotices', 'hostSamples']);
  if (input.version !== 1 || typeof input.traceId !== 'string' || !UUID.test(input.traceId)) {
    fail('evidence_invalid');
  }
  const owners = validateRoleInstances(input.roleInstances);
  const attempts = validateAttempts(input.attempts);
  const reports = validateReports(input.reports, owners, input.traceId);
  const browserGaps = validateBrowserGaps(input.browserGaps);
  const notices = validateCoverageNotices(input.coverageNotices);
  const producers = Object.create(null);
  for (const producer of PRODUCERS) {
    const gapCount = LISTENERS.has(producer)
      ? browserGaps[producer] : reports[producer].retainedCoverageGapCount;
    const noticeCount = LISTENERS.has(producer) ? null : notices[producer];
    producers[producer] = Object.freeze({
      attempts: attempts[producer], ...reports[producer], gapCount, noticeCount,
    });
  }
  return Object.freeze({
    version: 1,
    producers: Object.freeze(producers),
    hosts: validateHostSamples(input.hostSamples),
  });
}

export async function readCompleteTrace({ traceId, collector }) {
  if (typeof traceId !== 'string' || !UUID.test(traceId) || !collector
    || typeof collector.readTrace !== 'function') fail('configuration_invalid');
  const reports = [];
  let cursor = null;
  let metadata = null;
  for (let page = 0; page < 17; page += 1) {
    let result;
    try { result = await collector.readTrace({ traceId, cursor }); }
    catch { fail('collector_unavailable'); }
    record(result, 'collector_response_invalid');
    if (result.status !== 'found' || !Array.isArray(result.reports)
      || result.reports.length > 256 || result.metadata?.traceId !== traceId) {
      fail('collector_response_invalid');
    }
    const currentMetadata = JSON.stringify(result.metadata);
    if (metadata === null) metadata = currentMetadata;
    else if (metadata !== currentMetadata) fail('collector_response_invalid');
    reports.push(...result.reports);
    if (reports.length > MAX_REPORTS) fail('collector_response_invalid');
    if (result.complete) {
      if (result.cursor !== null || result.metadata.reportCount !== reports.length) {
        fail('collector_response_invalid');
      }
      return Object.freeze(reports);
    }
    if (result.cursor === null) fail('collector_response_invalid');
    cursor = result.cursor;
  }
  fail('collector_response_invalid');
}

export function browserGapRecord(producer, count) {
  if (!LISTENERS.has(producer)) fail('role_invalid');
  return Object.freeze({ role: producer, gapCount: safeInteger(count) });
}

export function coverageNoticeRecords(producer, lines) {
  if (!['source', 'relay'].includes(producer) || !Array.isArray(lines) || lines.length > MAX_ATTEMPTS) {
    fail('evidence_invalid');
  }
  const output = [];
  for (const line of lines) {
    if (typeof line !== 'string' || Buffer.byteLength(line) > 2048) fail('evidence_invalid');
    let accepted = line === 'coverage_gap';
    if (!accepted && producer === 'source') {
      try {
        const parsed = JSON.parse(line);
        accepted = record(parsed).service === 'managed-source-controller'
          && parsed.event === 'diagnostics.reporter_unavailable'
          && parsed.reasonCode === 'coverage_gap';
      } catch { accepted = false; }
    }
    if (accepted) output.push(Object.freeze({ role: producer, code: 'coverage_gap' }));
  }
  return Object.freeze(output);
}

function cpuTicks(text) {
  const line = text.split('\n', 1)[0];
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== 'cpu' || fields.length < 5) fail('sample_invalid');
  let total = 0;
  for (const field of fields.slice(1)) {
    if (!/^\d+$/.test(field)) fail('sample_invalid');
    total += Number(field);
    if (!Number.isSafeInteger(total)) fail('sample_invalid');
  }
  return total;
}

function processTicks(text) {
  const close = text.lastIndexOf(')');
  if (close < 2) fail('sample_invalid');
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 13 || !/^\d+$/.test(fields[11]) || !/^\d+$/.test(fields[12])) {
    fail('sample_invalid');
  }
  const total = Number(fields[11]) + Number(fields[12]);
  if (!Number.isSafeInteger(total)) fail('sample_invalid');
  return total;
}

function residentBytes(text) {
  const matches = [...text.matchAll(/^VmRSS:\s+(\d+)\s+kB$/gm)];
  if (matches.length !== 1) fail('sample_invalid');
  const value = Number(matches[0][1]) * 1024;
  if (!Number.isSafeInteger(value)) fail('sample_invalid');
  return value;
}

export async function readHostSample({
  hostRole,
  allowlistedProcesses,
  monotonicMs = Math.floor(performance.now()),
  procRoot = '/proc',
  readText = (path) => readFile(path, 'utf8'),
}) {
  if (!['application', 'source'].includes(hostRole)
    || !(allowlistedProcesses instanceof Map) || allowlistedProcesses.size < 1
    || allowlistedProcesses.size > 32 || procRoot !== '/proc') fail('configuration_invalid');
  const processes = [];
  for (const [service, pid] of allowlistedProcesses) {
    if (typeof service !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(service)
      || !Number.isSafeInteger(pid) || pid < 1) fail('configuration_invalid');
    try {
      processes.push(Object.freeze({
        service,
        cpuTicks: processTicks(await readText(`/proc/${pid}/stat`)),
        rssBytes: residentBytes(await readText(`/proc/${pid}/status`)),
      }));
    } catch (error) {
      if (error instanceof S2FEvidenceError) throw error;
      fail('sample_unavailable');
    }
  }
  let totalCpuTicks;
  try { totalCpuTicks = cpuTicks(await readText('/proc/stat')); }
  catch (error) {
    if (error instanceof S2FEvidenceError) throw error;
    fail('sample_unavailable');
  }
  return Object.freeze({
    hostRole, monotonicMs: finite(monotonicMs), totalCpuTicks,
    processes: Object.freeze(processes),
  });
}

function loopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost';
}

async function boundedBody(stream, maximum = MAX_PROXY_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maximum) fail('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function boundedResponseBody(response, maximum = MAX_PROXY_BODY_BYTES) {
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* finite cleanup */ }
        fail('upstream_invalid');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* finite cleanup */ }
  }
  return Buffer.concat(chunks, total);
}

export function createOneShotFaultProxy({
  upstreamOrigin,
  mode,
  delayMs = 0,
  deadlineMs = 5000,
  routeFamily,
  identityRoleMap,
  onAttempt = () => {},
  fetchImpl = fetch,
}) {
  let upstream;
  try { upstream = new URL(upstreamOrigin); } catch { fail('configuration_invalid'); }
  if (upstream.protocol !== 'http:' || !loopbackHost(upstream.hostname) || upstream.pathname !== '/'
    || upstream.username !== '' || upstream.password !== '' || upstream.search !== ''
    || upstream.hash !== '') {
    fail('configuration_invalid');
  }
  const classifiesAttempt = routeFamily !== 'passthrough';
  if (!ROUTES.has(routeFamily) || (classifiesAttempt && (!(identityRoleMap instanceof Map)
    || identityRoleMap.size < 1 || identityRoleMap.size > 32))) {
    fail('configuration_invalid');
  }
  for (const [identity, producer] of identityRoleMap ?? []) {
    if (typeof identity !== 'string' || !UUID.test(identity)) fail('configuration_invalid');
    role(producer);
    if (routeFamily !== 'collector-sync'
      && routeFamily !== `${producer.startsWith('listener') ? 'listener' : producer}-sync`) {
      fail('configuration_invalid');
    }
  }
  if (!['forward', 'drop-after-response', 'delay', 'malformed'].includes(mode)) fail('configuration_invalid');
  safeInteger(delayMs); safeInteger(deadlineMs, { positive: true });
  if (delayMs > 10000 || deadlineMs > 10000) fail('configuration_invalid');
  let faultAvailable = mode !== 'forward';

  return http.createServer(async (request, response) => {
    const finish = (status, body) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(body);
    };
    try {
      if (request.method !== 'POST' || typeof request.url !== 'string' || !request.url.startsWith('/')) {
        finish(404, '{"error":"unavailable","code":"unavailable"}');
        return;
      }
      if (request.url.startsWith('//')) fail('request_invalid');
      const upstreamTarget = new URL(request.url, upstream);
      if (upstreamTarget.origin !== upstream.origin) fail('request_invalid');
      const body = await boundedBody(request);
      if (classifiesAttempt) {
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { fail('request_invalid'); }
        let identity;
        if (routeFamily === 'collector-sync') {
          exact(parsed, ['traceId', 'issuance'], 'request_invalid');
          record(parsed.issuance, 'request_invalid');
          identity = parsed.issuance.instanceId;
          if (request.url !== '/v1/game/synchronization/issue') fail('request_invalid');
        } else {
          const identityField = routeFamily === 'listener-sync' ? 'grantId'
            : routeFamily === 'source-sync' ? 'sourceGrantId' : 'relayGenerationId';
          exact(parsed, ['action', 'requestId', identityField], 'request_invalid');
          if (parsed.action !== 'synchronize' || typeof parsed.requestId !== 'string'
            || !UUID.test(parsed.requestId)) fail('request_invalid');
          identity = parsed[identityField];
        }
        if (typeof identity !== 'string' || !UUID.test(identity)) fail('request_invalid');
        const producer = identityRoleMap.get(identity);
        if (!producer) fail('request_invalid');
        onAttempt(Object.freeze({
          role: producer, routeFamily, action: 'synchronize', monotonicMs: Math.floor(performance.now()),
        }));
      }
      const headers = Object.create(null);
      for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP_HEADERS.has(name) && value !== undefined) headers[name] = value;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deadlineMs);
      let upstreamResponse;
      let upstreamBody;
      try {
        upstreamResponse = await fetchImpl(upstreamTarget, {
          method: 'POST', headers, body,
          redirect: 'manual', signal: controller.signal,
        });
        upstreamBody = await boundedResponseBody(upstreamResponse);
        if (upstreamResponse.status < 100
          || upstreamResponse.status > 599 || (upstreamResponse.status >= 300 && upstreamResponse.status < 400)) {
          fail('upstream_invalid');
        }
      } finally {
        clearTimeout(timer);
      }
      const applyFault = faultAvailable;
      faultAvailable = false;
      if (applyFault && mode === 'drop-after-response') {
        response.destroy();
        return;
      }
      if (applyFault && mode === 'delay') await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (applyFault && mode === 'malformed') {
        finish(200, '{');
        return;
      }
      finish(upstreamResponse.status, upstreamBody);
    } catch {
      finish(503, '{"error":"Diagnostics are temporarily unavailable.","code":"diagnostic_unavailable"}');
    }
  });
}

async function stdinBytes() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_INPUT_BYTES) fail('input_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) fail('configuration_invalid');
  return process.argv[index + 1];
}

async function main() {
  const command = process.argv[2];
  if (command === 'summarize') {
    let input;
    try { input = JSON.parse((await stdinBytes()).toString('utf8')); } catch { fail('evidence_invalid'); }
    process.stdout.write(`${JSON.stringify(summarizeEvidence(input))}\n`);
    return;
  }
  if (command === 'summarize-live') {
    let input;
    try { input = JSON.parse((await stdinBytes()).toString('utf8')); } catch { fail('evidence_invalid'); }
    const expected = ['version', 'traceId', 'roleInstances', 'attempts',
      'browserGaps', 'coverageNotices', 'hostSamples'];
    exact(input, expected);
    const reports = await readCompleteTrace({
      traceId: input.traceId, collector: createDiagnosticCollectorClient(),
    });
    process.stdout.write(`${JSON.stringify(summarizeEvidence({ ...input, reports }))}\n`);
    return;
  }
  if (command === 'browser-gap') {
    process.stdout.write(`${JSON.stringify(browserGapRecord(argument('--role'), Number(argument('--count'))))}\n`);
    return;
  }
  if (command === 'coverage-notices') {
    const producer = argument('--role');
    const lines = (await stdinBytes()).toString('utf8').split(/\r?\n/).filter((line) => line.length > 0);
    process.stdout.write(`${JSON.stringify(coverageNoticeRecords(producer, lines))}\n`);
    return;
  }
  if (command === 'host-sample') {
    let allowlistedProcesses;
    try {
      const parsed = JSON.parse(process.env.S2F_ALLOWLISTED_PIDS_JSON ?? '');
      allowlistedProcesses = new Map(Object.entries(record(parsed, 'configuration_invalid'))
        .map(([service, pid]) => [service, Number(pid)]));
    } catch { fail('configuration_invalid'); }
    delete process.env.S2F_ALLOWLISTED_PIDS_JSON;
    process.stdout.write(`${JSON.stringify(await readHostSample({
      hostRole: argument('--host-role'), allowlistedProcesses,
    }))}\n`);
    return;
  }
  if (command === 'proxy') {
    const routeFamily = argument('--route-family');
    let identityRoleMap = null;
    if (routeFamily !== 'passthrough') {
      try {
        const parsed = JSON.parse(process.env.S2F_EPHEMERAL_ROLE_MAP ?? '');
        identityRoleMap = new Map(Object.entries(record(parsed, 'configuration_invalid')));
      } catch { fail('configuration_invalid'); }
    }
    delete process.env.S2F_EPHEMERAL_ROLE_MAP;
    const server = createOneShotFaultProxy({
      upstreamOrigin: argument('--upstream'), mode: argument('--mode'),
      delayMs: Number(process.argv.includes('--delay-ms') ? argument('--delay-ms') : 0),
      routeFamily, identityRoleMap,
      onAttempt: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
    });
    server.on('error', () => { process.exitCode = 1; });
    server.listen(Number(argument('--port')), '127.0.0.1');
    return;
  }
  fail('usage_invalid');
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    const code = error instanceof S2FEvidenceError ? error.code : 'unavailable';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
