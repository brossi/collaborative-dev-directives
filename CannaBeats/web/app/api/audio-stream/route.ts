import { readFile } from "node:fs/promises";
import { correlatedHeaders, observeRoute } from "../../../lib/server/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_RELAY_ORIGIN = "https://cannaudio.cannabeats.social";
const DEFAULT_TOKEN_FILE = "/run/secrets/cannabeats/audio-relay-listen-token";

function forwardedHeaders(request: Request) {
  const headers = correlatedHeaders();
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);
  return headers;
}

async function getAudioStream(request: Request) {
  const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();
  if (!code) return Response.json({ error: "A lobby code is required." }, { status: 400 });

  const publicGameOrigin = process.env.CANNABEATS_PUBLIC_GAME_ORIGIN?.trim().replace(/\/$/, "");
  const membershipUrl = publicGameOrigin
    ? new URL(`${publicGameOrigin}/api/game`)
    : new URL(request.url);
  if (!publicGameOrigin) {
    membershipUrl.pathname = membershipUrl.pathname.replace(/\/api\/audio-stream$/, "/api/game");
  }
  membershipUrl.search = new URLSearchParams({ code }).toString();
  const membership = await fetch(membershipUrl, {
    cache: "no-store",
    headers: forwardedHeaders(request),
    signal: request.signal,
  });
  if (!membership.ok) {
    return new Response(await membership.text(), {
      status: membership.status,
      headers: { "content-type": membership.headers.get("content-type") ?? "application/json" },
    });
  }

  const view = await membership.json() as { audio?: { selection?: string } };
  if (view.audio?.selection !== "managed") {
    return Response.json({ error: "This lobby is using local Spotify playback." }, { status: 409 });
  }

  let listenToken: string;
  try {
    listenToken = (await readFile(
      /* turbopackIgnore: true */
      process.env.AUDIO_RELAY_LISTEN_TOKEN_FILE?.trim() || DEFAULT_TOKEN_FILE,
      "utf8",
    )).trim();
  } catch {
    return Response.json({ error: "Shared audio is not configured on this server." }, { status: 503 });
  }
  if (!listenToken) {
    return Response.json({ error: "Shared audio is not configured on this server." }, { status: 503 });
  }

  const relayOrigin = process.env.AUDIO_RELAY_ORIGIN?.trim() || DEFAULT_RELAY_ORIGIN;
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/stream.pcm", relayOrigin), {
      cache: "no-store",
      headers: correlatedHeaders({ authorization: `Bearer ${listenToken}` }),
      signal: request.signal,
    });
  } catch {
    return Response.json({ error: "The shared audio relay is temporarily unavailable." }, { status: 503 });
  }
  if (!upstream.ok || !upstream.body) {
    const status = upstream.status === 401 ? 503 : upstream.status;
    return Response.json(
      { error: upstream.status === 503 ? "Waiting for the shared audio source." : "Shared audio is temporarily unavailable." },
      { status },
    );
  }

  const headers = new Headers({
    "cache-control": "no-store, no-cache, must-revalidate",
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "x-accel-buffering": "no",
  });
  for (const name of ["x-audio-rate", "x-audio-channels", "x-audio-encoding"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: 200, headers });
}

export const GET = observeRoute(getAudioStream);
