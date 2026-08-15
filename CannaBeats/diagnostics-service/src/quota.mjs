export const DIAGNOSTIC_LIMITS = Object.freeze({
  traceReports: 30_000,
  globalReports: 90_000,
  tracePeriodic: 24_000,
  traceTransitions: 6_000,
  traceBytes: 64 * 1024 * 1024,
  globalBytes: 192 * 1024 * 1024,
  requests: 4096,
  traceSegments: 256,
});

export function reportQuotaAllows(state, bucket, envelopeBytes) {
  const bucketCount = bucket === 'periodic' ? state.tracePeriodic : state.traceTransitions;
  const bucketLimit = bucket === 'periodic'
    ? DIAGNOSTIC_LIMITS.tracePeriodic : DIAGNOSTIC_LIMITS.traceTransitions;
  return state.tracePeriodic + state.traceTransitions < DIAGNOSTIC_LIMITS.traceReports
    && bucketCount < bucketLimit
    && state.globalReports < DIAGNOSTIC_LIMITS.globalReports
    && state.traceBytes + envelopeBytes <= DIAGNOSTIC_LIMITS.traceBytes
    && state.globalBytes + envelopeBytes <= DIAGNOSTIC_LIMITS.globalBytes;
}

export function requestQuotaAllows(requestCount, cleanupObligationsAfter, reducing) {
  return requestCount < DIAGNOSTIC_LIMITS.requests
    && (reducing
      || requestCount + 1 + cleanupObligationsAfter <= DIAGNOSTIC_LIMITS.requests);
}
