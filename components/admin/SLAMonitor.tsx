"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { useSectorScope } from "@/hooks/useSectorScope";
import { useState, useEffect } from "react";
import { Timer, CheckCircle2, XCircle, X, Loader2 } from "lucide-react";
import { getDumpReports, verifyReport, supabase } from "@/lib/supabase";
import { cn, formatDateTime, severityColor, statusColor } from "@/lib/utils";
import { Portal } from "@/components/shared/Portal";

interface Report { id: string; category: string; severity: string; location_name: string; status: string; created_at: string; reported_image_url?: string; cleaned_image_url?: string; assigned_worker_id?: string; workers?: { name: string }; }

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

  const { inScope, key: scopeKey } = useSectorScope();
  useEffect(() => { loadReports(); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadReports() {
    setLoading(true);
    try {
      const { data, error: qErr } = await supabase
        .from("dump_reports")
        .select("*, workers(name)")
        .in("status", ["Worker Assigned","Cleaning in Progress","Pending Verification"])
        .order("created_at", { ascending: true });
      if (qErr) throw qErr;
      setReports((data ?? []).filter((r: any) => inScope(r.sector_id)));
      setError("");
    } catch (e) { setError(errMsg(e, "Could not load active tasks.")); } finally { setLoading(false); }
  }

  async function handleVerify(approved: boolean) {
    if (!selected) return;
    setActionLoading(true);
    try {
      await verifyReport(selected.id, approved);
      if (approved && selected.assigned_worker_id) {
        // Award worker bonus
        const { data: worker, error: wErr } = await supabase.from("workers").select("tasks_completed, bonus_accrued, eco_points").eq("id", selected.assigned_worker_id).single();
        if (wErr) throw wErr;
        if (worker) {
          const { error: uErr } = await supabase.from("workers").update({
            tasks_completed: (worker.tasks_completed ?? 0) + 1,
            bonus_accrued: Number(worker.bonus_accrued ?? 0) + 200,
            eco_points: (worker.eco_points ?? 0) + 100,
          }).eq("id", selected.assigned_worker_id);
          if (uErr) throw uErr;
        }
      }
      setSuccess(approved ? "Cleanup approved! Worker bonus of ₹200 credited." : "Rejected. Report re-dispatched to queue.");
      setReports((r) => r.filter((x) => x.id !== selected.id));
      setTimeout(() => { setSelected(null); setSuccess(""); }, 2500);
    } catch (e) {
      setError(errMsg(e, "Could not complete verification. Please check the report and retry."));
    } finally { setActionLoading(false); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-display font-bold text-slate-100">SLA Monitor & Verification</h2>
        <span className="badge bg-orange-500/10 text-orange-400 border-orange-500/20">{reports.length} active</span>
      </div>

      {reports.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <Timer className="w-12 h-12 text-eco-400 mx-auto mb-3 opacity-40" />
          <p className="text-slate-400">No tasks pending verification</p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="civic-table">
            <thead className="bg-civic-900/80">
              <tr>
                <th>Report</th>
                <th>Worker</th>
                <th>Status</th>
                <th>SLA Timer</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
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
                  <td>
                    {r.status === "Pending Verification" && (
                      <button onClick={() => setSelected(r)} className="btn-eco text-xs px-3 py-1.5">
                        Verify
                      </button>
                    )}
                  </td>
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
          <div className="w-full max-w-2xl glass-card p-6 animate-fade-in-up">
            <div className="flex items-center justify-between mb-5">
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
                <div className="flex gap-3">
                  <button onClick={() => handleVerify(false)} disabled={actionLoading} className="btn-danger flex-1 justify-center">
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                    Reject &amp; Re-dispatch
                  </button>
                  <button onClick={() => handleVerify(true)} disabled={actionLoading} className="btn-eco flex-1 justify-center">
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    Approve &amp; Credit ₹200 Bonus
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

