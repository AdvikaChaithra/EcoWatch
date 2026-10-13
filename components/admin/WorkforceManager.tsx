"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { useState, useEffect } from "react";
import { Users, Plus, X, Loader2, CheckCircle2, UserMinus, AlertCircle } from "lucide-react";
import { getWorkers, createWorker, supabase } from "@/lib/supabase";
import { cn, statusColor } from "@/lib/utils";
import { useEcoStore } from "@/lib/store";

interface Worker { id: string; name: string; phone: string; ward: string; employee_id: string; status: string; tasks_completed: number; bonus_accrued: number; eco_points: number; active?: boolean; }
type WorkerStatus = "All" | "On Duty" | "Off Duty";

export function WorkforceManager() {
  const user = useEcoStore((s) => s.currentUser);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [success, setSuccess] = useState("");
  const [form, setForm] = useState({ name: "", phone: "", ward: "", employee_id: "" });
  const [filterStatus, setFilterStatus] = useState<WorkerStatus>("All");
  const [deactivating, setDeactivating] = useState<string | null>(null);
  const [deactivateConfirm, setDeactivateConfirm] = useState<Worker | null>(null);

  useEffect(() => { loadWorkers(); }, []);

  async function loadWorkers() {
    setLoading(true);
    try { const data = await getWorkers(); setWorkers(data ?? []); setError(""); }
    catch (e) { setError(errMsg(e, "Could not load workers.")); } finally { setLoading(false); }
  }

  async function handleDeactivate(worker: Worker) {
    setDeactivating(worker.id);
    try {
      // Mark inactive too, otherwise the worker can still log in (worker-login checks `active`).
      const { error: updErr } = await supabase
        .from("workers")
        .update({ status: "Off Duty", active: false })
        .eq("id", worker.id);
      if (updErr) throw updErr;
      setWorkers((prev) => prev.map((w) => w.id === worker.id ? { ...w, status: "Off Duty", active: false } : w));
      setDeactivateConfirm(null);
    } catch (e) {
      console.error("Deactivate failed", e);
      setError(errMsg(e, "Could not deactivate the worker."));
    } finally {
      setDeactivating(null);
    }
  }

  async function handleCreate() {
    if (!form.name || !form.phone || !form.ward) return;
    setCreating(true);
    try {
      const employee_id = form.employee_id || `EW-WRK-${Date.now().toString(36).slice(-4).toUpperCase()}`;
      await createWorker({
        ...form,
        employee_id,
        admin_id: user?.id ?? "system",
        pin_hash: "1234", // default PIN
      });
      setSuccess(`Worker "${form.name}" created! Default PIN: 1234`);
      setForm({ name: "", phone: "", ward: "", employee_id: "" });
      loadWorkers();
      setTimeout(() => { setShowCreate(false); setSuccess(""); }, 3000);
    } catch (e) {
      setError(errMsg(e, "Could not create the worker (is the employee ID already in use?)."));
    } finally { setCreating(false); }
  }

  const filteredWorkers = filterStatus === "All" ? workers : workers.filter((w) => w.status === filterStatus);

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      {/* Deactivate Confirm Modal */}
      {deactivateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="glass-card p-6 max-w-sm w-full animate-fade-in-up space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
                <AlertCircle className="w-5 h-5 text-red-400" />
              </div>
              <h3 className="font-display font-bold text-slate-100 text-lg">Deactivate Worker</h3>
            </div>
            <p className="text-sm text-slate-400">Set <strong className="text-slate-200">{deactivateConfirm.name}</strong> to Off Duty? They will be unable to receive new tasks until reactivated.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeactivateConfirm(null)} className="flex-1 py-2 rounded-xl border border-white/10 text-slate-400 hover:bg-white/5 text-sm">Cancel</button>
              <button
                onClick={() => handleDeactivate(deactivateConfirm)}
                disabled={deactivating === deactivateConfirm.id}
                className="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-sm flex items-center justify-center gap-2"
              >
                {deactivating === deactivateConfirm.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserMinus className="w-4 h-4" />}
                Deactivate
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Users className="w-5 h-5 text-purple-400" />
          <h2 className="text-xl font-display font-bold text-slate-100">Sanitation Workforce</h2>
          <span className="badge bg-purple-500/10 text-purple-400 border-purple-500/20">{workers.length} workers</span>
        </div>
        <div className="flex items-center gap-2">
          {(["All","On Duty","Off Duty"] as WorkerStatus[]).map((s) => (
            <button key={s} onClick={() => setFilterStatus(s)} className={cn(
              "px-3 py-1.5 rounded-xl text-xs font-medium border transition-all",
              filterStatus === s ? "bg-white/10 text-slate-200 border-white/20" : "text-slate-500 border-transparent hover:border-white/10"
            )}>{s}</button>
          ))}
          <button onClick={() => setShowCreate(true)} className="btn-eco text-xs ml-2">
            <Plus className="w-4 h-4" /> Add Worker
          </button>
        </div>
      </div>

      <div className="glass-card overflow-hidden">
        <table className="civic-table">
          <thead className="bg-civic-900/80">
            <tr>
              <th>Worker</th>
              <th>Employee ID</th>
              <th>Ward</th>
              <th>Status</th>
              <th>Tasks Done</th>
              <th>Bonus Accrued</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredWorkers.map((w) => (
              <tr key={w.id}>
                <td>
                  <div>
                    <p className="font-medium text-slate-200">{w.name}</p>
                    <p className="text-xs text-slate-500">{w.phone}</p>
                  </div>
                </td>
                <td className="font-mono text-xs text-slate-400">{w.employee_id}</td>
                <td className="text-sm">{w.ward}</td>
                <td><span className={cn("badge text-xs", statusColor(w.status))}>{w.status}</span></td>
                <td className="text-center font-semibold text-eco-400">{w.tasks_completed}</td>
                <td className="font-semibold text-green-400">₹{w.bonus_accrued?.toLocaleString() ?? 0}</td>
                <td>
                  <button
                    onClick={() => setDeactivateConfirm(w)}
                    disabled={w.status === "Off Duty" || deactivating === w.id}
                    className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title={w.status === "Off Duty" ? "Already Off Duty" : "Deactivate Worker"}
                  >
                    {deactivating === w.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserMinus className="w-4 h-4" />}
                  </button>
                </td>
              </tr>
            ))}
            {filteredWorkers.length === 0 && (
              <tr><td colSpan={7} className="text-center text-slate-500 py-8">
                {workers.length === 0 ? "No workers registered yet" : `No workers with status "${filterStatus}"`}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-md glass-card p-6 animate-fade-in-up">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-display font-bold text-lg text-slate-100">Onboard New Worker</h3>
              <button onClick={() => { setShowCreate(false); setSuccess(""); }} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400"><X className="w-5 h-5" /></button>
            </div>

            {success ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <CheckCircle2 className="w-12 h-12 text-eco-400" />
                <p className="text-eco-300 font-semibold">{success}</p>
              </div>
            ) : (
              <div className="space-y-3">
                {[
                  { key: "name",        label: "Full Name",    placeholder: "Ravi Kumar"       },
                  { key: "phone",       label: "Phone Number", placeholder: "+91 9876543210"   },
                  { key: "ward",        label: "Assigned Ward",placeholder: "Ward 12"          },
                  { key: "employee_id", label: "Employee ID",  placeholder: "EW-WRK-001 (auto)" },
                ].map(({ key, label, placeholder }) => (
                  <div key={key}>
                    <label className="text-xs text-slate-400 mb-1 block">{label}</label>
                    <input
                      className="input-civic"
                      placeholder={placeholder}
                      value={(form as Record<string, string>)[key]}
                      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    />
                  </div>
                ))}
                <p className="text-xs text-slate-500">Default PIN <strong className="text-slate-400">1234</strong> will be set. Worker must change on first login.</p>
                <button onClick={handleCreate} disabled={creating || !form.name || !form.phone} className="btn-eco w-full justify-center mt-2">
                  {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  {creating ? "Creating..." : "Create Worker Account"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
