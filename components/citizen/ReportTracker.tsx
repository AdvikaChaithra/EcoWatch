"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { useState, useEffect } from "react";
import { CheckCircle2, Clock, HardHat, Loader2, ChevronRight, ImageIcon } from "lucide-react";
import { getDumpReports, supabase } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { cn, formatDate, statusColor } from "@/lib/utils";

const STEPS = [
  { key: "Submitted",           label: "Submitted",            icon: "📤" },
  { key: "Worker Assigned",     label: "Worker Assigned",      icon: "👷" },
  { key: "Cleaning in Progress",label: "Cleaning in Progress", icon: "🧹" },
  { key: "Pending Verification",label: "Pending Verification", icon: "🔍" },
  { key: "Cleaned & Verified",  label: "Cleaned & Verified",   icon: "✅" },
];

interface Report {
  id: string; category: string; severity: string; location_name: string;
  status: string; created_at: string; reported_image_url?: string;
  cleaned_image_url?: string; workers?: { name: string };
}

export function ReportTracker() {
  const user = useEcoStore((s) => s.currentUser);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState<Report | null>(null);
  const [sliderPos, setSliderPos] = useState(50);

  useEffect(() => {
    loadReports();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live: dispatch, cleanup and verification of this citizen's reports show up without a reload.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase.channel(`my-reports:${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "dump_reports", filter: `citizen_id=eq.${user.id}` },
          () => loadReports(false))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadReports(spinner = true) {
    if (!user?.id) { setReports([]); setLoading(false); return; }   // never list other people's reports
    if (spinner) setLoading(true);
    try {
      const data = await getDumpReports(user.id);
      setReports(data ?? []);
      setLoadError("");
    } catch (e) { setReports([]); setLoadError(errMsg(e, "Could not load your reports.")); }
    finally { setLoading(false); }
  }

  const getStepIndex = (status: string) =>
    STEPS.findIndex((s) => s.key.toLowerCase() === status.toLowerCase());

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      <ErrorNote message={loadError} onDismiss={() => setLoadError("")} />
      <h2 className="text-xl font-display font-bold text-slate-100">My Reports</h2>

      {reports.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <Clock className="w-12 h-12 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400">No reports yet. Use the <span className="text-eco-400">&quot;Report Dump&quot;</span> tab to submit your first report.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {reports.map((report) => {
            const stepIdx = getStepIndex(report.status);
            const currentStep = stepIdx >= 0 ? stepIdx : 0;

            return (
              <div key={report.id} className={cn("glass-card p-5 cursor-pointer hover:border-eco-500/20 transition-all", selected?.id === report.id && "border-eco-500/30")} onClick={() => setSelected(selected?.id === report.id ? null : report)}>
                {/* Report header */}
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div className="flex gap-3">
                    <div className="w-14 h-14 rounded-xl overflow-hidden bg-civic-800 shrink-0">
                      {report.reported_image_url ? (
                        <img src={report.reported_image_url} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <ImageIcon className="w-6 h-6 text-slate-600" />
                        </div>
                      )}
                    </div>
                    <div>
                      <p className="font-semibold text-slate-100">{report.category}</p>
                      <p className="text-xs text-slate-400 mt-0.5">{report.location_name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{formatDate(report.created_at)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn("badge text-xs", statusColor(report.status))}>{report.status}</span>
                    <ChevronRight className={cn("w-4 h-4 text-slate-500 transition-transform", selected?.id === report.id && "rotate-90")} />
                  </div>
                </div>

                {/* Progress Timeline */}
                <div className="flex items-center gap-1">
                  {STEPS.map((step, i) => (
                    <div key={step.key} className="flex items-center flex-1">
                      <div className="flex flex-col items-center gap-1 flex-1">
                        <div className={cn(
                          "w-7 h-7 rounded-full flex items-center justify-center text-xs transition-all duration-300",
                          i < currentStep ? "bg-eco-600 text-white" :
                          i === currentStep ? "bg-eco-500 text-white ring-2 ring-eco-400/50 animate-glow-pulse" :
                          "bg-civic-700 text-slate-500"
                        )}>
                          {i <= currentStep ? step.icon : <div className="w-2 h-2 rounded-full bg-slate-600" />}
                        </div>
                        <span className={cn("text-[9px] text-center leading-tight hidden sm:block",
                          i <= currentStep ? "text-eco-400" : "text-slate-600"
                        )}>
                          {step.label.split(" ").slice(0, 2).join(" ")}
                        </span>
                      </div>
                      {i < STEPS.length - 1 && (
                        <div className={cn("h-0.5 flex-1 mx-1 transition-all duration-500 rounded-full",
                          i < currentStep ? "bg-eco-500" : "bg-civic-700"
                        )} />
                      )}
                    </div>
                  ))}
                </div>

                {/* Expanded: Before/After slider */}
                {selected?.id === report.id && (
                  <div className="mt-6 space-y-4 animate-fade-in-up border-t border-white/8 pt-4">
                    {report.workers?.name && (
                      <div className="flex items-center gap-2 text-sm">
                        <HardHat className="w-4 h-4 text-yellow-400" />
                        <span className="text-slate-400">Assigned Worker:</span>
                        <span className="text-slate-200 font-medium">{report.workers.name}</span>
                      </div>
                    )}
                    <div>
                      <label className="text-xs text-slate-400 mb-2 block">Before / After Comparison</label>
                      <div className="relative rounded-xl overflow-hidden aspect-video bg-black select-none">
                        {/* Before */}
                        <div className="absolute inset-0">
                          {report.reported_image_url ? (
                            <img src={report.reported_image_url} alt="Before" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-civic-800 text-slate-500 text-sm">Before photo</div>
                          )}
                        </div>
                        {/* After */}
                        <div className="absolute inset-0 overflow-hidden" style={{ width: `${sliderPos}%` }}>
                          {report.cleaned_image_url ? (
                            <img src={report.cleaned_image_url} alt="After" className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center bg-eco-900/60 text-eco-400 text-sm">After photo pending</div>
                          )}
                        </div>
                        {/* Slider handle */}
                        <div
                          className="absolute top-0 bottom-0 w-1 bg-white cursor-ew-resize"
                          style={{ left: `${sliderPos}%` }}
                        >
                          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-white shadow-lg flex items-center justify-center text-xs font-bold text-gray-800">
                            ↔
                          </div>
                        </div>
                        <input
                          type="range" min={0} max={100} value={sliderPos}
                          onChange={(e) => setSliderPos(Number(e.target.value))}
                          className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize z-10"
                        />
                        {/* Labels */}
                        <span className="absolute bottom-2 left-2 text-xs bg-black/60 text-slate-300 px-2 py-0.5 rounded">BEFORE</span>
                        <span className="absolute bottom-2 right-2 text-xs bg-eco-600/60 text-eco-200 px-2 py-0.5 rounded">AFTER</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
