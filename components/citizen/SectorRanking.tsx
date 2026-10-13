"use client";
import { useEffect, useState } from "react";
import { TrendingDown, TrendingUp, MapPin } from "lucide-react";
import { supabase, getSectors, getNearestSectorId, type SectorRow } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface Row { sector: SectorRow; score: number; open: number; recent: number }

const SEVERITY_WEIGHT: Record<string, number> = { Low: 1, Medium: 2, High: 3, Critical: 5 };
const WINDOW_DAYS = 30;

/**
 * Pollution ranking per sector, computed from real data:
 *   score = sum over (open reports) of severity weight  +  0.5 * (reports created in the last 30 days, any status)
 * Higher = more polluted. Ranks are only shown for sectors that exist in the database.
 */
export function SectorRanking() {
  const user = useEcoStore((s) => s.currentUser);
  const [rows, setRows] = useState<Row[]>([]);
  const [mine, setMine] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [sectors, reportsRes] = await Promise.all([
          getSectors(),
          supabase.from("dump_reports").select("sector_id,severity,status,created_at"),
        ]);
        if (reportsRes.error) throw reportsRes.error;
        const since = Date.now() - WINDOW_DAYS * 86400000;
        const agg = new Map<string, Row>();
        sectors.forEach((s) => agg.set(s.id, { sector: s, score: 0, open: 0, recent: 0 }));
        (reportsRes.data ?? []).forEach((r: any) => {
          const row = agg.get(r.sector_id);
          if (!row) return;
          if (r.status !== "Cleaned & Verified") { row.open += 1; row.score += SEVERITY_WEIGHT[r.severity] ?? 1; }
          if (new Date(r.created_at).getTime() >= since) { row.recent += 1; row.score += 0.5; }
        });
        setRows(Array.from(agg.values()).sort((a, b) => b.score - a.score));
        // The viewer's own sector: from their last known ward is not geographic, so use GPS if allowed.
        if ("geolocation" in navigator && user?.id) {
          navigator.geolocation.getCurrentPosition(
            async (p) => setMine(await getNearestSectorId(p.coords.latitude, p.coords.longitude)),
            () => {}, { timeout: 5000 }
          );
        }
      } catch (e: any) {
        setError("Sector ranking unavailable (run migrations/001_demo.sql, then reload).");
      } finally { setLoading(false); }
    })();
  }, [user?.id]);

  if (loading) return null;
  if (error) return <p className="text-xs text-slate-500">{error}</p>;
  if (rows.length === 0) return null;

  const most = rows.slice(0, 3);
  const least = [...rows].reverse().slice(0, 3);
  const myRank = mine ? rows.findIndex((r) => r.sector.id === mine) + 1 : 0;

  const List = ({ title, icon, items, tone }: { title: string; icon: React.ReactNode; items: Row[]; tone: string }) => (
    <div className="glass-card p-4 space-y-2">
      <p className={cn("text-sm font-semibold flex items-center gap-2", tone)}>{icon}{title}</p>
      {items.map((r) => (
        <div key={r.sector.id} className="flex items-center justify-between text-sm">
          <span className="text-slate-200">{r.sector.area} — {r.sector.name}</span>
          <span className="text-xs text-slate-400">{r.open} open · score {r.score.toFixed(1)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <List title="Most polluted sectors" icon={<TrendingUp className="w-4 h-4" />} items={most} tone="text-red-300" />
        <List title="Cleanest sectors" icon={<TrendingDown className="w-4 h-4" />} items={least} tone="text-eco-300" />
      </div>
      {myRank > 0 && (
        <p className="text-xs text-slate-400 flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5 text-purple-400" />
          Your location is in <strong className="text-slate-200">{rows[myRank - 1].sector.area} — {rows[myRank - 1].sector.name}</strong>,
          ranked <strong className="text-slate-200">#{myRank} of {rows.length}</strong> (1 = most polluted).
        </p>
      )}
      <p className="text-[10px] text-slate-600">Score = open reports by severity + recent activity (30 days). Computed live from reports.</p>
    </div>
  );
}
