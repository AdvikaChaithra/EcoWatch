"use client";
import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ── Severity color map ────────────────────────────────────────────────────────
const SEV: Record<string, { bg: string; border: string }> = {
  "Critical": { bg: "#ef4444", border: "#b91c1c" },
  "High":     { bg: "#f97316", border: "#c2410c" },
  "Medium":   { bg: "#eab308", border: "#a16207" },
  "Low":      { bg: "#22c55e", border: "#15803d" },
};
const DEFAULT_SEV = { bg: "#64748b", border: "#475569" };

/** Severity-colored teardrop pin for dump sites */
function makeDumpIcon(severity: string) {
  const c = SEV[severity] ?? DEFAULT_SEV;
  return L.divIcon({
    className: "",
    iconSize:   [30, 36],
    iconAnchor: [15, 36],
    popupAnchor:[0, -38],
    html: `<div style="width:30px;height:36px;display:flex;flex-direction:column;align-items:center;">
      <div style="width:30px;height:30px;background:${c.bg};border:2.5px solid ${c.border};border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-shadow:0 4px 10px ${c.bg}80;display:flex;align-items:center;justify-content:center;">
        <span style="transform:rotate(45deg);font-size:12px;">🗑</span>
      </div>
      <div style="width:4px;height:8px;background:${c.border};margin-top:-1px;"></div>
    </div>`,
  });
}

/** Worker emoji pin with status color ring */
function makeWorkerIcon(status: string) {
  const ring = status === "On Duty" ? "#10b981" : status === "Break" ? "#f59e0b" : "#64748b";
  return L.divIcon({
    className: "",
    iconSize:   [36, 42],
    iconAnchor: [18, 42],
    popupAnchor:[0, -44],
    html: `<div style="width:36px;height:42px;display:flex;flex-direction:column;align-items:center;">
      <div style="width:36px;height:36px;background:#1e293b;border:2.5px solid ${ring};border-radius:50%;box-shadow:0 0 12px ${ring}60;display:flex;align-items:center;justify-content:center;font-size:18px;">
        👷
      </div>
      <div style="width:4px;height:8px;background:${ring};margin-top:-1px;"></div>
    </div>`,
  });
}

interface DumpPoint   { lat: number; lng: number; severity: string; category: string; location_name: string; }
interface WorkerPoint { id: string; lat: number; lng: number; name: string; status: string; ward: string; }

function FlyTo({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => { map.flyTo(center, 12, { duration: 1.2 }); }, [center, map]);
  return null;
}

export default function OpsMapComponent({
  dumps, workers, center,
}: {
  dumps: DumpPoint[];
  workers: WorkerPoint[];
  center: [number, number];
}) {
  return (
    <MapContainer center={center} zoom={12} style={{ width: "100%", height: "100%", background: "#0f172a" }}>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
      />
      <FlyTo center={center} />

      {/* Dump site markers — severity-colored teardrop pins */}
      {dumps.map((d, i) => {
        const lat = parseFloat(String(d.lat));
        const lng = parseFloat(String(d.lng));
        if (isNaN(lat) || isNaN(lng)) return null;
        const c = SEV[d.severity] ?? DEFAULT_SEV;
        return (
          <Marker key={`dump-${i}`} position={[lat, lng]} icon={makeDumpIcon(d.severity)}>
            <Popup>
              <div style={{ color: "#e2e8f0", fontSize: "12px", minWidth: "170px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", paddingBottom: "6px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                  <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", background: c.bg, flexShrink: 0 }} />
                  <strong style={{ color: c.bg }}>{d.severity} Severity</strong>
                </div>
                <p style={{ color: "#cbd5e1", fontWeight: 600, marginBottom: "2px" }}>🗑 {d.category}</p>
                <p style={{ color: "#94a3b8", fontSize: "11px" }}>{d.location_name}</p>
                <p style={{ color: "#64748b", fontSize: "10px", marginTop: "4px", fontFamily: "monospace" }}>
                  {lat.toFixed(5)}, {lng.toFixed(5)}
                </p>
              </div>
            </Popup>
          </Marker>
        );
      })}

      {/* Worker markers — status-colored emoji pins */}
      {workers.filter((w) => w.lat && w.lng).map((w) => {
        const lat = parseFloat(String(w.lat));
        const lng = parseFloat(String(w.lng));
        if (isNaN(lat) || isNaN(lng)) return null;
        const ring = w.status === "On Duty" ? "#10b981" : w.status === "Break" ? "#f59e0b" : "#64748b";
        return (
          <Marker key={`worker-${w.id}`} position={[lat, lng]} icon={makeWorkerIcon(w.status)}>
            <Popup>
              <div style={{ color: "#e2e8f0", fontSize: "12px", minWidth: "170px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "6px", paddingBottom: "6px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                  <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", background: ring, flexShrink: 0 }} />
                  <strong style={{ color: "#10b981" }}>👷 {w.name}</strong>
                </div>
                <p style={{ color: "#94a3b8", marginBottom: "2px" }}>
                  Ward: <strong style={{ color: "#e2e8f0" }}>{w.ward}</strong>
                </p>
                <p style={{ marginBottom: "2px" }}>
                  Status:{" "}
                  <span style={{ color: ring, fontWeight: 600 }}>● {w.status}</span>
                </p>
                <p style={{ color: "#64748b", fontSize: "10px", marginTop: "4px", fontFamily: "monospace" }}>
                  {lat.toFixed(5)}, {lng.toFixed(5)}
                </p>
              </div>
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
