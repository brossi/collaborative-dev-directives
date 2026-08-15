import { createHash,timingSafeEqual } from "node:crypto";

import {
  canonicalMeasurementBytes,validateMeasurementJson,
} from "../s2e-e1-contract.mjs";
import {
  acceptSynchronizationSample,canonicalE2OperationCommandBytes,
  canonicalRelayBindingBytes,
  canonicalUploadedEnvelopeBytes,composeUploadedEnvelope,mapMeasurementAlignment,
  restoreE2OperationReceiptFromTrustedStore,restoreRelayBindingFromTrustedStore,
  restoreSynchronizationIssuanceFromTrustedStore,restoreTraceStateFromTrustedStore,
  restoreUploadedEnvelopeFromTrustedStore,validateE2OperationCommandJson,
  validateOperationAuthorityJson,validateServerContextJson,
  validateSynchronizationIssuanceJson,
} from "../s2e-e2-correlation.mjs";
import {
  deriveDiagnosticUuid,DiagnosticMediationError,
} from "./diagnostic-mediation.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[!-~]{32,256}$/;
const encoder = new TextEncoder();

function fail(status,code) {
  throw new DiagnosticMediationError(status,code);
}

function bytes(value) {
  return encoder.encode(JSON.stringify(value));
}

function exactUuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail(400,"request_invalid");
  return value;
}

function sameBytes(left,right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function exactContext(value,kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(502,"collector_response_invalid");
  }
  const shapes = {
    trace: { found: ["status","state"],trace_absent: ["status"] },
    issuance: { found: ["status","traceId","issuance"],sample_absent: ["status"] },
    report: { found: ["status","envelope","receivedAt"],report_absent: ["status"] },
    receipt: { found: ["status","receipt"],receipt_absent: ["status"] },
    binding: { found: ["status","binding"],binding_absent: ["status"] },
  };
  const expected = shapes[kind]?.[value.status];
  const keys = Object.keys(value);
  if (!expected || keys.length !== expected.length
    || expected.some((key) => !Object.hasOwn(value,key))) {
    fail(502,"collector_response_invalid");
  }
  return value;
}

function restoreTrace(value) {
  try { return restoreTraceStateFromTrustedStore(bytes(value)); }
  catch { fail(502,"collector_response_invalid"); }
}

function restoreIssuance(value) {
  try { return restoreSynchronizationIssuanceFromTrustedStore(bytes(value)); }
  catch { fail(502,"collector_response_invalid"); }
}

function restoreReceipt(value) {
  try { return restoreE2OperationReceiptFromTrustedStore(bytes(value)); }
  catch { fail(502,"collector_response_invalid"); }
}

function restoreBinding(value) {
  try { return restoreRelayBindingFromTrustedStore(bytes(value)); }
  catch { fail(502,"collector_response_invalid"); }
}

function exactStream(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(502,"state_response_invalid");
  }
  const keys = Object.keys(value);
  if (value.authorityVersion !== 1) fail(502,"state_response_invalid");
  if (value.status === "absent" && keys.length === 2
    && keys.includes("authorityVersion") && keys.includes("status")) return value;
  const expected = ["authorityVersion","status","runId","runGeneration","leaseId",
    "sourceId","leaseExpiresAt"];
  if (value.status !== "active" || keys.length !== expected.length
    || expected.some((key) => !Object.hasOwn(value,key))
    || !UUID.test(value.runId) || !UUID.test(value.leaseId) || !UUID.test(value.sourceId)
    || !Number.isSafeInteger(value.runGeneration) || value.runGeneration < 1
    || !Number.isSafeInteger(value.leaseExpiresAt) || value.leaseExpiresAt < 0) {
    fail(502,"state_response_invalid");
  }
  return value;
}

function fingerprint(authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")
    || !TOKEN.test(authorization.slice(7))) fail(401,"authentication_required");
  return createHash("sha256").update(`cannabeats:e8:source:${authorization}`).digest("hex");
}

function equalToken(authorization,token) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied,expected);
}

function command(requestId,operation,parameters) {
  try { return validateE2OperationCommandJson(bytes({ requestId,operation,parameters })); }
  catch { fail(400,"request_invalid"); }
}

function authority(value) {
  try { return validateOperationAuthorityJson(bytes(value)); }
  catch { fail(502,"authority_invalid"); }
}

function sourceProjection(record,status) {
  return Object.freeze({
    status,sourceGrantId: record.sourceGrantId,traceId: record.traceId,
    sourceInstanceId: record.sourceInstanceId,expiresAtMs: record.expiresAtMs,
  });
}

function relayProjection(binding,status) {
  return Object.freeze({
    status,relayGenerationId: binding.relayGenerationId,traceId: binding.traceId,
    correlationSegmentId: binding.segmentId,leaseId: binding.leaseId,
  });
}

export function createSourceGrantStore({ clock = Date.now,maxGrants = 8 } = {}) {
  if (typeof clock !== "function" || !Number.isSafeInteger(maxGrants) || maxGrants < 1) {
    throw new Error("source_grant_store_configuration_invalid");
  }
  const records = new Map();
  const requests = new Map();
  const tails = new Map();
  const depths = new Map();
  function purge(now = clock()) {
    for (const [id,record] of records) {
      if (now >= record.retainedUntilMs) records.delete(id);
    }
    for (const [id,value] of requests) {
      if (!records.has(value.sourceGrantId)) requests.delete(id);
    }
  }
  function install(requestId,requestFingerprint,record) {
    purge();
    const prior = requests.get(requestId);
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint) fail(409,"request_conflict");
      return { record: records.get(prior.sourceGrantId) ?? null,replayed: true };
    }
    if (records.size >= maxGrants || requests.size >= maxGrants) {
      fail(503,"quota_exhausted");
    }
    records.set(record.sourceGrantId,Object.freeze(record));
    requests.set(requestId,Object.freeze({ requestFingerprint,sourceGrantId: record.sourceGrantId }));
    return { record: records.get(record.sourceGrantId),replayed: false };
  }
  function request(requestId,requestFingerprint) {
    purge();
    const prior = requests.get(requestId);
    if (!prior) return null;
    if (prior.requestFingerprint !== requestFingerprint) fail(409,"request_conflict");
    const record = records.get(prior.sourceGrantId);
    if (!record) fail(409,"source_session_lost");
    return record;
  }
  function find(sourceGrantId,credentialFingerprint,{ allowExpired = false } = {}) {
    const record = records.get(sourceGrantId);
    if (!record) fail(409,"source_session_lost");
    if (record.credentialFingerprint !== credentialFingerprint) {
      fail(404,"diagnostic_not_found");
    }
    if (!allowExpired && clock() >= record.expiresAtMs) {
      fail(409,"stale_correlation");
    }
    return record;
  }
  async function serial(key,operation) {
    if (!tails.has(key) && tails.size >= maxGrants) fail(503,"quota_exhausted");
    const depth = depths.get(key) ?? 0;
    if (depth >= 2) fail(503,"collector_busy");
    depths.set(key,depth + 1);
    const prior = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    tails.set(key,current);
    try { await prior; return await operation(); }
    finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
      const next = (depths.get(key) ?? 1) - 1;
      if (next === 0) depths.delete(key); else depths.set(key,next);
    }
  }
  return Object.freeze({ install,request,find,serial,size: () => { purge(); return records.size; } });
}

export function validateDiagnosticProducerCredentials({
  relayToken,collectorGameToken,maintenanceToken = null,
}) {
  const values = maintenanceToken === null
    ? [relayToken,collectorGameToken] : [relayToken,collectorGameToken,maintenanceToken];
  if (values.some((value) => !TOKEN.test(value ?? ""))
    || new Set(values).size !== values.length) {
    throw new Error("diagnostic_producer_credential_invalid");
  }
  return Object.freeze({ relayToken,collectorGameToken,maintenanceToken });
}

export function createDiagnosticProducerMediation({
  sourceState,relayState,collector,reconcile,relayToken,collectorGameToken,
  sourceGrants = null,clock = Date.now,deadlineMs = 2_000,
} = {}) {
  if (!sourceState || !relayState || !collector || typeof reconcile !== "function"
    || typeof clock !== "function"
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("diagnostic_producer_mediation_configuration_invalid");
  }
  try { validateDiagnosticProducerCredentials({ relayToken,collectorGameToken }); }
  catch { throw new Error("diagnostic_producer_mediation_configuration_invalid"); }
  const grants = sourceGrants ?? createSourceGrantStore({ clock });

  async function bounded(operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),deadlineMs);
    try { return await operation(controller.signal); }
    catch (error) {
      if (error instanceof DiagnosticMediationError || Number.isInteger(error?.status)) throw error;
      fail(503,"diagnostic_unavailable");
    } finally { clearTimeout(timer); }
  }

  async function authenticateSource(authorization) {
    const credentialFingerprint = fingerprint(authorization);
    try {
      const stream = exactStream(await bounded((signal) => sourceState.authority({
        authorization,signal,
      })));
      return Object.freeze({ credentialFingerprint,stream });
    } catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      if ([401,403].includes(error?.status)) fail(401,"authentication_required");
      fail(503,"diagnostic_unavailable");
    }
  }

  function authenticateRelay(authorization) {
    if (!equalToken(authorization,relayToken)) fail(401,"authentication_required");
    return Object.freeze({ authenticated: true });
  }

  async function relayStream() {
    try { return exactStream(await bounded((signal) => relayState.authority({ signal })));
    } catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      fail(503,"diagnostic_unavailable");
    }
  }

  async function traceForRun(runId) {
    const found = exactContext(await collector.traceContext({ activeRunId: runId }),"trace");
    if (found.status !== "found") fail(409,"stale_correlation");
    const trace = restoreTrace(found.state);
    if (trace.runId !== runId) fail(502,"collector_response_invalid");
    return trace;
  }

  async function traceById(traceId) {
    const found = exactContext(await collector.traceContext({ traceId }),"trace");
    if (found.status !== "found") fail(409,"stale_correlation");
    const trace = restoreTrace(found.state);
    if (trace.traceId !== traceId) fail(502,"collector_response_invalid");
    return trace;
  }

  async function currentTrace(stream) {
    if (stream.status !== "active" || clock() >= stream.leaseExpiresAt) {
      fail(409,"stale_correlation");
    }
    let trace = await traceForRun(stream.runId);
    trace = await reconcile(trace);
    if (trace.status !== "active" || trace.runId !== stream.runId
      || trace.runGeneration !== stream.runGeneration
      || trace.segment.leaseId !== stream.leaseId) fail(409,"stale_correlation");
    return trace;
  }

  function requestFingerprint(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }

  async function openSource({ auth,requestId,sourceInstanceId }) {
    exactUuid(requestId); exactUuid(sourceInstanceId);
    const requestValue = { requestId,sourceInstanceId,credentialFingerprint: auth.credentialFingerprint };
    const requestDigest = requestFingerprint(requestValue);
    return grants.serial(`open:${requestId}`,async () => {
      const prior = grants.request(requestId,requestDigest);
      if (prior) return sourceProjection(prior,"replayed");
      if (auth.stream.status !== "active") fail(409,"stale_correlation");
      const trace = await currentTrace(auth.stream);
      const sourceGrantId = deriveDiagnosticUuid(
        "source-grant",auth.stream.sourceId,sourceInstanceId,trace.traceId,trace.segment.segmentId,
      );
      const outcome = grants.install(requestId,requestDigest,{
        sourceGrantId,credentialFingerprint: auth.credentialFingerprint,
        sourceId: auth.stream.sourceId,sourceInstanceId,runId: trace.runId,
        runGeneration: trace.runGeneration,traceId: trace.traceId,
        correlationSegmentId: trace.segment.segmentId,leaseId: trace.segment.leaseId,
        expiresAtMs: Math.min(auth.stream.leaseExpiresAt,trace.expiresAtMs),
        retainedUntilMs: Math.min(auth.stream.leaseExpiresAt,trace.expiresAtMs) + 900_000,
      });
      if (!outcome.record) fail(409,"source_session_lost");
      return sourceProjection(outcome.record,outcome.replayed ? "replayed" : "opened");
    });
  }

  async function sourceRecord(auth,sourceGrantId,{ allowExpired = false } = {}) {
    exactUuid(sourceGrantId);
    return grants.find(sourceGrantId,auth.credentialFingerprint,{ allowExpired });
  }

  async function currentSourceRecord(auth,sourceGrantId) {
    const record = await sourceRecord(auth,sourceGrantId);
    if (auth.stream.status !== "active" || auth.stream.sourceId !== record.sourceId
      || auth.stream.runId !== record.runId || auth.stream.runGeneration !== record.runGeneration
      || auth.stream.leaseId !== record.leaseId || clock() >= auth.stream.leaseExpiresAt) {
      fail(409,"stale_correlation");
    }
    const trace = await traceById(record.traceId);
    const reconciled = await reconcile(trace);
    if (reconciled.status !== "active"
      || reconciled.segment.segmentId !== record.correlationSegmentId
      || reconciled.segment.leaseId !== record.leaseId) fail(409,"stale_correlation");
    return record;
  }

  async function relayBinding(relayGenerationId) {
    exactUuid(relayGenerationId);
    const found = exactContext(await collector.relayBindingContext(relayGenerationId),"binding");
    if (found.status !== "found") fail(409,"relay_generation_unbound");
    const binding = restoreBinding(found.binding);
    if (binding.relayGenerationId !== relayGenerationId) fail(502,"collector_response_invalid");
    return binding;
  }

  function exactReceipt(receipt,submitted) {
    const restored = restoreReceipt(receipt);
    if (restored.requestId !== submitted.requestId || restored.operation !== submitted.operation
      || !sameBytes(canonicalE2OperationCommandBytes(restored.canonicalCommand),
        canonicalE2OperationCommandBytes(submitted))) fail(409,"request_conflict");
    return restored;
  }

  async function bindRelay({ requestId,relayGenerationId }) {
    exactUuid(requestId); exactUuid(relayGenerationId);
    const submitted = command(requestId,"relay_bind",{ relayGenerationId });
    const retained = exactContext(await collector.relayReceiptContext(requestId),"receipt");
    if (retained.status === "found") {
      const receipt = exactReceipt(retained.receipt,submitted);
      if (receipt.result.relayGenerationId !== relayGenerationId) fail(409,"request_conflict");
      return relayProjection(receipt.result,"replayed");
    }
    const stream = await relayStream();
    if (stream.status !== "active") fail(409,"stale_correlation");
    const trace = await currentTrace(stream);
    const operationAuthority = authority({
      authorityVersion: 1,operation: "relay_bind",traceId: trace.traceId,
      segmentId: trace.segment.segmentId,leaseId: trace.segment.leaseId,relayGenerationId,
    });
    const result = await collector.bindRelay({ command: submitted,authority: operationAuthority });
    if (!result || !["accepted","replayed"].includes(result.status)) {
      fail(502,"collector_response_invalid");
    }
    const receipt = exactReceipt(result.receipt,submitted);
    try {
      if (receipt.result.relayGenerationId !== relayGenerationId
        || receipt.result.traceId !== trace.traceId
        || receipt.result.segmentId !== trace.segment.segmentId
        || receipt.result.leaseId !== trace.segment.leaseId
        || !sameBytes(canonicalRelayBindingBytes(receipt.result),
          canonicalRelayBindingBytes(result.state))) fail(502,"collector_response_invalid");
    } catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      fail(502,"collector_response_invalid");
    }
    return relayProjection(receipt.result,result.status);
  }

  async function issueSample({ requestId,instanceId,binding }) {
    exactUuid(requestId); exactUuid(instanceId);
    const sampleId = deriveDiagnosticUuid("synchronization-sample",requestId);
    const retained = exactContext(await collector.issuanceContext(sampleId),"issuance");
    if (retained.status === "found") {
      const issuance = restoreIssuance(retained.issuance);
      if (retained.traceId !== binding.traceId || issuance.sampleId !== sampleId
        || issuance.timebaseId !== binding.traceId || issuance.instanceId !== instanceId) {
        fail(409,"request_conflict");
      }
      return Object.freeze({ status: "replayed",...issuance });
    }
    const serverReceiveMs = clock();
    const serverSendMs = clock();
    let issuance;
    try {
      issuance = validateSynchronizationIssuanceJson(bytes({
        sampleId,timebaseId: binding.traceId,instanceId,serverReceiveMs,serverSendMs,
      }));
    } catch { fail(502,"collector_response_invalid"); }
    const result = await collector.putIssuance({ traceId: binding.traceId,issuance });
    const status = result?.status ?? result;
    if (!["accepted","replayed"].includes(status)) fail(502,"collector_response_invalid");
    return Object.freeze({ status,...issuance });
  }

  async function synchronizeSource({ auth,requestId,sourceGrantId }) {
    return grants.serial(`grant:${sourceGrantId}`,async () => {
      const record = await currentSourceRecord(auth,sourceGrantId);
      return Object.freeze({ sourceGrantId,...await issueSample({
        requestId,instanceId: record.sourceInstanceId,binding: record,
      }) });
    });
  }

  async function synchronizeRelay({ requestId,relayGenerationId }) {
    const binding = await relayBinding(relayGenerationId);
    const trace = await traceById(binding.traceId);
    if (trace.status !== "active") fail(409,"trace_inactive");
    return Object.freeze({ relayGenerationId,...await issueSample({
      requestId,instanceId: relayGenerationId,binding,
    }) });
  }

  async function producerReport({ kind,binding,measurementCore,sampleObservation }) {
    let core;
    try { core = validateMeasurementJson(bytes(measurementCore)); }
    catch { fail(400,"report_invalid"); }
    const instanceId = kind === "source" ? binding.sourceInstanceId : binding.relayGenerationId;
    if (core.kind !== `${kind}_window` && core.kind !== `${kind}_transition`) {
      fail(400,"report_invalid");
    }
    if (core.instanceId !== instanceId) fail(400,"report_invalid");
    const retained = exactContext(await collector.reportIdentityContext({
      traceId: binding.traceId,instanceId,sequence: core.sequence,
    }),"report");
    if (retained.status === "found") {
      let envelope;
      try { envelope = restoreUploadedEnvelopeFromTrustedStore(bytes(retained.envelope)); }
      catch { fail(502,"collector_response_invalid"); }
      const context = envelope.serverContext;
      if (context.traceId !== binding.traceId || context.authorityKind !== kind
        || context.correlationSegmentId !== binding.correlationSegmentId
        || context.leaseId !== binding.leaseId
        || (kind === "source" ? context.sourceId !== binding.sourceId
          : context.relayGenerationId !== binding.relayGenerationId)
        || !sameBytes(canonicalMeasurementBytes(envelope.measurementCore),
          canonicalMeasurementBytes(core))) fail(409,"report_conflict");
      if (!Number.isSafeInteger(retained.receivedAt) || retained.receivedAt < 0) {
        fail(502,"collector_response_invalid");
      }
      return Object.freeze({ status: "replayed",receivedAt: retained.receivedAt });
    }
    const sampleId = exactUuid(sampleObservation?.sampleId);
    const issuanceContext = exactContext(await collector.issuanceContext(sampleId),"issuance");
    if (issuanceContext.status !== "found") fail(409,"stale_correlation");
    const issuance = restoreIssuance(issuanceContext.issuance);
    if (issuanceContext.traceId !== binding.traceId || issuance.timebaseId !== binding.traceId
      || issuance.instanceId !== instanceId) fail(409,"stale_correlation");
    const trace = await traceById(binding.traceId);
    if (trace.status !== "active") fail(409,"trace_inactive");
    let sample;
    let alignment;
    let context;
    let envelope;
    try {
      sample = acceptSynchronizationSample(bytes(sampleObservation),issuance);
      alignment = mapMeasurementAlignment(core,sample);
      context = validateServerContextJson(bytes({
        contextVersion: 1,traceId: binding.traceId,runId: binding.runId,
        runGeneration: binding.runGeneration,
        correlationSegmentId: binding.correlationSegmentId,leaseId: binding.leaseId,
        authorityKind: kind,role: kind,
        ...(kind === "source"
          ? { sourceId: binding.sourceId,sourceInstanceId: binding.sourceInstanceId }
          : { relayGenerationId: binding.relayGenerationId }),
      }));
      envelope = composeUploadedEnvelope(core,alignment,context);
    } catch { fail(400,"report_invalid"); }
    const result = await collector.ingestReport({ envelope,grantGeneration: null });
    if (!["accepted","replayed","trace_inactive","stale_correlation",
      "report_conflict","quota_exhausted"].includes(result?.status)) {
      fail(502,"collector_response_invalid");
    }
    if (!["accepted","replayed"].includes(result.status)) {
      return Object.freeze({ status: result.status });
    }
    let returned;
    try { returned = restoreUploadedEnvelopeFromTrustedStore(bytes(result.envelope)); }
    catch { fail(502,"collector_response_invalid"); }
    if (!sameBytes(canonicalUploadedEnvelopeBytes(returned),
      canonicalUploadedEnvelopeBytes(envelope))
      || !Number.isSafeInteger(result.receivedAt) || result.receivedAt < 0) {
      fail(502,"collector_response_invalid");
    }
    return Object.freeze({ status: result.status,receivedAt: result.receivedAt });
  }

  async function reportSource({ auth,sourceGrantId,measurementCore,sampleObservation }) {
    return grants.serial(`grant:${sourceGrantId}`,async () => {
      const record = await sourceRecord(auth,sourceGrantId,{ allowExpired: true });
      const identity = (() => {
        try { return validateMeasurementJson(bytes(measurementCore)); }
        catch { fail(400,"report_invalid"); }
      })();
      const retained = exactContext(await collector.reportIdentityContext({
        traceId: record.traceId,instanceId: identity.instanceId,sequence: identity.sequence,
      }),"report");
      if (retained.status !== "found") await currentSourceRecord(auth,sourceGrantId);
      return producerReport({ kind: "source",binding: record,measurementCore,sampleObservation });
    });
  }

  async function reportRelay({ relayGenerationId,measurementCore,sampleObservation }) {
    const bindingState = await relayBinding(relayGenerationId);
    const trace = await traceById(bindingState.traceId);
    const binding = Object.freeze({
      relayGenerationId,bindingVersion: 1,traceId: bindingState.traceId,
      correlationSegmentId: bindingState.segmentId,leaseId: bindingState.leaseId,
      runId: trace.runId,runGeneration: trace.runGeneration,
    });
    return producerReport({ kind: "relay",binding,measurementCore,sampleObservation });
  }

  return Object.freeze({
    authenticateSource,authenticateRelay,openSource,synchronizeSource,reportSource,
    bindRelay,synchronizeRelay,reportRelay,sourceGrants: grants,
  });
}
