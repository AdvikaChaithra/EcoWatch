"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, DollarSign, TrendingUp, Loader2, Activity, Users, Timer } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useSectorScope } from "@/hooks/useSectorScope";
import { OperationsHeatmap } from "@/components/admin/OperationsHeatmap";
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid } from "recharts";

interface KPIData {
  activeDumps: number; overdueSLA: number; finesIssued: number; finesCollected: number;
  wardScore: number; totalWorkers: number;
}

interface WeeklyPoint { day: string; violations: number; reports: number; }

/** YYYY-MM-DD in the viewer's local time zone (UTC dates put Indian evenings on the next day). */
function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Build an array for the past 7 days in dd Mon format
function last7DaysBuckets(): { label: string; date: string }[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    return {
      label: d.toLocaleDateString("en-IN", { weekday: "short" }),
      date:  localDay(d),
    };
  });
}

export function KPIOverview() {
  const [kpi, setKPI] = useState<KPIData>({ activeDumps: 0, overdueSLA: 0, finesIssued: 0, finesCollected: 0, wardScore: 0, totalWorkers: 0 });
  const [weekly, setWeekly] = useState<WeeklyPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Same scope as the rest of the console: the admin's sectors (or the selected one).
  const { restricted, mySectors, filter, key: scopeKey } = useSectorScope();
  useEffect(() => { loadKPI(); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadKPI() {
    setLoading(true);
    try {
      const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

      const ids = filter === "all" ? mySectors.map((x) => x.id) : [filter];
      const scoped = (q: any) => (restricted ? q.in("sector_id", ids) : q);
      const FINED = ["Pending", "Upheld", "Paid", "Disputed"];   // a citizen was actually fined

      const [
        { count: activeDumps, error: activeDumpsErr },
        { count: overdueSLA, error: overdueErr },
        { count: finesIssued, error: issuedErr },
        { count: finesCollected, error: collectedErr },
        { count: totalWorkers, error: workersErr },
        { data: vRows, error: vErr },
        { data: rRows, error: rErr },
      ] = await Promise.all([
        // unassigned = waiting in the dispatch queue
        scoped(supabase.from("dump_reports").select("id", { count: "exact", head: true }).eq("status", "Submitted")),
        scoped(supabase.from("dump_reports").select("id", { count: "exact", head: true }).lte("created_at", sixHoursAgo).not("status", "eq", "Cleaned & Verified")),
        scoped(supabase.from("violations").select("id", { count: "exact", head: true }).in("status", FINED)),
        scoped(supabase.from("violations").select("id", { count: "exact", head: true }).eq("status", "Paid")),
        scoped(supabase.from("workers").select("id", { count: "exact", head: true }).eq("active", true)),
        // Real 7-day timestamps
        scoped(supabase.from("violations").select("timestamp").in("status", FINED).gte("timestamp", sevenDaysAgo)),
        scoped(supabase.from("dump_reports").select("created_at").gte("created_at", sevenDaysAgo)),
      ]);

      const failed = [
        ["active dumps", activeDumpsErr], ["overdue SLA", overdueErr], ["fines issued", issuedErr],
        ["fines collected", collectedErr], ["workers", workersErr], ["violations", vErr], ["reports", rErr],
      ].filter(([, err]) => err);
      if (failed.length) throw new Error(`failed queries: ${failed.map(([n]) => n).join(", ")}`);

      setKPI({
        activeDumps: activeDumps ?? 0,
        overdueSLA: overdueSLA ?? 0,
        finesIssued: finesIssued ?? 0,
        finesCollected: finesCollected ?? 0,
        wardScore: Math.max(40, 100 - (activeDumps ?? 0) * 2),
        totalWorkers: totalWorkers ?? 0,
      });

      // Aggregate into day buckets
      const buckets = last7DaysBuckets();
      const weeklyData: WeeklyPoint[] = buckets.map(({ label, date }) => ({
        day:        label,
        violations: (vRows ?? []).filter((v: { timestamp?: string }) => v.timestamp && localDay(new Date(v.timestamp)) === date).length,
        reports:    (rRows ?? []).filter((r: { created_at?: string }) => r.created_at && localDay(new Date(r.created_at)) === date).length,
      }));
      setWeekly(weeklyData);
      setError("");
    } catch (e) { setError(errMsg(e, "Could not load KPIs; figures shown may be incomplete.")); } finally { setLoading(false); }
  }

  const CARDS = [
    { label: "Active Unassigned Dumps", value: kpi.activeDumps,    icon: AlertTriangle, color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
    { label: "Overdue SLA Tasks",       value: kpi.overdueSLA,     icon: Timer,         color: "text-red-400",    bg: "bg-red-500/10 border-red-500/20"       },
    { label: "Total Fines Issued",      value: kpi.finesIssued,    icon: DollarSign,    color: "text-blue-400",   bg: "bg-blue-500/10 border-blue-500/20"     },
    { label: "Fines Collected",         value: kpi.finesCollected, icon: CheckCircle2,  color: "text-eco-400",    bg: "bg-eco-500/10 border-eco-500/20"       },
    { label: "Ward Cleanliness Score",  value: `${kpi.wardScore}/100`, icon: TrendingUp, color: "text-purple-400", bg: "bg-purple-500/10 border-purple-500/20" },
    { label: "Active Workers",           value: kpi.totalWorkers,   icon: Users,         color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
  ];

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  return (
    <div className="space-y-8">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
        {CARDS.map(({ label, value, icon: Icon, color, bg }) => (
          <div key={label} className="kpi-card animate-fade-in-up">
            <div className={`p-2.5 rounded-xl border self-start ${bg}`}><Icon className={`w-5 h-5 ${color}`} /></div>
            <div>
              <p className="text-xs text-slate-400">{label}</p>
              <p className={`font-display text-3xl font-bold mt-0.5 ${color}`}>{value}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="glass-card p-6">
        <div className="flex items-center gap-2 mb-6">
          <Activity className="w-5 h-5 text-eco-400" />
          <h3 className="font-display font-semibold text-slate-100">Weekly Activity Trend</h3>
          <span className="text-xs text-slate-500 ml-auto">Last 7 days — live from Supabase</span>
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={weekly} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="vioGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="repGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
            <XAxis dataKey="day" tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#64748b", fontSize: 12 }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={{ background: "rgba(15,23,42,0.95)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "12px", color: "#e2e8f0" }} />
            <Area type="monotone" dataKey="violations" stroke="#ef4444" strokeWidth={2} fill="url(#vioGrad)" name="Violations" />
            <Area type="monotone" dataKey="reports"    stroke="#10b981" strokeWidth={2} fill="url(#repGrad)" name="Reports"    />
          </AreaChart>
        </ResponsiveContainer>
        <div className="flex gap-4 mt-2">
          <div className="flex items-center gap-2 text-xs"><div className="w-3 h-0.5 bg-red-500" /><span className="text-slate-400">Violations</span></div>
          <div className="flex items-center gap-2 text-xs"><div className="w-3 h-0.5 bg-eco-500" /><span className="text-slate-400">Reports</span></div>
        </div>
      </div>

      {/* Live Operations Heatmap with worker GPS markers */}
      <OperationsHeatmap />
    </div>
  );
}
