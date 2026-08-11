import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'X-CannaBeats-Correlation-ID';

const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const SAFE_CONTEXT_FIELDS = new Set([
  'correlationId',
  'method',
  'route',
  'status',
  'durationMs',
  'lobbyId',
  'runId',
  'sourceId',
  'leaseId',
  'errorType',
  'reasonCode',
]);
const CAPABILITY = /\b[A-Za-z0-9_-]{32,128}\b/g;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const COOKIE = /\b(?:Cookie|Set-Cookie)\s*:[^\r\n]*/gi;
const QUERY = /([a-z][a-z0-9+.-]*:\/\/[^\s?]+)\?[^\s]*/gi;
const SPOTIFY_TRACK = /spotify:track:[A-Za-z0-9]+/gi;

function safeString(value, secrets) {
  let result = String(value ?? '');
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, '[redacted]');
  }
  return result
    .replace(BEARER, 'Bearer [redacted]')
    .replace(COOKIE, 'Cookie: [redacted]')
    .replace(QUERY, '$1?[redacted]')
    .replace(SPOTIFY_TRACK, '[pre-reveal-track]')
    .slice(0, 1_000);
}

function safeMessage(value, secrets) {
  return safeString(value, secrets).replace(CAPABILITY, '[redacted]');
}

function safeContext(context, secrets) {
  const result = {};
  for (const [key, value] of Object.entries(context ?? {})) {
    if (!SAFE_CONTEXT_FIELDS.has(key) || value === undefined || value === null) continue;
    if (['status', 'durationMs'].includes(key)) {
      if (Number.isFinite(value)) result[key] = Number(value);
      continue;
    }
    result[key] = safeString(value, secrets);
  }
  return result;
}

function defaultWrite(level, line) {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export function createOperationalLogger({
  service,
  environment = 'development',
  applicationVersion = 'unknown',
  catalogVersion = 'unknown',
  secrets = [],
  write = defaultWrite,
  now = () => new Date(),
}) {
  const protectedValues = secrets.filter(Boolean).map(String);
  function record(level, event, message, context = {}) {
    const normalizedLevel = LEVELS.has(level) ? level : 'info';
    const payload = {
      timestamp: now().toISOString(),
      level: normalizedLevel,
      service: safeString(service, protectedValues),
      environment: safeString(environment, protectedValues),
      event: safeString(event, protectedValues),
      message: safeMessage(message, protectedValues),
      applicationVersion: safeString(applicationVersion, protectedValues),
      catalogVersion: safeString(catalogVersion, protectedValues),
      ...safeContext(context, protectedValues),
    };
    try {
      write(normalizedLevel, JSON.stringify(payload));
    } catch {
      try {
        process.stderr.write(`${JSON.stringify({
          timestamp: now().toISOString(),
          level: 'error',
          service: safeString(service, protectedValues),
          environment: safeString(environment, protectedValues),
          event: 'logging.write_failed',
          message: 'Operational record could not be written',
          applicationVersion: safeString(applicationVersion, protectedValues),
          catalogVersion: safeString(catalogVersion, protectedValues),
        })}\n`);
      } catch {}
    }
    return payload;
  }
  return {
    safeText: (text) => safeMessage(text, protectedValues),
    debug: (event, message, context) => record('debug', event, message, context),
    info: (event, message, context) => record('info', event, message, context),
    warn: (event, message, context) => record('warn', event, message, context),
    error: (event, message, context) => record('error', event, message, context),
  };
}

export function requestContext(logger) {
  return (req, res, next) => {
    // This is the public authority boundary. A caller may send a syntactically
    // plausible value, but the service always creates its own reference.
    req.correlationId = randomUUID();
    req.observabilityStartedAt = process.hrtime.bigint();
    res.set(CORRELATION_HEADER, req.correlationId);
    req.operationalLogger = logger;
    next();
  };
}

export function requestDurationMs(req) {
  if (typeof req.observabilityStartedAt !== 'bigint') return undefined;
  return Number(process.hrtime.bigint() - req.observabilityStartedAt) / 1_000_000;
}

export function errorCode(status) {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'authentication_required';
  if (status === 403) return 'access_denied';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 410) return 'expired';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'dependency_unavailable';
  return status >= 500 ? 'unexpected_server_error' : 'request_rejected';
}

export function errorResponse(req, res, error, status) {
  const correlationId = req.correlationId || randomUUID();
  res.set(CORRELATION_HEADER, correlationId);
  const code = errorCode(status);
  const unsafeMessage = status >= 500 ? 'Unexpected server error' : String(error?.message || 'Request was not accepted');
  const message = req.operationalLogger?.safeText(unsafeMessage) ?? 'Request was not accepted';
  req.operationalLogger?.[status >= 500 ? 'error' : 'warn'](
    'http.request_failed',
    status >= 500 ? 'Request failed unexpectedly' : 'Request was rejected',
    {
      correlationId,
      method: req.method,
      route: req.route?.path || req.path,
      status,
      durationMs: requestDurationMs(req),
      errorType: status >= 500 ? error?.constructor?.name || 'Error' : code,
    },
  );
  return res.status(status).json({ error: message, code, correlationId });
}
