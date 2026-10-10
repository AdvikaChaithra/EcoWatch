"use client";
import { useState } from "react";
import { Camera, MapPin, Loader2, CheckCircle2, AlertCircle, Upload, X } from "lucide-react";
import { useCamera } from "@/hooks/useCamera";
import { useGeolocation } from "@/hooks/useGeolocation";
import { createDumpReport, checkDuplicateReport, updateCitizenEcoPoints } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const CATEGORIES = ["Illegal Dump Yard","Plastic Waste","Overflowing Bin","Hazardous Debris","Dead Animal","Oil Spill"];
const SEVERITIES = ["Low","Medium","High","Critical"] as const;

export function ReportTool() {
  const user = useEcoStore((s) => s.currentUser);
  const cam = useCamera();
  const geo = useGeolocation();
  const [category, setCategory] = useState("");
  const [severity, setSeverity] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [pointsEarned, setPointsEarned] = useState(false);

  const handleCapture = async () => {
    if (!cam.active) { await cam.startCamera("environment"); return; }
    // Fetch exact fresh location at the exact moment of capture
    const freshGeo = await geo.fetchLocation();
    cam.captureFrame(freshGeo.lat ? { lat: freshGeo.lat, lng: freshGeo.lng!, address: freshGeo.address ?? undefined } : undefined);
  };

  const handleSubmit = async () => {
    if (!cam.capturedImage || !category || !severity || !geo.lat) {
      setError("Please capture a photo, set location, and fill all fields.");
      return;
    }
    if (!user) { setError("Please sign in to submit a report."); return; }

    setLoading(true); setError("");
    try {
      // Anti-spam: check proximity
      const isDuplicate = await checkDuplicateReport(geo.lat, geo.lng!);
      if (isDuplicate) {
        setError("A similar report exists within 15m. Thank you for your civic spirit!");
        setLoading(false);
        return;
      }

      // Upload image to Supabase Storage
      let imageUrl = cam.capturedImage;
      try {
        const blob = await (await fetch(cam.capturedImage)).blob();
        const filename = `reports/${user.id}/${Date.now()}.jpg`;
        const { data: uploadData } = await import("@/lib/supabase").then((m) =>
          m.supabase.storage.from("evidence").upload(filename, blob, { contentType: "image/jpeg" })
        );
        if (uploadData) {
          const { data: { publicUrl } } = await import("@/lib/supabase").then((m) =>
            m.supabase.storage.from("evidence").getPublicUrl(filename)
          );
          imageUrl = publicUrl;
        }
      } catch { /* Storage unavailable — use base64 */ }

      await createDumpReport({
        citizen_id: user.id,
        category,
        severity,
        location_name: geo.address ?? `${geo.lat?.toFixed(4)}, ${geo.lng?.toFixed(4)}`,
        lat: geo.lat!,
        lng: geo.lng!,
        reported_image_url: imageUrl,
      });

      // Award Eco-Points
      await updateCitizenEcoPoints(user.id, 50);
      setPointsEarned(true);
      setSuccess("Report submitted successfully! You've earned +50 Eco-Points 🌿");
      cam.clearCapture();
      cam.stopCamera();
    } catch (err: unknown) {
      setError((err as Error).message ?? "Failed to submit report");
    } finally { setLoading(false); }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h2 className="text-xl font-display font-bold text-slate-100">Geo-Tagged Waste Report</h2>
        <p className="text-sm text-slate-400 mt-0.5">Capture a photo, select the dump type, and submit. Earn +50 Eco-Points per report.</p>
      </div>

      {success ? (
        <div className="glass-card p-10 text-center space-y-4 animate-fade-in-up">
          <CheckCircle2 className="w-16 h-16 text-eco-400 mx-auto" />
          <h3 className="font-display font-bold text-xl text-slate-100">{success}</h3>
          <div className="badge bg-yellow-500/10 text-yellow-300 border-yellow-500/20 text-sm mx-auto">
            +50 Eco-Points credited!
          </div>
          <button className="btn-eco mx-auto" onClick={() => { setSuccess(""); setPointsEarned(false); }}>
            Report Another Dump
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Camera Section */}
          <div className="space-y-3">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Photo Evidence</label>
            <div className="camera-container aspect-video">
              {cam.capturedImage ? (
                <div className="relative w-full h-full">
                  <img src={cam.capturedImage} alt="Captured" className="w-full h-full object-cover" />
                  <button
                    onClick={() => { cam.clearCapture(); cam.stopCamera(); }}
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
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 gap-2">
                      <Camera className="w-10 h-10 text-eco-400" />
                      <p className="text-sm text-slate-300">Tap to activate camera</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {cam.error && (
              <p className="text-xs text-yellow-300 bg-yellow-500/10 p-2 rounded-lg border border-yellow-500/20">
                <AlertCircle className="w-3 h-3 inline mr-1" />{cam.error}
              </p>
            )}

            <button onClick={handleCapture} className={cn("btn-eco w-full justify-center", cam.capturedImage && "opacity-0 pointer-events-none")}>
              {cam.active ? <><Camera className="w-4 h-4" /> Capture Photo</> : <><Upload className="w-4 h-4" /> Start Camera</>}
            </button>
          </div>

          {/* Location + Form */}
          <div className="space-y-4">
            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider block mb-2">GPS Location</label>
              <div className="glass-card-sm p-3">
                {geo.loading && <Loader2 className="w-4 h-4 text-eco-400 animate-spin" />}
                {geo.lat ? (
                  <div className="space-y-1">
                    <div className="flex items-start gap-2 text-xs">
                      <MapPin className="w-3.5 h-3.5 text-eco-400 shrink-0 mt-0.5" />
                      <span className="text-slate-300 leading-relaxed">{geo.address}</span>
                    </div>
                    <p className="text-[10px] font-mono text-slate-500 mt-1">
                      {geo.lat.toFixed(6)}, {geo.lng?.toFixed(6)} · ±{geo.accuracy?.toFixed(0)}m
                    </p>
                  </div>
                ) : (
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
              disabled={loading || !cam.capturedImage || !category || !severity || !geo.lat}
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
