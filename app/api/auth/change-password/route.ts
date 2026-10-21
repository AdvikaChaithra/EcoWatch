import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, verifySecret, hashSecret, requireRole, audit } from "@/lib/server";

/** Admin / super admin changes their own password (required on first login). */
export async function POST(req: NextRequest) {
  try {
    const s = await requireRole(req, ["admin", "super_admin"]);
    if (s instanceof NextResponse) return s;
    const body = await readJson<{ current?: string; next?: string }>(req);
    const current = body?.current ?? "";
    const next = body?.next ?? "";
    if (next.length < 8 || !/[A-Za-z]/.test(next) || !/[0-9]/.test(next)) {
      return fail("New password must be at least 8 characters and contain letters and numbers.", 400);
    }
    if (next === current) return fail("New password must be different from the current one.", 400);

    const sb = serverSupabase();
    const { data: admin, error } = await sb.from("admins").select("id, password_hash").eq("id", s.sub).single();
    if (error) throw error;
    if (!verifySecret(current, admin.password_hash)) return fail("Current password is incorrect.", 401);

    const { error: ue } = await sb.from("admins")
      .update({ password_hash: hashSecret(next), must_change_password: false }).eq("id", s.sub);
    if (ue) throw ue;
    await audit(sb, s, "PASSWORD_CHANGED", "admin", s.sub);
    return NextResponse.json({ success: true });
  } catch (e) {
    return serverError(e, "change-password");
  }
}
