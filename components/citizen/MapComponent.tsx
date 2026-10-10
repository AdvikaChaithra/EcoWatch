"use client";
import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

interface Point {
  lat: number; lng: number;
  severity: string; category: string; location_name: string;
}

// Severity → hex color mapping
const SEV_COLOR: Record<string, { bg: string; border: string; emoji: string }> = {
  "Critical": { bg: "#ef4444", border: "#b91c1c", emoji: "🔴" },
  "High":     { bg: "#f97316", border: "#c2410c", emoji: "🟠" },
  "Medium":   { bg: "#eab308", border: "#a16207", emoji: "🟡" },
  "Low":      { bg: "#22c55e", border: "#15803d", emoji: "🟢" },
};
const DEFAULT_SEV = { bg: "#64748b", border: "#475569", emoji: "⚫" };

/** Create a custom L.divIcon HTML waste pin colored by severity */
function makeDivIcon(severity: string) {
  const color = SEV_COLOR[severity] ?? DEFAULT_SEV;
  return L.divIcon({
    className: "",
    iconSize: [32, 38],
    iconAnchor: [16, 38],
    popupAnchor: [0, -38],
    html: `
      <div style="
        position:relative;
        width:32px;
        height:38px;
        display:flex;
        flex-direction:column;
        align-items:center;
      ">
        <div style="
          width:32px; height:32px;
          background:${color.bg};
          border:2.5px solid ${color.border};
          border-radius:50% 50% 50% 0;
          transform:rotate(-45deg);
          box-shadow:0 4px 12px ${color.bg}80;
          display:flex; align-items:center; justify-content:center;
        ">
          <span style="transform:rotate(45deg);font-size:13px;display:block;">🗑</span>
        </div>
        <div style="
          width:4px; height:8px;
          background:${color.border};
          margin-top:-2px;
        "></div>
      </div>`,
  });
}

function FlyTo({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => { map.flyTo(center, 13, { duration: 1.5 }); }, [center, map]);
  return null;
}

export default function MapComponent({
  points, center, activeLayer,
}: {
  points: Point[];
  center: [number, number];
  activeLayer: "heat" | "markers";
}) {
  return (
    <MapContainer
      center={center}
      zoom={13}
      style={{ width: "100%", height: "100%", background: "#0f172a" }}
      zoomControl={true}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://openstreetmap.org">OpenStreetMap</a>'
      />
      <FlyTo center={center} />

      {points.map((pt, i) => {
        // parseFloat to guard against string coords from DB
        const lat = parseFloat(String(pt.lat));
        const lng = parseFloat(String(pt.lng));
        if (isNaN(lat) || isNaN(lng)) return null;

        const color = SEV_COLOR[pt.severity] ?? DEFAULT_SEV;

        return (
          <Marker
            key={i}
            position={[lat, lng]}
            icon={makeDivIcon(pt.severity)}
          >
            <Popup>
              <div style={{ color: "#e2e8f0", fontSize: "12px", minWidth: "160px" }}>
                <div style={{
                  display: "flex", alignItems: "center", gap: "6px",
                  marginBottom: "6px", paddingBottom: "6px", borderBottom: "1px solid rgba(255,255,255,0.1)",
                }}>
                  <span style={{
                    display: "inline-block", width: "10px", height: "10px",
                    borderRadius: "50%", background: color.bg, flexShrink: 0,
                  }} />
                  <strong style={{ color: color.bg }}>{pt.severity} Severity</strong>
                </div>
                <p style={{ color: "#cbd5e1", fontWeight: 600, marginBottom: "2px" }}>🗑 {pt.category}</p>
                <p style={{ color: "#94a3b8", fontSize: "11px" }}>{pt.location_name}</p>
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
