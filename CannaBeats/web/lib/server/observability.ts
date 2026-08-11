import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import catalogManifest from "../../data/catalog-manifest.json" with { type: "json" };

export const CORRELATION_HEADER = "X-CannaBeats-Correlation-ID";

type Context = { correlationId: string };
type RouteHandler<T extends unknown[]> = (request: Request, ...args: T) => Response | Promise<Response>;
type LogLevel = "info" | "warn" | "error";
type LogWrite = (level: LogLevel, line: string) => void;

const context = new AsyncLocalStorage<Context>();
const CAPABILITY = /\b[A-Za-z0-9_-]{32,128}\b/g;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const COOKIE = /\b(?:Cookie|Set-Cookie)\s*:[^\r\n]*/gi;
const QUERY = /([a-z][a-z0-9+.-]*:\/\/[^\s?]+)\?[^\s]*/gi;
const SPOTIFY_TRACK = /spotify:track:[A-Za-z0-9]+/gi;
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_VALUE = /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/;
const SAFE_CONTEXT_FIELDS = new Set([
  "correlationId", "method", "route", "status", "durationMs", "lobbyId", "runId",
  "sourceId", "leaseId", "errorType", "reasonCode",
]);

function safeValue(value: unknown) {
  return String(value ?? "")
    .replace(BEARER, "Bearer [redacted]")
    .replace(COOKIE, "Cookie: [redacted]")
    .replace(QUERY, "$1?[redacted]")
    .replace(SPOTIFY_TRACK, "[pre-reveal-track]")
    .slice(0, 1_000);
}

function safeMessage(value: unknown) {
  return safeValue(value).replace(CAPABILITY, "[redacted]");
}

function errorCode(status: number) {
  if (status === 400) return "bad_request";
  if (status === 401) return "authentication_required";
  if (status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 410) return "expired";
  if (status === 429) return "rate_limited";
  if (status === 503) return "dependency_unavailable";
  return status >= 500 ? "unexpected_server_error" : "request_rejected";
}

function safeContext(values: Record<string, unknown>) {
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!SAFE_CONTEXT_FIELDS.has(key) || value === undefined || value === null) continue;
    if (key === "status" || key === "durationMs") {
      if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
      continue;
    }
    const text = String(value);
    if (key === "correlationId" || ["runId", "sourceId", "leaseId"].includes(key)) {
      if (CORRELATION_ID.test(text)) result[key] = text.toLowerCase();
    } else if (key === "route") {
      const route = text.split("?", 1)[0];
      if (route.startsWith("/") && route.length <= 200) result[key] = route;
    } else if (key === "lobbyId") {
      if (/^[A-Z2-9]{6}$/.test(text)) result[key] = text;
    } else if (key === "method") {
      if (/^[A-Z]{3,10}$/.test(text)) result[key] = text;
    } else if (STABLE_VALUE.test(text)) {
      result[key] = text;
    }
  }
  return result;
}

function defaultWrite(level: LogLevel, line: string) {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createGameOperationalLogger({
  write = defaultWrite,
  now = () => new Date(),
}: { write?: LogWrite; now?: () => Date } = {}) {
  function record(level: LogLevel, event: string, message: string, values: Record<string, unknown> = {}) {
    const payload = {
      timestamp: now().toISOString(),
      level,
      service: "game",
      environment: safeValue(process.env.CANNABEATS_ENVIRONMENT ?? process.env.NODE_ENV ?? "development"),
      event: STABLE_VALUE.test(event) ? event : "operational.event_invalid",
      message: safeMessage(message),
      applicationVersion: safeValue(process.env.CANNABEATS_APP_VERSION ?? "development"),
      catalogVersion: safeValue(process.env.CANNABEATS_CATALOG_VERSION ?? catalogManifest.catalogVersion),
      ...safeContext(values),
    };
    try {
      write(level, JSON.stringify(payload));
    } catch {
      // Diagnostics must never change request behavior.
    }
    return payload;
  }
  return {
    info: (event: string, message: string, values?: Record<string, unknown>) => record("info", event, message, values),
    warn: (event: string, message: string, values?: Record<string, unknown>) => record("warn", event, message, values),
    error: (event: string, message: string, values?: Record<string, unknown>) => record("error", event, message, values),
  };
}

type GameLogger = ReturnType<typeof createGameOperationalLogger>;

export function createRouteTransitionReporter(logger: GameLogger) {
  const states = new Map<string, "healthy" | "unavailable">();
  return {
    observe(route: string, status: number, values: Record<string, unknown> = {}) {
      const readiness = route.endsWith("/api/ready");
      const audioSource = route.endsWith("/api/audio-source");
      const audioStream = route.endsWith("/api/audio-stream");
      const previous = states.get(route);
      if (!readiness && !audioSource && !audioStream) return { handled: false, emitted: false };
      if (status >= 400 && audioStream && status < 500) return { handled: false, emitted: false };
      const state = status < 400 ? "healthy" : "unavailable";
      states.set(route, state);
      if (previous === state || (previous === undefined && state === "healthy" && !readiness)) {
        return { handled: true, emitted: false };
      }
      if (readiness) {
        logger[state === "healthy" ? "info" : "warn"](
          "service.readiness_changed", "Game service readiness changed", {
            ...values,
            route,
            status: state === "healthy" ? 200 : status,
            reasonCode: state === "healthy" ? "ready" : "readiness_check_failed",
          },
        );
      } else if (state === "unavailable") {
        logger.warn("dependency.unavailable", "Polling dependency became unavailable", {
          ...values, route, status, reasonCode: `http_${status}`,
        });
      } else {
        logger.info("dependency.recovered", "Polling dependency recovered", {
          ...values, route, status, reasonCode: "request_succeeded",
        });
      }
      return { handled: true, emitted: true };
    },
  };
}

export async function correlatedResponse(response: Response, correlationId: string) {
  const headers = new Headers(response.headers);
  headers.set(CORRELATION_HEADER, correlationId);
  if (response.status < 400) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const fallback = response.status >= 500 ? "Unexpected server error" : "Request was not accepted.";
  let message = fallback;
  let code = errorCode(response.status);
  if (headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await response.clone().json() as Record<string, unknown>;
      if (typeof body.error === "string") message = safeMessage(body.error);
      if (typeof body.code === "string" && STABLE_VALUE.test(body.code)) code = body.code;
    } catch {}
  }
  headers.delete("content-length");
  headers.set("content-type", "application/json");
  return Response.json({ error: message, code, correlationId }, { status: response.status, headers });
}

const logger = createGameOperationalLogger();
const routeTransitions = createRouteTransitionReporter(logger);

export function logGameLifecycle(event: "service.started" | "service.stopping", reasonCode?: string) {
  logger.info(event, event === "service.started" ? "Game service started" : "Game service is stopping", {
    reasonCode,
  });
}

export function observeRoute<T extends unknown[]>(
  handler: RouteHandler<T>,
  { acceptCorrelationId = false }: {
    acceptCorrelationId?: boolean | ((request: Request) => boolean);
  } = {},
): RouteHandler<T> {
  return async (request, ...args) => {
    const supplied = request.headers.get(CORRELATION_HEADER);
    let acceptSupplied = acceptCorrelationId === true;
    if (typeof acceptCorrelationId === "function") {
      try {
        acceptSupplied = acceptCorrelationId(request);
      } catch {
        acceptSupplied = false;
      }
    }
    const correlationId = acceptSupplied && supplied && CORRELATION_ID.test(supplied)
      ? supplied.toLowerCase()
      : randomUUID();
    const startedAt = performance.now();
    return context.run({ correlationId }, async () => {
      const route = new URL(request.url).pathname;
      try {
        const response = await handler(request, ...args);
        const values = {
          correlationId,
          method: request.method,
          route,
          status: response.status,
          durationMs: performance.now() - startedAt,
          ...(response.status >= 400 ? { errorType: errorCode(response.status) } : {}),
        };
        const transition = routeTransitions.observe(route, response.status, values);
        if (response.status >= 400 && !transition.handled) {
          logger[response.status >= 500 ? "error" : "warn"](
            "http.request_failed",
            response.status >= 500 ? "Request failed unexpectedly" : "Request was rejected",
            values,
          );
        }
        return correlatedResponse(response, correlationId);
      } catch (error) {
        logger.error("http.request_failed", "Request failed unexpectedly", {
          correlationId,
          method: request.method,
          route,
          status: 500,
          durationMs: performance.now() - startedAt,
          errorType: error instanceof Error ? error.constructor.name : "Error",
        });
        return correlatedResponse(Response.json({ error: "Unexpected server error" }, { status: 500 }), correlationId);
      }
    });
  };
}

export function correlationId() {
  return context.getStore()?.correlationId;
}

export function correlatedHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  const current = correlationId();
  if (current) headers.set(CORRELATION_HEADER, current);
  return headers;
}
