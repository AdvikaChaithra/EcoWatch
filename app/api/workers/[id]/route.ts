import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, hashSecret, generatePin, requireRole, audit } from "@/lib/server";

const SAFE_COLS = "id, name, phone, employee_id, ward, status, active, sector_id, admin_id, tasks_completed, eco_points, bonus_accrued, tier, must_change_pin, created_at";
const PHONE_RE = /^\+?[0-9]{8,15}$/;

/**
 * Manage one worker.
 * body: { action: "update" | "reset_pin" | "transfer" | "deactivate" | "activate", name?, phone?, sector_id? }
 * Admins: only workers in their own sectors (and transfers only into their own sectors).
 * Super admin: any worker, any sector.
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const s = requireRole(req, ["admin", "super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, string>>(req);
    const action = b?.action;
    const sb = serverSupabase();

    const { data: w, error: we } = await sb.from("workers").select("id, name, sector_id, admin_id, employee_id").eq("id", params.id).maybeSingle();
    if (we) throw we;
    if (!w) return fail("Worker not found.", 404);

    // Authorisation: an admin controls only workers in sectors they own
    if (s.role === "admin") {
      const owns = w.admin_id === s.sub || (w.sector_id
        ? !!(await sb.from("sectors").select("id").eq("id", w.sector_id).eq("admin_id", s.sub).maybeSingle()).data
        : false);
      if (!owns) return fail("This worker is not in one of your sectors.", 403);
    }

    let update: Record<string, unknown> = {};
    let pin: string | null = null;

    if (action === "update") {
      if (typeof b?.name === "string") {
        if (b.name.trim().length < 2) return fail("Name is too short.", 400);
        update.name = b.name.trim();
      }
      if (typeof b?.phone === "string") {
        const phone = b.phone.replace(/[\s-]/g, "");
        if (!PHONE_RE.test(phone)) return fail("Enter a valid phone number (8-15 digits).", 400);
        const { data: dup } = await sb.from("workers").select("id").eq("phone", phone).neq("id", params.id).maybeSingle();
        if (dup) return fail("Another worker already uses this phone number.", 409);
        update.phone = phone;
      }
    } else if (action === "reset_pin") {
      pin = generatePin();
      update = { pin_hash: hashSecret(pin), must_change_pin: true };
    } else if (action === "transfer") {
      const sectorId = (b?.sector_id ?? "").trim();
      const { data: target } = await sb.from("sectors").select("id, area, name, admin_id, active").eq("id", sectorId).maybeSingle();
      if (!target || !target.active) return fail("Choose an active sector.", 400);
      if (!target.admin_id) return fail("That sector has no admin yet.", 400);
      if (s.role === "admin" && target.admin_id !== s.sub) {
        return fail("You can only transfer into your own sectors. Ask the super admin for transfers to other admins.", 403);
      }
      update = { sector_id: target.id, admin_id: target.admin_id, ward: `${target.area} ${target.name}` };
      // open tasks go back to the dispatch queue of the old sector
      const { error: te } = await sb.from("dump_reports").update({ assigned_worker_id: null, status: "Submitted" })
        .eq("assigned_worker_id", params.id).in("status", ["Worker Assigned", "Cleaning in Progress"]);
      if (te) throw te;
    } else if (action === "deactivate") {
      update = { active: false, status: "Off Duty" };
    } else if (action === "activate") {
      update = { active: true };
    } else {
      return fail("Unknown action.", 400);
    }

    const { data, error } = await sb.from("workers").update(update).eq("id", params.id).select(SAFE_COLS).single();
    if (error) throw error;
    await audit(sb, s, `WORKER_${String(action).toUpperCase()}`, "worker", params.id, {
      employee_id: w.employee_id,
      ...(action === "transfer" ? { from_sector: w.sector_id, to_sector: update.sector_id } : {}),
      ...(action === "update" ? update : {}),
    });
    return NextResponse.json({ success: true, worker: data, ...(pin ? { one_time_pin: pin } : {}) });
  } catch (e) {
    return serverError(e, "workers-update");
  }
}
