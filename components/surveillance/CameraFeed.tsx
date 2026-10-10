"use client";
import { useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";

interface BoundingBox {
  type: "person" | "trash";
  x1: number; y1: number; x2: number; y2: number; // pixel coords from vision_engine
  confidence: number;
  label?: string;
  trackId?: number;
}

interface Props {
  bboxes:        BoundingBox[];
  running:       boolean;
  cameraOffline: boolean;     // true = show CAMERA OFFLINE, no simulation fallback
  cameraId:      string;
  smState?:      string;      // state machine state for overlay
  dwellProgress?: number;     // 0–1 dwell bar fill
}

/**
 * CameraFeed — real hardware webcam via getUserMedia.
 * Canvas overlay renders real bounding boxes received from vision_engine.py.
 *
 * NO simulation mode. If camera is unavailable → CAMERA OFFLINE.
 * NO fake scan-line animations when camera is not active.
 * NO Math.random() anywhere.
 */
export function CameraFeed({ bboxes, running, cameraOffline, cameraId, smState, dwellProgress }: Props) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const camActiveRef = useRef(false);
  const camErrorRef  = useRef<string>("");

  // ── Start real webcam ─────────────────────────────────────────────────────
  const startWebcam = useCallback(async () => {
    camErrorRef.current = "";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      camActiveRef.current = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Camera access denied";
      camErrorRef.current = msg;
      camActiveRef.current = false;
    }
  }, []);

  const stopWebcam = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    camActiveRef.current = false;
  }, []);

  useEffect(() => {
    if (running && !cameraOffline) {
      startWebcam();
    } else {
      stopWebcam();
    }
    return () => { stopWebcam(); };
  }, [running, cameraOffline]); // eslint-disable-line

  // ── Canvas: render bboxes from WebSocket ──────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const video  = videoRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;

    function draw() {
      if (!canvas || !ctx) return;

      // Sync canvas dimensions to video
      if (video && video.videoWidth > 0) {
        canvas.width  = video.videoWidth;
        canvas.height = video.videoHeight;
      } else {
        canvas.width  = 1280;
        canvas.height = 720;
      }
      const W = canvas.width;
      const H = canvas.height;

      ctx.clearRect(0, 0, W, H);

      if (!running) {
        animId = requestAnimationFrame(draw);
        return;
      }

      // Draw bounding boxes (pixel coords from vision_engine — already absolute pixels)
      for (const box of bboxes) {
        // vision_engine sends pixel coords at original resolution (e.g. 1280x720)
        // Map to current canvas size
        const scaleX = W / 1280;
        const scaleY = H / 720;
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

        // Label with track ID
        const labelText = box.label
          ? `${box.label} ${box.confidence.toFixed(0)}%`
          : `${box.type === "person" ? "Person" : "Waste"} ${box.confidence.toFixed(0)}%`;
        ctx.font = "bold 11px monospace";
        const tw = ctx.measureText(labelText).width + 8;
        ctx.fillStyle = col;
        ctx.fillRect(x1, y1 - 18, tw, 18);
        ctx.fillStyle = "#000";
        ctx.fillText(labelText, x1 + 4, y1 - 5);
      }

      // Dwell progress bar if active
      if (dwellProgress && dwellProgress > 0 && bboxes.length > 1) {
        const wasteBbox = bboxes.find((b) => b.type === "trash");
        if (wasteBbox) {
          const scaleX = W / 1280;
          const scaleY = H / 720;
          const bx1 = wasteBbox.x1 * scaleX;
          const by2 = wasteBbox.y2 * scaleY;
          const bboxW = (wasteBbox.x2 - wasteBbox.x1) * scaleX;
          const barW = bboxW * dwellProgress;
          ctx.fillStyle = "rgba(255,140,0,0.8)";
          ctx.fillRect(bx1, by2 + 2, barW, 6);
        }
      }

      // State machine status overlay
      if (smState && smState !== "NORMAL" && smState !== "") {
        const isConfirmed = smState === "LITTERING_CONFIRMED";
        ctx.font = "bold 13px monospace";
        const stateText = isConfirmed ? `⚠ ${smState}` : smState;
        const tw = ctx.measureText(stateText).width + 12;
        ctx.fillStyle = isConfirmed ? "rgba(239,68,68,0.9)" : "rgba(234,179,8,0.85)";
        ctx.fillRect(8, H - 32, tw, 22);
        ctx.fillStyle = "#000";
        ctx.fillText(stateText, 14, H - 16);
      }

      // Timestamp
      ctx.font = "10px monospace";
      ctx.fillStyle = "rgba(16,185,129,0.7)";
      ctx.fillText(`${cameraId} · ${new Date().toLocaleTimeString()}`, 8, H - 8);

      animId = requestAnimationFrame(draw);
    }

    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [bboxes, running, cameraOffline, smState, dwellProgress, cameraId]); // eslint-disable-line

  // ── CAMERA OFFLINE state ──────────────────────────────────────────────────
  if (cameraOffline && running) {
    return (
      <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden border-2 border-red-500/40 flex flex-col items-center justify-center gap-3">
        <div className="text-center">
          <p className="text-2xl font-mono font-bold text-red-400">CAMERA OFFLINE</p>
          <p className="text-sm text-red-400/60 mt-1 font-mono">{cameraId}</p>
          <p className="text-xs text-slate-500 mt-3">
            Check CAMERA_SOURCE in backend/.env<br />
            and restart vision_engine.py
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full aspect-video bg-black rounded-xl overflow-hidden border-2 border-eco-500/40">
      {/* Real webcam video */}
      <video
        ref={videoRef}
        autoPlay muted playsInline
        className="absolute inset-0 w-full h-full object-cover"
      />

      {/* Offline overlay (camera not started) */}
      {!running && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="text-center">
            <p className="text-slate-500 font-mono text-sm">INFERENCE STOPPED</p>
            <p className="text-slate-600 text-xs mt-1 font-mono">{cameraId}</p>
          </div>
        </div>
      )}

      {/* Canvas overlay — bboxes from vision_engine WebSocket */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: "none" }}
      />

      {/* REC indicator */}
      {running && camActiveRef.current && (
        <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-red-600/80 backdrop-blur-sm">
          <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="text-white text-[10px] font-bold">REC</span>
        </div>
      )}

      {/* Camera error (browser denied / no device) */}
      {camErrorRef.current && running && (
        <div className="absolute bottom-0 left-0 right-0 p-2 bg-red-900/90 text-red-300 text-[10px] text-center font-mono">
          CAMERA ERROR: {camErrorRef.current}
        </div>
      )}
    </div>
  );
}
