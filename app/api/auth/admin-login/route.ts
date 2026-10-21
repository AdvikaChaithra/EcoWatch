import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, verifySecret, verifyTotp, signSession } from "@/lib/server";

// Demo shortcuts are OFF by default. Set ALLOW_DEMO_AUTH=true (never in production) to accept
// the demo 2FA PIN for admins that have no TOTP secret enrolled.
const DEMO_TOTP = "123456";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<{ email?: string; password?: string; totp?: string }>(req);
    if (!body) return fail("Invalid request body.", 400);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const totp = typeof body.totp === "string" ? body.totp.trim() : "";

    if (!email || !password) return fail("Email and password are required.", 400);

    const supabase = serverSupabase();
    const { data: admin, error } = await supabase
      .from("admins")
      .select("id, name, email, password_hash, totp_secret, admin_id, ward_jurisdiction, designation, role, active, must_change_password")
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

    // ── 2FA ───────────────────────────────────────────────────────────────
    if (admin.totp_secret) {
      if (!totp) return fail("2FA code required.", 401);
      if (!verifyTotp(admin.totp_secret, totp)) return fail("Invalid 2FA code.", 401);
    } else if (process.env.ALLOW_DEMO_AUTH === "true") {
      if (totp && totp !== DEMO_TOTP) return fail("Invalid 2FA PIN.", 401);
    } else if (process.env.REQUIRE_2FA === "true") {
      return fail("2FA is required but not enrolled for this account.", 403);
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
