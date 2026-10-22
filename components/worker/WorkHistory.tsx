"use client";
import { useEffect, useState } from "react";
import { History, Loader2, MapPin, CheckCircle2, Clock } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { cn, formatDateTime, severityColor } from "@/lib/utils";

interface Done {
  id: string; category: string; severity: string; location_name: string; status: string;
  updated_at: string | null; verified_at: string | null; worker_points: number | null; worker_bonus: number | string | null;
}

/** The worker's finished cleanups: location, type of waste and the eco-points each one earned. */
export function WorkHistory({ workerId }: { workerId: string }) {
  const [rows, setRows] = useState<Done[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const { data, error: e } = await supabase.from("dump_reports")
          .select("id,category,severity,location_name,status,updated_at,verified_at,worker_points,worker_bonus")
          .eq("assigned_worker_id", workerId)
          .in("status", ["Pending Verification", "Cleaned & Verified"])
          .order("updated_at", { ascending: false });
        if (e) throw e;
        setRows((data ?? []) as Done[]);
        setError("");
      } catch (e) { setError(errMsg(e, "Could not load your work history.")); }
      finally { setLoading(false); }
    })();
  }, [workerId]);

  if (loading) return <div className="flex justify-center py-12"><Loader2 className="w-7 h-7 text-yellow-400 animate-spin" /></div>;

  const verified = rows.filter((r) => r.status === "Cleaned & Verified");
  const earned = verified.reduce((a, r) => a + (r.worker_points ?? 0), 0);
  const bonusTotal = verified.reduce((a, r) => a + Number(r.worker_bonus ?? 0), 0);

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card-sm p-3 text-center">
          <p className="text-xs text-slate-400">Verified cleanups</p>
          <p className="font-display text-xl font-bold text-eco-400">{verified.length}</p>
        </div>
        <div className="glass-card-sm p-3 text-center">
          <p className="text-xs text-slate-400">Awaiting review</p>
          <p className="font-display text-xl font-bold text-blue-300">{rows.length - verified.length}</p>
        </div>
        <div className="glass-card-sm p-3 text-center">
          <p className="text-xs text-slate-400">Eco-points earned</p>
          <p className="font-display text-xl font-bold text-yellow-400">{earned}</p>
        </div>
        <div className="glass-card-sm p-3 text-center">
          <p className="text-xs text-slate-400">Bonus earned</p>
          <p className="font-display text-xl font-bold text-green-400">₹{bonusTotal.toLocaleString("en-IN")}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="glass-card p-10 text-center">
          <History className="w-10 h-10 text-slate-600 mx-auto mb-2" />
          <p className="text-slate-400 text-sm">No finished tasks yet. Cleanups you submit appear here.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const ok = r.status === "Cleaned & Verified";
            return (
              <div key={r.id} className="glass-card p-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn("badge text-[10px]", severityColor(r.severity))}>{r.severity}</span>
                    <span className="text-sm font-semibold text-slate-100">{r.category}</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-1 flex items-start gap-1">
                    <MapPin className="w-3.5 h-3.5 text-eco-400 shrink-0 mt-px" /> <span className="line-clamp-2">{r.location_name}</span>
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1">
                    {ok ? `Verified ${formatDateTime(r.verified_at ?? r.updated_at ?? "")}` : `Submitted ${formatDateTime(r.updated_at ?? "")}`}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  {ok ? (
                    r.worker_points != null ? (
                      <>
                        <p className="font-display text-lg font-bold text-yellow-400">+{r.worker_points} <span className="text-xs font-normal text-slate-400">pts</span></p>
                        {r.worker_bonus != null && <p className="text-sm font-semibold text-green-400">+₹{Number(r.worker_bonus).toLocaleString("en-IN")}</p>}
                      </>
                    ) : (
                      <p className="text-[11px] text-slate-500 max-w-[7rem]">Verified before points were recorded</p>
                    )
                  ) : null}
                  <span className={cn("badge text-[10px] mt-1", ok ? "bg-eco-500/10 text-eco-400 border-eco-500/20" : "bg-blue-500/10 text-blue-300 border-blue-500/20")}>
                    {ok ? <><CheckCircle2 className="w-3 h-3" /> Verified</> : <><Clock className="w-3 h-3" /> Awaiting review</>}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
