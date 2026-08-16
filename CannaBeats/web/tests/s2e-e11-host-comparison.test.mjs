import assert from "node:assert/strict";
import test from "node:test";

import { validateMeasurementJson } from "../lib/s2e-e1-contract.mjs";
import {
  acceptSynchronizationSample,composeUploadedEnvelope,
  createServerContextFixtureForTest,createSynchronizationIssuanceFixtureForTest,
  mapMeasurementAlignment,
} from "../lib/s2e-e2-correlation.mjs";
import {
  createDiagnosticComparisonService,DiagnosticComparisonError,E11_LIMITS,
  selectDiagnosticEvidence,
} from "../lib/server/diagnostic-comparison.mjs";

const TRACE = "10000000-0000-4000-8000-000000000001";
const RUN = "10000000-0000-4000-8000-000000000002";
const SEGMENT = "10000000-0000-4000-8000-000000000003";
const LEASE = "10000000-0000-4000-8000-000000000004";
const SOURCE_ID = "10000000-0000-4000-8000-000000000006";
const bytes = (value) => Buffer.from(JSON.stringify(value));
const id = (number) => `20000000-0000-4000-8000-${String(number).padStart(12,"0")}`;
let sampleSequence = 500;

function sourceReport(instanceId, sequence, start, overrides = {}) {
  return { schemaVersion: 1,kind: "source_window",instanceId,sequence,
    monotonicStartMs: start,durationMs: 10_000,measurements: {
      sampleRate: 48_000,channels: 2,encoding: "s16le",
      capturedFrames: sequence * 48_000,enqueuedFrames: sequence * 48_000,
      publishedFrames: sequence * 48_000,publishedBytes: sequence * 192_000,
      captureGapCount: 0,droppedUploadCount: 0,reconnectCount: 0,
      publisherRestartCount: 0,publisherState: "publishing",
      playbackObservation: "playing",...overrides,
    } };
}

function relayReport(instanceId, sequence, start, overrides = {}) {
  return { schemaVersion: 1,kind: "relay_window",instanceId,sequence,
    monotonicStartMs: start,durationMs: 10_000,measurements: {
      sampleRate: 48_000,channels: 2,encoding: "s16le",
      ingressFrames: sequence * 48_000,ingressBytes: sequence * 192_000,
      ingressGapCount: 0,rejectedIngressCount: 0,droppedIngressCount: 0,
      acceptedListenerCount: 2,closedListenerCount: 0,
      deliveredBytes: sequence * 192_000,backpressureClosureCount: 0,
      generationFenceDisconnectCount: 0,activeListenerCount: 2,...overrides,
    } };
}

function listenerReport(instanceId, start, overrides = {}) {
  return { schemaVersion: 1,kind: "listener_window",instanceId,sequence: 1,
    monotonicStartMs: start,durationMs: 10_000,measurements: {
      connectionAttemptSequence: 0,receivedBytes: 192_000,receivedFrames: 48_000,
      chunkCount: 100,chunkGap: { status: "observed",count: 99,meanMs: 10,maxMs: 20 },
      reconnectCount: 0,terminalCategory: "open",bufferDepth: {
        status: "observed",sampleCount: 10,currentMs: 400,minMs: 300,
        maxMs: 500,meanMs: 410,trendMsPerSecond: 2,
      },underrunCount: 0,underrunDurationMs: 0,reprimeCount: 0,
      windowStartedInUnderrun: false,overflowCount: 0,discardedFrames: 0,
      resetCount: 0,sourceSampleRate: 48_000,sourceChannels: 2,
      outputSampleRate: 48_000,nominalRateRatio: 1,audioContextState: "running",
      baseLatencyMs: { status: "observed",value: 12 },
      outputLatencyMs: { status: "unsupported" },visibilityState: "visible",
      suspensionCount: 0,longTasks: { status: "observed",count: 0,maxDurationMs: 0 },
      signalPresence: "present",clippingSeverity: "none",browserFamily: "safari",
      browserMajor: { status: "observed",value: 18 },osFamily: "ios",
      displayMode: "browser",implementationVersion: 1,...overrides,
    } };
}

function envelope(reportValue, family, {
  traceId = TRACE,segmentId = SEGMENT,leaseId = LEASE,timebaseId = TRACE,
} = {}) {
  const report = validateMeasurementJson(bytes(reportValue));
  const sampleId = id(sampleSequence++);
  const issuance = createSynchronizationIssuanceFixtureForTest(bytes({
    sampleId,timebaseId,instanceId: report.instanceId,
    serverReceiveMs: report.monotonicStartMs,serverSendMs: report.monotonicStartMs,
  }));
  const sample = acceptSynchronizationSample(bytes({
    sampleId,instanceId: report.instanceId,localSendMs: report.monotonicStartMs,
    localReceiveMs: report.monotonicStartMs,
  }),issuance);
  const authority = family === "source"
    ? { authorityKind: "source",role: "source",sourceId: SOURCE_ID,
      sourceInstanceId: report.instanceId }
    : family === "relay"
      ? { authorityKind: "relay",role: "relay",relayGenerationId: report.instanceId }
      : { authorityKind: "listener",role: "member",listenerInstanceId: report.instanceId };
  const context = createServerContextFixtureForTest(bytes({
    contextVersion: 1,traceId,runId: RUN,runGeneration: 1,
    correlationSegmentId: segmentId,leaseId,...authority,
  }));
  return composeUploadedEnvelope(report,mapMeasurementAlignment(report,sample),context);
}

function sourcePair({ anomaly = false,priorStart = 0,currentStart = 20_000 } = {}) {
  const instance = id(1);
  return [
    envelope(sourceReport(instance,0,priorStart),"source"),
    envelope(sourceReport(instance,1,currentStart,anomaly ? { captureGapCount: 1 } : {}),"source"),
  ];
}

function relayPair({ anomaly = false,priorStart = 10_000,currentStart = 40_000 } = {}) {
  const instance = id(2);
  return [
    envelope(relayReport(instance,0,priorStart),"relay"),
    envelope(relayReport(instance,1,currentStart,anomaly ? { ingressGapCount: 1 } : {}),"relay"),
  ];
}

function listener(number, start = 60_000, overrides = {}, options = {}) {
  return envelope(listenerReport(id(10 + number),start,overrides),"listener",options);
}

const delivery = { reconnectCount: 1 };
const buffer = { bufferDepth: {
  status: "observed",sampleCount: 10,currentMs: 99,minMs: 50,
  maxMs: 500,meanMs: 200,trendMsPerSecond: -1,
} };
const output = { audioContextState: "suspended",suspensionCount: 1 };

function pageFixture(reports, { pageSize = 256,repeatCursor = false } = {}) {
  const trace = {
    traceId: TRACE,runId: RUN,status: "active",startedAtMs: 1,
    expiresAtMs: 21_600_001,ended: null,
  };
  const metadata = {
    traceId: TRACE,status: "active",startedAtMs: 1,endedAtMs: null,
    endReason: null,reportCount: reports.length,
  };
  let offset = 0;
  return async ({ cursor }) => {
    const current = offset;
    const selected = reports.slice(current,current + pageSize);
    offset += selected.length;
    const complete = offset === reports.length;
    const next = complete ? null : {
      readSessionId: id(900),last: {
        mappedStartEarliestMs: repeatCursor ? 1 : offset,
        mappedEndLatestMs: repeatCursor ? 2 : offset + 1,
        kind: "listener_window",instanceId: id(901),sequence: repeatCursor ? 1 : offset,
      },
    };
    if (current === 0) assert.equal(cursor,null);
    return { trace,status: "found",complete,metadata,reports: selected,cursor: next };
  };
}

async function compareReports(reports, options = {}) {
  return createDiagnosticComparisonService({
    readPage: pageFixture(reports,options),deadlineMs: 100,
  }).compare({ headers: {},traceId: TRACE });
}

test("five fixed E3 results pass through deterministic E11 selection", async () => {
  const cases = [
    ["source_suspected",[
      ...sourcePair({ anomaly: true,currentStart: 20_000 }),
      ...relayPair({ anomaly: true,priorStart: 30_000,currentStart: 40_000 }),
      listener(1,60_000,delivery),listener(2,60_000,delivery),
    ]],
    ["relay_suspected",[
      ...sourcePair({ currentStart: 70_000 }),...relayPair({ anomaly: true }),
      listener(1,60_000,delivery),listener(2,60_000,delivery),
    ]],
    ["listener_delivery_suspected",[
      ...sourcePair({ currentStart: 70_000 }),...relayPair({ currentStart: 70_000 }),
      listener(1,60_000,delivery),listener(2,60_000),
    ]],
    ["listener_buffer_suspected",[
      ...sourcePair({ currentStart: 70_000 }),...relayPair({ currentStart: 70_000 }),
      listener(1,60_000,buffer),listener(2,60_000),
    ]],
    ["browser_output_suspected",[
      ...sourcePair({ currentStart: 70_000 }),...relayPair({ currentStart: 70_000 }),
      listener(1,60_000,output),listener(2,60_000),
    ]],
  ];
  for (const [expected,reports] of cases) {
    const result = await compareReports(reports);
    assert.equal(result.diagnosis.result,expected);
    assert.equal(result.diagnosis.missing.length,0);
    assert.ok(result.diagnosis.evidenceCount <= 12);
    assert.equal("contributing" in result.diagnosis,false);
    assert.equal(JSON.stringify(result).includes(id(11)),false);
  }
});

test("selection never falls back to an older source instance and excludes stale listeners", () => {
  const old = sourcePair({ currentStart: 20_000 });
  const newestInstance = id(50);
  const reports = [
    ...old,envelope(sourceReport(newestInstance,0,80_000),"source"),
    ...relayPair({ currentStart: 90_000 }),listener(1,80_000),listener(2,10_000),
  ];
  const selected = selectDiagnosticEvidence(reports);
  assert.equal(selected.source,null);
  assert.deepEqual(selected.listeners.map(
    (value) => value.measurementCore.instanceId,
  ),[id(11)]);
});

test("newest listener partition wins and nine recent listeners fail insufficient", async () => {
  const olderForeign = listener(99,1_000,{}, { segmentId: id(88),leaseId: id(89) });
  const reports = [
    olderForeign,...sourcePair({ currentStart: 70_000 }),...relayPair({ currentStart: 70_000 }),
    ...Array.from({ length: 9 },(_,index) => listener(index + 1,60_000)),
  ];
  const result = await compareReports(reports);
  assert.equal(result.diagnosis.result,"insufficient_evidence");
  assert.deepEqual(result.diagnosis.missing,["listener"]);
  assert.equal(selectDiagnosticEvidence(reports).listeners.length,9);
});

test("listener selection enforces exact capacity and cohort-horizon boundaries", () => {
  for (const count of [7,8,9]) {
    const selected = selectDiagnosticEvidence([
      ...sourcePair({ currentStart: 100_000 }),...relayPair({ currentStart: 100_000 }),
      ...Array.from({ length: count },(_,index) => listener(index + 1,90_000)),
    ]);
    assert.equal(selected.listeners.length,count);
  }
  const reports = [
    listener(1,90_000),
    listener(2,30_001),
    listener(3,30_000),
    listener(4,29_999),
  ];
  assert.deepEqual(selectDiagnosticEvidence(reports).listeners.map(
    (value) => value.measurementCore.instanceId,
  ),[id(11),id(12),id(13)]);
});

test("listener-anchor ties use only the lexical partition and identities are unique", () => {
  const lowerSegment = id(80);
  const upperSegment = id(90);
  const reports = [
    listener(1,60_000,{}, { segmentId: lowerSegment }),
    envelope(sourceReport(id(70),0,90_000),"source",{ segmentId: lowerSegment }),
    listener(2,60_000,{}, { segmentId: upperSegment }),
  ];
  const selected = selectDiagnosticEvidence(reports);
  assert.equal(selected.listeners[0].serverContext.correlationSegmentId,upperSegment);
  const duplicate = listener(3,60_000);
  assert.throws(() => selectDiagnosticEvidence([duplicate,duplicate]),
    (error) => error.code === "collector_response_invalid");
});

test("missing contradictory and overlapping evidence remain finite and explicit", async () => {
  const cases = [
    ["source",[...relayPair({ currentStart: 70_000 }),listener(1)]],
    ["relay",[...sourcePair({ currentStart: 70_000 }),listener(1)]],
    ["listener",[...sourcePair({ currentStart: 70_000 }),
      ...relayPair({ currentStart: 70_000 })]],
    ["contradictory_evidence",[...sourcePair({ currentStart: 70_000 }),
      ...relayPair({ currentStart: 70_000 }),listener(1,60_000,delivery),
      listener(2,60_000,delivery)]],
    ["ordering_overlap",[...sourcePair({ anomaly: true,currentStart: 30_000 }),
      ...relayPair({ anomaly: true,priorStart: 20_000,currentStart: 40_000 }),
      listener(1,60_000,delivery),listener(2,60_000,delivery)]],
  ];
  for (const [missing,reports] of cases) {
    const result = await compareReports(reports);
    assert.equal(result.diagnosis.result,"insufficient_evidence");
    assert.deepEqual(result.diagnosis.missing,[missing]);
  }
});

test("one and multiple pages produce one complete privacy-minimized snapshot", async () => {
  const base = [
    ...sourcePair({ currentStart: 70_000 }),...relayPair({ currentStart: 70_000 }),listener(1,60_000),
  ];
  const one = await compareReports(base);
  const many = await compareReports(base,{ pageSize: 1 });
  assert.deepEqual(many,one);
  assert.deepEqual(Object.keys(one),[
    "comparisonVersion","trace","reportCount","diagnosis",
  ]);
  assert.equal(one.reportCount,5);
  assert.equal(one.trace.traceId,TRACE);
  assert.equal("runId" in one.trace,false);
});

test("paging rejects repeated cursors, cross-page substitution, and a seventeenth page", async () => {
  const item = listener(1,60_000);
  await assert.rejects(() => compareReports([item,item,item],{
    pageSize: 1,repeatCursor: true,
  }),(error) => error instanceof DiagnosticComparisonError
    && error.code === "collector_response_invalid");

  let count = 0;
  const changed = createDiagnosticComparisonService({ readPage: async () => {
    count += 1;
    const page = await pageFixture([item,item],{ pageSize: 1 })({ cursor: null });
    return count === 1 ? page : {
      ...page,trace: { ...page.trace,startedAtMs: 2 },
    };
  } });
  await assert.rejects(() => changed.compare({ headers: {},traceId: TRACE }),
    (error) => error.code === "collector_response_invalid");

  assert.deepEqual(E11_LIMITS,{ maxPages: 16,maxReports: 4096,maxListeners: 8,
    cohortHorizonMs: 60_000 });
  for (const count of [255,256,257,4_095,4_096]) {
    const result = await compareReports(Array.from(
      { length: count },(_,index) => listener(index + 100,60_000),
    ),{ pageSize: 256 });
    assert.equal(result.reportCount,count);
  }
  await assert.rejects(() => compareReports(Array.from(
    { length: 4_097 },(_,index) => listener(index + 100,60_000),
  ),{ pageSize: 256 }),
    (error) => error.code === "collector_response_invalid");
});

test("outer timeout publishes no partial diagnosis and starts no later page", async () => {
  let calls = 0;
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const service = createDiagnosticComparisonService({
    deadlineMs: 5,readPage: async () => { calls += 1; await held; return {}; },
  });
  await assert.rejects(() => service.compare({ headers: {},traceId: TRACE }),
    (error) => error.code === "request_timeout");
  assert.equal(calls,1);
  release();
});
