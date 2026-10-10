"use client";
import { useState, useEffect } from "react";
import { MapPin, User, Zap, X, CheckCircle2, Loader2, Navigation } from "lucide-react";
import { getDumpReports, getWorkers, assignWorkerToReport } from "@/lib/supabase";
import { haversineMeters } from "@/lib/supabase";
import { cn, formatDate, severityColor, statusColor } from "@/lib/utils";

interface Report { id: string; category: string; severity: string; location_name: string; lat: number; lng: number; status: string; created_at: string; reported_image_url?: string; }
interface Worker { id: string; name: string; phone: string; ward: string; status: string; lat?: number; lng?: number; tasks_completed: number; }

export function TaskDispatch() {
  const [reports, setReports] = useState<Report[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Report | null>(null);
  const [dispatching, setDispatching] = useState<string | null>(null);
  const [success, setSuccess] = useState("");

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [rData, wData] = await Promise.all([
        getDumpReports(),
        getWorkers(),
      ]);
      setReports((rData ?? []).filter((r: Report) => r.status === "Submitted"));
      setWorkers((wData ?? []).filter((w: Worker) => w.status === "On Duty"));
    } catch {} finally { setLoading(false); }
  }

  const nearestWorkers = (report: Report) =>
    workers
      .map((w) => ({
        ...w,
        // FIX 5: Workers without GPS sort to the end (Infinity) — no fake random distances
        distKm: w.lat && w.lng
          ? haversineMeters(report.lat ?? 12.9716, report.lng ?? 77.5946, w.lat, w.lng) / 1000
          : Infinity,
      }))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 5);

  async function handleAssign(reportId: string, workerId: string) {
    setDispatching(workerId);
    try {
      await assignWorkerToReport(reportId, workerId);
      setSuccess("Worker dispatched successfully!");
      setReports((r) => r.filter((x) => x.id !== reportId));
      setTimeout(() => { setSelected(null); setSuccess(""); }, 2000);
    } finally { setDispatching(null); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-display font-bold text-slate-100">Citizen Reports & Task Dispatch</h2>
        <span className="badge bg-orange-500/10 text-orange-400 border-orange-500/20">{reports.length} unassigned</span>
      </div>

      {reports.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <CheckCircle2 className="w-12 h-12 text-eco-400 mx-auto mb-3 opacity-40" />
          <p className="text-slate-400">All reports have been assigned!</p>
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="civic-table">
            <thead className="bg-civic-900/80">
              <tr>
                <th>Thumbnail</th>
                <th>Category</th>
                <th>Severity</th>
                <th>Location</th>
                <th>Submitted</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="w-14 h-10 rounded-lg overflow-hidden bg-civic-800">
                      {r.reported_image_url ? <img src={r.reported_image_url} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-slate-600 text-xs">📷</div>}
                    </div>
                  </td>
                  <td className="font-medium text-slate-200">{r.category}</td>
                  <td><span className={cn("badge text-xs", severityColor(r.severity))}>{r.severity}</span></td>
                  <td className="max-w-48">
                    <div className="flex items-start gap-1">
                      <MapPin className="w-3.5 h-3.5 text-eco-400 shrink-0 mt-0.5" />
                      <span className="text-xs text-slate-400 line-clamp-2">{r.location_name}</span>
                    </div>
                  </td>
                  <td className="text-xs">{formatDate(r.created_at)}</td>
                  <td><span className={cn("badge text-xs", statusColor(r.status))}>{r.status}</span></td>
                  <td>
                    <button onClick={() => setSelected(r)} className="btn-eco text-xs px-3 py-1.5">
                      <Zap className="w-3.5 h-3.5" /> Dispatch
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Dispatch Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-xl glass-card p-6 animate-fade-in-up max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-display font-bold text-lg text-slate-100">Smart Dispatch</h3>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400"><X className="w-5 h-5" /></button>
            </div>

            {success ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <CheckCircle2 className="w-12 h-12 text-eco-400" />
                <p className="text-eco-300 font-semibold">{success}</p>
              </div>
            ) : (
              <>
                <div className="glass-card-sm p-4 mb-5">
                  <p className="text-xs text-slate-400 mb-1">Report Location</p>
                  <div className="flex items-start gap-2">
                    <MapPin className="w-4 h-4 text-eco-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-slate-200 font-medium">{selected.location_name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{selected.category} · <span className={cn("font-semibold", severityColor(selected.severity).split(" ")[0])}>{selected.severity}</span></p>
                    </div>
                  </div>
                </div>

                <p className="text-sm font-semibold text-slate-300 mb-3">
                  Nearest Available Workers ({nearestWorkers(selected).length})
                </p>

                {workers.length === 0 ? (
                  <p className="text-sm text-slate-500 text-center py-4">No workers currently On Duty</p>
                ) : (
                  <div className="space-y-2">
                    {nearestWorkers(selected).map((w) => (
                      <div key={w.id} className="flex items-center justify-between p-3 rounded-xl border border-white/8 hover:border-eco-500/20 bg-white/3 transition-all">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center">
                            <User className="w-4 h-4 text-yellow-400" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-slate-200">{w.name}</p>
                            <p className="text-xs text-slate-400">Ward: {w.ward} · {w.tasks_completed} tasks done</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className="text-xs font-semibold text-eco-400">
                              {w.distKm === Infinity ? "No GPS" : `${w.distKm.toFixed(1)} km`}
                            </p>
                            <p className="text-[10px] text-slate-500">{w.distKm === Infinity ? "location unknown" : "away"}</p>
                          </div>
                          <button
                            onClick={() => handleAssign(selected.id, w.id)}
                            disabled={dispatching === w.id}
                            className="btn-eco text-xs px-3 py-1.5"
                          >
                            {dispatching === w.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Navigation className="w-3.5 h-3.5" />}
                            Assign
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
