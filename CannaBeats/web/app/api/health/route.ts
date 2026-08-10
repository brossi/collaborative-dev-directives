export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { ok: true, service: "cannabeats-game" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
