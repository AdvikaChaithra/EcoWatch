"use client";
import { useRef, useState } from "react";
import { Camera, MapPin, Loader2, CheckCircle2, AlertCircle, Upload, X, ImagePlus, RefreshCw } from "lucide-react";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";
import { createDumpReport, checkDuplicateReport, updateCitizenEcoPoints, getNearestSectorId } from "@/lib/supabase";
import { TARGET_ACCURACY_M } from "@/lib/geo";
import { useEcoStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const CATEGORIES = ["Illegal Dump Yard","Plastic Waste","Overflowing Bin","Hazardous Debris","Dead Animal","Oil Spill"];
const SEVERITIES = ["Low","Medium","High","Critical"] as const;

/** Downscale an uploaded photo (max 1280 px) so reports stay small. */
async function fileToJpegDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Could not read that image")); i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ReportTool() {
  const user = useEcoStore((s) => s.currentUser);
  const cam = useCamera();
  const geo = useGeolocation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [allowLowAccuracy, setAllowLowAccuracy] = useState(false);

  const photo = cam.capturedImage ?? uploaded;
  const accurate = geo.accuracy != null && geo.accuracy <= TARGET_ACCURACY_M;
  const locationOk = !!geo.lat && (accurate || allowLowAccuracy);
  // "Device in use" / NotReadableError = another program (e.g. the AI camera engine) holds the webcam
  const camBusy = !!cam.error && /in use|not ?readable|could not start/i.test(cam.error);

  const handleCapture = async () => {
    if (!cam.active) { await cam.startCamera("environment"); return; }
    setAllowLowAccuracy(false);
    // Fresh, best-accuracy fix at the moment of capture (stamped onto the photo)
    const fresh = await geo.fetchLocation();
    cam.captureFrame(fresh.lat ? { lat: fresh.lat, lng: fresh.lng!, address: fresh.address ?? undefined } : undefined);
  };

  const handleUpload = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      setUploaded(await fileToJpegDataUrl(file));
      cam.stopCamera();
      setAllowLowAccuracy(false);
      await geo.fetchLocation(); // the report location is where the citizen is now
    } catch (e: any) {
      setError(e?.message ?? "Could not load the photo");
    }
  };

  const clearPhoto = () => { cam.clearCapture(); cam.stopCamera(); setUploaded(null); };

  const handleSubmit = async () => {
    if (!photo || !category || !severity || !geo.lat) {
      setError("Please add a photo, get your location, and fill all fields.");
      return;
    }
    if (!locationOk) {
      setError(`Location accuracy is ±${Math.round(geo.accuracy ?? 0)} m (target ${TARGET_ACCURACY_M} m). Retry GPS or confirm below.`);
      return;
    }
    if (!user) { setError("Please sign in to submit a report."); return; }

    setLoading(true); setError("");
    try {
      const isDuplicate = await checkDuplicateReport(geo.lat, geo.lng!);
      if (isDuplicate) {
        setError("A similar report already exists within 15 m in the last 24 h. Thank you for your civic spirit!");
        setLoading(false);
        return;
      }

      // Upload image to Supabase Storage (falls back to inline image if the bucket is unavailable)
      let imageUrl = photo;
      try {
        const blob = await (await fetch(photo)).blob();
        const filename = `reports/${user.id}/${Date.now()}.jpg`;
        const { supabase } = await import("@/lib/supabase");
        const { data: uploadData, error: upErr } = await supabase.storage.from("evidence").upload(filename, blob, { contentType: "image/jpeg" });
        if (upErr) console.warn("[ReportTool] storage upload failed, using inline image:", upErr.message);
        if (uploadData) imageUrl = supabase.storage.from("evidence").getPublicUrl(filename).data.publicUrl;
      } catch { /* inline image fallback */ }

      await createDumpReport({
        citizen_id: user.id,
        category,
        severity,
        location_name: geo.address ?? `${geo.lat.toFixed(6)}, ${geo.lng?.toFixed(6)}`,
        lat: geo.lat,
        lng: geo.lng!,
        location_accuracy_m: geo.accuracy != null ? Math.round(geo.accuracy) : null,
        reported_image_url: imageUrl,
        sector_id: await getNearestSectorId(geo.lat, geo.lng!),
      });

      try {
        await updateCitizenEcoPoints(user.id, 50);
        setSuccess("Report submitted successfully! You've earned +50 Eco-Points 🌿");
      } catch (pointsErr) {
        console.error("[ReportTool] Eco-Points award failed:", pointsErr);
        setSuccess("Report submitted successfully! (Eco-Points could not be credited right now.)");
      }
      clearPhoto();
    } catch (err: unknown) {
      setError((err as Error).message ?? "Failed to submit report");
    } finally { setLoading(false); }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-display font-bold text-slate-100">Geo-Tagged Waste Report</h2>
        <p className="text-sm text-slate-400 mt-0.5">Take or upload a photo, select the dump type, and submit. Earn +50 Eco-Points per report.</p>
      </div>

      {success ? (
        <div className="glass-card p-10 text-center space-y-4 animate-fade-in-up">
          <CheckCircle2 className="w-16 h-16 text-eco-400 mx-auto" />
          <h3 className="font-display font-bold text-xl text-slate-100">{success}</h3>
          <button className="btn-eco mx-auto" onClick={() => setSuccess("")}>Report Another Dump</button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Photo */}
          <div className="space-y-3">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Photo Evidence</label>
            <div className="camera-container aspect-video">
              {photo ? (
                <div className="relative w-full h-full">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={photo} alt="Dump photo" className="w-full h-full object-cover" />
                  <button onClick={clearPhoto} className="absolute top-2 right-2 p-1.5 rounded-lg bg-black/60 text-white hover:bg-red-600/60" aria-label="Remove photo">
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
                      <p className="text-sm text-slate-300">Start the camera or upload a photo</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {cam.error && (
              <p className="text-xs text-yellow-300 bg-yellow-500/10 p-2 rounded-lg border border-yellow-500/20">
                <AlertCircle className="w-3 h-3 inline mr-1" />
                {camBusy
                  ? "The webcam is being used by another program (on this laptop: the EcoWatch AI camera engine). Use “Upload Photo” instead, or report from your phone."
                  : cam.error}
              </p>
            )}

            {!photo && (
              <div className="grid grid-cols-2 gap-2">
                <button onClick={handleCapture} className="btn-eco w-full justify-center">
                  {cam.active ? <><Camera className="w-4 h-4" /> Capture</> : <><Upload className="w-4 h-4" /> Start Camera</>}
                </button>
                <button onClick={() => fileRef.current?.click()} className="w-full flex items-center justify-center gap-2 rounded-xl border border-white/15 text-slate-200 text-sm hover:bg-white/5">
                  <ImagePlus className="w-4 h-4" /> Upload Photo
                </button>
                {/* capture="environment" opens the rear camera on phones */}
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden"
                       onChange={(e) => { handleUpload(e.target.files?.[0]); e.target.value = ""; }} />
              </div>
            )}
          </div>

          {/* Location + Form */}
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-2">GPS Location</label>
              <div className="glass-card-sm p-3 space-y-2">
                {geo.loading && (
                  <p className="flex items-center gap-2 text-xs text-slate-400">
                    <Loader2 className="w-4 h-4 text-eco-400 animate-spin" /> Getting the most accurate fix (up to 15 s)…
                  </p>
                )}
                {geo.lat && !geo.loading ? (
                  <div className="space-y-1.5">
                    <div className="flex items-start gap-2 text-xs">
                      <MapPin className="w-3.5 h-3.5 text-eco-400 shrink-0 mt-0.5" />
                      <span className="text-slate-300 leading-relaxed">{geo.address}</span>
                    </div>
                    <p className="text-[11px] font-mono text-slate-400">
                      Lat {geo.lat.toFixed(6)} · Lng {geo.lng?.toFixed(6)}
                    </p>
                    <div className="flex items-center gap-2">
                      <span className={cn("badge text-[10px]", accurate
                        ? "bg-eco-500/10 text-eco-300 border-eco-500/30"
                        : "bg-orange-500/10 text-orange-300 border-orange-500/30")}>
                        ±{Math.round(geo.accuracy ?? 0)} m {accurate ? `· within ${TARGET_ACCURACY_M} m` : `· target ${TARGET_ACCURACY_M} m`}
                      </span>
                      <button onClick={() => { setAllowLowAccuracy(false); geo.fetchLocation(); }} className="flex items-center gap-1 text-[11px] text-eco-400 hover:text-eco-300">
                        <RefreshCw className="w-3 h-3" /> Retry GPS
                      </button>
                    </div>
                    {!accurate && (
                      <div className="text-[11px] text-orange-200/80 space-y-1">
                        <p>Laptops without GPS locate by Wi-Fi (often 50-150 m). For &lt;50 m, report from a phone with GPS on, or move near a window and retry.</p>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={allowLowAccuracy} onChange={(e) => setAllowLowAccuracy(e.target.checked)} />
                          Submit with ±{Math.round(geo.accuracy ?? 0)} m accuracy (recorded on the report)
                        </label>
                      </div>
                    )}
                  </div>
                ) : !geo.loading && (
                  <button onClick={geo.fetchLocation} className="flex items-center gap-2 text-xs text-eco-400 hover:text-eco-300">
                    <MapPin className="w-4 h-4" /> Get My Location
                  </button>
                )}
              </div>
              {geo.error && <p className="text-xs text-yellow-300 mt-1">{geo.error}</p>}
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-2">Dump Category</label>
              <select className="select-civic" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Select category...</option>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-2">Severity Level</label>
              <div className="grid grid-cols-4 gap-2">
                {SEVERITIES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSeverity(s)}
                    className={cn(
                      "py-2 rounded-xl text-xs font-semibold border transition-all",
                      severity === s
                        ? s === "Critical" ? "bg-red-500/20 border-red-500/40 text-red-300"
                          : s === "High" ? "bg-orange-500/20 border-orange-500/40 text-orange-300"
                          : s === "Medium" ? "bg-yellow-500/20 border-yellow-500/40 text-yellow-300"
                          : "bg-green-500/20 border-green-500/40 text-green-300"
                        : "border-white/10 text-slate-400 hover:border-white/20"
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-xs text-red-300 bg-red-500/10 p-2.5 rounded-xl border border-red-500/20">
                <AlertCircle className="w-4 h-4 shrink-0" /> {error}
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={loading || !photo || !category || !severity || !locationOk}
              className="btn-eco w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              {loading ? "Submitting Report..." : "Submit Report (+50 Points)"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
