import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import catalogManifest from "../../data/catalog-manifest.json";

export const CORRELATION_HEADER = "X-CannaBeats-Correlation-ID";

type Context = { correlationId: string };
type RouteHandler<T extends unknown[]> = (request: Request, ...args: T) => Response | Promise<Response>;

const context = new AsyncLocalStorage<Context>();
const CAPABILITY = /\b[A-Za-z0-9_-]{32,128}\b/g;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const COOKIE = /\b(?:Cookie|Set-Cookie)\s*:[^\r\n]*/gi;
const QUERY = /([a-z][a-z0-9+.-]*:\/\/[^\s?]+)\?[^\s]*/gi;
const SPOTIFY_TRACK = /spotify:track:[A-Za-z0-9]+/gi;
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function operationalRecord(
  level: "info" | "warn" | "error",
  event: string,
  message: string,
  values: Record<string, string | number | undefined>,
) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    service: "game",
    environment: safeValue(process.env.CANNABEATS_ENVIRONMENT ?? process.env.NODE_ENV ?? "development"),
    event: safeValue(event),
    message: safeMessage(message),
    applicationVersion: safeValue(process.env.CANNABEATS_APP_VERSION ?? "development"),
    catalogVersion: safeValue(process.env.CANNABEATS_CATALOG_VERSION ?? catalogManifest.catalogVersion),
    ...Object.fromEntries(Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === "number" ? value : safeValue(value)])),
  };
  const line = JSON.stringify(record);
  try {
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    // Diagnostics must never change request behavior.
  }
}

async function correlatedResponse(response: Response, correlationId: string) {
  const headers = new Headers(response.headers);
  headers.set(CORRELATION_HEADER, correlationId);
  if (response.status < 400 || !headers.get("content-type")?.includes("application/json")) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  try {
    const body = await response.clone().json() as Record<string, unknown>;
    headers.delete("content-length");
    return Response.json({
      ...body,
      code: typeof body.code === "string" ? body.code : errorCode(response.status),
      correlationId,
    }, { status: response.status, headers });
  } catch {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
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
      try {
        const response = await handler(request, ...args);
        if (response.status >= 400) {
          operationalRecord(response.status >= 500 ? "error" : "warn", "http.request_failed",
            response.status >= 500 ? "Request failed unexpectedly" : "Request was rejected", {
              correlationId,
              method: request.method,
              route: new URL(request.url).pathname,
              status: response.status,
              durationMs: performance.now() - startedAt,
              errorType: errorCode(response.status),
            });
        }
        return correlatedResponse(response, correlationId);
      } catch (error) {
        operationalRecord("error", "http.request_failed", "Request failed unexpectedly", {
          correlationId,
          method: request.method,
          route: new URL(request.url).pathname,
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
