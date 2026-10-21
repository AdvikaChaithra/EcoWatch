"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { HardHat, IdCard, Lock, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useEcoStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export default function WorkerAuthPage() {
  const router = useRouter();
  const { setCurrentUser, isAuthenticated, currentUser } = useEcoStore();
  const [employeeId, setEmployeeId] = useState("EW-WRK-001");
  const [pin,        setPin]        = useState("");
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState("");
  const [success,    setSuccess]    = useState(false);

  useEffect(() => {
    if (isAuthenticated && currentUser?.role === "worker") router.replace("/worker");
  }, [isAuthenticated, currentUser, router]);

  const handleLogin = async () => {
    if (!employeeId || pin.length !== 4) { setError("Enter Employee ID and 4-digit PIN."); return; }
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/auth/worker-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: employeeId, pin }),
      });
      const data = await res.json().catch(() => ({} as any));
      if (!res.ok || !data.success) { setError(data.error || "Invalid credentials."); return; }
      setSuccess(true);
      setCurrentUser({
        id:          data.worker.id,
        role:        "worker",
        name:        data.worker.name,
        phone:       data.worker.phone,
        ward:        data.worker.ward,
        employee_id: data.worker.employee_id,
        eco_points:  data.worker.eco_points,
        tier:        data.worker.tier,
        sector_id:   data.worker.sector_id,
        token:       data.token,
        must_change: !!data.worker.must_change_pin,
      });
      setTimeout(() => router.push("/worker"), 1200);
    } catch (e: any) {
      setError("Login failed: " + e.message);
    } finally { setLoading(false); }
  };

  if (success) return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="glass-card p-10 text-center space-y-4 max-w-sm w-full animate-fade-in-up">
        <CheckCircle2 className="w-16 h-16 text-yellow-400 mx-auto" />
        <h2 className="font-display text-2xl font-bold text-yellow-300">Badge Verified!</h2>
        <p className="text-slate-400 text-sm">Loading your tasks…</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm animate-fade-in-up">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-yellow-500 to-amber-600 flex items-center justify-center mx-auto mb-4 shadow-lg shadow-yellow-500/20">
            <HardHat className="w-8 h-8 text-white" />
          </div>
          <h1 className="font-display text-3xl font-bold text-slate-100">Worker Portal</h1>
          <p className="text-slate-400 text-sm mt-2">Sanitation Worker Badge Authentication</p>
        </div>

        <div className="glass-card p-6 space-y-5">
          {/* Employee ID */}
          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">Employee ID</label>
            <div className="relative">
              <IdCard className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                placeholder="EW-WRK-001"
                value={employeeId}
                onChange={e => setEmployeeId(e.target.value.toUpperCase())}
                className="input-civic pl-9 font-mono"
              />
            </div>
          </div>

          {/* PIN */}
          <div>
            <label className="text-xs text-slate-400 mb-1.5 block">4-Digit PIN</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                placeholder="••••"
                value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="input-civic pl-9 text-center font-mono text-xl tracking-[0.5em]"
                onKeyDown={e => e.key === "Enter" && handleLogin()}
              />
            </div>
            {/* PIN dots display */}
            <div className="flex justify-center gap-4 mt-3">
              {[0,1,2,3].map(i => (
                <div key={i} className={cn(
                  "w-3 h-3 rounded-full border-2 transition-all",
                  pin.length > i ? "bg-yellow-400 border-yellow-400" : "border-slate-600"
                )} />
              ))}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          <button
            onClick={handleLogin}
            disabled={loading || pin.length !== 4}
            className={cn(
              "w-full flex items-center justify-center gap-2 py-3 rounded-xl font-semibold text-sm transition-all",
              "bg-yellow-600 hover:bg-yellow-500 text-white shadow-lg shadow-yellow-500/20 active:scale-95",
              "disabled:opacity-50 disabled:cursor-not-allowed"
            )}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <HardHat className="w-4 h-4" />}
            {loading ? "Verifying Badge…" : "Clock In"}
          </button>

          <p className="text-center text-xs text-slate-500">Demo: <span className="text-yellow-400 font-mono">EW-WRK-001</span> / PIN: <span className="text-yellow-400 font-mono">1234</span></p>
        </div>
      </div>
    </div>
  );
}
