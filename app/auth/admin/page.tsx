"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Shield, Mail, Lock, Loader2, CheckCircle2, AlertCircle, Eye, EyeOff } from "lucide-react";
import { useEcoStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export default function AdminAuthPage() {
  const router = useRouter();
  const { setCurrentUser, isAuthenticated, currentUser } = useEcoStore();
  const [form, setForm] = useState({ email: "", password: "" });
  const [loading, setLoading]   = useState(false);
  const [error,   setError]     = useState("");
  const [success, setSuccess]   = useState(false);
  const [showPwd, setShowPwd]   = useState(false);

  useEffect(() => {
    if (isAuthenticated && currentUser?.role === "admin") router.replace("/admin");
    if (isAuthenticated && currentUser?.role === "super_admin") router.replace("/super");
  }, [isAuthenticated, currentUser, router]);

  const handleLogin = async () => {
    if (!form.email || !form.password) { setError("Email and password are required."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/auth/admin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data.success) { setError(data.error || "Invalid credentials."); return; }
      setSuccess(true);
      const isSuper = data.admin.role === "super_admin";
      setCurrentUser({
        id:          data.admin.id,
        role:        isSuper ? "super_admin" : "admin",
        name:        data.admin.name,
        email:       data.admin.email,
        ward:        data.admin.ward_jurisdiction,
        designation: data.admin.designation,
        token:       data.token,
        must_change: !!data.admin.must_change_password,
      });
      setTimeout(() => router.push(isSuper ? "/super" : "/admin"), 1200);
    } catch (e: any) {
      setError("Login failed: " + e.message);
    } finally { setLoading(false); }
  };

  if (success) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="glass-card p-10 text-center space-y-4 max-w-sm w-full animate-fade-in-up">
        <CheckCircle2 className="w-16 h-16 text-blue-400 mx-auto" />
        <h2 className="font-display text-2xl font-bold text-blue-300">Access Granted</h2>
        <p className="text-slate-400 text-sm">Redirecting to Admin Console…</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md animate-fade-in-up">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-blue-500/20">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="font-display text-3xl font-bold text-slate-100">Admin Console</h1>
          <p className="text-slate-400 text-sm mt-2">Municipal Officer Authentication</p>
        </div>

        <div className="glass-card p-6 space-y-4">
          {/* Email */}
          <div className="relative">
            <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="email"
              placeholder="Officer Email (e.g. admin@bbmp.gov.in)"
              value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
              className="input-civic pl-9"
              onKeyDown={e => e.key === "Enter" && handleLogin()}
            />
          </div>

          {/* Password */}
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type={showPwd ? "text" : "password"}
              placeholder="Password (admin123 for demo)"
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              className="input-civic pl-9 pr-9"
              onKeyDown={e => e.key === "Enter" && handleLogin()}
            />
            <button onClick={() => setShowPwd(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">
              {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          <button onClick={handleLogin} disabled={loading} className={cn(
            "w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all",
            "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20 active:scale-95"
          )}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
            {loading ? "Authenticating…" : "Access Admin Console"}
          </button>

          <div className="pt-2 border-t border-white/8 text-center text-xs text-slate-500 space-y-1">
            <p>Demo: <span className="text-blue-400 font-mono">admin@bbmp.gov.in</span> / <span className="text-blue-400 font-mono">admin123</span></p>
            <p className="text-amber-300/80">Municipal Commissioner (Super Admin) signs in here too and is taken to the Super Admin portal.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
