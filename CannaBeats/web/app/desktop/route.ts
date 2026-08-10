import { database, randomToken, sha256 } from "../../lib/server/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DESKTOP_WEB_COOKIE = "cb_desktop_web";
const DESKTOP_WEB_SESSION_MS = 12 * 60 * 60 * 1000;

export function GET(request: Request) {
  const url = new URL(request.url);
  const ticket = url.searchParams.get("ticket") ?? "";
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(ticket)) {
    return Response.json({ error: "Desktop launch ticket is invalid." }, { status: 400 });
  }

  const ticketHash = sha256(ticket);
  const pending = database().prepare(`
    SELECT desktop_web_tickets.*, desktop_sessions.expires_at AS desktop_expires_at,
           desktop_sessions.revoked_at
    FROM desktop_web_tickets
    JOIN desktop_sessions
      ON desktop_sessions.token_hash = desktop_web_tickets.desktop_session_hash
    WHERE desktop_web_tickets.token_hash = ?
  `).get(ticketHash) as {
    desktop_session_hash: string;
    room_code: string | null;
    expires_at: number;
    desktop_expires_at: number;
    revoked_at: number | null;
  } | undefined;
  database().prepare("DELETE FROM desktop_web_tickets WHERE token_hash = ?").run(ticketHash);
  const now = Date.now();
  if (!pending || pending.expires_at <= now || pending.desktop_expires_at <= now || pending.revoked_at) {
    return Response.json({ error: "Desktop launch ticket expired or was already used." }, { status: 401 });
  }

  const sessionToken = randomToken();
  const expiresAt = Math.min(now + DESKTOP_WEB_SESSION_MS, pending.desktop_expires_at);
  database().prepare(`
    INSERT INTO desktop_web_sessions
      (token_hash, desktop_session_hash, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sha256(sessionToken), pending.desktop_session_hash, now, expiresAt, now);

  const basePath = process.env.NEXT_PUBLIC_CANNABEATS_BASE_PATH ?? "";
  const destination = new URL(`${basePath || ""}/`, url.origin);
  if (pending.room_code) destination.searchParams.set("room", pending.room_code);
  const maxAge = Math.max(1, Math.floor((expiresAt - now) / 1000));
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: destination.toString(),
      "Set-Cookie": `${DESKTOP_WEB_COOKIE}=${encodeURIComponent(sessionToken)}; Path=${basePath || "/"}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`,
    },
  });
}
