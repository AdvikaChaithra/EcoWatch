import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, requireRole, audit } from "@/lib/server";

/** Super admin: create a sector (area + name + centre point) and optionally assign its admin. */
export async function POST(req: NextRequest) {
  try {
    const s = requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, any>>(req);
    const area = String(b?.area ?? "").trim();
    const name = String(b?.name ?? "").trim();
    const lat = Number(b?.lat), lng = Number(b?.lng);
    const adminId = b?.admin_id ? String(b.admin_id) : null;
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
      .insert({ id, area, name, lat, lng, admin_id: adminId, active: true }).select("*").single();
    if (error) {
      if ((error as any).code === "23505") return fail("A sector with that id already exists - try again.", 409);
      throw error;
    }
    await audit(sb, s, "SECTOR_CREATED", "sector", id, { area, name, admin_id: adminId });
    return NextResponse.json({ success: true, sector: data });
  } catch (e) {
    return serverError(e, "super-sectors-create");
  }
}
