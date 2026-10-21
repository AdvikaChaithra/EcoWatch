import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, verifySecret, hashSecret, requireRole, audit } from "@/lib/server";

/** Worker changes their own 4-digit PIN (required after an admin issues a one-time PIN). */
export async function POST(req: NextRequest) {
  try {
    const s = requireRole(req, ["worker"]);
    if (s instanceof NextResponse) return s;
    const body = await readJson<{ current?: string; next?: string }>(req);
    const current = body?.current ?? "";
    const next = body?.next ?? "";
    if (!/^\d{4}$/.test(next)) return fail("New PIN must be exactly 4 digits.", 400);
    if (next === current) return fail("New PIN must be different from the current one.", 400);
    if (["0000", "1111", "1234", "4321"].includes(next)) return fail("Please choose a less guessable PIN.", 400);

    const sb = serverSupabase();
    const { data: w, error } = await sb.from("workers").select("id, pin_hash").eq("id", s.sub).single();
    if (error) throw error;
    if (!verifySecret(current, w.pin_hash)) return fail("Current PIN is incorrect.", 401);

    const { error: ue } = await sb.from("workers")
      .update({ pin_hash: hashSecret(next), must_change_pin: false }).eq("id", s.sub);
    if (ue) throw ue;
    await audit(sb, s, "PIN_CHANGED", "worker", s.sub);
    return NextResponse.json({ success: true });
  } catch (e) {
    return serverError(e, "change-pin");
  }
}
