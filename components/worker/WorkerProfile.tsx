"use client";
import { useEffect, useState } from "react";
import { Loader2, Star, Package, User, BadgeCheck, Phone, MapPin } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn , tierFor } from "@/lib/utils";

interface WorkerData {
  id: string; name: string; phone: string; ward: string; employee_id: string;
  tasks_completed: number; bonus_accrued: number; eco_points: number; tier: string;
  status: string; admin_id?: string;
  admins?: { name: string; email: string; designation: string } | null;
}

interface Reward { id: string; title: string; points_cost: number; category: string; }

interface Props { workerId: string; }

const TIER_COLORS: Record<string, string> = {
  Bronze:        "text-orange-400 border-orange-500/30 bg-orange-500/10",
  Silver:        "text-slate-300  border-slate-400/30  bg-slate-400/10",
  Gold:          "text-yellow-400 border-yellow-500/30 bg-yellow-500/10",
  "Eco-Champion": "text-eco-400   border-eco-500/30    bg-eco-500/10",
};

const TIER_NEXT_PTS: Record<string, number> = {
  Bronze: 500, Silver: 2000, Gold: 5000, "Eco-Champion": 5000,
};

export function WorkerProfile({ workerId }: Props) {
  const [worker,  setWorker]  = useState<WorkerData | null>(null);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState<string | null>(null);

  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (workerId) loadAll(); else setLoading(false);
  }, [workerId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll() {
    setLoading(true);
    try {
      const [wRes, rRes] = await Promise.all([
        // JOIN admins table to get supervisor name (may be null if schema not yet applied)
        supabase
          .from("workers")
          // explicit columns: never send pin_hash (credential) to the browser
          .select("id,name,phone,ward,employee_id,tasks_completed,bonus_accrued,eco_points,tier,status,admin_id,admins(name, email, designation)")
          .eq("id", workerId)
          .maybeSingle(),
        // target_role is the actual column name in rewards table
        supabase.from("rewards").select("id,title,points_cost,category").eq("target_role", "worker"),
      ]);
      if (wRes.error) throw wRes.error;
      if (rRes.error) console.warn("[WorkerProfile] rewards unavailable:", rRes.error.message);
      if (wRes.data) setWorker(wRes.data as unknown as WorkerData);
      setLoadError("");
      // Fall back to empty array if rewards table not seeded yet
      setRewards(rRes.data ?? []);
    } catch (e: any) {
      console.warn('[WorkerProfile] DB query failed:', e?.message);
      setLoadError(`Could not load your profile (${e?.message ?? "database error"}).`);
    } finally { setLoading(false); }
  }

  async function handleRedeem(reward: Reward) {
    if (!worker || worker.eco_points < reward.points_cost) return;
    setRedeeming(reward.id);
    setNotice("");
    const prevPoints = worker.eco_points;
    // Optimistic update
    setWorker((w) => w ? { ...w, eco_points: w.eco_points - reward.points_cost } : w);
    try {
      // optimistic lock: only succeeds if the balance hasn't changed (no double spend)
      const { data, error } = await supabase.from("workers").update({
        eco_points: prevPoints - reward.points_cost,
        tier: tierFor(prevPoints - reward.points_cost),
      }).eq("id", workerId).eq("eco_points", prevPoints).select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("Your points balance changed. Please refresh and try again.");
      setNotice(`Redeemed "${reward.title}" for ${reward.points_cost} points. Collect it from your supervisor.`);
    } catch (err: any) {
      // FIX 3: Revert optimistic update on failure
      console.error("[WorkerProfile] Redeem failed:", err?.message);
      setWorker((w) => w ? { ...w, eco_points: prevPoints } : w);
      alert(`Redemption failed: ${err?.message ?? "Unknown error"}`);
    } finally { setRedeeming(null); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-yellow-400 animate-spin" /></div>;
  if (!worker) return <div className="glass-card p-8 text-center text-slate-500">{loadError || "Profile not found"}</div>;

  const pts   = worker.eco_points ?? 0;
  const tier  = tierFor(pts);   // always follows the current balance
  const next  = TIER_NEXT_PTS[tier] ?? 5000;
  const pct   = Math.min(100, (pts / next) * 100);
  const supervisor = worker.admins;

  return (
    <div className="space-y-5">
      {/* Profile Card */}
      <div className="glass-card p-6 flex flex-col sm:flex-row items-start sm:items-center gap-5">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-yellow-500 to-orange-500 flex items-center justify-center text-2xl font-bold text-white shadow-lg shrink-0">
          {worker.name?.[0] ?? "W"}
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-display text-xl font-bold text-slate-100">{worker.name}</h2>
            <span className={cn("badge text-xs", TIER_COLORS[tier] ?? TIER_COLORS.Bronze)}>
              <BadgeCheck className="w-3 h-3" /> {tier}
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-3 text-xs">
            <div className="flex items-center gap-2 text-slate-400"><User className="w-3.5 h-3.5" /> {worker.employee_id}</div>
            <div className="flex items-center gap-2 text-slate-400"><Phone className="w-3.5 h-3.5" /> {worker.phone}</div>
            <div className="flex items-center gap-2 text-slate-400"><MapPin className="w-3.5 h-3.5" /> Ward: {worker.ward ?? "—"}</div>
            {/* Supervisor join from admins table */}
            {supervisor && (
              <div className="flex items-center gap-2 text-slate-400">
                <BadgeCheck className="w-3.5 h-3.5 text-blue-400" />
                <span>Supervisor: <span className="text-blue-300 font-medium">{supervisor.name}</span></span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Tasks Done",    value: worker.tasks_completed,           color: "text-eco-400" },
          { label: "Bonus Accrued", value: `₹${Number(worker.bonus_accrued ?? 0).toLocaleString("en-IN")}`, color: "text-green-400" },
          { label: "Eco-Points",    value: pts,                              color: "text-yellow-400" },
        ].map(({ label, value, color }) => (
          <div key={label} className="glass-card-sm p-3 text-center">
            <p className="text-[10px] text-slate-400 mb-1">{label}</p>
            <p className={cn("font-display text-xl font-bold", color)}>{value}</p>
          </div>
        ))}
      </div>

      {/* Tier Progress */}
      <div className="glass-card p-4 space-y-2">
        <div className="flex justify-between text-xs">
          <span className="text-slate-400">Progress to next tier: <span className="text-yellow-400 font-semibold">{tier}</span></span>
          <span className="text-slate-400">{pts} / {next} pts</span>
        </div>
        <div className="w-full h-2.5 rounded-full bg-civic-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-yellow-500 to-orange-400 transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Welfare Marketplace */}
      <div>
        <h3 className="font-display font-bold text-lg text-slate-100 flex items-center gap-2 mb-4">
          <Package className="w-5 h-5 text-yellow-400" /> Welfare Marketplace
        </h3>
        {notice && <p className="mb-3 text-sm text-eco-300">{notice}</p>}
        {rewards.length === 0 ? (
          <div className="glass-card p-8 text-center text-slate-500 text-sm">No rewards available</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {rewards.map((r) => {
              const canRedeem = pts >= r.points_cost;
              return (
                <div key={r.id} className="glass-card p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-semibold text-slate-100 text-sm">{r.title}</h4>
                    <div className="badge bg-yellow-500/10 text-yellow-300 border-yellow-500/20 text-xs shrink-0">
                      <Star className="w-3 h-3" /> {r.points_cost} pts
                    </div>
                  </div>
                  <div className="badge bg-blue-500/10 text-blue-300 border-blue-500/20 text-xs self-start">{r.category}</div>
                  <button
                    disabled={!canRedeem || redeeming === r.id}
                    onClick={() => handleRedeem(r)}
                    className={cn(
                      "w-full py-2 rounded-xl text-xs font-semibold border transition-all flex items-center justify-center gap-2",
                      canRedeem
                        ? "bg-yellow-600/20 border-yellow-500/30 text-yellow-300 hover:bg-yellow-600/30"
                        : "bg-white/3 border-white/8 text-slate-500 cursor-not-allowed"
                    )}
                  >
                    {redeeming === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    {canRedeem ? "🎁 Redeem Now" : `Need ${r.points_cost - pts} more pts`}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
