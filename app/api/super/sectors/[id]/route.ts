import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, requireRole, audit } from "@/lib/server";

/**
 * Super admin manages a sector.
 * body: { action: "update" | "reassign" | "deactivate" | "activate", area?, name?, lat?, lng?, admin_id? }
 * "reassign" moves the sector AND its workers to the new admin (workers.admin_id follows the sector).
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const s = requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, any>>(req);
    const action = b?.action;
    const sb = serverSupabase();

    const { data: sector, error: se } = await sb.from("sectors").select("*").eq("id", params.id).maybeSingle();
    if (se) throw se;
    if (!sector) return fail("Sector not found.", 404);

    let update: Record<string, unknown> = {};
    let workersMoved = 0;

    if (action === "update") {
      if (typeof b?.area === "string" && b.area.trim()) update.area = b.area.trim();
      if (typeof b?.name === "string" && b.name.trim()) update.name = b.name.trim();
      if (typeof b?.corporation === "string") update.corporation = b.corporation.trim() || null;
      if (b?.lat !== undefined || b?.lng !== undefined) {
        const lat = Number(b.lat), lng = Number(b.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return fail("Invalid latitude/longitude.", 400);
        update.lat = lat; update.lng = lng;
      }
    } else if (action === "reassign") {
      const adminId = b?.admin_id ? String(b.admin_id) : null;
      if (!adminId) return fail("Choose the admin to assign.", 400);
      const { data: a } = await sb.from("admins").select("id, active, role, name").eq("id", adminId).maybeSingle();
      if (!a || !a.active || a.role !== "admin") return fail("Choose an active municipal admin.", 400);
      update.admin_id = adminId;
      // workers of this sector now report to the new admin
      const { data: moved, error: we } = await sb.from("workers").update({ admin_id: adminId })
        .eq("sector_id", params.id).select("id");
      if (we) throw we;
      workersMoved = moved?.length ?? 0;
    } else if (action === "deactivate") {
      const { count } = await sb.from("workers").select("id", { count: "exact", head: true })
        .eq("sector_id", params.id).eq("active", true);
      if ((count ?? 0) > 0) return fail(`Transfer this sector's ${count} active worker(s) first.`, 409);
      update.active = false;
    } else if (action === "activate") {
      update.active = true;
    } else {
      return fail("Unknown action.", 400);
    }

    const { data, error } = await sb.from("sectors").update(update).eq("id", params.id).select("*").single();
    if (error) throw error;
    await audit(sb, s, `SECTOR_${String(action).toUpperCase()}`, "sector", params.id,
      { ...update, from_admin: sector.admin_id, workers_moved: workersMoved });
    return NextResponse.json({ success: true, sector: data, workers_moved: workersMoved });
  } catch (e) {
    return serverError(e, "super-sector-update");
  }
}
