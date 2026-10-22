import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, verifySecret, signSession , hashSecret } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<{ employee_id?: string; pin?: string }>(req);
    if (!body) return fail("Invalid request body.", 400);
    // Employee IDs are stored in capitals (unique case-insensitively), so "ew-wrk-005" also signs in.
    const employee_id = typeof body.employee_id === "string" ? body.employee_id.trim().toUpperCase() : "";
    const pin = typeof body.pin === "string" ? body.pin : "";

    if (!employee_id || !pin) return fail("Employee ID and PIN are required.", 400);
    if (!/^\d{4}$/.test(pin)) return fail("PIN must be exactly 4 digits.", 400);

    const supabase = serverSupabase();
    const { data: worker, error } = await supabase
      .from("workers")
      .select("id, name, phone, employee_id, pin_hash, ward, status, active, lat, lng, tasks_completed, eco_points, bonus_accrued, tier, sector_id, must_change_pin")
      .eq("employee_id", employee_id)
      .maybeSingle();
    if (error) throw error;

    // Same response for unknown ID and wrong PIN (no account enumeration).
    if (!worker || !verifySecret(pin, worker.pin_hash)) {
      return fail("Invalid employee ID or PIN.", 401);
    }
    if (worker.active === false) {
      return fail("This worker account has been deactivated.", 403);
    }

    // A PIN still stored in plain text (pre-hashing accounts) is upgraded to a pbkdf2 hash here.
    const upgrade = worker.pin_hash && !String(worker.pin_hash).startsWith("pbkdf2$") ? { pin_hash: hashSecret(pin) } : {};
    const { error: updErr } = await supabase
      .from("workers")
      .update({ status: "On Duty", updated_at: new Date().toISOString(), ...upgrade })
      .eq("id", worker.id);
    if (updErr) throw updErr;

    return NextResponse.json({
      success: true,
      token: signSession(worker.id, "worker", worker.name),
      worker: {
        sector_id: worker.sector_id,
        must_change_pin: !!worker.must_change_pin,
        id: worker.id,
        name: worker.name,
        phone: worker.phone,
        employee_id: worker.employee_id,
        ward: worker.ward,
        status: "On Duty",
        lat: worker.lat,
        lng: worker.lng,
        tasks_completed: worker.tasks_completed,
        eco_points: worker.eco_points,
        bonus_accrued: worker.bonus_accrued,
        tier: worker.tier,
      },
    });
  } catch (e) {
    return serverError(e, "worker-login");
  }
}
