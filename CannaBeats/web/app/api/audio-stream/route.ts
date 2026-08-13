import { readFile } from "node:fs/promises";
import { internalGameOrigin, internalServiceHeaders } from "../../../lib/server/internal-service";
import { correlatedHeaders, observeRoute } from "../../../lib/server/observability";
import { GAME_CLIENT_CONTRACT_HEADER, GAME_CLIENT_CONTRACT_VERSION } from "../../../lib/game-client-contract.ts";
import { leaseBoundStream } from "../../../lib/server/lease-bound-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_RELAY_ORIGIN = "https://cannaudio.cannabeats.social";
const DEFAULT_TOKEN_FILE = "/run/secrets/cannabeats/audio-relay-listen-token";

function forwardedHeaders(request: Request) {
  const headers = internalServiceHeaders(correlatedHeaders());
  headers.set(GAME_CLIENT_CONTRACT_HEADER, GAME_CLIENT_CONTRACT_VERSION);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  if (cookie) headers.set("cookie", cookie);
  if (authorization) headers.set("authorization", authorization);
  return headers;
}

async function getAudioStream(request: Request) {
  const code = new URL(request.url).searchParams.get("code")?.trim().toUpperCase();
  if (!code) return Response.json({ error: "A lobby code is required." }, { status: 400 });

  // Membership is checked only through an explicitly loopback-only service
  // origin. Neither a public configuration value nor a request Host header
  // can become a credential-forwarding destination.
  const membershipOrigin = internalGameOrigin();
  if (!membershipOrigin) {
    return Response.json({ error: "Game membership checking is unavailable." }, { status: 503 });
  }
  const membershipUrl = new URL(membershipOrigin);
  membershipUrl.pathname = `${membershipUrl.pathname.replace(/\/$/, "")}/api/game`;
  membershipUrl.search = new URLSearchParams({ code }).toString();
  const authorityHeaders = forwardedHeaders(request);
  const readAuthority = (checkSignal?: AbortSignal) => fetch(membershipUrl, {
    cache: "no-store",headers: authorityHeaders,
    signal: checkSignal ? AbortSignal.any([request.signal,checkSignal]) : request.signal,
  });
  async function readAuthorityBounded() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(),750);
    try { return await readAuthority(controller.signal); }
    finally { clearTimeout(timeout); }
  }
  let membership: Response;
  try {
    membership = await readAuthorityBounded();
  } catch {
    return Response.json({ error: "Game membership checking is unavailable." }, { status: 503 });
  }
  if (!membership.ok) {
    return new Response(await membership.text(), {
      status: membership.status,
      headers: { "content-type": membership.headers.get("content-type") ?? "application/json" },
    });
  }

  const view = await membership.json() as {
    audio?: { selection?: string; mode?: string; leaseId?: string };
  };
  if (view.audio?.selection !== "managed") {
    return Response.json({ error: "This lobby is using local Spotify playback." }, { status: 409 });
  }
  if (view.audio.mode !== "managed" || typeof view.audio.leaseId !== "string") {
    return Response.json({ error: "This lobby does not currently own the shared audio source." }, { status: 409 });
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
  const upstreamController = new AbortController();
  request.signal.addEventListener("abort",() => upstreamController.abort(),{ once: true });
  try {
    upstream = await fetch(new URL("/stream.pcm", relayOrigin), {
      cache: "no-store",
      headers: correlatedHeaders({ authorization: `Bearer ${listenToken}` }),
      signal: upstreamController.signal,
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

  // Relay setup can be slow enough for ownership to change.  Never expose its
  // body until the same exact lease is authoritative a second time.
  try {
    const currentResponse = await readAuthorityBounded();
    const current = currentResponse.ok ? await currentResponse.json() as {
      audio?: { mode?: string; leaseId?: string };
    } : null;
    if (current?.audio?.mode !== "managed" || current.audio.leaseId !== view.audio.leaseId) {
      upstreamController.abort();
      return Response.json({ error: "Shared audio authority changed during connection." }, { status: 409 });
    }
  } catch {
    upstreamController.abort();
    return Response.json({ error: "Game membership checking is unavailable." }, { status: 503 });
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
  const leaseId = view.audio.leaseId;
  const body = leaseBoundStream(upstream.body,async (signal) => {
    const response = await readAuthority(signal);
    if (!response.ok) return false;
    const current = await response.json() as { audio?: { mode?: string; leaseId?: string } };
    return current.audio?.mode === "managed" && current.audio.leaseId === leaseId;
  },{ onCancel: () => upstreamController.abort() });
  return new Response(body, { status: 200, headers });
}

export const GET = observeRoute(getAudioStream);
