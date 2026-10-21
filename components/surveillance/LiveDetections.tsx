"use client";
import { useEffect, useState } from "react";
import { ScanEye, User, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LiveDetection {
  kind: "person" | "waste";
  track_id: number;
  label: string;
  conf: number | null;
  bbox: number[]; // normalised 0..1 [x1, y1, x2, y2]
}

export interface ActiveMachineLite {
  person_id: number;
  waste_id: number;
  state: string;
  dwell_progress: number;
}

interface Props {
  running: boolean;
  detections: LiveDetection[];
  machines: ActiveMachineLite[];
  /** engine timestamp (seconds since epoch) of the frame these detections came from */
  timestamp: number | null;
}

const STALE_AFTER_S = 2;

// Human-readable stage of the littering state machine for a person/object pair.
const STAGE_LABEL: Record<string, string> = {
  PERSON_NEAR_OBJECT: "near object",
  OBJECT_ASSOCIATED: "holding object",
  OBJECT_SEPARATING: "object separating",
  OBJECT_DROPPED: "object dropped",
  OBJECT_STATIONARY: "object stationary",
  PERSON_MOVING_AWAY: "person leaving",
  LITTERING_CONFIRMED: "LITTERING CONFIRMED",
};

/**
 * Real-time list of what YOLOv8 + ByteTrack see in the current frame (sent by the engine
 * ~5x/second, data only). Greys out when no fresh frame has arrived (camera stopped / black).
 */
export function LiveDetections({ running, detections, machines, timestamp }: Props) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 500);
    return () => clearInterval(id);
  }, []);

  const stale = !timestamp || now - timestamp > STALE_AFTER_S;
  const persons = detections.filter((d) => d.kind === "person");
  const objects = detections.filter((d) => d.kind === "waste");
  const tracked = machines.filter((m) => STAGE_LABEL[m.state]);

  return (
    <div className="glass-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400 flex items-center gap-1.5">
          <ScanEye className="w-3.5 h-3.5 text-eco-400" /> Live Detections
        </p>
        <span className={cn(
          "badge text-[9px]",
          !running ? "bg-slate-500/10 text-slate-500 border-slate-500/20"
          : stale ? "bg-orange-500/10 text-orange-400 border-orange-500/20"
          : "bg-eco-500/10 text-eco-400 border-eco-500/20",
        )}>
          {!running ? "OFF" : stale ? "NO FRESH FRAMES" : `${persons.length} person · ${objects.length} object`}
        </span>
      </div>

      {!running ? (
        <p className="text-slate-600 text-xs text-center py-3">Start inference to see detections</p>
      ) : detections.length === 0 ? (
        <p className="text-slate-600 text-xs text-center py-3">
          {stale ? "Waiting for camera frames…" : "Nothing detected in view"}
        </p>
      ) : (
        <div className={cn("space-y-1.5 max-h-44 overflow-y-auto pr-1", stale && "opacity-40")}>
          {detections.map((d) => (
            <div key={`${d.kind}-${d.track_id}`} className="flex items-center gap-2 text-[11px]">
              {d.kind === "person"
                ? <User className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
                : <Trash2 className="w-3.5 h-3.5 text-red-400 shrink-0" />}
              <span className="font-mono text-slate-200">
                {d.kind === "person" ? "Person" : d.label} #{d.track_id}
              </span>
              {d.conf != null && (
                <div className="flex-1 flex items-center gap-1.5 min-w-0">
                  <div className="flex-1 h-1 rounded bg-civic-800">
                    <div
                      className={cn("h-full rounded", d.kind === "person" ? "bg-yellow-500/70" : "bg-red-500/70")}
                      style={{ width: `${Math.round(d.conf * 100)}%` }}
                    />
                  </div>
                  <span className="text-slate-400 w-8 text-right">{Math.round(d.conf * 100)}%</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {running && !stale && tracked.length > 0 && (
        <div className="pt-2 border-t border-white/5 space-y-1">
          <p className="text-[10px] text-slate-500">Person ↔ object interactions being analysed</p>
          {tracked.map((m) => (
            <div key={`${m.person_id}-${m.waste_id}`} className="flex items-center justify-between text-[11px]">
              <span className="font-mono text-slate-300">P#{m.person_id} ↔ #{m.waste_id}</span>
              <span className={cn(
                "text-[10px]",
                m.state === "LITTERING_CONFIRMED" ? "text-red-400 font-semibold" : "text-blue-300",
              )}>
                {STAGE_LABEL[m.state]}
                {m.dwell_progress > 0 && m.state !== "LITTERING_CONFIRMED" ? ` · ${Math.round(m.dwell_progress * 100)}%` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
