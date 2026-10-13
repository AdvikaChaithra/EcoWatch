"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Loader2, Users, MapPin, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";

const Map = dynamic(() => import("@/components/admin/OpsMapComponent"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center bg-civic-900">
      <Loader2 className="w-8 h-8 text-eco-400 animate-spin" />
    </div>
  ),
});

interface DumpPoint   { lat: number; lng: number; severity: string; category: string; location_name: string; }
interface WorkerPoint { id: string; lat: number; lng: number; name: string; status: string; ward: string; }

export function OperationsHeatmap() {
  const [dumps,   setDumps]   = useState<DumpPoint[]>([]);
  const [wrkrs,   setWrkrs]   = useState<WorkerPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [center,  setCenter]  = useState<[number, number]>([12.9716, 77.5946]);

  // FIX 4: Subscribe to real-time worker location updates from the Zustand store.
  // useRealtime.ts now populates this via worker_location WebSocket events.
  const workerLocations = useEcoStore((s) => s.workerLocations);

  useEffect(() => { loadData(); }, []);

  // Merge incoming WS worker_location events into displayed markers
  useEffect(() => {
    if (Object.keys(workerLocations).length === 0) return;
    setWrkrs((prev) =>
      prev.map((w) => {
        const live = workerLocations[w.id];
        return live ? { ...w, lat: live.lat, lng: live.lng } : w;
      })
    );
  }, [workerLocations]);

  async function loadData() {
    setLoading(true);
    try {
      const [dRes, wRes] = await Promise.all([
        supabase.from("dump_reports").select("lat,lng,severity,category,location_name").not("lat", "is", "null"),
        supabase.from("workers").select("id,name,status,ward,lat,lng").eq("status", "On Duty").not("lat", "is", "null"),
      ]);
      if (dRes.error) throw dRes.error;
      if (wRes.error) throw wRes.error;
      setDumps(dRes.data ?? []);
      setWrkrs(wRes.data ?? []);
      setError("");
    } catch (e) { setError(errMsg(e, "Could not load map data.")); } finally { setLoading(false); }
  }

  return (
    <div className="glass-card overflow-hidden">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <div className="flex items-center justify-between p-4 border-b border-white/8">
        <div className="flex items-center gap-2">
          <MapPin className="w-4 h-4 text-eco-400" />
          <h3 className="font-display font-semibold text-slate-100 text-sm">Operations Heatmap</h3>
          <span className="badge bg-orange-500/10 text-orange-400 border-orange-500/20 text-xs">{dumps.length} sites</span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-eco-400">
            <Users className="w-3.5 h-3.5" />
            <span>{wrkrs.length} on-duty workers</span>
          </div>
          <button onClick={loadData} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="h-[400px]">
        {loading ? (
          <div className="w-full h-full flex items-center justify-center">
            <Loader2 className="w-8 h-8 text-eco-400 animate-spin" />
          </div>
        ) : (
          <Map dumps={dumps} workers={wrkrs} center={center} />
        )}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-4 p-3 border-t border-white/8 text-xs">
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-red-500" /><span className="text-slate-400">Critical dump</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-orange-500" /><span className="text-slate-400">High severity</span></div>
        <div className="flex items-center gap-1.5"><div className="w-3 h-3 rounded-full bg-yellow-400" /><span className="text-slate-400">Moderate</span></div>
        <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded-full bg-eco-500 border-2 border-white/30 text-[8px] flex items-center justify-center text-white">👷</div><span className="text-slate-400">Worker (live GPS)</span></div>
      </div>
    </div>
  );
}
