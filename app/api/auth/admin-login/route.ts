import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, verifySecret, signSession } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<{ email?: string; password?: string }>(req);
    if (!body) return fail("Invalid request body.", 400);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";

    if (!email || !password) return fail("Email and password are required.", 400);

    const supabase = serverSupabase();
    const { data: admin, error } = await supabase
      .from("admins")
      .select("id, name, email, password_hash, admin_id, ward_jurisdiction, designation, role, active, must_change_password")
      .eq("email", email)
      .maybeSingle();
    if (error) throw error;

    // Same response for unknown email and wrong password (no account enumeration).
    if (!admin || !verifySecret(password, admin.password_hash)) {
      return fail("Invalid email or password.", 401);
    }
    if (admin.active === false) {
      return fail("This admin account has been deactivated. Contact the Municipal Commissioner.", 403);
    }

    const role = admin.role === "super_admin" ? "super_admin" : "admin";
    return NextResponse.json({
      success: true,
      token: signSession(admin.id, role, admin.name),
      admin: {
        id: admin.id,
        role,
        must_change_password: !!admin.must_change_password,
        name: admin.name,
        email: admin.email,
        admin_id: admin.admin_id,
        ward_jurisdiction: admin.ward_jurisdiction,
        designation: admin.designation,
      },
    });
  } catch (e) {
    return serverError(e, "admin-login");
  }
}
