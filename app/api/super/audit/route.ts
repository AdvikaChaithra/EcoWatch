import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, serverError, requireRole } from "@/lib/server";

// Reads the caller's session token, so this route must never be pre-rendered at build time.
export const dynamic = "force-dynamic";

/** Super admin: most recent privileged actions. */
export async function GET(req: NextRequest) {
  try {
    const s = requireRole(req, ["super_admin"]);
    if (s instanceof NextResponse) return s;
    const { data, error } = await serverSupabase().from("audit_log").select("*")
      .order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return NextResponse.json({ success: true, entries: data });
  } catch (e) {
    return serverError(e, "super-audit");
  }
}
