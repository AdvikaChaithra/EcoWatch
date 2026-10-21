import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, hashSecret, generatePin, requireRole, audit } from "@/lib/server";

const SAFE_COLS = "id, name, phone, employee_id, ward, status, active, sector_id, admin_id, tasks_completed, eco_points, bonus_accrued, tier, must_change_pin, created_at";
const PHONE_RE = /^\+?[0-9]{8,15}$/;

/**
 * Add a worker to a sector. The worker automatically reports to that sector's admin.
 * Admins may only add to their own sectors; the super admin may add anywhere.
 * Returns the generated employee ID and a one-time PIN (shown once, stored hashed).
 */
export async function POST(req: NextRequest) {
  try {
    const s = await requireRole(req, ["admin", "super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, string>>(req);
    const name = (b?.name ?? "").trim();
    const phone = (b?.phone ?? "").replace(/[\s-]/g, "");
    const sectorId = (b?.sector_id ?? "").trim();
    if (name.length < 2) return fail("Enter the worker's full name.", 400);
    if (!PHONE_RE.test(phone)) return fail("Enter a valid phone number (8-15 digits).", 400);
    if (!sectorId) return fail("Choose the worker's sector.", 400);

    const sb = serverSupabase();
    const { data: sector, error: se } = await sb.from("sectors").select("id, area, name, admin_id, active").eq("id", sectorId).maybeSingle();
    if (se) throw se;
    if (!sector || !sector.active) return fail("That sector does not exist or is retired.", 400);
    if (s.role === "admin" && sector.admin_id !== s.sub) return fail("You can only add workers to your own sectors.", 403);
    if (!sector.admin_id) return fail("This sector has no admin yet - ask the super admin to assign one.", 400);

    const { data: dup } = await sb.from("workers").select("id").eq("phone", phone).maybeSingle();
    if (dup) return fail("A worker with this phone number already exists.", 409);

    // Employee ID encodes the sector, e.g. EW-BHN1-004
    const code = sector.id.replace(/^SEC-/, "").replace(/-/g, "");
    const pin = generatePin();
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const { count } = await sb.from("workers").select("id", { count: "exact", head: true }).like("employee_id", `EW-${code}-%`);
      const employee_id = `EW-${code}-${String((count ?? 0) + 1 + attempt).padStart(3, "0")}`;
      const { data, error } = await sb.from("workers").insert({
        name, phone, employee_id, sector_id: sector.id, admin_id: sector.admin_id,
        ward: `${sector.area} ${sector.name}`, pin_hash: hashSecret(pin), must_change_pin: true,
        status: "Off Duty", active: true, tasks_completed: 0, eco_points: 0, bonus_accrued: 0,
      }).select(SAFE_COLS).single();
      if (!error) created = data;
      else if ((error as any).code !== "23505") throw error;   // retry only on duplicate employee_id
    }
    if (!created) return fail("Could not allocate an employee ID - please try again.", 500);

    await audit(sb, s, "WORKER_CREATED", "worker", created.id, { employee_id: created.employee_id, sector_id: sector.id });
    return NextResponse.json({ success: true, worker: created, one_time_pin: pin });
  } catch (e) {
    return serverError(e, "workers-create");
  }
}
