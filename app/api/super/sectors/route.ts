import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, requireRole, audit } from "@/lib/server";

// Reads the caller's session token, so this route must never be pre-rendered at build time.
export const dynamic = "force-dynamic";

/**
 * Super admin: create a custom sector (area + name + centre point) and optionally assign its admin.
 * Bengaluru is pre-divided into sectors (migrations/005); this is only for localities not covered.
 */
export async function POST(req: NextRequest) {
  try {
    const s = requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, any>>(req);
    const area = String(b?.area ?? "").trim();
    const name = String(b?.name ?? "").trim();
    const lat = Number(b?.lat), lng = Number(b?.lng);
    const adminId = b?.admin_id ? String(b.admin_id) : null;
    const corporation = String(b?.corporation ?? "").trim() || null;
    if (area.length < 2 || name.length < 1) return fail("Enter the area and sector name.", 400);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return fail("Enter a valid centre latitude and longitude.", 400);
    }

    const sb = serverSupabase();
    if (adminId) {
      const { data: a } = await sb.from("admins").select("id, active, role").eq("id", adminId).maybeSingle();
      if (!a || !a.active || a.role !== "admin") return fail("Choose an active municipal admin.", 400);
    }
    // readable, stable id: SEC-<AREA3>-<n>
    const code = area.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "SEC";
    const { count } = await sb.from("sectors").select("id", { count: "exact", head: true }).like("id", `SEC-${code}-%`);
    const id = `SEC-${code}-${(count ?? 0) + 1}`;

    const { data, error } = await sb.from("sectors")
      .insert({ id, area, name, corporation, lat, lng, admin_id: adminId, active: true }).select("*").single();
    if (error) {
      if ((error as any).code === "23505") return fail("A sector with that id already exists - try again.", 409);
      throw error;
    }
    await audit(sb, s, "SECTOR_CREATED", "sector", id, { area, name, corporation, admin_id: adminId });
    return NextResponse.json({ success: true, sector: data });
  } catch (e) {
    return serverError(e, "super-sectors-create");
  }
}

/**
 * Super admin: assign every active sector of a city corporation to one admin in a single step.
 * body: { corporation, admin_id }. Workers of those sectors follow (workers.admin_id = sector admin).
 */
export async function PATCH(req: NextRequest) {
  try {
    const s = requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, any>>(req);
    const corporation = String(b?.corporation ?? "").trim();
    const adminId = b?.admin_id ? String(b.admin_id) : "";
    if (!corporation) return fail("Choose the city corporation.", 400);
    if (!adminId) return fail("Choose the admin to assign.", 400);

    const sb = serverSupabase();
    const { data: a } = await sb.from("admins").select("id, active, role").eq("id", adminId).maybeSingle();
    if (!a || !a.active || a.role !== "admin") return fail("Choose an active municipal admin.", 400);

    const { data: secs, error: le } = await sb.from("sectors").select("id")
      .eq("corporation", corporation).eq("active", true);
    if (le) throw le;
    const ids = (secs ?? []).map((x: any) => x.id);
    if (!ids.length) return fail("No active sectors in that corporation.", 404);

    const { error: ue } = await sb.from("sectors").update({ admin_id: adminId }).in("id", ids);
    if (ue) throw ue;
    const { data: moved, error: we } = await sb.from("workers").update({ admin_id: adminId }).in("sector_id", ids).select("id");
    if (we) throw we;
    await audit(sb, s, "CORPORATION_ASSIGN", "corporation", corporation,
      { admin_id: adminId, sectors: ids.length, workers_moved: moved?.length ?? 0 });
    return NextResponse.json({ success: true, sectors_assigned: ids.length, workers_moved: moved?.length ?? 0 });
  } catch (e) {
    return serverError(e, "super-corporation-assign");
  }
}
