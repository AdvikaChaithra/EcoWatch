"use client";
import { useState, useEffect, useRef } from "react";
import { MapPin, Navigation, Camera, CheckCircle2, Loader2, AlertCircle, X, ImagePlus, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";
import { haversineMeters } from "@/lib/supabase";
import { fileToJpegDataUrl } from "@/lib/image";
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

const GEOFENCE_RADIUS_METERS = 50;

interface Fix { lat: number | null; lng: number | null; accuracy: number | null; address: string | null }

export function TaskCard({ task, workerId, onComplete }: Props) {
  const [expanded, setExpanded]     = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [locating, setLocating]     = useState(false);
  const [error, setError]           = useState("");
  const [success, setSuccess]       = useState(false);
  const [uploaded, setUploaded]     = useState<string | null>(null);
  const [fix, setFix]               = useState<Fix | null>(null);
  // Where the proof is located: the device's GPS (geofence-checked) or, when GPS can't be used
  // (e.g. a demo away from the site), the dump site chosen manually - always labelled as such.
  const [locMode, setLocMode]       = useState<"gps" | "manual_site">("gps");
  const fileRef = useRef<HTMLInputElement>(null);

  const cam = useCamera();
  const geo = useGeolocation();

  const photo = cam.capturedImage ?? uploaded;
  // "Device in use" / NotReadableError = another program (on the demo laptop: the AI camera engine) holds the webcam
  const camBusy = !!cam.error && /in use|not ?readable|could not start/i.test(cam.error);
  const camDenied = !!cam.error && /denied|not allowed|permission/i.test(cam.error);

  const hasSite = Number.isFinite(task.lat) && Number.isFinite(task.lng);
  const dist = fix?.lat != null && fix?.lng != null && hasSite ? haversineMeters(fix.lat, fix.lng, task.lat, task.lng) : null;
  const manual = locMode === "manual_site";
  const withinFence = !hasSite || manual || (dist != null && dist <= GEOFENCE_RADIUS_METERS);

  function openPanel() {
    setExpanded(true); setError("");
    if (!photo) cam.startCamera("environment"); // open the camera straight away
  }

  function closePanel() {
    cam.stopCamera(); // release the webcam (hands it back to the AI camera engine)
    cam.clearCapture(); setUploaded(null); setFix(null); setError("");
    setExpanded(false);
  }

  /** Best-accuracy GPS fix at the moment the proof is taken (watched for up to 15 s),
   *  or the dump site itself when the worker chose the location manually. */
  async function locate(): Promise<Fix> {
    if (manual) return { lat: task.lat, lng: task.lng, accuracy: null, address: task.location_name };
    setLocating(true);
    try {
      const g = await geo.fetchLocation();
      if (g.lat == null) setError(g.error ?? "Could not determine your GPS location. Enable location access and try again.");
      return { lat: g.lat, lng: g.lng, accuracy: g.accuracy, address: g.address };
    } finally { setLocating(false); }
  }

  async function capture() {
    setError("");
    if (!cam.active) { await cam.startCamera("environment"); return; }
    const g = await locate();
    cam.captureFrame(g.lat != null && g.lng != null
      ? { lat: g.lat, lng: g.lng, address: stampAddress(g) }
      : undefined);
    cam.stopCamera(); // photo taken: release the webcam
    setFix(g);
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError("");
    cam.stopCamera();
    try {
      const g = await locate();
      setUploaded(await fileToJpegDataUrl(file, g.lat != null && g.lng != null
        ? { lat: g.lat, lng: g.lng, address: stampAddress(g) }
        : undefined));
      setFix(g);
    } catch (e: any) {
      setError(e?.message ?? "Could not load the photo");
    }
  }

  /** Watermark text: a manually chosen location is labelled on the photo itself. */
  function stampAddress(g: Fix) {
    return manual ? `${task.location_name} [location chosen manually - GPS not verified]` : (g.address ?? task.location_name);
  }

  function switchLocMode(mode: "gps" | "manual_site") {
    if (mode === locMode) return;
    setLocMode(mode);
    // a photo stamped with the other location must be retaken
    if (photo) { cam.clearCapture(); setUploaded(null); setFix(null); cam.startCamera("environment"); }
    setError("");
  }

  function retake() {
    cam.clearCapture(); setUploaded(null); setFix(null); setError("");
    cam.startCamera("environment");
  }

  async function submit() {
    if (!photo) return;
    if (!withinFence) return;
    setSubmitting(true); setError("");
    try {
      // Upload the photo to Supabase Storage (evidence bucket); fall back to the inline image
      let imageUrl = photo;
      try {
        const blob     = await (await fetch(photo)).blob();
        const filename = `cleaned/${workerId ?? "worker"}/${Date.now()}.jpg`;
        const { data: up, error: upErr } = await supabase.storage.from("evidence").upload(filename, blob, { contentType: "image/jpeg" });
        if (upErr) console.warn("[TaskCard] Storage upload failed, using inline image:", upErr.message);
        if (up) imageUrl = supabase.storage.from("evidence").getPublicUrl(filename).data.publicUrl;
      } catch { /* storage bucket may not exist yet — use the inline image */ }

      // Only while the task is still open and assigned to this worker
      let q = supabase.from("dump_reports").update({
        status:            "Pending Verification",
        cleaned_image_url: imageUrl,
        proof_location_source: manual ? "manual_site" : "gps",
        updated_at:        new Date().toISOString(),
      }).eq("id", task.id).in("status", ["Worker Assigned", "Cleaning in Progress"]);
      if (workerId) q = q.eq("assigned_worker_id", workerId);
      const { data, error: updateErr } = await q.select("id");
      if (updateErr) throw updateErr;
      if (!data || data.length === 0) throw new Error("This task is no longer assigned to you (it may have been reassigned or already submitted).");

      // Points/bonus are credited by the admin on verification (not here), so a rejected
      // submission that is re-done can't be rewarded twice.
      cam.stopCamera();
      setSuccess(true);
      setTimeout(() => onComplete(task.id), 1500);
    } catch (err: any) {
      console.error("[TaskCard] Proof upload failed:", err?.message);
      setError(`Upload failed: ${err?.message ?? "Unknown error"}. Please try again.`);
    } finally { setSubmitting(false); }
  }

  if (success) {
    return (
      <div className="glass-card p-5 flex items-center gap-3 animate-fade-in-up">
        <CheckCircle2 className="w-6 h-6 text-eco-400 shrink-0" />
        <p className="text-eco-300 text-sm font-medium">Proof submitted for {task.location_name}! Admin review pending.</p>
      </div>
    );
  }

  const fenceMessage = (() => {
    if (!photo || !hasSite) return null;
    if (manual) return { ok: true, text: "Location set manually to the dump site. GPS was not checked - the admin will see this on the proof." };
    if (fix?.lat == null) return { ok: false, text: "No GPS fix for this photo. Turn on location access, then retake." };
    const acc = Math.round(fix.accuracy ?? 0);
    if (withinFence) return { ok: true, text: `Location verified: ${Math.round(dist!)} m from the site (GPS ±${acc} m).` };
    return {
      ok: false,
      text: acc > GEOFENCE_RADIUS_METERS
        ? `GPS accuracy is only ±${acc} m — too low to confirm you are within ${GEOFENCE_RADIUS_METERS} m of the site (measured ${Math.round(dist!)} m). Use a phone with GPS on, or step outside and retake.`
        : `You are ${Math.round(dist!)} m from the site. Go within ${GEOFENCE_RADIUS_METERS} m of it and retake the photo.`,
    };
  })();

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
        <button onClick={() => (expanded ? closePanel() : openPanel())} className="btn-eco flex-1 justify-center text-xs">
          <Camera className="w-3.5 h-3.5" /> {expanded ? "Close" : "Upload Proof"}
        </button>
      </div>

      {/* Proof Upload Panel */}
      {expanded && (
        <div className="border-t border-white/5 pt-4 space-y-3 animate-fade-in-up">
          {error && (
            <div className="flex items-center gap-2 text-xs text-red-300 bg-red-500/10 p-3 rounded-xl border border-red-500/20">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}
          {cam.error && !photo && (
            <div className="flex items-start gap-2 text-xs text-yellow-300 bg-yellow-500/10 p-3 rounded-xl border border-yellow-500/20">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {camBusy
                  ? "The webcam is being used by another program (on this laptop: the EcoWatch AI camera engine). Tap “Upload Photo” instead, or use your phone."
                  : camDenied
                    ? "Camera permission is blocked. Allow camera access for this site (camera icon in the address bar) and tap Start Camera, or tap “Upload Photo”."
                    : `Camera error: ${cam.error}. You can tap “Upload Photo” instead.`}
              </span>
            </div>
          )}

          {/* Proof location: device GPS (default) or the dump site chosen manually */}
          <div className="grid grid-cols-2 gap-2 text-xs">
            {([["gps", "📍 My current GPS location", "Checked: must be within 50 m of the site"],
               ["manual_site", "🗺️ Dump site location (manual)", "No GPS check · marked as manual for the admin"]] as const).map(([mode, label, hint]) => (
              <button key={mode} onClick={() => switchLocMode(mode)} disabled={locating || submitting}
                      className={cn("rounded-xl border p-2 text-left transition-colors",
                        locMode === mode ? "border-eco-500/50 bg-eco-500/10 text-eco-200" : "border-white/10 text-slate-400 hover:bg-white/5")}>
                <span className="block font-semibold">{label}</span>
                <span className="block text-[10px] opacity-80">{hint}</span>
              </button>
            ))}
          </div>

          <div className="camera-container aspect-video">
            {photo ? (
              <div className="relative w-full h-full">
                <img src={photo} alt="Cleaned area" className="w-full h-full object-cover" />
                <button onClick={retake} className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-white hover:bg-red-600/60" aria-label="Retake photo">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="relative w-full h-full">
                <video ref={cam.videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
                <canvas ref={cam.canvasRef} className="hidden" />
                {!cam.active && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 gap-2">
                    <Camera className="w-10 h-10 text-eco-400" />
                    <p className="text-xs text-slate-300">Starting camera… or upload a photo</p>
                  </div>
                )}
                {locating && (
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-2 bg-black/70 py-2 text-xs text-eco-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Getting an accurate GPS fix (up to 15 s)…
                  </div>
                )}
              </div>
            )}
          </div>

          {fenceMessage && (
            <div className={cn("flex items-start gap-2 text-xs p-3 rounded-xl border",
              fenceMessage.ok ? "text-eco-300 bg-eco-500/10 border-eco-500/20" : "text-orange-300 bg-orange-500/10 border-orange-500/20")}>
              {fenceMessage.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />} {fenceMessage.text}
            </div>
          )}

          {!photo ? (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={capture} disabled={locating} className="btn-eco w-full justify-center disabled:opacity-50">
                {locating
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Locating…</>
                  : cam.active
                    ? <><Camera className="w-4 h-4" /> Capture Photo</>
                    : <><Camera className="w-4 h-4" /> Start Camera</>}
              </button>
              <button onClick={() => fileRef.current?.click()} disabled={locating}
                      className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/15 text-slate-200 text-sm hover:bg-white/5 disabled:opacity-50">
                <ImagePlus className="w-4 h-4" /> Upload Photo
              </button>
              {/* capture="environment" opens the rear camera on phones */}
              <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
                     onChange={(e) => { handleFile(e.target.files?.[0]); e.target.value = ""; }} />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button onClick={retake} disabled={submitting}
                      className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/15 text-slate-200 text-sm hover:bg-white/5">
                <RefreshCw className="w-4 h-4" /> Retake
              </button>
              <button onClick={submit} disabled={submitting || !withinFence} className="btn-eco w-full justify-center disabled:opacity-40">
                {submitting ? <><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</> : <><CheckCircle2 className="w-4 h-4" /> Submit Proof</>}
              </button>
            </div>
          )}
          <p className="text-[10px] text-slate-500 text-center">
            📍 GPS watermark auto-stamped · Geofence: {GEOFENCE_RADIUS_METERS} m radius enforced · Uploaded to Supabase Storage
          </p>
        </div>
      )}
    </div>
  );
}
