"use client";
import { useEffect, useRef, useCallback, useState } from "react";
import { cn } from "@/lib/utils";

interface BoundingBox {
  type: "person" | "trash";
  x1: number; y1: number; x2: number; y2: number;  // pixel coords
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

interface Props {
  bboxes:          BoundingBox[];
  running:         boolean;
  cameraOffline:   boolean;
  cameraId:        string;
  mjpegUrl?:       string;        // A9: from /api/camera/config
  activeMachines?: ActiveMachine[]; // A9: pipeline_state
}

const MJPEG_FALLBACK = `http://localhost:8001/stream.mjpg`;

/**
 * CameraFeed v2 (A9)
 * -------------------
 * Displays the annotated MJPEG stream from the vision engine as a plain <img>.
 * - No getUserMedia / no browser camera conflict.
 * - A canvas overlay renders bboxes received on littering_event WS messages.
 * - Dwell progress bars and SM state overlays drawn from pipeline_state WS messages.
 * - CAMERA OFFLINE shown when running=true but camera_status=CAMERA_ERROR.
 *
 * Why <img> instead of <video>: MJPEG is multipart/x-mixed-replace — the browser
 * natively renders it as a continuously updating image with a plain <img> tag.
 * No Media Source Extensions or getUserMedia needed.
 */
export function CameraFeed({
  bboxes, running, cameraOffline, cameraId, mjpegUrl, activeMachines = [],
}: Props) {
  const canvasRef     = useRef<HTMLCanvasElement>(null);
  const imgRef        = useRef<HTMLImageElement>(null);
  const [streamError, setStreamError] = useState(false);
  const [streamOk,    setStreamOk]    = useState(false);

  const streamUrl = mjpegUrl ?? MJPEG_FALLBACK;

  // Reset stream error state when running changes
  useEffect(() => {
    if (running) {
      setStreamError(false);
      setStreamOk(false);
    }
  }, [running]);

  // Canvas: render littering event bboxes + pipeline dwell bars
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let animId: number;

    function draw() {
      if (!canvas || !ctx) return;

      // Match canvas size to the MJPEG image element
      const img = imgRef.current;
      const W = img?.naturalWidth  || img?.clientWidth  || 1280;
      const H = img?.naturalHeight || img?.clientHeight || 720;
      if (canvas.width !== W)  canvas.width  = W;
      if (canvas.height !== H) canvas.height = H;

      ctx.clearRect(0, 0, W, H);

      if (!running) {
        animId = requestAnimationFrame(draw);
        return;
      }

      // Draw littering_event bboxes (pixel coords from backend)
      const scaleX = W / 1280;
      const scaleY = H / 720;
      for (const box of bboxes) {
        const x1 = box.x1 * scaleX;
        const y1 = box.y1 * scaleY;
        const x2 = box.x2 * scaleX;
        const y2 = box.y2 * scaleY;
        const bw = x2 - x1;
        const bh = y2 - y1;
        const col = box.type === "person" ? "#facc15" : "#ef4444";

        ctx.strokeStyle = col;
        ctx.lineWidth   = 2;
        ctx.strokeRect(x1, y1, bw, bh);
        ctx.fillStyle = box.type === "person" ? "rgba(250,204,21,0.08)" : "rgba(239,68,68,0.12)";
        ctx.fillRect(x1, y1, bw, bh);

        // Corner accents
        const cs = Math.min(bw, bh, 16);
        ctx.lineWidth = 3;
        ([ [x1, y1, 1, 1], [x2, y1,-1, 1], [x1, y2, 1,-1], [x2, y2,-1,-1] ] as [number,number,number,number][])
          .forEach(([cx, cy, dx, dy]) => {
            ctx.beginPath();
            ctx.moveTo(cx + dx * cs, cy);
            ctx.lineTo(cx, cy);
            ctx.lineTo(cx, cy + dy * cs);
            ctx.stroke();
          });

        const labelText = box.label ?? `${box.type === "person" ? "Person" : "Waste"} #${box.trackId ?? "?"}`;
        ctx.font = "bold 11px monospace";
        const tw = ctx.measureText(labelText).width + 8;
        ctx.fillStyle = col;
        ctx.fillRect(x1, y1 - 18, tw, 18);
        ctx.fillStyle = "#000";
        ctx.fillText(labelText, x1 + 4, y1 - 5);
      }

      // Draw pipeline_state SM overlays: dwell bar + state badge
      if (activeMachines.length > 0) {
        ctx.font = "bold 10px monospace";
        activeMachines.forEach((sm, idx) => {
          const y  = 52 + idx * 20;
          const isConfirmed = sm.state === "LITTERING_CONFIRMED";
          const col = isConfirmed ? "rgba(239,68,68,0.92)" : "rgba(234,179,8,0.85)";
          const label = `P#${sm.person_id} W#${sm.waste_id}: ${sm.state}`;
          const tw2 = ctx.measureText(label).width + 10;
          ctx.fillStyle = col;
          ctx.fillRect(8, y - 13, tw2, 16);
          ctx.fillStyle = isConfirmed ? "#fff" : "#000";
          ctx.fillText(label, 13, y);

          // Dwell bar (if active)
          if (sm.dwell_progress > 0) {
            const barW = Math.round((W - 20) * sm.dwell_progress);
            ctx.fillStyle = "rgba(255,140,0,0.75)";
            ctx.fillRect(8, y + 4, barW, 4);
          }
        });
      }

      // Timestamp
      ctx.font = "10px monospace";
      ctx.fillStyle = "rgba(16,185,129,0.7)";
      ctx.fillText(`${cameraId} · ${new Date().toLocaleTimeString()}`, 8, H - 8);

      animId = requestAnimationFrame(draw);
    }

    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [bboxes, running, cameraOffline, activeMachines, cameraId]);

  // ── CAMERA OFFLINE ────────────────────────────────────────────────────────
  if (cameraOffline && running) {
    return (
      <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden border-2 border-red-500/40 flex flex-col items-center justify-center gap-3">
        <div className="text-center">
          <p className="text-2xl font-mono font-bold text-red-400">CAMERA OFFLINE</p>
          <p className="text-sm text-red-400/60 mt-1 font-mono">{cameraId}</p>
          <p className="text-xs text-slate-500 mt-3">
            MJPEG stream not available<br />
            Check CAMERA_SOURCE in backend/.env<br />
            and restart vision_engine.py
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden border-2 border-eco-500/40">

      {/* A9: MJPEG stream as a plain <img> — no getUserMedia conflict */}
      {running ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={imgRef}
          src={streamUrl}
          alt="EcoWatch live stream"
          className="absolute inset-0 w-full h-full object-cover"
          onLoad={() => { setStreamOk(true); setStreamError(false); }}
          onError={() => { setStreamError(true); setStreamOk(false); }}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="text-center">
            <p className="text-slate-500 font-mono text-sm">INFERENCE STOPPED</p>
            <p className="text-slate-600 text-xs mt-1 font-mono">{cameraId}</p>
          </div>
        </div>
      )}

      {/* Canvas overlay — bboxes + SM state from WS */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: "none" }}
      />

      {/* Stream error banner (MJPEG server not running) */}
      {running && streamError && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80">
          <div className="text-center space-y-1">
            <p className="text-red-400 font-mono text-sm">STREAM UNAVAILABLE</p>
            <p className="text-slate-500 text-xs font-mono">{streamUrl}</p>
            <p className="text-slate-600 text-xs">Is vision_engine.py running?</p>
          </div>
        </div>
      )}

      {/* REC indicator — shown when stream is live */}
      {running && streamOk && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-red-600/80 backdrop-blur-sm">
          <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="text-white text-[10px] font-bold">REC · MJPEG</span>
        </div>
      )}
    </div>
  );
}
