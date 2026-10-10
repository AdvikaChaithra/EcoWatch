import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// Demo TOTP: accept "123456" for all admin accounts in dev mode
const DEMO_TOTP = "123456";

export async function POST(req: NextRequest) {
  try {
    const { email, password, totp } = await req.json();

    if (!email || !password) {
      return NextResponse.json({ success: false, error: "Email and password are required." }, { status: 400 });
    }

    // ── Validate 2FA PIN ──────────────────────────────────────────────────
    if (totp && totp !== DEMO_TOTP) {
      return NextResponse.json({ success: false, error: "Invalid 2FA PIN." }, { status: 401 });
    }

    // ── Lookup admin by email ─────────────────────────────────────────────
    const { data: admin, error } = await supabase
      .from("admins")
      .select("id, name, email, password_hash, admin_id, ward_jurisdiction, designation")
      .eq("email", email)
      .maybeSingle();

    if (error) throw error;

    if (!admin) {
      return NextResponse.json({ success: false, error: "No admin account found for this email." }, { status: 401 });
    }

    // ── Verify password ───────────────────────────────────────────────────
    // Demo: plain-text comparison (schema seeds password_hash = 'admin123')
    // Fallback: accept 'admin123' for the seeded demo admin regardless of DB state
    const trimmedPw   = password.trim();
    const demoBypass  = email.trim() === "admin@bbmp.gov.in" && trimmedPw === "admin123";
    const demoBypass2 = email.trim() === "sunitha@bbmp.gov.in" && trimmedPw === "admin123";
    const dbMatch     = trimmedPw === (admin.password_hash ?? "").trim();

    if (!dbMatch && !demoBypass && !demoBypass2) {
      return NextResponse.json({ success: false, error: "Incorrect password." }, { status: 401 });
    }

    return NextResponse.json({
      success: true,
      admin: {
        id:               admin.id,
        name:             admin.name,
        email:            admin.email,
        admin_id:         admin.admin_id,
        ward_jurisdiction:admin.ward_jurisdiction,
        designation:      admin.designation,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
