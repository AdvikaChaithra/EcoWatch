import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, hashSecret, generatePassword, requireRole, audit } from "@/lib/server";

const SAFE_COLS = "id, name, email, phone, admin_id, ward_jurisdiction, designation, role, active, must_change_password, created_at";

/**
 * Super admin manages one admin account.
 * body: { action: "update" | "reset_password" | "deactivate" | "activate", name?, designation?, phone?, ward_jurisdiction? }
 */
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const s = await requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, any>>(req);
    const action = b?.action;
    const sb = serverSupabase();

    const { data: target, error: te } = await sb.from("admins").select("id, role, name, email").eq("id", params.id).maybeSingle();
    if (te) throw te;
    if (!target) return fail("Admin not found.", 404);
    if (target.role === "super_admin" && action !== "update") return fail("The super admin account cannot be changed here.", 400);

    let update: Record<string, unknown> = {};
    let tempPassword: string | null = null;

    if (action === "update") {
      for (const k of ["name", "designation", "phone", "ward_jurisdiction"]) {
        if (typeof b?.[k] === "string") update[k] = b[k].trim() || null;
      }
      if (update.name !== undefined && String(update.name ?? "").length < 2) return fail("Name is too short.", 400);
    } else if (action === "reset_password") {
      tempPassword = generatePassword();
      update = { password_hash: hashSecret(tempPassword), must_change_password: true };
    } else if (action === "deactivate") {
      // Nothing may be orphaned: the admin's sectors must be reassigned first.
      const { data: owned, error: oe } = await sb.from("sectors").select("id, area, name").eq("admin_id", params.id).eq("active", true);
      if (oe) throw oe;
      if (owned && owned.length) {
        return fail(`Reassign this admin's sectors first: ${owned.map((x) => `${x.area} ${x.name}`).join(", ")}.`, 409);
      }
      update = { active: false };
    } else if (action === "activate") {
      update = { active: true };
    } else {
      return fail("Unknown action.", 400);
    }

    const { data, error } = await sb.from("admins").update(update).eq("id", params.id).select(SAFE_COLS).single();
    if (error) throw error;
    await audit(sb, s, `ADMIN_${String(action).toUpperCase()}`, "admin", params.id,
      action === "update" ? update : { email: target.email });
    return NextResponse.json({ success: true, admin: data, ...(tempPassword ? { temporary_password: tempPassword } : {}) });
  } catch (e) {
    return serverError(e, "super-admin-update");
  }
}
