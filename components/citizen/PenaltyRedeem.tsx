"use client";
import { useEffect, useState } from "react";
import { Leaf, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { formatCurrency } from "@/lib/utils";

const POINTS_PER_RUPEE = 10;   // 10 Eco-Points = ₹1 off
const MAX_DISCOUNT_SHARE = 0.5; // at most 50% of a fine can be paid with points

interface Pending { id: string; location_name: string; fine_amount: number; points_discount?: number | null; }

/** Use Eco-Points to reduce a pending fine (capped). Deducts points first, rolls back on failure. */
export function PenaltyRedeem({ points, onPointsChange }: { points: number; onPointsChange: (n: number) => void }) {
  const user = useEcoStore((s) => s.currentUser);
  const [items, setItems] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");

  async function load() {
    if (!user?.id) return;
    const { data, error: e } = await supabase
      .from("violations").select("id,location_name,fine_amount,points_discount")
      .eq("citizen_id", user.id).in("status", ["Pending", "Upheld"]).gt("fine_amount", 0);
    if (e) { setError(errMsg(e, "Could not load your pending fines.")); return; }
    setItems((data ?? []) as Pending[]);
  }
  useEffect(() => { load(); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function maxDiscount(v: Pending): number {
    const already = Number(v.points_discount ?? 0);
    const cap = Math.floor((Number(v.fine_amount) + already) * MAX_DISCOUNT_SHARE) - already;
    return Math.max(0, Math.min(cap, Math.floor(points / POINTS_PER_RUPEE)));
  }

  async function redeem(v: Pending) {
    if (!user?.id) return;
    const discount = maxDiscount(v);
    if (discount <= 0) return;
    const cost = discount * POINTS_PER_RUPEE;
    setBusy(v.id); setError(""); setOk("");
    try {
      // 1) deduct points (optimistic lock on the balance)
      const { data: c, error: e1 } = await supabase.from("citizens")
        .update({ eco_points: points - cost }).eq("id", user.id).eq("eco_points", points).select("id");
      if (e1) throw e1;
      if (!c || c.length === 0) throw new Error("Your points balance changed. Please refresh and try again.");
      // 2) reduce the fine (only while still pending and unchanged)
      const { data: u, error: e2 } = await supabase.from("violations")
        .update({ fine_amount: Number(v.fine_amount) - discount, points_discount: Number(v.points_discount ?? 0) + discount })
        .eq("id", v.id).in("status", ["Pending", "Upheld"]).eq("fine_amount", v.fine_amount).select("id");
      if (e2 || !u || u.length === 0) {
        await supabase.from("citizens").update({ eco_points: points }).eq("id", user.id); // roll back points
        throw e2 ?? new Error("This fine changed or was already paid; points were not spent.");
      }
      onPointsChange(points - cost);
      setOk(`Used ${cost} points: ${formatCurrency(discount)} off.`);
      await load();
    } catch (e) {
      setError(errMsg(e, "Could not apply points to this fine."));
    } finally { setBusy(null); }
  }

  if (!user?.id || items.length === 0) return null;

  return (
    <div className="glass-card p-4 space-y-3">
      <p className="text-sm font-semibold text-slate-200 flex items-center gap-2">
        <Leaf className="w-4 h-4 text-eco-400" /> Reduce a pending fine with Eco-Points
      </p>
      <p className="text-[11px] text-slate-500">{POINTS_PER_RUPEE} points = ₹1 off · up to {MAX_DISCOUNT_SHARE * 100}% of a fine.</p>
      <ErrorNote message={error} onDismiss={() => setError("")} />
      {ok && <p className="text-xs text-eco-300">{ok}</p>}
      {items.map((v) => {
        const d = maxDiscount(v);
        return (
          <div key={v.id} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-300 truncate">{v.location_name} · {formatCurrency(Number(v.fine_amount))}</span>
            <button
              disabled={d <= 0 || busy === v.id}
              onClick={() => redeem(v)}
              className="px-3 py-1.5 rounded-lg bg-eco-600/20 text-eco-300 border border-eco-500/30 text-xs disabled:opacity-40"
            >
              {busy === v.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : d > 0 ? `Use ${d * POINTS_PER_RUPEE} pts → ${formatCurrency(d)} off` : "Not enough points / cap reached"}
            </button>
          </div>
        );
      })}
    </div>
  );
}
