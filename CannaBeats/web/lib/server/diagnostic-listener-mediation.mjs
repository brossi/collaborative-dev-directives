import {
  canonicalMeasurementBytes,validateMeasurementJson,
} from "../s2e-e1-contract.mjs";
import {
  acceptSynchronizationSample,canonicalE2OperationCommandBytes,
  canonicalUploadedEnvelopeBytes,composeUploadedEnvelope,
  mapMeasurementAlignment,restoreE2OperationReceiptFromTrustedStore,
  restoreSynchronizationIssuanceFromTrustedStore,restoreTraceStateFromTrustedStore,
  restoreUploadedEnvelopeFromTrustedStore,validateE2OperationCommandJson,
  validateOperationAuthorityJson,validateServerContextJson,
  validateSynchronizationIssuanceJson,
} from "../s2e-e2-correlation.mjs";
import { DiagnosticMediationError,deriveDiagnosticUuid } from "./diagnostic-mediation.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();
const GRANT_LIFETIME_MS = 15 * 60 * 1000;
const MAX_GRANTS = 32;

function fail(status,code) {
  throw new DiagnosticMediationError(status,code);
}

function bytes(value) {
  return encoder.encode(JSON.stringify(value));
}

function sameBytes(left,right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function exactUuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) fail(400,"request_invalid");
  return value;
}

function restoreTrace(value) {
  try { return restoreTraceStateFromTrustedStore(bytes(value)); }
  catch { fail(502,"collector_response_invalid"); }
}

function restoreReceipt(value) {
  try { return restoreE2OperationReceiptFromTrustedStore(bytes(value)); }
  catch { fail(502,"collector_response_invalid"); }
}

function restoreIssuance(value) {
  try { return restoreSynchronizationIssuanceFromTrustedStore(bytes(value)); }
  catch { fail(502,"collector_response_invalid"); }
}

function command(value) {
  try { return validateE2OperationCommandJson(bytes(value)); }
  catch { fail(400,"request_invalid"); }
}

function authority(value) {
  try { return validateOperationAuthorityJson(bytes(value)); }
  catch { fail(502,"collector_response_invalid"); }
}

function exactMember(value,runId) {
  if (!value || value.authorityVersion !== 1 || value.runId !== runId
    || !["active","ended"].includes(value.status)
    || !["host","member"].includes(value.role)
    || !Number.isSafeInteger(value.runGeneration) || value.runGeneration < 1
    || Object.keys(value).length !== 5) fail(502,"state_response_invalid");
  return value;
}

const ABSENT_CONTEXT = Object.freeze({
  state: "trace_absent",receipt: "receipt_absent",issuance: "sample_absent",
  envelope: "report_absent",
});

function context(value,payloadKey) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(502,"collector_response_invalid");
  }
  if (value.status === ABSENT_CONTEXT[payloadKey]
    && Object.keys(value).length === 1) return value;
  if (value.status === "found" && Object.keys(value).length === (
    ["issuance","envelope"].includes(payloadKey) ? 3 : 2
  )
    && Object.hasOwn(value,payloadKey)) return value;
  fail(502,"collector_response_invalid");
}

function exactPrincipal(value) {
  const principal = value?.principal;
  if (!principal || typeof principal.id !== "string" || !principal.id) {
    fail(503,"diagnostic_unavailable");
  }
  return principal;
}

function grantProjection(record) {
  return Object.freeze({
    status: record.status,grantId: record.grantId,traceId: record.traceId,
    listenerInstanceId: record.listenerInstanceId,generation: record.generation,
    expiresAtMs: record.expiresAtMs,
  });
}

function sameGrant(left,right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameGrantBinding(left,right) {
  return ["grantId","principalId","runId","runGeneration","traceId",
    "correlationSegmentId","leaseId","listenerInstanceId","role","generation",
    "expiresAtMs","optInRequestId"].every((key) => left[key] === right[key]);
}

export function createListenerGrantStore({ clock = Date.now,maxGrants = MAX_GRANTS } = {}) {
  if (typeof clock !== "function" || !Number.isSafeInteger(maxGrants) || maxGrants < 1) {
    throw new Error("listener_grant_store_configuration_invalid");
  }
  const records = new Map();
  const pendingOptIns = new Map();
  const tails = new Map();

  function purge(now = clock()) {
    for (const [id,record] of records) {
      if (now >= record.expiresAtMs) records.delete(id);
    }
    for (const [id,record] of pendingOptIns) {
      if (now >= record.expiresAtMs) pendingOptIns.delete(id);
    }
  }

  function find(grantId,principalId,{ allowRevoked = false } = {}) {
    purge();
    const record = records.get(exactUuid(grantId));
    if (!record || record.principalId !== principalId) fail(404,"diagnostic_not_found");
    if (!allowRevoked && record.status !== "enabled") fail(409,"sharing_disabled");
    return record;
  }

  function install(input) {
    purge();
    const record = Object.freeze({ ...input });
    const prior = records.get(record.grantId);
    if (prior) {
      if (!sameGrant(prior,record)) fail(409,"request_conflict");
      pendingOptIns.delete(record.optInRequestId);
      return prior;
    }
    if (!pendingOptIns.has(record.optInRequestId)
      && records.size + pendingOptIns.size >= maxGrants) fail(503,"quota_exhausted");
    records.set(record.grantId,record);
    pendingOptIns.delete(record.optInRequestId);
    return record;
  }

  function rememberOptIn(input) {
    purge();
    const record = Object.freeze({ ...input });
    const prior = pendingOptIns.get(record.requestId);
    if (prior) {
      if (!sameGrant(prior,record)) fail(409,"request_conflict");
      return prior;
    }
    if (records.size + pendingOptIns.size >= maxGrants) fail(503,"quota_exhausted");
    pendingOptIns.set(record.requestId,record);
    return record;
  }

  function pendingOptIn(requestId) {
    purge();
    return pendingOptIns.get(requestId) ?? null;
  }

  function revoke(grantId,requestId) {
    const prior = records.get(grantId);
    if (!prior) fail(404,"diagnostic_not_found");
    if (prior.status === "revoked" && prior.lastStopRequestId !== requestId) {
      fail(409,"sharing_disabled");
    }
    const next = Object.freeze({
      ...prior,status: "revoked",lastStopRequestId: requestId,
    });
    records.set(grantId,next);
    return next;
  }

  async function serial(key,operation) {
    if (!tails.has(key) && tails.size >= maxGrants) fail(503,"quota_exhausted");
    const prior = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    tails.set(key,current);
    await prior;
    try { return await operation(); }
    finally {
      release();
      if (tails.get(key) === current) tails.delete(key);
    }
  }

  return Object.freeze({
    find,install,rememberOptIn,pendingOptIn,revoke,serial,
    size: () => { purge(); return records.size + pendingOptIns.size; },
  });
}

export function createDiagnosticListenerMediation({
  access,state,collector,reconcile,grants = null,clock = Date.now,
  deadlineMs = 2_000,
} = {}) {
  const grantStore = grants ?? createListenerGrantStore({ clock });
  if (!access || !state || !collector || typeof reconcile !== "function"
    || !grantStore || typeof clock !== "function"
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1) {
    throw new Error("diagnostic_listener_mediation_configuration_invalid");
  }

  async function bounded(operation) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(),deadlineMs);
    try { return await operation(controller.signal); }
    catch (error) {
      if (error instanceof DiagnosticMediationError || Number.isInteger(error?.status)) throw error;
      fail(503,"diagnostic_unavailable");
    } finally { clearTimeout(timer); }
  }

  async function principal(headers) {
    try { return exactPrincipal(await bounded((signal) => access.principal({ ...headers,signal }))); }
    catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      if ([401,403].includes(error?.status)) fail(401,"authentication_required");
      fail(503,"diagnostic_unavailable");
    }
  }

  async function member(principalId,runId) {
    try {
      return exactMember(await bounded((signal) => state.runMember({
        principalId,runId,signal,
      })),runId);
    } catch (error) {
      if (error instanceof DiagnosticMediationError) throw error;
      if ([403,404].includes(error?.status)) fail(404,"diagnostic_not_found");
      fail(503,"diagnostic_unavailable");
    }
  }

  async function traceForRun(runId) {
    const found = context(await collector.traceContext({ activeRunId: runId }),"state");
    if (found.status !== "found") fail(404,"diagnostic_not_found");
    return restoreTrace(found.state);
  }

  async function traceById(traceId) {
    const found = context(await collector.traceContext({ traceId }),"state");
    if (found.status !== "found") fail(404,"diagnostic_not_found");
    return restoreTrace(found.state);
  }

  function grantRecord({ consent,trace,principalId,role,optInRequestId }) {
    const grantId = deriveDiagnosticUuid(
      "listener-grant",consent.traceId,consent.listenerInstanceId,String(consent.generation),
    );
    return Object.freeze({
      grantId,principalId,runId: trace.runId,runGeneration: trace.runGeneration,
      traceId: trace.traceId,correlationSegmentId: trace.segment.segmentId,
      leaseId: trace.segment.leaseId,listenerInstanceId: consent.listenerInstanceId,
      role,generation: consent.generation,status: "enabled",
      expiresAtMs: Math.min(consent.changedAtMs + GRANT_LIFETIME_MS,trace.expiresAtMs),
      lastStopRequestId: null,optInRequestId,
    });
  }

  function exactReceipt(receipt,submittedCommand) {
    if (receipt.requestId !== submittedCommand.requestId
      || receipt.operation !== submittedCommand.operation
      || !sameBytes(canonicalE2OperationCommandBytes(receipt.canonicalCommand),
        canonicalE2OperationCommandBytes(submittedCommand))) {
      fail(409,"request_conflict");
    }
    return receipt;
  }

  async function optIn({
    headers,requestId,runId,listenerInstanceId,firstAllowedSequence,localConsentStartedMs,
  }) {
    exactUuid(requestId); exactUuid(runId); exactUuid(listenerInstanceId);
    const submitted = command({
      requestId,operation: "consent_opt_in",parameters: {
        listenerInstanceId,firstAllowedSequence,localConsentStartedMs,
      },
    });
    return grantStore.serial(`opt:${requestId}`,async () => {
      const principalValue = await principal(headers);
      const retained = context(await collector.consentReceiptContext(
        requestId,"consent_opt_in",
      ),"receipt");
      if (retained.status === "found") {
        const receipt = exactReceipt(restoreReceipt(retained.receipt),submitted);
        if (receipt.result.listenerInstanceId !== listenerInstanceId) {
          fail(409,"request_conflict");
        }
        let trace = await traceById(receipt.result.traceId);
        if (trace.runId !== runId) fail(409,"request_conflict");
        const membership = await member(principalValue.id,runId);
        trace = await reconcile(trace);
        if (trace.status !== "active" || trace.runId !== runId
          || trace.runGeneration !== membership.runGeneration) fail(409,"stale_correlation");
        const record = grantRecord({
          consent: receipt.result,trace,principalId: principalValue.id,role: membership.role,
          optInRequestId: requestId,
        });
        try {
          const existing = grantStore.find(record.grantId,principalValue.id,{ allowRevoked: true });
          if (!sameGrantBinding(existing,record)) fail(409,"request_conflict");
          if (existing.status !== "enabled") fail(409,"sharing_disabled");
          return grantProjection(existing);
        } catch (error) {
          if (!(error instanceof DiagnosticMediationError)
            || error.code !== "diagnostic_not_found") throw error;
        }
        const pending = grantStore.pendingOptIn(requestId);
        if (!pending || pending.principalId !== principalValue.id
          || pending.runId !== runId || pending.listenerInstanceId !== listenerInstanceId) {
          fail(409,"grant_lost");
        }
        if (clock() < record.expiresAtMs) grantStore.install(record);
        return grantProjection(record);
      }
      if (retained.status !== "receipt_absent") fail(502,"collector_response_invalid");
      const membership = await member(principalValue.id,runId);
      if (membership.status !== "active") fail(404,"diagnostic_not_found");
      let trace = await traceForRun(runId);
      trace = await reconcile(trace);
      if (trace.status !== "active" || trace.runId !== runId
        || trace.runGeneration !== membership.runGeneration) fail(409,"stale_correlation");
      const nowMs = clock();
      grantStore.rememberOptIn({
        requestId,principalId: principalValue.id,runId,listenerInstanceId,
        expiresAtMs: nowMs + GRANT_LIFETIME_MS,
      });
      const result = await collector.optIn({
        command: submitted,authority: authority({
          authorityVersion: 1,operation: "consent_opt_in",nowMs,
          traceId: trace.traceId,listenerInstanceId,
        }),
      });
      if (!["accepted","replayed"].includes(result?.status)) {
        fail(502,"collector_response_invalid");
      }
      const receipt = exactReceipt(restoreReceipt(result.receipt),submitted);
      if (JSON.stringify(receipt.result) !== JSON.stringify(result.state)
        || receipt.result.traceId !== trace.traceId
        || receipt.result.listenerInstanceId !== listenerInstanceId
        || (result.status === "accepted" && receipt.result.changedAtMs !== nowMs)) {
        fail(502,"collector_response_invalid");
      }
      trace = await reconcile(trace);
      if (trace.status !== "active" || trace.runId !== runId
        || trace.runGeneration !== membership.runGeneration) fail(409,"stale_correlation");
      const record = grantRecord({
        consent: receipt.result,trace,principalId: principalValue.id,role: membership.role,
        optInRequestId: requestId,
      });
      grantStore.install(record);
      return grantProjection(record);
    });
  }

  async function synchronize({ headers,requestId,grantId }) {
    exactUuid(requestId); exactUuid(grantId);
    return grantStore.serial(`grant:${grantId}`,async () => {
      const principalValue = await principal(headers);
      const grant = grantStore.find(grantId,principalValue.id);
      const membership = await member(principalValue.id,grant.runId);
      if (membership.status !== "active" || membership.runGeneration !== grant.runGeneration
        || membership.role !== grant.role) fail(409,"stale_correlation");
      let trace = await traceById(grant.traceId);
      trace = await reconcile(trace);
      if (trace.status !== "active" || trace.runId !== grant.runId
        || trace.runGeneration !== grant.runGeneration
        || trace.segment.segmentId !== grant.correlationSegmentId
        || trace.segment.leaseId !== grant.leaseId) fail(409,"stale_correlation");
      const sampleId = deriveDiagnosticUuid("synchronization-sample",requestId);
      const retained = context(await collector.issuanceContext(sampleId),"issuance");
      if (retained.status === "found") {
        const issuance = restoreIssuance(retained.issuance);
        if (retained.traceId !== grant.traceId || issuance.timebaseId !== grant.traceId
          || issuance.instanceId !== grant.listenerInstanceId || issuance.sampleId !== sampleId) {
          fail(409,"request_conflict");
        }
        return Object.freeze({ status: "replayed",grantId,...issuance });
      }
      if (retained.status !== "sample_absent") fail(502,"collector_response_invalid");
      const serverReceiveMs = clock();
      const serverSendMs = clock();
      let issuance;
      try {
        issuance = validateSynchronizationIssuanceJson(bytes({
          sampleId,timebaseId: grant.traceId,instanceId: grant.listenerInstanceId,
          serverReceiveMs,serverSendMs,
        }));
      } catch { fail(502,"collector_response_invalid"); }
      const status = await collector.putIssuance({ traceId: grant.traceId,issuance });
      if (!status || !["accepted","replayed"].includes(status.status ?? status)) {
        fail(502,"collector_response_invalid");
      }
      return Object.freeze({ status: status.status ?? status,grantId,...issuance });
    });
  }

  async function stop({ headers,requestId,grantId }) {
    exactUuid(requestId); exactUuid(grantId);
    return grantStore.serial(`grant:${grantId}`,async () => {
      const principalValue = await principal(headers);
      let grant;
      try { grant = grantStore.find(grantId,principalValue.id,{ allowRevoked: true }); }
      catch (error) {
        const retained = context(await collector.consentReceiptContext(
          requestId,"consent_stop",
        ),"receipt");
        if (retained.status !== "found") throw error;
        const receipt = restoreReceipt(retained.receipt);
        const trace = await traceById(receipt.result.traceId);
        await member(principalValue.id,trace.runId);
        const originalGeneration = receipt.canonicalCommand.parameters.expectedGeneration;
        const expectedGrantId = deriveDiagnosticUuid(
          "listener-grant",trace.traceId,receipt.result.listenerInstanceId,
          String(originalGeneration),
        );
        if (expectedGrantId !== grantId || receipt.requestId !== requestId
          || receipt.operation !== "consent_stop") fail(404,"diagnostic_not_found");
        return Object.freeze({
          status: "revoked",grantId,generation: receipt.result.generation,
        });
      }
      const membership = await member(principalValue.id,grant.runId);
      if (membership.runGeneration !== grant.runGeneration || membership.role !== grant.role) {
        fail(409,"stale_correlation");
      }
      const submitted = command({
        requestId,operation: "consent_stop",parameters: {
          listenerInstanceId: grant.listenerInstanceId,expectedGeneration: grant.generation,
        },
      });
      const nowMs = clock();
      const result = await collector.stopSharing({
        command: submitted,authority: authority({
          authorityVersion: 1,operation: "consent_stop",nowMs,
          traceId: grant.traceId,listenerInstanceId: grant.listenerInstanceId,
        }),
      });
      if (!["accepted","replayed"].includes(result?.status)) {
        fail(502,"collector_response_invalid");
      }
      const receipt = exactReceipt(restoreReceipt(result.receipt),submitted);
      if (JSON.stringify(receipt.result) !== JSON.stringify(result.state)
        || receipt.result.traceId !== grant.traceId
        || receipt.result.listenerInstanceId !== grant.listenerInstanceId
        || receipt.result.generation !== grant.generation + 1
        || receipt.result.status !== "revoked"
        || (result.status === "accepted" && receipt.result.changedAtMs !== nowMs)) {
        fail(502,"collector_response_invalid");
      }
      grantStore.revoke(grantId,requestId);
      return Object.freeze({
        status: "revoked",grantId,generation: receipt.result.generation,
      });
    });
  }

  async function report({ headers,grantId,measurementCore,sampleObservation }) {
    exactUuid(grantId);
    return grantStore.serial(`grant:${grantId}`,async () => {
      const principalValue = await principal(headers);
      const grant = grantStore.find(grantId,principalValue.id,{ allowRevoked: true });
      let core;
      try { core = validateMeasurementJson(bytes(measurementCore)); }
      catch { fail(400,"report_invalid"); }
      if (!core.kind.startsWith("listener_") || core.instanceId !== grant.listenerInstanceId) {
        fail(400,"report_invalid");
      }
      const retained = context(await collector.reportIdentityContext({
        traceId: grant.traceId,instanceId: core.instanceId,sequence: core.sequence,
      }),"envelope");
      if (retained.status === "found") {
        let envelope;
        try { envelope = restoreUploadedEnvelopeFromTrustedStore(bytes(retained.envelope)); }
        catch { fail(502,"collector_response_invalid"); }
        if (envelope.serverContext.traceId !== grant.traceId
          || envelope.measurementCore.instanceId !== grant.listenerInstanceId) {
          fail(502,"collector_response_invalid");
        }
        if (!sameBytes(canonicalMeasurementBytes(envelope.measurementCore),
          canonicalMeasurementBytes(core))) fail(409,"report_conflict");
        return Object.freeze({ status: "replayed",receivedAt: retained.receivedAt });
      }
      if (retained.status !== "report_absent") fail(502,"collector_response_invalid");
      if (grant.status !== "enabled") fail(409,"sharing_disabled");
      const membership = await member(principalValue.id,grant.runId);
      if (membership.status !== "active" || membership.runGeneration !== grant.runGeneration
        || membership.role !== grant.role) fail(409,"stale_correlation");
      let trace = await traceById(grant.traceId);
      trace = await reconcile(trace);
      if (trace.status !== "active" || trace.runId !== grant.runId
        || trace.runGeneration !== grant.runGeneration
        || trace.segment.segmentId !== grant.correlationSegmentId
        || trace.segment.leaseId !== grant.leaseId) fail(409,"stale_correlation");
      const sampleId = exactUuid(sampleObservation?.sampleId);
      const issuanceContext = context(await collector.issuanceContext(sampleId),"issuance");
      if (issuanceContext.status !== "found") fail(409,"stale_correlation");
      const issuance = restoreIssuance(issuanceContext.issuance);
      if (issuanceContext.traceId !== grant.traceId || issuance.timebaseId !== grant.traceId
        || issuance.instanceId !== grant.listenerInstanceId) fail(409,"stale_correlation");
      let sample;
      let alignment;
      let serverContext;
      let envelope;
      try {
        sample = acceptSynchronizationSample(bytes(sampleObservation),issuance);
        alignment = mapMeasurementAlignment(core,sample);
        serverContext = validateServerContextJson(bytes({
          contextVersion: 1,traceId: grant.traceId,runId: grant.runId,
          runGeneration: grant.runGeneration,
          correlationSegmentId: grant.correlationSegmentId,leaseId: grant.leaseId,
          authorityKind: "listener",role: membership.role,
          listenerInstanceId: grant.listenerInstanceId,
        }));
        envelope = composeUploadedEnvelope(core,alignment,serverContext);
      } catch { fail(400,"report_invalid"); }
      const result = await collector.ingestReport({
        envelope,grantGeneration: grant.generation,
      });
      if (!["accepted","replayed","sharing_disabled","trace_inactive",
        "stale_correlation","report_conflict","rate_limited","quota_exhausted"].includes(
        result?.status,
      )) fail(502,"collector_response_invalid");
      if (["accepted","replayed"].includes(result.status)) {
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
      return Object.freeze({ status: result.status });
    });
  }

  return Object.freeze({ optIn,synchronize,stop,report,grants: grantStore });
}
