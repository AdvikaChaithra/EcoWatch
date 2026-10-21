import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, hashSecret, generatePassword, requireRole, audit } from "@/lib/server";

// Reads the caller's session token, so this route must never be pre-rendered at build time.
export const dynamic = "force-dynamic";

const SAFE_COLS = "id, name, email, phone, admin_id, ward_jurisdiction, designation, role, active, must_change_password, created_at";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Super admin: list all admin accounts (no credential columns). */
export async function GET(req: NextRequest) {
  try {
    const s = requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const { data, error } = await serverSupabase().from("admins").select(SAFE_COLS).order("created_at");
    if (error) throw error;
    return NextResponse.json({ success: true, admins: data });
  } catch (e) {
    return serverError(e, "super-admins-list");
  }
}

/** Super admin: create a municipal admin. Returns a one-time temporary password (shown once). */
export async function POST(req: NextRequest) {
  try {
    const s = requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<Record<string, string>>(req);
    const name = (b?.name ?? "").trim();
    const email = (b?.email ?? "").trim().toLowerCase();
    const designation = (b?.designation ?? "").trim() || "Ward Officer";
    const phone = (b?.phone ?? "").trim() || null;
    const jurisdiction = (b?.ward_jurisdiction ?? "").trim() || null;
    if (name.length < 2) return fail("Enter the admin's full name.", 400);
    if (!EMAIL_RE.test(email)) return fail("Enter a valid email address.", 400);

    const sb = serverSupabase();
    const { data: exists, error: ee } = await sb.from("admins").select("id").eq("email", email).maybeSingle();
    if (ee) throw ee;
    if (exists) return fail("An admin with this email already exists.", 409);

    const { count } = await sb.from("admins").select("id", { count: "exact", head: true }).eq("role", "admin");
    const tempPassword = generatePassword();
    const row = {
      name, email, designation, phone, ward_jurisdiction: jurisdiction,
      admin_id: `ADM-BBMP-${String((count ?? 0) + 1).padStart(3, "0")}-${Date.now().toString(36).slice(-3).toUpperCase()}`,
      password_hash: hashSecret(tempPassword), role: "admin", active: true, must_change_password: true,
    };
    const { data, error } = await sb.from("admins").insert(row).select(SAFE_COLS).single();
    if (error) throw error;
    await audit(sb, s, "ADMIN_CREATED", "admin", data.id, { email, designation });
    return NextResponse.json({ success: true, admin: data, temporary_password: tempPassword });
  } catch (e) {
    return serverError(e, "super-admins-create");
  }
}
