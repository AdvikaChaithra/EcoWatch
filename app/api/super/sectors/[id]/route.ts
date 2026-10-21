import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, requireRole, audit } from "@/lib/server";

// Reads the caller's session token, so this route must never be pre-rendered at build time.
export const dynamic = "force-dynamic";

/**
 * Super admin manages a sector.
 * body: { action: "update" | "reassign" | "deactivate" | "activate", area?, name?, lat?, lng?, admin_id? }
 * "reassign" moves the sector AND its workers to the new admin (workers.admin_id follows the sector).
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const s = await requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, any>>(req);
    const action = b?.action;
    const sb = serverSupabase();

    const { data: sector, error: se } = await sb.from("sectors").select("*").eq("id", params.id).maybeSingle();
    if (se) throw se;
    if (!sector) return fail("Sector not found.", 404);

    let update: Record<string, unknown> = {};
    let workersMoved = 0;
    let rerouted: Record<string, unknown> | undefined;

    if (action === "update") {
      if (typeof b?.area === "string" && b.area.trim()) update.area = b.area.trim();
      if (typeof b?.name === "string" && b.name.trim()) update.name = b.name.trim();
      if (typeof b?.corporation === "string") update.corporation = b.corporation.trim() || null;
      if (b?.lat !== undefined || b?.lng !== undefined) {
        const lat = Number(b.lat), lng = Number(b.lng);
        if (b.lat === "" || b.lng === "" || b.lat === null || b.lng === null ||
            !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
          return fail("Enter a valid centre latitude and longitude.", 400);
        }
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
      // open work must not be stranded in a sector nobody manages: hand it to the nearest active sector
      const { data: others, error: oe } = await sb.from("sectors").select("id, area, name, lat, lng")
        .eq("active", true).neq("id", params.id);
      if (oe) throw oe;
      const heir = nearest(others ?? [], Number(sector.lat), Number(sector.lng));
      if (heir) {
        const { data: reps, error: re } = await sb.from("dump_reports").update({ sector_id: heir.id })
          .eq("sector_id", params.id).neq("status", "Cleaned & Verified").select("id");
        if (re) throw re;
        const { data: vios, error: ve } = await sb.from("violations").update({ sector_id: heir.id })
          .eq("sector_id", params.id).in("status", ["Pending", "Upheld", "Unidentified"]).select("id");
        if (ve) throw ve;
        rerouted = { to: heir.id, reports: reps?.length ?? 0, violations: vios?.length ?? 0 };
      }
    } else if (action === "activate") {
      update.active = true;
    } else {
      return fail("Unknown action.", 400);
    }

    const { data, error } = await sb.from("sectors").update(update).eq("id", params.id).select("*").single();
    if (error) throw error;
    await audit(sb, s, `SECTOR_${String(action).toUpperCase()}`, "sector", params.id,
      { ...update, from_admin: sector.admin_id, workers_moved: workersMoved, rerouted });
    return NextResponse.json({ success: true, sector: data, workers_moved: workersMoved, rerouted });
  } catch (e) {
    return serverError(e, "super-sector-update");
  }
}

type Pt = { id: string; area: string; name: string; lat: number; lng: number };
function nearest(list: Pt[], lat: number, lng: number): Pt | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !list.length) return null;
  const d = (p: Pt) => {
    const R = 6371000, r = Math.PI / 180;
    const a = Math.sin(((p.lat - lat) * r) / 2) ** 2 +
      Math.cos(lat * r) * Math.cos(p.lat * r) * Math.sin(((p.lng - lng) * r) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };
  return list.reduce((b, p) => (d(p) < d(b) ? p : b));
}
