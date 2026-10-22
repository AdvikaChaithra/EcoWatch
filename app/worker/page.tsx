"use client";
import { useState, useEffect } from "react";
import { HardHat, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { updateWorkerStatus } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { ShiftToggle } from "@/components/worker/ShiftToggle";
import { TaskCard, type Task } from "@/components/worker/TaskCard";
import { WorkerProfile } from "@/components/worker/WorkerProfile";
import { WorkHistory } from "@/components/worker/WorkHistory";
import { cn } from "@/lib/utils";

export default function WorkerDashboard() {
  const user = useEcoStore((s) => s.currentUser);
  const [onDuty,    setOnDuty]    = useState(false);
  const [tasks,     setTasks]     = useState<Task[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [toggling,  setToggling]  = useState(false);
  const [worker,    setWorker]    = useState<{ name: string; ward: string; eco_points: number; bonus_accrued: number; tasks_completed: number } | null>(null);
  const [activeTab, setActiveTab] = useState<"tasks" | "history" | "profile">("tasks");

  useEffect(() => {
    if (user?.id) {
      loadAll();
    } else {
      // No authenticated user — stop loading immediately so the auth prompt shows
      setLoading(false);
    }
  }, [user]); // eslint-disable-line

  // Live: the admin's approval (bonus / points / tasks done) and new task assignments appear
  // without reloading the page.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase.channel(`worker:${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "dump_reports", filter: `assigned_worker_id=eq.${user.id}` },
          () => loadAll(false))
      .subscribe();
    // An approval updates the task row (dump_reports), which triggers the reload above. The worker
    // row itself is not broadcast (it holds the PIN hash), so also refresh every 30 s.
    const t = setInterval(() => loadAll(false), 30_000);
    return () => { supabase.removeChannel(ch); clearInterval(t); };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll(spinner = true) {
    if (spinner) setLoading(true);
    try {
      const [wRes, rRes] = await Promise.all([
        user?.id
          ? supabase
              .from("workers")
              .select("id,name,ward,status,tasks_completed,eco_points,bonus_accrued")
              .eq("id", user.id)
              .single()
          : Promise.resolve({ data: null }),
        // Only fetch tasks assigned to THIS worker
        user?.id
          ? supabase
              .from("dump_reports")
              .select("id,category,severity,location_name,lat,lng,status,created_at,reported_image_url")
              .in("status", ["Worker Assigned", "Cleaning in Progress"])
              .eq("assigned_worker_id", user.id)
          : Promise.resolve({ data: [] }),
      ]);
      if (wRes.data) {
        setWorker(wRes.data);
        setOnDuty(wRes.data.status === "On Duty");
      }
      setTasks(rRes.data ?? []);
    } catch {} finally { setLoading(false); }
  }

  async function handleShiftToggle() {
    if (!user?.id) return;
    setToggling(true);
    const newStatus = onDuty ? "Off Duty" : "On Duty";
    try {
      await updateWorkerStatus(user.id, newStatus);
      setOnDuty(!onDuty);
    } catch (e: any) {
      alert(`Could not change shift status: ${e?.message ?? "database error"}. Please try again.`);
    } finally { setToggling(false); }
  }

  if (loading) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 text-yellow-400 animate-spin" /></div>;
  if (!user) return (
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <HardHat className="w-14 h-14 text-yellow-400/40" />
      <h2 className="font-display text-2xl font-bold text-slate-300">Worker Login Required</h2>
      <p className="text-slate-500 text-sm">Please sign in with your Employee ID and PIN to access your dashboard.</p>
      <a href="/" className="btn-eco mt-2">← Back to Home</a>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* Shift Header */}
      <div className="glass-card p-6 flex flex-col sm:flex-row items-center gap-6">
        <ShiftToggle onDuty={onDuty} onToggle={handleShiftToggle} loading={toggling} />
        <div className="flex-1">
          <h1 className="font-display text-2xl font-bold text-slate-100">{user?.name ?? worker?.name ?? "Worker"}</h1>
          <p className="text-slate-400 text-sm mt-1">Ward: {user?.ward ?? worker?.ward ?? "—"} · EcoWatch Sanitation</p>
          <div className="flex flex-wrap gap-3 mt-3">
            <div className="glass-card-sm px-3 py-2 text-center">
              <p className="text-xs text-slate-400">Tasks Done</p>
              <p className="font-display font-bold text-eco-400">{worker?.tasks_completed ?? 0}</p>
            </div>
            <div className="glass-card-sm px-3 py-2 text-center">
              <p className="text-xs text-slate-400">Bonus</p>
              <p className="font-display font-bold text-green-400">₹{Number(worker?.bonus_accrued ?? 0).toLocaleString("en-IN")}</p>
            </div>
            <div className="glass-card-sm px-3 py-2 text-center">
              <p className="text-xs text-slate-400">Eco-Pts</p>
              <p className="font-display font-bold text-yellow-400">{worker?.eco_points ?? 0}</p>
            </div>
            <div className={cn("badge self-center", onDuty ? "bg-eco-500/10 text-eco-400 border-eco-500/20" : "bg-slate-500/10 text-slate-400 border-slate-500/20")}>
              {onDuty ? "🟢 On Duty" : "🔴 Off Duty"}
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-civic-900/60 rounded-2xl border border-white/8">
        {(["tasks", "history", "profile"] as const).map((t) => (
          <button key={t} onClick={() => setActiveTab(t)} className={cn(
            "flex-1 py-2.5 rounded-xl text-sm font-medium transition-all",
            activeTab === t ? "bg-yellow-600/15 text-yellow-300 border border-yellow-500/20" : "text-slate-400 hover:text-slate-200"
          )}>
            {t === "tasks" ? `🧹 My Tasks (${tasks.length})` : t === "history" ? "📜 Work History" : "👷 Profile & Rewards"}
          </button>
        ))}
      </div>

      {/* Task Queue */}
      {activeTab === "tasks" && (
        <div className="space-y-4">
          {!onDuty && (
            <div className="glass-card p-6 text-center">
              <HardHat className="w-10 h-10 text-slate-600 mx-auto mb-2" />
              <p className="text-slate-400">Start your shift to see assigned tasks</p>
            </div>
          )}
          {onDuty && tasks.length === 0 && (
            <div className="glass-card p-10 text-center">
              <p className="text-slate-400">No tasks assigned yet. Well done! 🌿</p>
            </div>
          )}
          {onDuty && tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              workerId={user?.id}
              onComplete={(id) => setTasks((t) => t.filter((x) => x.id !== id))}
            />
          ))}
        </div>
      )}

      {/* Profile & Rewards */}
      {activeTab === "history" && user?.id && (
        <WorkHistory workerId={user.id} />
      )}

      {activeTab === "profile" && user?.id && (
        <WorkerProfile workerId={user.id} />
      )}
    </div>
  );
}
