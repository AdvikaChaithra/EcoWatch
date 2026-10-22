"use client";
import { PenaltyRedeem } from "@/components/citizen/PenaltyRedeem";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { useState, useEffect } from "react";
import { Award, Star, ShoppingBag, Loader2, CheckCircle2, Zap, X } from "lucide-react";
import { getRewards, supabase } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { cn, tierColor, tierPoints, tierFor } from "@/lib/utils";
import { Portal } from "@/components/shared/Portal";

interface Reward {
  id: string; title: string; category: string; points_cost: number; voucher_code: string; target_role: string;
}

// FIX 3: Redemption confirmation modal showing the actual voucher_code from DB
interface RedeemedVoucher {
  reward: Reward;
  voucher_code: string;
}

const TIER_META = [
  { name: "Bronze",       min: 0,    max: 500,  color: "from-orange-600 to-amber-500",  emoji: "🥉" },
  { name: "Silver",       min: 500,  max: 2000, color: "from-slate-500 to-slate-300",   emoji: "🥈" },
  { name: "Gold",         min: 2000, max: 5000, color: "from-yellow-600 to-yellow-300", emoji: "🥇" },
  { name: "Eco-Champion", min: 5000, max: 10000,color: "from-eco-600 to-eco-300",       emoji: "🌿" },
];

export function RewardsHub() {
  const user = useEcoStore((s) => s.currentUser);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [redeemed, setRedeemed] = useState<Set<string>>(new Set());
  const [ecoPoints, setEcoPoints] = useState(user?.eco_points ?? 0);
  // FIX 3: Track the voucher being shown after redemption
  const [voucherModal, setVoucherModal] = useState<RedeemedVoucher | null>(null);

  useEffect(() => {
    loadRewards();
    if (user?.id) loadUserPoints();
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadRewards() {
    setLoading(true);
    try {
      const data = await getRewards("citizen");
      setRewards(data ?? []);
      setLoadError("");
    } catch (e) { setRewards([]); setLoadError(errMsg(e, "Could not load rewards.")); }
    finally { setLoading(false); }
  }

  async function loadUserPoints() {
    if (!user?.id) return;
    const { data } = await supabase.from("citizens").select("eco_points, tier").eq("id", user.id).single();
    if (data) setEcoPoints(data.eco_points);
  }

  // FIX 3: Real Supabase eco_points deduction + voucher_code display
  async function handleRedeem(reward: Reward) {
    if (ecoPoints < reward.points_cost || !user?.id) return;
    setRedeeming(reward.id);
    try {
      const newPoints = ecoPoints - reward.points_cost;
      // Calculate new tier
      let newTier = "Bronze";
      if (newPoints >= 5000) newTier = "Eco-Champion";
      else if (newPoints >= 2000) newTier = "Gold";
      else if (newPoints >= 500)  newTier = "Silver";

      const { data, error } = await supabase
        .from("citizens")
        .update({ eco_points: newPoints, tier: newTier })
        .eq("id", user.id)
        .eq("eco_points", ecoPoints) // optimistic lock: fail if points changed elsewhere
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) throw new Error("Your points balance changed. Please refresh and try again.");

      setRedeemed((s) => new Set(s).add(reward.id));
      setEcoPoints(newPoints);
      // FIX 3: Show voucher modal with the actual voucher_code from the DB record
      setVoucherModal({ reward, voucher_code: reward.voucher_code });
    } catch (err: any) {
      console.error("[RewardsHub] Redemption failed:", err?.message);
      alert(`Redemption failed: ${err?.message ?? "Unknown error"}. Please try again.`);
    } finally {
      setRedeeming(null);
    }
  }

  // Tier always follows the CURRENT balance (the stored login-time tier goes stale after earning/redeeming).
  const tier = tierFor(ecoPoints);
  const tierMeta = TIER_META.find((t) => t.name === tier) ?? TIER_META[0];
  const { min, max } = tierPoints(tier);
  const progress = Math.max(0, Math.min(100, ((ecoPoints - min) / Math.max(1, max - min)) * 100));
  const nextTier = TIER_META[TIER_META.findIndex((t) => t.name === tier) + 1];

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      <ErrorNote message={loadError} onDismiss={() => setLoadError("")} />
      <PenaltyRedeem points={ecoPoints} onPointsChange={setEcoPoints} />
      {/* FIX 3: Voucher Redemption Modal */}
      {voucherModal && (
        <Portal>
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-sm glass-card p-6 animate-fade-in-up space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="font-display font-bold text-lg text-slate-100">🎉 Reward Redeemed!</h3>
              <button onClick={() => setVoucherModal(null)} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckCircle2 className="w-12 h-12 text-eco-400" />
              <p className="font-semibold text-slate-100">{voucherModal.reward.title}</p>
              <p className="text-sm text-slate-400">{voucherModal.reward.category}</p>
            </div>
            <div className="bg-eco-500/10 border border-eco-500/30 rounded-xl p-4 text-center">
              <p className="text-xs text-slate-400 mb-1">Your Voucher Code</p>
              <p className="font-mono text-xl font-bold text-eco-300 tracking-widest select-all">
                {voucherModal.voucher_code}
              </p>
              <p className="text-xs text-slate-500 mt-2">Present this code at the designated government office or portal</p>
            </div>
            <button
              onClick={() => setVoucherModal(null)}
              className="w-full py-2.5 rounded-xl bg-eco-600 hover:bg-eco-500 text-white font-semibold text-sm"
            >
              Done
            </button>
          </div>
        </div>
        </Portal>
      )}

      {/* Points Card */}
      <div className="eco-card p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className={cn("w-16 h-16 rounded-2xl bg-gradient-to-br flex items-center justify-center text-3xl", tierMeta.color)}>
              {tierMeta.emoji}
            </div>
            <div>
              <p className="text-xs text-slate-400 font-medium">Current Tier</p>
              <h3 className={cn("font-display text-2xl font-bold", tierColor(tier).split(" ")[0])}>{tier}</h3>
              <p className="text-sm text-slate-400 mt-0.5">{user?.name ?? "Citizen"}</p>
            </div>
          </div>
          <div className="text-center sm:text-right">
            <p className="text-xs text-slate-400 mb-0.5">Total Eco-Points</p>
            <p className="font-display text-4xl font-bold text-eco-300 animate-count-up">{ecoPoints.toLocaleString()}</p>
            {nextTier && (
              <p className="text-xs text-slate-400 mt-1">{(nextTier.min - ecoPoints).toLocaleString()} pts to {nextTier.name}</p>
            )}
          </div>
        </div>

        {/* Progress */}
        <div className="mt-5">
          <div className="flex justify-between text-xs text-slate-400 mb-1.5">
            <span>{tier}</span>
            <span>{Math.round(progress)}%</span>
            <span>{nextTier?.name ?? "Max"}</span>
          </div>
          <div className="progress-bar">
            <div className={cn("progress-fill bg-gradient-to-r", tierMeta.color)} style={{ width: `${progress}%` }} />
          </div>
        </div>

        {/* Tier badges */}
        <div className="flex gap-2 mt-4 overflow-x-auto">
          {TIER_META.map((t) => (
            <div key={t.name} className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-medium whitespace-nowrap",
              t.name === tier ? "border-eco-500/40 bg-eco-500/10 text-eco-300" : "border-white/8 bg-white/3 text-slate-500"
            )}>
              <span>{t.emoji}</span> {t.name}
            </div>
          ))}
        </div>
      </div>

      {/* Rewards Catalog */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <ShoppingBag className="w-5 h-5 text-eco-400" />
          <h3 className="font-display font-bold text-lg text-slate-100">Government Benefits Catalog</h3>
        </div>

        {rewards.length === 0 ? (
          <div className="glass-card p-8 text-center">
            <Award className="w-10 h-10 text-slate-600 mx-auto mb-2" />
            <p className="text-slate-400 text-sm">No rewards available yet. Check back soon!</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {rewards.map((reward) => {
              const canAfford = ecoPoints >= reward.points_cost;
              const isRedeemed = redeemed.has(reward.id);
              const isRedeeming = redeeming === reward.id;

              return (
                <div key={reward.id} className={cn(
                  "glass-card p-5 flex flex-col gap-4 transition-all hover:border-eco-500/20",
                  !canAfford && "opacity-60",
                  isRedeemed && "border-green-500/30 bg-green-500/5"
                )}>
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-semibold text-slate-100 text-sm leading-snug">{reward.title}</h4>
                    <div className="badge bg-yellow-500/10 text-yellow-300 border-yellow-500/20 shrink-0 text-xs">
                      <Star className="w-3 h-3" />
                      {reward.points_cost.toLocaleString()} pts
                    </div>
                  </div>
                  <div className="badge text-xs bg-blue-500/10 text-blue-300 border-blue-500/20 self-start">
                    {reward.category}
                  </div>

                  {isRedeemed ? (
                    <div className="flex items-center gap-2 text-green-400 text-sm">
                      <CheckCircle2 className="w-4 h-4" />
                      <span className="font-medium">Redeemed!</span>
                      <button
                        onClick={() => setVoucherModal({ reward, voucher_code: reward.voucher_code })}
                        className="ml-auto text-xs text-eco-400 underline"
                      >
                        Show code
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleRedeem(reward)}
                      disabled={!canAfford || isRedeeming}
                      className={cn(
                        "flex items-center justify-center gap-2 w-full py-2 rounded-xl text-sm font-semibold transition-all mt-auto",
                        canAfford
                          ? "bg-eco-600/20 hover:bg-eco-600/30 text-eco-300 border border-eco-500/20"
                          : "bg-white/5 text-slate-500 cursor-not-allowed border border-white/8"
                      )}
                    >
                      {isRedeeming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                      {isRedeeming ? "Redeeming..." : canAfford ? "Redeem Now" : `Need ${(reward.points_cost - ecoPoints).toLocaleString()} more pts`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
