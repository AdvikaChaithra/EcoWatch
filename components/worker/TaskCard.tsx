"use client";
import { useState, useEffect, useRef } from "react";
import { MapPin, Navigation, Camera, CheckCircle2, Loader2, AlertCircle, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";
import { haversineMeters } from "@/lib/supabase";
import { cn, getDayOfWeek, severityColor } from "@/lib/utils";

export interface Task {
  id: string; category: string; severity: string;
  location_name: string; lat: number; lng: number;
  status: string; created_at: string; reported_image_url?: string;
}

interface Props {
  task: Task;
  workerId?: string;
  onComplete: (taskId: string) => void;
}

// FIX 4: SLACountdown now uses useEffect for the interval instead of useState.
// The previous useState(() => setInterval(...)) ran the setup but the returned
// cleanup function was treated as useState's initial value — interval never cleared.
function SLACountdown({ createdAt }: { createdAt: string }) {
  const [remaining, setRemaining] = useState(() => calc(createdAt));

  useEffect(() => {
    const id = setInterval(() => setRemaining(calc(createdAt)), 60_000);
    return () => clearInterval(id);
  }, [createdAt]);

  function calc(ts: string) {
    const left = 6 * 3600_000 - (Date.now() - new Date(ts).getTime());
    if (left <= 0) return "⚠️ SLA Breached";
    return `${Math.floor(left / 3_600_000)}h ${Math.floor((left % 3_600_000) / 60_000)}m remaining`;
  }

  return (
    <span className={cn("text-xs font-mono", remaining.includes("Breached") ? "text-red-400 animate-pulse" : "text-eco-400")}>
      {remaining}
    </span>
  );
}

export function TaskCard({ task, workerId, onComplete }: Props) {
  const [expanded, setExpanded]     = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [geoError, setGeoError]     = useState("");
  const [success, setSuccess]       = useState(false);

  const cam = useCamera();
  const geo = useGeolocation();

  // Polling removed: geo.fetchLocation() now returns a Promise directly

  async function handleProofUpload() {
    setGeoError("");

    // If we've already captured an image, this click means "Submit it"
    if (cam.capturedImage) {
      setSubmitting(true);
      try {
        // Upload snapshot to Supabase Storage → evidence bucket
        let imageUrl = cam.capturedImage;
        try {
          const blob     = await (await fetch(cam.capturedImage)).blob();
          const filename = `cleaned/${workerId ?? "worker"}/${Date.now()}.jpg`;
          const { data: up, error: upErr } = await supabase.storage.from("evidence").upload(filename, blob, { contentType: "image/jpeg" });
          if (upErr) console.warn("[TaskCard] Storage upload failed, using inline image:", upErr.message);
          if (up) {
            const { data: { publicUrl } } = supabase.storage.from("evidence").getPublicUrl(filename);
            imageUrl = publicUrl;
          }
        } catch { /* storage bucket may not exist yet — use base64 fallback */ }

        // Update dump_reports: status → Pending Verification, store cleaned_image_url
        const { error: updateErr } = await supabase.from("dump_reports").update({
          status:            "Pending Verification",
          cleaned_image_url: imageUrl,
          updated_at:        new Date().toISOString(),
        }).eq("id", task.id);

        if (updateErr) throw updateErr;

        // Points/bonus are credited by the admin on verification (not here), so a rejected
        // submission that is re-done can't be rewarded twice.

        cam.stopCamera();
        setSuccess(true);
        setTimeout(() => onComplete(task.id), 1500);
      } catch (err: any) {
        console.error("[TaskCard] Proof upload failed:", err?.message);
        setGeoError(`Upload failed: ${err?.message ?? "Unknown error"}. Please try again.`);
      } finally { setSubmitting(false); }
      return; 
    }

    const GEOFENCE_RADIUS_METERS = 50;

    // 1. Open the camera first (no GPS wait); the location is taken once, at capture time.
    if (!cam.active) { await cam.startCamera("environment"); return; }

    // 2. Acquire a fresh, best-accuracy GPS fix for the proof photo
    const gpsResult = await geo.fetchLocation();

    // 2. Strict 50m geofence — enforce only when we have a GPS fix AND task coordinates
    if (gpsResult.lat !== null && gpsResult.lng !== null && task.lat !== undefined && task.lng !== undefined) {
      const dist = haversineMeters(gpsResult.lat, gpsResult.lng, task.lat, task.lng);
      if (dist > GEOFENCE_RADIUS_METERS) {
        const acc = Math.round(gpsResult.accuracy ?? 0);
        setGeoError(
          acc > GEOFENCE_RADIUS_METERS
            ? `GPS accuracy is only ±${acc} m, too low to verify you are within ${GEOFENCE_RADIUS_METERS} m of the site (measured ${Math.round(dist)} m). Use a phone with GPS on, or step outside and retry.`
            : `You are ${Math.round(dist)} m away. You must be within ${GEOFENCE_RADIUS_METERS} m of the site to submit proof.`
        );
        return;
      }
    } else if ((gpsResult.lat === null || gpsResult.lng === null) && task.lat !== undefined && task.lng !== undefined) {
      setGeoError("Could not determine your GPS location. Enable location access and try again.");
      return;
    }

    // Capture the frame with the GPS stamp (the next click submits it)
    cam.captureFrame({
      lat:     gpsResult.lat  ?? task.lat,
      lng:     gpsResult.lng  ?? task.lng,
      address: gpsResult.address     ?? task.location_name,
    });
    cam.stopCamera(); // photo taken: release the webcam
  }

  if (success) {
    return (
      <div className="glass-card p-5 flex items-center gap-3 animate-fade-in-up">
        <CheckCircle2 className="w-6 h-6 text-eco-400 shrink-0" />
        <p className="text-eco-300 text-sm font-medium">Proof submitted for {task.location_name}! Admin review pending.</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-5 space-y-4 animate-fade-in-up">
      {/* Task Header */}
      <div className="flex gap-4 items-start">
        <div className="w-20 h-16 rounded-xl overflow-hidden bg-civic-800 shrink-0">
          {task.reported_image_url
            ? <img src={task.reported_image_url} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-slate-600 text-2xl">📷</div>
          }
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={cn("badge text-xs", severityColor(task.severity))}>{task.severity}</span>
            <span className="text-sm font-semibold text-slate-100">{task.category}</span>
          </div>
          <div className="flex items-start gap-1 mt-1.5">
            <MapPin className="w-3.5 h-3.5 text-eco-400 shrink-0 mt-0.5" />
            <p className="text-xs text-slate-400 leading-relaxed">{task.location_name}</p>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 mt-2 text-xs text-slate-500">
            <span>📅 {new Date(task.created_at).toLocaleDateString("en-IN")}</span>
            <span>📆 {getDayOfWeek(task.created_at)}</span>
            {task.lat && <span className="font-mono">🛰 {task.lat.toFixed(4)}, {task.lng?.toFixed(4)}</span>}
            <SLACountdown createdAt={task.created_at} />
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-2 border-t border-white/5">
        <a
          href={`https://www.google.com/maps/dir/?api=1&destination=${task.lat},${task.lng}`}
          target="_blank" rel="noopener noreferrer"
          className="btn-eco-outline flex-1 justify-center text-xs"
        >
          <Navigation className="w-3.5 h-3.5" /> Navigate
        </a>
        <button
          onClick={() => { setExpanded((e) => !e); setGeoError(""); }}
          className="btn-eco flex-1 justify-center text-xs"
        >
          <Camera className="w-3.5 h-3.5" /> {expanded ? "Close" : "Upload Proof"}
        </button>
      </div>

      {/* Proof Upload Panel */}
      {expanded && (
        <div className="border-t border-white/5 pt-4 space-y-3 animate-fade-in-up">
          {geoError && (
            <div className="flex items-center gap-2 text-xs text-red-300 bg-red-500/10 p-3 rounded-xl border border-red-500/20">
              <AlertCircle className="w-4 h-4 shrink-0" /> {geoError}
            </div>
          )}
          {cam.error && (
            <div className="flex items-center gap-2 text-xs text-red-300 bg-red-500/10 p-3 rounded-xl border border-red-500/20">
              <AlertCircle className="w-4 h-4 shrink-0" /> Camera Error: {cam.error}
            </div>
          )}
          <div className="camera-container aspect-video">
            {cam.capturedImage ? (
              <div className="relative w-full h-full">
                <img src={cam.capturedImage} alt="" className="w-full h-full object-cover" />
                <button
                  onClick={() => cam.clearCapture()}
                  className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-white hover:bg-red-600/60"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="relative w-full h-full">
                <video ref={cam.videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
                <canvas ref={cam.canvasRef} className="hidden" />
                {!cam.active && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    <Camera className="w-10 h-10 text-eco-400" />
                  </div>
                )}
              </div>
            )}
          </div>
          <button onClick={handleProofUpload} disabled={submitting} className="btn-eco w-full justify-center">
            {submitting
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting...</>
              : cam.capturedImage
                ? <><CheckCircle2 className="w-4 h-4" /> Submit Proof</>
                : cam.active
                  ? <><Camera className="w-4 h-4" /> Capture After-Photo</>
                  : <><Camera className="w-4 h-4" /> Start Camera</>
            }
          </button>
          <p className="text-[10px] text-slate-500 text-center">
            📍 GPS watermark auto-stamped · Geofence: 50m radius enforced · Uploaded to Supabase Storage
          </p>
        </div>
      )}
    </div>
  );
}
