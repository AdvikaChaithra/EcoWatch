import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, requireRole, audit, BACKEND_URL } from "@/lib/server";

// Reads the caller's session token, so this route must never be pre-rendered at build time.
export const dynamic = "force-dynamic";

/**
 * Admin actions on an UNIDENTIFIED camera event (no citizen was fined).
 * body: { action: "dismiss", reason? }  -> false alarm, closed with the admin's reason
 *       { action: "reidentify" }        -> re-run face identification on the saved evidence;
 *                                          a confident match issues the fine + citizen alert
 * Allowed for the admin of the event's sector, or the super admin.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const s = await requireRole(req, ["admin", "super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<{ action?: string; reason?: string }>(req);
    const sb = serverSupabase();

    const { data: v, error: ve } = await sb.from("violations").select("id, status, sector_id").eq("id", params.id).maybeSingle();
    if (ve) throw ve;
    if (!v) return fail("Event not found.", 404);
    if (v.status !== "Unidentified") return fail("This event is no longer unidentified.", 409);
    if (s.role === "admin") {
      const { data: sec } = v.sector_id
        ? await sb.from("sectors").select("admin_id").eq("id", v.sector_id).maybeSingle()
        : { data: null };
      if (sec?.admin_id !== s.sub) return fail("This event belongs to another admin's sector.", 403);
    }

    if (b?.action === "dismiss") {
      const reason = (b.reason ?? "").trim() || "False alarm: no littering in the evidence";
      const { data, error } = await sb.from("violations").update({
        status: "Dismissed", admin_reason: reason, reviewed_by: s.sub, reviewed_at: new Date().toISOString(),
      }).eq("id", v.id).eq("status", "Unidentified").select("id");
      if (error) throw error;
      if (!data || data.length === 0) return fail("This event was changed by someone else.", 409);
      await audit(sb, s, "EVENT_DISMISSED", "violation", v.id, { reason });
      return NextResponse.json({ success: true, dismissed: true });
    }

    if (b?.action === "reidentify") {
      let res: Response;
      try {
        res = await fetch(`${BACKEND_URL}/api/violations/${v.id}/reidentify`, {
          method: "POST",
          headers: process.env.ENGINE_API_KEY ? { "X-Engine-API-Key": process.env.ENGINE_API_KEY } : {},
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        return fail("The face-recognition backend is not reachable. Start it (uvicorn backend.main:app) and retry.", 503);
      }
      const out = await res.json().catch(() => ({}));
      if (!res.ok) return fail(out?.detail ?? `Re-identification failed (${res.status}).`, res.status);
      await audit(sb, s, "EVENT_REIDENTIFIED", "violation", v.id,
        { result: out.identity_status, similarity: out.similarity ?? null, fined: !!out.fined });
      return NextResponse.json({ success: true, ...out });
    }

    return fail("Unknown action.", 400);
  } catch (e) {
    return serverError(e, "violation-admin-action");
  }
}
