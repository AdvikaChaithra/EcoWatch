"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { useSectorScope } from "@/hooks/useSectorScope";
import { useState, useEffect } from "react";
import { Timer, CheckCircle2, XCircle, X, Loader2, RefreshCw, ClipboardCheck, Eye } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { authFetch } from "@/lib/api";
import { useEcoStore } from "@/lib/store";
import { pointsFor, inRange, TASK_BONUS_RUPEES, TASK_BONUS_MIN, TASK_BONUS_MAX, TASK_POINTS_MIN, TASK_POINTS_MAX } from "@/lib/taskPoints";
import { cn, formatDateTime, severityColor, statusColor } from "@/lib/utils";
import { Portal } from "@/components/shared/Portal";

interface Report {
  id: string; category: string; severity: string; location_name: string; status: string; created_at: string; updated_at?: string;
  reported_image_url?: string; cleaned_image_url?: string; assigned_worker_id?: string; sector_id?: string | null;
  proof_location_source?: "gps" | "manual_site" | null;
  workers?: { name: string; admin_id: string | null } | null;
}

/** Interactive draggable Before ↔ After image comparison slider */
function BeforeAfterSlider({ beforeUrl, afterUrl }: { beforeUrl?: string; afterUrl?: string }) {
  const [pos, setPos] = useState(50); // 0-100 percent
  const PLACEHOLDER = (
    <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-slate-500">
      <div className="text-3xl">📷</div>
      <p className="text-xs">Pending image</p>
    </div>
  );
  return (
    <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-civic-800 border border-white/10 select-none">
      {/* Before image (bottom layer, full width) */}
      <div className="absolute inset-0">
        {beforeUrl
          ? <img src={beforeUrl} alt="Before" className="w-full h-full object-cover" />
          : PLACEHOLDER}
        <span className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-orange-500/80 text-white text-[10px] font-bold">
          BEFORE
        </span>
      </div>
      {/* After image (top layer, clipped to right of slider) */}
      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}
      >
        {afterUrl
          ? <img src={afterUrl} alt="After" className="w-full h-full object-cover" />
          : PLACEHOLDER}
        <span className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-eco-500/80 text-white text-[10px] font-bold">
          AFTER
        </span>
      </div>
      {/* Divider handle */}
      <div
        className="absolute top-0 bottom-0 w-0.5 bg-white/90 shadow-lg"
        style={{ left: `${pos}%` }}
      >
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-white shadow-xl flex items-center justify-center">
          <span className="text-slate-700 text-base select-none">↔</span>
        </div>
      </div>
      {/* Invisible range input for dragging */}
      <input
        type="range" min={0} max={100} value={pos}
        onChange={(e) => setPos(Number(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize"
        aria-label="comparison slider"
      />
    </div>
  );
}

/** How the worker's proof was located (GPS geofence-checked vs chosen manually). */
function LocationBadge({ source }: { source?: "gps" | "manual_site" | null }) {
  if (source === "manual_site") {
    return <span className="badge text-[10px] mt-1 bg-orange-500/10 text-orange-300 border-orange-500/20">📍 Location chosen manually · GPS not verified</span>;
  }
  if (source === "gps") {
    return <span className="badge text-[10px] mt-1 bg-eco-500/10 text-eco-300 border-eco-500/20">📍 GPS verified (within 50 m)</span>;
  }
  return null;
}

function SlaTimer({ createdAt }: { createdAt: string }) {
  const hrs = (Date.now() - new Date(createdAt).getTime()) / 3600000;
  const color = hrs < 6 ? "sla-safe" : hrs < 12 ? "sla-warning" : "sla-breached";
  const label = hrs < 6 ? `${(6 - hrs).toFixed(1)}h remaining` : hrs < 12 ? `${(12 - hrs).toFixed(1)}h overdue` : "SLA Breached!";
  return <span className={cn("font-mono text-xs font-bold", color)}>{label}</span>;
}

export function SLAMonitor() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Report | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [success, setSuccess] = useState("");
  // Reward for this cleanup, chosen by the admin (pre-filled with the suggestion)
  const [bonusIn, setBonusIn] = useState(String(TASK_BONUS_RUPEES));
  const [pointsIn, setPointsIn] = useState("");
  const bonusVal = inRange(bonusIn, TASK_BONUS_MIN, TASK_BONUS_MAX);
  const pointsVal = inRange(pointsIn, TASK_POINTS_MIN, TASK_POINTS_MAX);

  function openReview(r: Report) {
    setSelected(r);
    setBonusIn(String(TASK_BONUS_RUPEES));
    setPointsIn(String(pointsFor(r.severity)));
  }

  const me = useEcoStore((s) => s.currentUser);
  const { inScope, filter, key: scopeKey } = useSectorScope();
  // An admin sees tasks in their sectors, plus (under "All my sectors") tasks done by their own workers.
  const visible = (r: Report) => inScope(r.sector_id) || (filter === "all" && !!me?.id && r.workers?.admin_id === me.id);

  useEffect(() => { loadReports(); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: refresh when a worker submits proof (or another admin acts on a task).
  useEffect(() => {
    const ch = supabase.channel("sla-monitor")
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dump_reports" }, () => loadReports(false))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadReports(spinner = true) {
    if (spinner) setLoading(true);
    try {
      const { data, error: qErr } = await supabase
        .from("dump_reports")
        .select("*, workers(name, admin_id)")
        .in("status", ["Worker Assigned", "Cleaning in Progress", "Pending Verification"])
        .order("created_at", { ascending: true });
      if (qErr) throw qErr;
      setReports(((data ?? []) as Report[]).filter(visible));
      setError("");
    } catch (e) { setError(errMsg(e, "Could not load active tasks.")); } finally { setLoading(false); }
  }

  async function handleVerify(approved: boolean) {
    if (!selected) return;
    setActionLoading(true);
    try {
      const r = await authFetch<{ points: number; bonus: number; worker: string | null }>(
        `/api/reports/${selected.id}/verify`, { method: "POST", body: JSON.stringify(approved ? { approved, bonus: bonusVal, points: pointsVal } : { approved }) });
      setSuccess(approved
        ? `Cleanup approved. ${r.worker ?? "The worker"} earned ${r.points} eco-points and a ₹${r.bonus} bonus.`
        : "Rejected. The report is back in the dispatch queue.");
      setReports((xs) => xs.filter((x) => x.id !== selected.id));
      setTimeout(() => { setSelected(null); setSuccess(""); }, 2500);
    } catch (e) {
      setError(errMsg(e, "Could not complete verification. Please check the report and retry."));
      setSelected(null);
    } finally { setActionLoading(false); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  const pending = reports.filter((r) => r.status === "Pending Verification")
    .sort((a, b) => new Date(b.updated_at ?? b.created_at).getTime() - new Date(a.updated_at ?? a.created_at).getTime());
  const inProgress = reports.filter((r) => r.status !== "Pending Verification");

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xl font-display font-bold text-slate-100 mr-auto">SLA Monitor & Verification</h2>
        <button onClick={() => loadReports()} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-slate-200" title="Refresh">
          <RefreshCw className="w-4 h-4" />
        </button>
        <span className="badge bg-eco-500/10 text-eco-400 border-eco-500/20">{pending.length} to verify</span>
        <span className="badge bg-orange-500/10 text-orange-400 border-orange-500/20">{inProgress.length} in progress</span>
      </div>

      {/* ── Finished by workers: awaiting this admin's decision ── */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-eco-300 flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4" /> Awaiting your verification ({pending.length})
        </h3>
        {pending.length === 0 ? (
          <div className="glass-card p-6 text-center text-sm text-slate-500">
            No finished tasks to check right now. When a worker uploads proof of a cleanup it appears here.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 gap-3">
            {pending.map((r) => (
              <div key={r.id} className="glass-card p-3 flex gap-3 border-eco-500/20">
                <div className="w-24 h-20 rounded-lg overflow-hidden bg-civic-800 shrink-0">
                  {r.cleaned_image_url
                    ? <img src={r.cleaned_image_url} alt="After cleanup" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-2xl">📷</div>}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={cn("badge text-[10px]", severityColor(r.severity))}>{r.severity}</span>
                    <span className="text-sm font-semibold text-slate-100">{r.category}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5 line-clamp-1" title={r.location_name}>{r.location_name}</p>
                  <p className="text-[11px] text-slate-500 mt-0.5">
                    {r.workers?.name ?? "Worker"} · submitted {formatDateTime(r.updated_at ?? r.created_at)}
                  </p>
                  <LocationBadge source={r.proof_location_source} />
                  <button onClick={() => openReview(r)} className="btn-eco text-xs px-3 py-1 mt-2">
                    <Eye className="w-3.5 h-3.5" /> Review &amp; approve
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Assigned, not finished yet ── */}
      <h3 className="text-sm font-semibold text-orange-300 flex items-center gap-2 pt-2">
        <Timer className="w-4 h-4" /> In progress ({inProgress.length})
      </h3>
      {inProgress.length === 0 ? (
        <div className="glass-card p-6 text-center text-sm text-slate-500">No tasks are in progress.</div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="civic-table">
            <thead className="bg-civic-900/80">
              <tr>
                <th>Report</th>
                <th>Worker</th>
                <th>Status</th>
                <th>SLA Timer</th>
              </tr>
            </thead>
            <tbody>
              {inProgress.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div>
                      <p className="font-medium text-slate-200">{r.category}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{r.location_name}</p>
                    </div>
                  </td>
                  <td className="text-sm">{r.workers?.name ?? <span className="text-slate-500">Unassigned</span>}</td>
                  <td><span className={cn("badge text-xs", statusColor(r.status))}>{r.status}</span></td>
                  <td><SlaTimer createdAt={r.created_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Verification Modal */}
      {selected && (
        <Portal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-2xl glass-card p-6 animate-fade-in-up max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-display font-bold text-lg text-slate-100">Verify Cleanup Proof</h3>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400"><X className="w-5 h-5" /></button>
            </div>

            {success ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <CheckCircle2 className="w-12 h-12 text-eco-400" />
                <p className="text-eco-300 font-semibold">{success}</p>
              </div>
            ) : (
              <>
                {selected.proof_location_source === "manual_site" && (
                  <p className="text-xs text-orange-300 bg-orange-500/10 border border-orange-500/20 rounded-lg p-2 mb-2">
                    The worker chose the dump-site location manually, so their GPS position was not checked against the 50 m geofence. Judge the cleanup from the photos.
                  </p>
                )}
                <p className="text-xs text-slate-400 mb-3">
                  <strong className="text-slate-200">{selected.category}</strong> ({selected.severity}) at {selected.location_name} ·
                  cleaned by <strong className="text-slate-200">{selected.workers?.name ?? "worker"}</strong>
                </p>
                {/* ── Draggable Before / After Comparison Slider ── */}
                <div className="mb-5">
                  <p className="text-xs text-slate-400 mb-2 text-center">
                    Drag slider to compare <span className="text-orange-400 font-semibold">Before</span> &amp; <span className="text-eco-400 font-semibold">After</span> photos
                  </p>
                  <BeforeAfterSlider
                    beforeUrl={selected.reported_image_url}
                    afterUrl={selected.cleaned_image_url}
                  />
                </div>
                {/* Reward for the worker if approved */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <label className="text-xs text-slate-400 space-y-1">
                    <span>Bonus (₹{TASK_BONUS_MIN} – ₹{TASK_BONUS_MAX})</span>
                    <input type="number" min={TASK_BONUS_MIN} max={TASK_BONUS_MAX} step={1} value={bonusIn}
                           onChange={(e) => setBonusIn(e.target.value)}
                           className={cn("input-civic", bonusVal === null && "border-red-500/60")} />
                  </label>
                  <label className="text-xs text-slate-400 space-y-1">
                    <span>Eco-points ({TASK_POINTS_MIN} – {TASK_POINTS_MAX})</span>
                    <input type="number" min={TASK_POINTS_MIN} max={TASK_POINTS_MAX} step={1} value={pointsIn}
                           onChange={(e) => setPointsIn(e.target.value)}
                           className={cn("input-civic", pointsVal === null && "border-red-500/60")} />
                  </label>
                  {(bonusVal === null || pointsVal === null) && (
                    <p className="col-span-2 text-[11px] text-red-300">
                      Enter whole numbers: bonus ₹{TASK_BONUS_MIN}–{TASK_BONUS_MAX}, eco-points {TASK_POINTS_MIN}–{TASK_POINTS_MAX}.
                    </p>
                  )}
                </div>
                <div className="flex gap-3">
                  <button onClick={() => handleVerify(false)} disabled={actionLoading} className="btn-danger flex-1 justify-center">
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                    Reject &amp; Re-dispatch
                  </button>
                  <button onClick={() => handleVerify(true)} disabled={actionLoading || bonusVal === null || pointsVal === null}
                          className="btn-eco flex-1 justify-center disabled:opacity-40">
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    Approve · +{pointsVal ?? "?"} pts &amp; ₹{bonusVal ?? "?"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        </Portal>
      )}
    </div>
  );
}
