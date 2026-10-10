import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { employee_id, pin } = await req.json();

    if (!employee_id || !pin) {
      return NextResponse.json({ success: false, error: "Employee ID and PIN are required." }, { status: 400 });
    }

    if (pin.length !== 4) {
      return NextResponse.json({ success: false, error: "PIN must be exactly 4 digits." }, { status: 400 });
    }

    // ── Lookup worker by employee_id ──────────────────────────────────────
    const { data: worker, error } = await supabase
      .from("workers")
      .select("id, name, phone, employee_id, pin_hash, ward, status, active, lat, lng, tasks_completed, eco_points, bonus_accrued, tier")
      .eq("employee_id", employee_id)
      .maybeSingle();

    if (error) throw error;

    if (!worker) {
      return NextResponse.json({ success: false, error: "Employee ID not found." }, { status: 401 });
    }

    if (!worker.active) {
      return NextResponse.json({ success: false, error: "This worker account has been deactivated." }, { status: 403 });
    }

    // ── Verify PIN ────────────────────────────────────────────────────────
    // Demo: plain-text comparison (schema seeds pin_hash = '1234')
    // Fallback bypass: seeded workers always accept PIN 1234
    const SEEDED_WORKERS = ["EW-WRK-001", "EW-WRK-002", "EW-WRK-003"];
    const demoBypass = SEEDED_WORKERS.includes(employee_id.trim()) && pin === "1234";
    const dbMatch    = pin === (worker.pin_hash ?? "").trim();

    if (!dbMatch && !demoBypass) {
      return NextResponse.json({ success: false, error: "Incorrect PIN." }, { status: 401 });
    }

    // ── Update worker to On Duty on login ─────────────────────────────────
    await supabase
      .from("workers")
      .update({ status: "On Duty", updated_at: new Date().toISOString() })
      .eq("id", worker.id);

    return NextResponse.json({
      success: true,
      worker: {
        id:          worker.id,
        name:        worker.name,
        phone:       worker.phone,
        employee_id: worker.employee_id,
        ward:        worker.ward,
        status:      "On Duty",
        lat:         worker.lat,
        lng:         worker.lng,
        tasks_completed: worker.tasks_completed,
        eco_points:  worker.eco_points,
        bonus_accrued: worker.bonus_accrued,
        tier:        worker.tier,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
