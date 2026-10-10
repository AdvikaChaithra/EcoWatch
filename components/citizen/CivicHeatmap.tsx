"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Search, Layers, MapPin, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";

// Leaflet requires no-SSR
const MapComponent = dynamic(() => import("./MapComponent"), { ssr: false, loading: () => (
  <div className="w-full h-full flex items-center justify-center bg-civic-900">
    <Loader2 className="w-8 h-8 text-eco-400 animate-spin" />
  </div>
)});

interface ReportPoint {
  lat: number; lng: number; severity: string; category: string; location_name: string;
}

const LEGEND = [
  { label: "Clean",        color: "bg-green-500",  range: "< 2 reports" },
  { label: "Moderate",     color: "bg-yellow-500", range: "2-5 reports"  },
  { label: "High",         color: "bg-orange-500", range: "5-10 reports" },
  { label: "Critical Dump",color: "bg-red-600",    range: "> 10 reports" },
];

export function CivicHeatmap() {
  const [points, setPoints] = useState<ReportPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeLayer, setActiveLayer] = useState<"heat" | "markers">("heat");
  const [center, setCenter] = useState<[number, number]>([12.9716, 77.5946]); // Bengaluru default

  useEffect(() => {
    loadPoints();
  }, []);

  async function loadPoints() {
    setLoading(true);
    try {
      const { data } = await supabase
        .from("dump_reports")
        .select("lat, lng, severity, category, location_name")
        .not("lat", "is", null);
      if (data) setPoints(data);
    } catch { setPoints([]); }
    finally { setLoading(false); }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&limit=1`
      );
      const results = await res.json();
      if (results?.[0]) {
        setCenter([parseFloat(results[0].lat), parseFloat(results[0].lon)]);
      }
    } catch {}
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-display font-bold text-slate-100">Interactive Civic Heatmap</h2>
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-slate-400" />
          {(["heat","markers"] as const).map((layer) => (
            <button
              key={layer}
              onClick={() => setActiveLayer(layer)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                activeLayer === layer ? "bg-eco-600/20 text-eco-300 border border-eco-500/20" : "text-slate-400 hover:bg-white/5"
              }`}
            >
              {layer === "heat" ? "Heatmap" : "Markers"}
            </button>
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            className="input-civic pl-9"
            placeholder="Search by State, District, Ward, Street..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>
        <button onClick={handleSearch} className="btn-eco px-4">
          <Search className="w-4 h-4" />
        </button>
      </div>

      {/* Map */}
      <div className="map-container h-[500px] relative">
        <MapComponent points={points} center={center} activeLayer={activeLayer} />
        {/* Stats overlay */}
        <div className="absolute top-3 left-3 z-[1000] glass-card-sm p-3 space-y-1">
          <p className="text-xs font-semibold text-slate-300">📍 {points.length} Active Reports</p>
          <p className="text-xs text-slate-500">Live data from Supabase</p>
        </div>
      </div>

      {/* Legend */}
      <div className="glass-card-sm p-3 flex flex-wrap gap-4">
        {LEGEND.map(({ label, color, range }) => (
          <div key={label} className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${color}`} />
            <span className="text-xs text-slate-300">{label}</span>
            <span className="text-xs text-slate-500">{range}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
