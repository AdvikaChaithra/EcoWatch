import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, requireRole, audit } from "@/lib/server";
import { pointsFor, inRange, TASK_BONUS_RUPEES, TASK_BONUS_MIN, TASK_BONUS_MAX, TASK_POINTS_MIN, TASK_POINTS_MAX } from "@/lib/taskPoints";

// Reads the caller's session token, so this route must never be pre-rendered at build time.
export const dynamic = "force-dynamic";

/**
 * Admin decision on a worker's cleanup proof. body: { approved: boolean, bonus?: ₹0-1000, points?: 40-200 }
 * (bonus / points default to the suggested amounts when not given).
 * - Allowed for the admin who owns the report's sector, the admin the worker reports to, or the super admin.
 * - Acts only while the report is "Pending Verification", so it can never be credited twice.
 * - Approve: report -> "Cleaned & Verified" (verified_at/by, worker_points); worker gets +1 task,
 *   the chosen bonus and eco-points. Reject: report goes back to the dispatch queue.
 */
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const s = await requireRole(req, ["admin", "super_admin"]);
    if (s instanceof NextResponse) return s;
    const b = await readJson<{ approved?: boolean; bonus?: unknown; points?: unknown }>(req);
    if (typeof b?.approved !== "boolean") return fail("Say whether the cleanup is approved.", 400);
    const bonus = b.bonus === undefined ? TASK_BONUS_RUPEES : inRange(b.bonus, TASK_BONUS_MIN, TASK_BONUS_MAX);
    if (b.approved && bonus === null) return fail(`Bonus must be a whole amount from ₹${TASK_BONUS_MIN} to ₹${TASK_BONUS_MAX}.`, 400);
    const chosenPoints = b.points === undefined ? undefined : inRange(b.points, TASK_POINTS_MIN, TASK_POINTS_MAX);
    if (b.approved && chosenPoints === null) return fail(`Eco-points must be a whole number from ${TASK_POINTS_MIN} to ${TASK_POINTS_MAX}.`, 400);
    const sb = serverSupabase();

    const { data: r, error: re } = await sb.from("dump_reports")
      .select("id, status, severity, category, location_name, sector_id, assigned_worker_id").eq("id", params.id).maybeSingle();
    if (re) throw re;
    if (!r) return fail("Report not found.", 404);
    if (r.status !== "Pending Verification") return fail("This report was already reviewed or is not awaiting verification.", 409);

    const { data: w, error: we } = r.assigned_worker_id
      ? await sb.from("workers").select("id, name, admin_id, tasks_completed, bonus_accrued, eco_points").eq("id", r.assigned_worker_id).maybeSingle()
      : { data: null, error: null };
    if (we) throw we;

    if (s.role === "admin") {
      const { data: sec } = r.sector_id
        ? await sb.from("sectors").select("admin_id").eq("id", r.sector_id).maybeSingle()
        : { data: null };
      if (sec?.admin_id !== s.sub && w?.admin_id !== s.sub) {
        return fail("This report belongs to another admin's sector and worker.", 403);
      }
    }

    const now = new Date().toISOString();
    const points = chosenPoints ?? pointsFor(r.severity as string);
    const update = b.approved
      ? { status: "Cleaned & Verified", verified_at: now, verified_by: s.sub, worker_points: w ? points : null, updated_at: now }
      : { status: "Submitted", assigned_worker_id: null, cleaned_image_url: null, updated_at: now };
    // guarded on the status so two admins (or a double click) can't both act
    const { data: done, error: ue } = await sb.from("dump_reports").update(update)
      .eq("id", r.id).eq("status", "Pending Verification").select("id");
    if (ue) throw ue;
    if (!done || done.length === 0) return fail("This report was already reviewed.", 409);

    if (b.approved && w) {
      const { error: ce } = await sb.from("workers").update({
        tasks_completed: (w.tasks_completed ?? 0) + 1,
        bonus_accrued: Number(w.bonus_accrued ?? 0) + (bonus ?? 0),
        eco_points: (w.eco_points ?? 0) + points,
      }).eq("id", w.id);
      if (ce) throw ce;
    }

    await audit(sb, s, b.approved ? "REPORT_APPROVED" : "REPORT_REJECTED", "report", r.id,
      { worker: w?.name ?? null, category: r.category, points: b.approved && w ? points : 0, bonus: b.approved && w ? bonus : 0 });
    return NextResponse.json({
      success: true, approved: b.approved,
      points: b.approved && w ? points : 0, bonus: b.approved && w ? bonus : 0, worker: w?.name ?? null,
    });
  } catch (e) {
    return serverError(e, "report-verify");
  }
}
