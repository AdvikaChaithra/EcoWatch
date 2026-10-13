"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Camera, User, Phone, Mail, MapPin, CreditCard,
  Loader2, CheckCircle2, AlertCircle, UserCheck, X, Lock, Scan
} from "lucide-react";
import { useEcoStore } from "@/lib/store";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

type Tab = "login" | "register";
type LoginMethod = "email" | "face";

export default function CitizenAuthPage() {
  const router = useRouter();
  const { setCurrentUser, isAuthenticated, currentUser } = useEcoStore();
  const [tab, setTab] = useState<Tab>("login");

  // Redirect if already logged in as citizen
  useEffect(() => {
    if (isAuthenticated && currentUser?.role === "citizen") {
      router.replace("/citizen");
    }
  }, [isAuthenticated, currentUser, router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-eco-600 to-teal-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-eco-500/20">
            <UserCheck className="w-8 h-8 text-white" />
          </div>
          <h1 className="font-display text-3xl font-bold text-slate-100">Citizen Portal</h1>
          <p className="text-slate-400 text-sm mt-2">Access your EcoWatch dashboard</p>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 p-1 bg-civic-900/60 rounded-2xl border border-white/8 mb-6">
          {(["login", "register"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 py-2.5 rounded-xl text-sm font-medium transition-all",
                tab === t
                  ? "bg-eco-600/20 text-eco-300 border border-eco-500/30"
                  : "text-slate-400 hover:text-slate-200"
              )}
            >
              {t === "login" ? "🪪 Login" : "✍️ Register"}
            </button>
          ))}
        </div>

        {tab === "login"    ? <LoginForm    setCurrentUser={setCurrentUser} router={router} /> : null}
        {tab === "register" ? <RegisterForm  setCurrentUser={setCurrentUser} router={router} /> : null}
      </div>
    </div>
  );
}

/* ─────────────────────── Login (Email or Face) ───────────────────────── */
function LoginForm({ setCurrentUser, router }: { setCurrentUser: (u: any) => void; router: any }) {
  const [method, setMethod] = useState<LoginMethod>("email");

  return (
    <div className="space-y-4 animate-fade-in-up">
      {/* Method toggle */}
      <div className="flex gap-1 p-1 bg-civic-900/40 rounded-xl border border-white/5">
        <button
          onClick={() => setMethod("email")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all",
            method === "email"
              ? "bg-white/10 text-slate-100 shadow"
              : "text-slate-500 hover:text-slate-300"
          )}
        >
          <Mail className="w-4 h-4" /> Email & Phone
        </button>
        <button
          onClick={() => setMethod("face")}
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-all",
            method === "face"
              ? "bg-white/10 text-slate-100 shadow"
              : "text-slate-500 hover:text-slate-300"
          )}
        >
          <Scan className="w-4 h-4" /> Face ID
        </button>
      </div>

      {method === "email" ? (
        <EmailLoginForm setCurrentUser={setCurrentUser} router={router} />
      ) : (
        <FaceLoginForm setCurrentUser={setCurrentUser} router={router} />
      )}
    </div>
  );
}

/* ─────────────────────── Email + Phone Login ───────────────────────── */
function EmailLoginForm({ setCurrentUser, router }: { setCurrentUser: (u: any) => void; router: any }) {
  const [email, setEmail]   = useState("");
  const [phone, setPhone]   = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");
  const [matched, setMatched] = useState<{ name: string } | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!email.trim() || !phone.trim()) {
      setError("Both Email and Phone are required.");
      return;
    }
    setLoading(true);
    try {
      // Query citizens matching both email AND phone
      const { data, error: dbErr } = await supabase
        .from("citizens")
        .select("id,name,phone,email,ward,eco_points,tier")
        .eq("email", email.trim().toLowerCase())
        .eq("phone", phone.trim())
        .single();

      if (dbErr || !data) {
        setError("No account found with this email and phone combination. Check your details or register first.");
        return;
      }

      setMatched({ name: data.name });
      setCurrentUser({
        id:         data.id,
        role:       "citizen",
        name:       data.name,
        email:      data.email,
        phone:      data.phone,
        ward:       data.ward,
        eco_points: data.eco_points,
        tier:       data.tier,
      });
      setTimeout(() => router.push("/citizen"), 1200);
    } catch (e: any) {
      setError("Login failed: " + (e.message ?? "Unknown error"));
    } finally {
      setLoading(false);
    }
  };

  if (matched) return (
    <div className="glass-card p-8 text-center space-y-4">
      <CheckCircle2 className="w-16 h-16 text-eco-400 mx-auto" />
      <h2 className="font-display text-2xl font-bold text-eco-300">Welcome, {matched.name}!</h2>
      <p className="text-slate-400 text-sm">Redirecting to your dashboard…</p>
    </div>
  );

  return (
    <form onSubmit={handleLogin} className="glass-card p-6 space-y-4">
      <div>
        <p className="text-sm text-slate-400 mb-4">
          Login using your registered <span className="text-eco-400 font-medium">email address</span> and{" "}
          <span className="text-eco-400 font-medium">phone number</span>.
        </p>
      </div>

      {/* Email */}
      <div className="relative">
        <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          type="email"
          placeholder="Email Address *"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input-civic pl-9"
          autoComplete="email"
          required
        />
      </div>

      {/* Phone (acts as password — matches registered phone) */}
      <div className="relative">
        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
        <input
          type="tel"
          placeholder="Registered Phone (+91XXXXXXXXXX) *"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="input-civic pl-9"
          autoComplete="tel"
          required
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !email || !phone}
        className="btn-eco w-full justify-center"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
        {loading ? "Verifying…" : "Login"}
      </button>

      <p className="text-center text-xs text-slate-500">
        Your phone number is matched against our records — no password needed.
      </p>
    </form>
  );
}

/* ─────────────────────── Face Login ───────────────────────── */
function FaceLoginForm({ setCurrentUser, router }: { setCurrentUser: (u: any) => void; router: any }) {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const [camOn,     setCamOn]     = useState(false);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState("");
  const [captured,  setCaptured]  = useState<string | null>(null);
  const [matched,   setMatched]   = useState<{ name: string; id: string } | null>(null);

  const startCam = useCallback(async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setCamOn(true);
    } catch (e: any) { setError("Camera access denied: " + e.message); }
  }, []);

  const stopCam = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamOn(false);
    setCaptured(null);
  }, []);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  const capture = () => {
    const v = videoRef.current; const c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    setCaptured(c.toDataURL("image/jpeg", 0.9));
  };

  const handleLogin = async () => {
    if (!captured) { setError("Please capture a face snapshot first."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/auth/face-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: captured }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data.success) {
        setError(data.error || "Face not recognized. Please register first.");
        return;
      }
      setMatched({ name: data.citizen.name, id: data.citizen.id });
      setCurrentUser({
        id:         data.citizen.id,
        role:       "citizen",
        name:       data.citizen.name,
        phone:      data.citizen.phone,
        ward:       data.citizen.ward,
        eco_points: data.citizen.eco_points,
        tier:       data.citizen.tier,
      });
      stopCam();
      setTimeout(() => router.push("/citizen"), 1200);
    } catch (e: any) {
      setError("Login failed: " + e.message);
    } finally { setLoading(false); }
  };

  if (matched) return (
    <div className="glass-card p-8 text-center space-y-4">
      <CheckCircle2 className="w-16 h-16 text-eco-400 mx-auto" />
      <h2 className="font-display text-2xl font-bold text-eco-300">Welcome, {matched.name}!</h2>
      <p className="text-slate-400 text-sm">Redirecting to your dashboard…</p>
    </div>
  );

  return (
    <div className="glass-card p-6 space-y-5">
      <p className="text-sm text-slate-400">
        Position your face in the frame and capture a photo to authenticate via{" "}
        <span className="text-eco-400 font-medium">ArcFace biometrics</span>.{" "}
        <span className="text-yellow-400">Requires the AI backend to be running.</span>
      </p>

      <div className="relative aspect-video bg-black rounded-xl overflow-hidden border border-white/10">
        <video ref={videoRef} autoPlay muted playsInline className={cn("w-full h-full object-cover", !camOn && "hidden")} />
        {captured && <img src={captured} alt="" className="absolute inset-0 w-full h-full object-cover" />}
        {!camOn && !captured && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-500">
            <Scan className="w-12 h-12" />
            <p className="text-sm">Camera not started</p>
          </div>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="flex gap-3">
        {!camOn && !captured && (
          <button onClick={startCam} className="btn-eco flex-1 justify-center">
            <Camera className="w-4 h-4" /> Open Camera
          </button>
        )}
        {camOn && !captured && (
          <button onClick={capture} className="btn-eco flex-1 justify-center">
            📸 Capture Face
          </button>
        )}
        {captured && (
          <>
            <button onClick={() => { setCaptured(null); if (!camOn) startCam(); }} className="btn-eco-outline flex-1 justify-center">
              <X className="w-4 h-4" /> Retake
            </button>
            <button onClick={handleLogin} disabled={loading} className="btn-eco flex-1 justify-center">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
              {loading ? "Matching…" : "Login with Face ID"}
            </button>
          </>
        )}
      </div>
      <p className="text-center text-xs text-slate-500">
        512-D ArcFace embedding · Cosine similarity ≥ 0.70 · pgvector
      </p>
    </div>
  );
}

/* ─────────────────────── Registration ─────────────────────── */
function RegisterForm({ setCurrentUser, router }: { setCurrentUser: (u: any) => void; router: any }) {
  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [camOn,    setCamOn]   = useState(false);
  const [captured, setCaptured]= useState<string | null>(null);
  const [loading,  setLoading] = useState(false);
  const [error,    setError]   = useState("");
  const [success,  setSuccess] = useState(false);
  const [showFace, setShowFace]= useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "", ward: "", gov_id: "" });

  const startCam = useCallback(async () => {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: "user" } });
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      setCamOn(true);
    } catch (e: any) { setError("Camera denied: " + e.message); }
  }, []);

  useEffect(() => () => { streamRef.current?.getTracks().forEach(t => t.stop()); }, []);

  const capture = () => {
    const v = videoRef.current; const c = canvasRef.current;
    if (!v || !c) return;
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    setCaptured(c.toDataURL("image/jpeg", 0.9));
    streamRef.current?.getTracks().forEach(t => t.stop());
    setCamOn(false);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.phone) { setError("Name and phone are required."); return; }
    if (!form.email) { setError("Email is required to enable login."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/auth/register-face", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, imageBase64: captured ?? null }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data.success) { setError(data.error || "Registration failed."); return; }
      setSuccess(true);
      setCurrentUser({
        id:         data.citizen.id,
        role:       "citizen",
        name:       data.citizen.name,
        email:      data.citizen.email ?? form.email,
        phone:      data.citizen.phone,
        ward:       form.ward,
        eco_points: 0,
        tier:       "Bronze",
      });
      setTimeout(() => router.push("/citizen"), 1500);
    } catch (e: any) {
      setError("Registration failed: " + e.message);
    } finally { setLoading(false); }
  };

  if (success) return (
    <div className="glass-card p-8 text-center space-y-4 animate-fade-in-up">
      <CheckCircle2 className="w-16 h-16 text-eco-400 mx-auto" />
      <h2 className="font-display text-2xl font-bold text-eco-300">Registered!</h2>
      <p className="text-slate-400 text-sm">Your account has been created. Redirecting…</p>
    </div>
  );

  return (
    <form onSubmit={handleRegister} className="glass-card p-6 space-y-4 animate-fade-in-up">
      {/* Form fields */}
      <div className="grid gap-3">
        {[
          { key: "name",    icon: User,       placeholder: "Full Name *",            type: "text",  required: true  },
          { key: "phone",   icon: Phone,      placeholder: "Phone (+91XXXXXXXXXX) *", type: "tel",   required: true  },
          { key: "email",   icon: Mail,       placeholder: "Email Address *",        type: "email", required: true  },
          { key: "address", icon: MapPin,     placeholder: "Residential Address",    type: "text",  required: false },
          { key: "ward",    icon: MapPin,     placeholder: "Ward / Area",            type: "text",  required: false },
          { key: "gov_id",  icon: CreditCard, placeholder: "Aadhar / Govt ID",       type: "text",  required: false },
        ].map(({ key, icon: Icon, placeholder, type, required }) => (
          <div key={key} className="relative">
            <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type={type}
              placeholder={placeholder}
              value={(form as any)[key]}
              onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
              className="input-civic pl-9"
              required={required}
            />
          </div>
        ))}
      </div>

      {/* Optional Face Enrollment */}
      <div className="border border-white/8 rounded-xl p-4 space-y-3 bg-white/2">
        <button
          type="button"
          onClick={() => setShowFace(v => !v)}
          className="flex items-center gap-2 text-sm text-slate-400 hover:text-slate-200 transition-colors w-full text-left"
        >
          <Scan className="w-4 h-4 text-eco-400 shrink-0" />
          <span>
            <strong className="text-slate-300">Optional:</strong> Enroll Face for biometric login
          </span>
          <span className="ml-auto text-xs text-slate-500">{showFace ? "▲ Hide" : "▼ Show"}</span>
        </button>

        {showFace && (
          <div className="space-y-3">
            <div className="relative aspect-video bg-black rounded-xl overflow-hidden border border-white/10">
              <video ref={videoRef} autoPlay muted playsInline className={cn("w-full h-full object-cover", !camOn && "hidden")} />
              {captured && <img src={captured} alt="" className="absolute inset-0 w-full h-full object-cover" />}
              {!camOn && !captured && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-slate-500">
                  <Camera className="w-10 h-10" />
                  <p className="text-xs">Face photo for biometric enrollment</p>
                </div>
              )}
              <canvas ref={canvasRef} className="hidden" />
            </div>
            <div className="flex gap-2">
              {!camOn && !captured && (
                <button type="button" onClick={startCam} className="btn-eco-outline flex-1 justify-center text-xs">
                  <Camera className="w-3.5 h-3.5" /> Enroll Face
                </button>
              )}
              {camOn && (
                <button type="button" onClick={capture} className="btn-eco flex-1 justify-center text-xs">
                  📸 Capture
                </button>
              )}
              {captured && (
                <button
                  type="button"
                  onClick={() => { setCaptured(null); startCam(); }}
                  className="btn-eco-outline flex-1 justify-center text-xs"
                >
                  <X className="w-3.5 h-3.5" /> Retake
                </button>
              )}
              {captured && (
                <span className="flex items-center gap-1 text-eco-400 text-xs">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Captured
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">Skipping face enrollment is fine — you can still login with email + phone.</p>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <button
        type="submit"
        disabled={loading || !form.name || !form.phone || !form.email}
        className="btn-eco w-full justify-center"
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserCheck className="w-4 h-4" />}
        {loading ? "Creating Account…" : "Register Citizen Account"}
      </button>

      <p className="text-center text-xs text-slate-500">
        Name, phone & email are required · Face enrollment is optional
      </p>
    </form>
  );
}
