import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

export const INTERNAL_SERVICE_HEADER = "X-CannaBeats-Internal-Service-Token";

function serviceToken() {
  const direct = process.env.CANNABEATS_GAME_SERVICE_TOKEN?.trim();
  if (direct) return direct;
  const path = process.env.CANNABEATS_GAME_SERVICE_TOKEN_FILE?.trim();
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

function equalText(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function internalGameOrigin() {
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  const configuredBasePath = process.env.NEXT_PUBLIC_CANNABEATS_BASE_PATH?.trim() ?? "";
  const basePath = configuredBasePath
    ? `/${configuredBasePath.replace(/^\/+|\/+$/g, "")}`
    : "";
  return new URL(`http://127.0.0.1:${port}${basePath}`);
}

export function trustedInternalRequest(request: Request) {
  const expected = serviceToken();
  const supplied = request.headers.get(INTERNAL_SERVICE_HEADER) ?? "";
  return expected.length >= 32 && equalText(supplied, expected);
}

export function internalServiceHeaders(initial?: HeadersInit) {
  const headers = new Headers(initial);
  const token = serviceToken();
  if (token.length >= 32) headers.set(INTERNAL_SERVICE_HEADER, token);
  return headers;
}
