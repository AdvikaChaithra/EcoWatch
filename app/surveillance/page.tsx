"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { Activity, AlertTriangle, Wifi, WifiOff, Play, Square, RefreshCw, MapPin, Clock, ExternalLink } from "lucide-react";
import { useEcoStore } from "@/lib/store";
import { CameraFeed } from "@/components/surveillance/CameraFeed";
import { BiometricPanel, type IdentityResultMsg } from "@/components/surveillance/BiometricPanel";
import { PenaltyTerminal, LogEntry } from "@/components/surveillance/PenaltyTerminal";
import { cn } from "@/lib/utils";

const WS_URL    = process.env.NEXT_PUBLIC_WS_URL    ?? "ws://localhost:8000/ws/alerts";
const BACKEND   = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";
const EVIDENCE  = `${BACKEND}/evidence`;   // served via StaticFiles mount

// ── Types ─────────────────────────────────────────────────────────────────────

interface BBox {
  type: "person" | "trash";
  x1: number; y1: number; x2: number; y2: number;
  confidence: number;
  label?: string;
  trackId?: number;
}

interface ActiveMachine {
  person_id:      number;
  waste_id:       number;
  state:          string;
  dwell_progress: number;
}

interface NodeHealth {
  camera_fps:           number;
  inference_fps:        number;
  inference_latency_ms: number;
  cpu_percent:          number;
  ram_mb:               number;
  gpu:                  string;
  dropped_frames:       number;
  queue_size:           number;
  camera_status?:       string;
  camera_resolution?:   string;
}

interface LitterEvent {
  event_id:         string;
  camera_id:        string;
  timestamp:        string;
  location:         { name: string; latitude: number; longitude: number; ward: string };
  person_track_id:  number;
  waste_track_id:   number;
  person_bbox:      number[];
  waste_bbox:       number[];
  event_confidence: number;
  action_label:     string;          // DROP | PICKUP | PASS_BY | PLACE_IN_BIN
  identity_status:  string;          // "PENDING" until the backend sends identity_result
  confidence_breakdown?: {
    association: number; separation: number; stationary: number;
    departure: number; dwell_seconds: number;
  };
  evidence_dir?: string;             // item 2: short event_id prefix
}

interface CameraConfig {
  camera_id: string; camera_name: string;
  latitude: string; longitude: string;
  location_name: string; ward: string;
  mjpeg_url?: string;                // A9: from /api/camera/config
}

type BootStage =
  | "OFFLINE" | "STARTING" | "YOLO_READY" | "CAMERA_READY"
  | "TRACKER_READY" | "EVENT_ENGINE_READY" | "SYSTEM_READY"
  | "CAMERA_ERROR" | "CAMERA_BLACK" | "YOLO_ERROR";

const STAGE_COLOR: Record<string, string> = {
  OFFLINE:            "text-slate-500",
  STARTING:           "text-yellow-400",
  YOLO_READY:         "text-blue-400",
  CAMERA_READY:       "text-blue-400",
  TRACKER_READY:      "text-blue-400",
  EVENT_ENGINE_READY: "text-blue-400",
  SYSTEM_READY:       "text-eco-400",
  CAMERA_ERROR:       "text-red-400",
  CAMERA_BLACK:       "text-red-400",
  YOLO_ERROR:         "text-red-400",
};

const ZERO_HEALTH: NodeHealth = {
  camera_fps: 0, inference_fps: 0, inference_latency_ms: 0,
  cpu_percent: 0, ram_mb: 0, gpu: "—",
  dropped_frames: 0, queue_size: 0,
};

// ── Component ─────────────────────────────────────────────────────────────────

export default function SurveillanceDashboard() {
  const [running,       setRunning]       = useState(false);
  const [wsStatus,      setWsStatus]      = useState<"connected"|"disconnected"|"connecting">("disconnected");
  const [bootStage,     setBootStage]     = useState<BootStage>("OFFLINE");
  const [bboxes,        setBboxes]        = useState<BBox[]>([]);
  // A9: active state machines from pipeline_state
  const [activeMachines, setActiveMachines] = useState<ActiveMachine[]>([]);
  const [health,        setHealth]        = useState<NodeHealth>(ZERO_HEALTH);
  const [logs,          setLogs]          = useState<LogEntry[]>([]);
  const [litterEvents,  setLitterEvents]  = useState<LitterEvent[]>([]);
  const [latestEvent,   setLatestEvent]   = useState<LitterEvent | null>(null);
  const [identity,      setIdentity]      = useState<IdentityResultMsg | null>(null);
  const [camConfig,     setCamConfig]     = useState<CameraConfig | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const addLiveAlert = useEcoStore((s) => s.addLiveAlert);

  const addLog = useCallback((msg: string, type: LogEntry["type"] = "info") => {
    const ts = new Date().toLocaleTimeString("en-IN", { hour12: false });
    setLogs((prev) => [...prev.slice(-80), { msg, type, ts }]);
  }, []);

  // Fetch camera config (includes mjpeg_url) on mount
  useEffect(() => {
    fetch(`${BACKEND}/api/camera/config`)
      .then((r) => r.json())
      .then((d: CameraConfig) => setCamConfig(d))
      .catch(() => {});
  }, []);

  // WebSocket
  useEffect(() => {
    if (!running) {
      wsRef.current?.close();
      wsRef.current = null;
      setWsStatus("disconnected");
      setBootStage("OFFLINE");
      setBboxes([]);
      setHealth(ZERO_HEALTH);
      setActiveMachines([]);
      return;
    }

    setWsStatus("connecting");
    addLog("Connecting to EcoWatch backend WebSocket…", "sys");

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsStatus("connected");
      addLog(`WS connected → ${WS_URL}`, "sys");
      ws.send(JSON.stringify({ type: "ping" }));
    };

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        // ── Boot status from vision_engine.py ────────────────────────────
        if (msg.type === "boot_status") {
          setBootStage(msg.stage as BootStage);
          addLog(`[${msg.stage}] ${msg.message}`, msg.error ? "error" : "info");
          return;
        }

        // ── Real telemetry (psutil) ───────────────────────────────────────
        if (msg.type === "node_health") {
          setHealth({
            camera_fps:           msg.camera_fps           ?? 0,
            inference_fps:        msg.inference_fps         ?? 0,
            inference_latency_ms: msg.inference_latency_ms ?? 0,
            cpu_percent:          msg.cpu_percent           ?? 0,
            ram_mb:               msg.ram_mb                ?? 0,
            gpu:                  msg.gpu                   ?? "—",
            dropped_frames:       msg.dropped_frames        ?? 0,
            queue_size:           msg.queue_size            ?? 0,
            camera_status:        msg.camera_status,
            camera_resolution:    msg.camera_resolution,
          });
          if (msg.camera_status === "CAMERA_ERROR" || msg.camera_status === "CAMERA_BLACK") {
            setBootStage(msg.camera_status);
          } else if (msg.camera_status === "CAMERA_READY" && (msg.camera_fps ?? 0) > 0) {
            // Engine was already running before this page opened (boot messages were missed),
            // or the camera recovered: live telemetry proves the pipeline is up.
            setBootStage((s) => (s === "OFFLINE" || s === "CAMERA_ERROR" || s === "CAMERA_BLACK") ? "SYSTEM_READY" : s);
          }
          return;
        }

        // ── A9: Pipeline state (5 Hz, no images) ─────────────────────────
        if (msg.type === "pipeline_state") {
          setActiveMachines(msg.active_machines ?? []);
          return;
        }

        // ── Real identity result for a confirmed event (face -> pgvector -> violation) ──
        if (msg.type === "identity_result") {
          const r = msg as IdentityResultMsg;
          setIdentity(r);
          if (r.identity_status === "MATCH") {
            addLog(`✅ IDENTIFIED ${r.citizen_name} · sim=${((r.similarity ?? 0) * 100).toFixed(1)}% · fine ₹${r.fine_amount} · SMS ${r.sms_status ?? "NOT_CONFIGURED"}`, "match");
          } else {
            addLog(`ℹ identity ${r.identity_status}: ${r.reason ?? ""} (no citizen fine)`, r.identity_status === "ERROR" ? "error" : "info");
          }
          return;
        }

        // ── Confirmed littering event ───────────────────────────────────
        if (msg.type === "littering_event") {
          const ev = msg as LitterEvent;
          setLatestEvent(ev);
          setIdentity(null);

          const newBboxes: BBox[] = [
            {
              type: "person", confidence: ev.event_confidence * 100,
              x1: ev.person_bbox[0], y1: ev.person_bbox[1],
              x2: ev.person_bbox[2], y2: ev.person_bbox[3],
              label: `Person #${ev.person_track_id}`, trackId: ev.person_track_id,
            },
            {
              type: "trash", confidence: ev.event_confidence * 100,
              x1: ev.waste_bbox[0], y1: ev.waste_bbox[1],
              x2: ev.waste_bbox[2], y2: ev.waste_bbox[3],
              label: `Waste #${ev.waste_track_id}`, trackId: ev.waste_track_id,
            },
          ];
          setBboxes(newBboxes);

          setLitterEvents((prev) => [ev, ...prev.slice(0, 19)]);

          addLog(
            `🚨 LITTERING CONFIRMED at ${ev.location.name} | conf=${(ev.event_confidence * 100).toFixed(1)}%`,
            "alert",
          );
          if (ev.confidence_breakdown) {
            const b = ev.confidence_breakdown;
            addLog(
              `  assoc=${(b.association*100).toFixed(0)}% sep=${(b.separation*100).toFixed(0)}% ` +
              `stat=${(b.stationary*100).toFixed(0)}% dep=${(b.departure*100).toFixed(0)}% ` +
              `dwell=${b.dwell_seconds.toFixed(1)}s`,
              "info",
            );
          }
          addLog(
            `  action=${ev.action_label} | P#${ev.person_track_id} W#${ev.waste_track_id} | identity: PENDING`,
            "match",
          );

          addLiveAlert({
            id: ev.event_id, type: "violation",
            message: `Littering detected at ${ev.location.name}`,
            timestamp: ev.timestamp,
          });

          // Clear event bbox overlay after 12s (but keep activeMachines from pipeline_state)
          setTimeout(() => { setBboxes([]); }, 12000);
          return;
        }

        // ── Pong ─────────────────────────────────────────────────────────
        if (msg.type === "pong") {
          addLog(`Backend ACK — ${msg.connections ?? 1} WS connection(s)`, "sys");
          return;
        }

        // ── Legacy violation format (backward compat) ─────────────────────
        if (msg.type === "violation") {
          const bboxList: BBox[] = [];
          if (msg.person_bbox) {
            const [x1,y1,x2,y2] = msg.person_bbox;
            bboxList.push({ type: "person", x1, y1, x2, y2, confidence: 94, label: "Person" });
          }
          if (msg.trash_bbox) {
            const [x1,y1,x2,y2] = msg.trash_bbox;
            bboxList.push({ type: "trash", x1, y1, x2, y2, confidence: msg.confidence_score ?? 87, label: "Waste" });
          }
          setBboxes(bboxList);
          addLog(`🚨 LITTER at ${msg.location} — ${msg.confidence_score?.toFixed(1)}%`, "alert");
          setTimeout(() => { setBboxes([]); }, 8000);
          return;
        }

      } catch {
        addLog(`WS parse error: ${evt.data?.slice(0, 80)}`, "error");
      }
    };

    ws.onclose  = () => { setWsStatus("disconnected"); addLog("WS disconnected", "sys"); };
    ws.onerror  = () => addLog("WS error — is FastAPI running on :8000?", "error");

    return () => { ws.close(); };
  }, [running]); // eslint-disable-line

  const isError = bootStage === "CAMERA_ERROR" || bootStage === "YOLO_ERROR";

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">

      {/* Page Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-display text-3xl font-bold text-slate-100">AI Camera Surveillance</h1>
          <p className="text-slate-400 text-sm mt-1">
            YOLOv8n · ByteTrack · LitteringStateMachine v3 · MJPEG Stream
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Boot stage badge */}
          <div className={cn(
            "text-xs font-mono px-3 py-1.5 rounded-xl border",
            isError
              ? "bg-red-500/10 border-red-500/20"
              : bootStage === "SYSTEM_READY"
              ? "bg-eco-500/10 border-eco-500/20"
              : "bg-slate-500/10 border-slate-500/20",
          )}>
            <span className={STAGE_COLOR[bootStage] ?? "text-slate-400"}>{bootStage}</span>
          </div>
          {/* WS status */}
          <div className={cn(
            "flex items-center gap-2 text-xs px-3 py-1.5 rounded-xl border",
            wsStatus === "connected"  ? "text-eco-400 bg-eco-500/10 border-eco-500/20"
            : wsStatus === "connecting" ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/20"
            : "text-slate-400 bg-slate-500/10 border-slate-500/20",
          )}>
            {wsStatus === "connected" ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
            {wsStatus === "connected" ? "Backend Connected" : wsStatus === "connecting" ? "Connecting…" : "Backend Offline"}
          </div>
          {/* Start/Stop */}
          <button
            onClick={() => setRunning((r) => !r)}
            className={cn(
              "flex items-center gap-2 px-5 py-2.5 rounded-xl font-semibold text-sm transition-all",
              running
                ? "bg-red-600 hover:bg-red-500 text-white"
                : "bg-eco-600 hover:bg-eco-500 text-white shadow-lg shadow-eco-500/20",
            )}
          >
            {running ? <><Square className="w-4 h-4" /> Stop</> : <><Play className="w-4 h-4" /> Start Inference</>}
          </button>
        </div>
      </div>

      {/* Camera info bar */}
      {camConfig && (
        <div className="flex flex-wrap items-center gap-4 px-4 py-2.5 rounded-xl bg-civic-900/60 border border-white/8 text-xs text-slate-400">
          <span className="font-mono text-eco-400 font-semibold">{camConfig.camera_id}</span>
          <span>{camConfig.camera_name}</span>
          {camConfig.location_name && (
            <span className="flex items-center gap-1">
              <MapPin className="w-3 h-3" />{camConfig.location_name}
            </span>
          )}
          {camConfig.ward && <span>{camConfig.ward}</span>}
          {health.camera_resolution && <span className="font-mono">{health.camera_resolution}</span>}
          {/* A9: show MJPEG URL */}
          {camConfig.mjpeg_url && (
            <span className="text-slate-600 font-mono ml-auto">{camConfig.mjpeg_url}</span>
          )}
        </div>
      )}

      {/* Main Grid */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6">

        {/* ── Single Camera Feed ── */}
        <div className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-mono text-slate-400">
                {camConfig?.camera_id ?? "CAM_01"} · {health.camera_resolution ?? "—"}
              </p>
              {running && wsStatus === "connected" && (
                <span className="text-[10px] text-eco-400 font-mono">
                  {health.camera_fps.toFixed(1)}fps · MJPEG
                </span>
              )}
            </div>
            {/* A9: pass mjpegUrl + activeMachines; remove old props */}
            <CameraFeed
              bboxes={running ? bboxes : []}
              running={running}
              cameraOffline={["CAMERA_ERROR", "CAMERA_BLACK"].includes(health.camera_status ?? "") || bootStage === "CAMERA_ERROR" || bootStage === "CAMERA_BLACK"}
              offlineReason={(health.camera_status === "CAMERA_BLACK" || bootStage === "CAMERA_BLACK")
                ? "The webcam is sending only black frames. Check the lens/privacy shutter and lighting, and close other apps using the camera (Teams, Zoom, Camera app, browser tabs). The engine retries automatically."
                : undefined}
              cameraId={camConfig?.camera_id ?? "CAM_01"}
              mjpegUrl={camConfig?.mjpeg_url}
              activeMachines={running ? activeMachines : []}
            />
          </div>

          {/* Evidence viewer: shows disk-saved key frames via /evidence/ route (item 2) */}
          {latestEvent?.evidence_dir && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono text-red-400">
                  📸 EVIDENCE — {latestEvent.evidence_dir} · {latestEvent.action_label}
                </p>
                <a
                  href={`${EVIDENCE}/${latestEvent.evidence_dir}/event.json`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[9px] text-slate-500 hover:text-slate-300"
                >
                  event.json <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {["1_assoc", "2_drop", "3_confirmed"].map((label) => (
                  <div key={label} className="relative rounded-lg overflow-hidden border border-white/10 bg-black">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`${EVIDENCE}/${latestEvent.evidence_dir}/${label}.jpg`}
                      alt={label}
                      className="w-full object-cover"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    <span className="absolute bottom-0 left-0 right-0 text-center text-[8px] font-mono py-0.5 bg-black/70 text-slate-400">
                      {label}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-[9px] text-slate-600 text-center">
                identity: {latestEvent.identity_status} · conf: {(latestEvent.event_confidence*100).toFixed(1)}%
              </p>
            </div>
          )}
        </div>

        {/* ── Right Panel ── */}
        <div className="space-y-4">

          {/* Biometric Panel — PENDING in Part 1 */}
          <BiometricPanel
            match={null}
            identity={identity}
            running={running}
            pendingEvent={running ? latestEvent : null}
          />

          {/* Node Health */}
          <div className="glass-card p-4 space-y-3">
            <p className="text-xs text-slate-400 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-blue-400" /> Node Health
              <span className="ml-auto text-[10px] text-slate-600">psutil · real values</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Cam FPS",  value: running && wsStatus === "connected" ? `${health.camera_fps.toFixed(1)}`           : "—", color: "text-eco-400"    },
                { label: "AI FPS",   value: running && wsStatus === "connected" ? `${health.inference_fps.toFixed(1)}`         : "—", color: "text-blue-400"   },
                { label: "Latency",  value: running && wsStatus === "connected" ? `${health.inference_latency_ms}ms`           : "—", color: "text-orange-400" },
                { label: "CPU",      value: running && wsStatus === "connected" ? `${health.cpu_percent.toFixed(1)}%`          : "—", color: "text-yellow-400" },
                { label: "RAM",      value: running && wsStatus === "connected" ? `${health.ram_mb}MB`                         : "—", color: "text-purple-400" },
                { label: "Drops",    value: running && wsStatus === "connected" ? `${health.dropped_frames}`                   : "—", color: "text-slate-400"  },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-civic-900/60 rounded-xl p-3 text-center">
                  <p className="text-[10px] text-slate-400">{label}</p>
                  <p className={cn("font-display text-base font-bold", color)}>{value}</p>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-slate-500 text-center">GPU: {running ? health.gpu : "—"}</p>
          </div>

          {/* Pipeline state machines (A9) */}
          {running && activeMachines.length > 0 && (
            <div className="glass-card p-3 space-y-2">
              <p className="text-[10px] font-mono text-slate-400">Active State Machines ({activeMachines.length})</p>
              {activeMachines.map((sm) => (
                <div key={`${sm.person_id}-${sm.waste_id}`}
                     className="flex items-center gap-2 text-[10px] font-mono">
                  <span className="text-slate-500">P#{sm.person_id} W#{sm.waste_id}</span>
                  <span className={cn(
                    "px-1.5 py-0.5 rounded text-[9px]",
                    sm.state === "LITTERING_CONFIRMED" ? "bg-red-500/20 text-red-400"
                    : sm.state === "OBJECT_STATIONARY" ? "bg-orange-500/20 text-orange-400"
                    : "bg-slate-500/10 text-slate-400",
                  )}>{sm.state}</span>
                  {sm.dwell_progress > 0 && (
                    <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-orange-400 transition-all"
                        style={{ width: `${sm.dwell_progress * 100}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Littering Events List */}
          <div className="glass-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-400 flex items-center gap-1.5">
                <AlertTriangle className="w-3.5 h-3.5 text-red-400" /> Detections
              </p>
              <button onClick={() => setLitterEvents([])}
                      className="p-1 rounded-md hover:bg-white/5 text-slate-500">
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
            {litterEvents.length === 0 ? (
              <p className="text-slate-600 text-xs text-center py-4">
                {running ? "Awaiting real littering detection…" : "Start inference to monitor"}
              </p>
            ) : (
              <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                {litterEvents.map((ev) => (
                  <div key={ev.event_id} className="p-2 rounded-lg bg-white/3 border border-white/5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[10px] font-mono text-slate-300">
                        P#{ev.person_track_id} · W#{ev.waste_track_id}
                      </p>
                      <div className="flex items-center gap-1">
                        <span className="badge text-[9px] bg-blue-500/10 text-blue-400 border-blue-500/20">
                          {ev.action_label}
                        </span>
                        <span className="badge text-[9px] bg-red-500/10 text-red-400 border-red-500/20">
                          {(ev.event_confidence * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>
                    <p className="text-[10px] text-slate-500 truncate mt-0.5">{ev.location.name}</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      <Clock className="w-2.5 h-2.5 text-slate-600" />
                      <p className="text-[9px] text-slate-600">
                        {new Date(ev.timestamp).toLocaleTimeString()}
                      </p>
                      <span className="badge text-[8px] bg-yellow-500/10 text-yellow-400 border-yellow-500/20 ml-auto">
                        IDENTITY PENDING
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Pipeline Terminal */}
          <PenaltyTerminal logs={logs} maxHeight="h-44" />
        </div>
      </div>
    </div>
  );
}
