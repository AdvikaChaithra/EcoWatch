"use client";
import { useEffect } from "react";
import { MapPin } from "lucide-react";
import { useEcoStore } from "@/lib/store";
import { supabase } from "@/lib/supabase";

/** Area -> Sector selector for the logged-in admin (their own sectors only). */
export function SectorFilter() {
  const user = useEcoStore((s) => s.currentUser);
  const mySectors = useEcoStore((s) => s.mySectors);
  const setMySectors = useEcoStore((s) => s.setMySectors);
  const filter = useEcoStore((s) => s.sectorFilter);
  const setFilter = useEcoStore((s) => s.setSectorFilter);

  useEffect(() => {
    if (!user?.id) return;
    supabase
      .from("sectors")
      .select("id,area,name,admin_id")
      .eq("admin_id", user.id)
      .order("area")
      .then(({ data, error }) => {
        if (error) console.warn("[SectorFilter] sectors unavailable (run migrations/001_demo.sql):", error.message);
        setMySectors(error ? [] : data ?? []);
      });
  }, [user?.id, setMySectors]);

  if (mySectors.length === 0) return null;

  return (
    <div className="flex items-center gap-2 text-sm">
      <MapPin className="w-4 h-4 text-blue-400" />
      <label htmlFor="sector-filter" className="text-slate-400">Sector</label>
      <select
        id="sector-filter"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="input-civic py-1.5 text-sm w-auto"
      >
        <option value="all">All my sectors ({mySectors.length})</option>
        {mySectors.map((s) => (
          <option key={s.id} value={s.id}>{s.area} — {s.name}</option>
        ))}
      </select>
    </div>
  );
}
