"use client";
import { useEffect, useState } from "react";
import { Loader2, UserCog, Map, Users, UserCheck, ClipboardList, IndianRupee } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { authFetch } from "@/lib/api";
import { ErrorNote } from "@/components/layout/ErrorNote";
import { corpLabel } from "@/components/shared/SectorOptions";

interface Row { id: string; area: string; name: string; corporation: string | null; admin: string; active: boolean; workers: number; onDuty: number; openReports: number; unpaid: number; unpaidAmount: number }

/** City-wide picture for the Municipal Commissioner, computed live from the database. */
export function SuperOverview() {
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState({ admins: 0, sectors: 0, workers: 0, onDuty: 0, citizens: 0, openReports: 0, unpaid: 0, unpaidAmount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [{ admins }, sec, wk, rep, vio, cit] = await Promise.all([
          authFetch<{ admins: { id: string; name: string; role: string; active: boolean }[] }>("/api/super/admins"),
          supabase.from("sectors").select("id,area,name,corporation,admin_id,active").order("area"),
          supabase.from("workers").select("sector_id,status,active"),
          supabase.from("dump_reports").select("sector_id,status").neq("status", "Cleaned & Verified"),
          supabase.from("violations").select("sector_id,status,fine_amount").in("status", ["Pending", "Upheld"]),
          supabase.from("citizens").select("id", { count: "exact", head: true }),
        ]);
        for (const r of [sec, wk, rep, vio, cit]) if (r.error) throw r.error;
        const name = (id: string | null) => admins.find((a) => a.id === id)?.name ?? "Unassigned";
        const out: Row[] = (sec.data ?? []).map((s: any) => {
          const w = (wk.data ?? []).filter((x: any) => x.sector_id === s.id && x.active);
          const v = (vio.data ?? []).filter((x: any) => x.sector_id === s.id);
          return {
            id: s.id, area: s.area, name: s.name, corporation: s.corporation, admin: name(s.admin_id), active: s.active !== false,
            workers: w.length, onDuty: w.filter((x: any) => x.status === "On Duty").length,
            openReports: (rep.data ?? []).filter((x: any) => x.sector_id === s.id).length,
            unpaid: v.length, unpaidAmount: v.reduce((a: number, x: any) => a + Number(x.fine_amount ?? 0), 0),
          };
        });
        // busiest first; sectors with no workers, reports or fines are summarised, not listed
        const load = (r: Row) => r.openReports * 2 + r.unpaid * 2 + r.workers;
        setRows(out.sort((a, b) => load(b) - load(a) || a.area.localeCompare(b.area)));
        const activeW = (wk.data ?? []).filter((x: any) => x.active);
        setTotals({
          admins: admins.filter((a) => a.role === "admin" && a.active).length,
          sectors: (sec.data ?? []).filter((s: any) => s.active !== false).length,
          workers: activeW.length, onDuty: activeW.filter((x: any) => x.status === "On Duty").length,
          citizens: cit.count ?? 0, openReports: (rep.data ?? []).length,
          unpaid: (vio.data ?? []).length, unpaidAmount: (vio.data ?? []).reduce((a: number, x: any) => a + Number(x.fine_amount ?? 0), 0),
        });
      } catch (e: any) {
        setError(`Could not load overview: ${e?.message ?? e}`);
      } finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-amber-400 animate-spin" /></div>;

  const cards = [
    { label: "Active admins", value: totals.admins, icon: UserCog },
    { label: "Active sectors", value: totals.sectors, icon: Map },
    { label: "Workers (on duty)", value: `${totals.workers} (${totals.onDuty})`, icon: Users },
    { label: "Registered citizens", value: totals.citizens, icon: UserCheck },
    { label: "Open dump reports", value: totals.openReports, icon: ClipboardList },
    { label: "Unpaid fines", value: `${totals.unpaid} · ₹${totals.unpaidAmount.toLocaleString()}`, icon: IndianRupee },
  ];

  return (
    <div className="space-y-6">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {cards.map(({ label, value, icon: Icon }) => (
          <div key={label} className="glass-card p-4">
            <p className="text-xs text-slate-400 flex items-center gap-1.5"><Icon className="w-3.5 h-3.5 text-amber-400" />{label}</p>
            <p className="font-display text-2xl font-bold text-slate-100 mt-1">{value}</p>
          </div>
        ))}
      </div>
      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-civic-900/80 text-xs text-slate-400">
            <tr><th className="text-left p-3">Sector</th><th className="text-left p-3">Responsible admin</th><th className="p-3">Workers (on duty)</th><th className="p-3">Open reports</th><th className="p-3">Unpaid fines</th></tr>
          </thead>
          <tbody>
            {rows.filter((r) => r.workers || r.openReports || r.unpaid).map((r) => (
              <tr key={r.id} className={`border-t border-white/5 ${r.active ? "" : "opacity-50"}`}>
                <td className="p-3 text-slate-200">{r.area} — {r.name}{!r.active && " (retired)"}<span className="block text-[10px] font-mono text-slate-500">{r.id} · {corpLabel(r.corporation)}</span></td>
                <td className={`p-3 ${r.admin === "Unassigned" ? "text-orange-300" : "text-slate-300"}`}>{r.admin}</td>
                <td className="p-3 text-center text-slate-300">{r.workers} ({r.onDuty})</td>
                <td className="p-3 text-center text-slate-300">{r.openReports}</td>
                <td className="p-3 text-center text-slate-300">{r.unpaid} · ₹{r.unpaidAmount.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="p-3 text-[11px] text-slate-500 border-t border-white/5">
          {rows.filter((r) => !(r.workers || r.openReports || r.unpaid)).length} other sector(s) have no workers, open reports or unpaid fines yet — manage them in the Sectors tab.
        </p>
      </div>
    </div>
  );
}
