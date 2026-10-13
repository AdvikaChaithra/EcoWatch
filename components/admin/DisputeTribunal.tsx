"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { EvidenceStrip } from "@/components/shared/EvidenceStrip";
import { useSectorScope } from "@/hooks/useSectorScope";
import { useState, useEffect } from "react";
import { Gavel, Eye, X, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { getViolations, updateViolationStatus } from "@/lib/supabase";
import { cn, formatDateTime, statusColor } from "@/lib/utils";

interface Violation { id: string; citizen_id: string; timestamp: string; location_name: string; fine_amount: number; status: string; confidence_score: number; dispute_reason?: string; snapshot_url?: string; evidence_path?: string | null; face_similarity?: number | null; }

export function DisputeTribunal() {
  const [disputes, setDisputes] = useState<Violation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unidentified, setUnidentified] = useState<Violation[]>([]);
  const [openUnid, setOpenUnid] = useState<string | null>(null);
  const [selected, setSelected] = useState<Violation | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [success, setSuccess] = useState("");

  const { inScope, key: scopeKey } = useSectorScope();
  useEffect(() => { loadDisputes(); }, [scopeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadDisputes() {
    setLoading(true);
    try {
      const all = await getViolations();
      setDisputes((all ?? []).filter((v: Violation) => v.status === "Disputed" && inScope((v as any).sector_id)));
      setUnidentified((all ?? []).filter((v: Violation) => v.status === "Unidentified" && inScope((v as any).sector_id)));
      setError("");
    } catch (e) { setError(errMsg(e, "Could not load disputes.")); } finally { setLoading(false); }
  }

  async function handleAction(dismiss: boolean) {
    if (!selected) return;
    setActionLoading(true);
    try {
      await updateViolationStatus(selected.id, dismiss ? "Dismissed" : "Upheld");
      setSuccess(dismiss ? "Penalty waived. Citizen notified." : "Fine upheld. Citizen dispute rejected.");
      setDisputes((d) => d.filter((x) => x.id !== selected.id));
      setTimeout(() => { setSelected(null); setSuccess(""); }, 2000);
    } catch (e) {
      setError(errMsg(e, "Could not update the dispute. Please try again."));
    } finally { setActionLoading(false); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <div className="flex items-center gap-2 mb-2">
        <Gavel className="w-5 h-5 text-red-400" />
        <h2 className="text-xl font-display font-bold text-slate-100">Dispute Tribunal</h2>
        <span className="badge bg-red-500/10 text-red-400 border-red-500/20 ml-2">{disputes.length} pending</span>
      </div>

      {disputes.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <CheckCircle2 className="w-12 h-12 text-eco-400 mx-auto mb-3 opacity-40" />
          <p className="text-slate-400">No pending disputes</p>
        </div>
      ) : (
        <div className="space-y-3">
          {disputes.map((v) => (
            <div key={v.id} className="glass-card p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn("badge text-xs", statusColor(v.status))}>{v.status}</span>
                  <span className="text-xs text-slate-400">{formatDateTime(v.timestamp)}</span>
                </div>
                <p className="text-sm font-medium text-slate-200">{v.location_name}</p>
                <p className="text-xs text-slate-400 mt-1">
                  AI Confidence: <strong className="text-eco-400">{v.confidence_score.toFixed(1)}%</strong> · Fine: <strong className="text-orange-400">₹{v.fine_amount}</strong>
                </p>
                {v.dispute_reason && (
                  <p className="text-xs text-slate-400 mt-2 italic line-clamp-2">
                    &quot;{v.dispute_reason}&quot;
                  </p>
                )}
              </div>
              <button onClick={() => setSelected(v)} className="btn-eco-outline text-xs px-3 py-1.5 shrink-0">
                <Eye className="w-3.5 h-3.5" /> Review
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Review Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg glass-card p-6 animate-fade-in-up">
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-display font-bold text-lg text-slate-100">Tribunal Review</h3>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400"><X className="w-5 h-5" /></button>
            </div>

            {success ? (
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <Gavel className="w-12 h-12 text-blue-400" />
                <p className="text-blue-300 font-semibold">{success}</p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Evidence: the 3 real frames (holding / dropped / leaving) */}
                <EvidenceStrip evidencePath={selected.evidence_path} fallbackUrl={selected.snapshot_url} />
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="glass-card-sm p-3">
                    <p className="text-xs text-slate-400">AI Confidence</p>
                    <p className="font-bold text-eco-400 mt-0.5">{selected.confidence_score.toFixed(1)}%</p>
                  </div>
                  <div className="glass-card-sm p-3">
                    <p className="text-xs text-slate-400">Fine Amount</p>
                    <p className="font-bold text-orange-400 mt-0.5">₹{selected.fine_amount}</p>
                  </div>
                </div>
                {selected.dispute_reason && (
                  <div className="p-3 rounded-xl bg-blue-500/5 border border-blue-500/20">
                    <p className="text-xs text-slate-400 mb-1">Citizen Appeal Statement</p>
                    <p className="text-sm text-slate-300 italic">&quot;{selected.dispute_reason}&quot;</p>
                  </div>
                )}
                <div className="flex gap-3 mt-2">
                  <button onClick={() => handleAction(true)} disabled={actionLoading} className="btn-eco flex-1 justify-center">
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                    Waive Penalty
                  </button>
                  <button onClick={() => handleAction(false)} disabled={actionLoading} className="btn-danger flex-1 justify-center">
                    {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <XCircle className="w-4 h-4" />}
                    Uphold Fine
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Littering events the camera confirmed but could NOT identify — no fine is issued */}
      <div className="pt-4">
        <h3 className="text-sm font-semibold text-slate-300 mb-2">
          Unidentified littering events <span className="text-slate-500 font-normal">({unidentified.length}) · no citizen fine issued</span>
        </h3>
        {unidentified.length === 0 ? (
          <p className="text-xs text-slate-500">None.</p>
        ) : (
          <div className="space-y-2">
            {unidentified.slice(0, 20).map((v: any) => (
              <div key={v.id} className="glass-card p-3 space-y-2">
                <button className="w-full text-left" onClick={() => setOpenUnid(openUnid === v.id ? null : v.id)}>
                  <p className="text-sm text-slate-200">{v.location_name} · {formatDateTime(v.timestamp)}</p>
                  <p className="text-[11px] text-slate-500">
                    {v.identity_status ?? "UNIDENTIFIED"}{v.face_similarity != null ? ` · best similarity ${(v.face_similarity * 100).toFixed(0)}%` : ""} · tap to view evidence
                  </p>
                </button>
                {openUnid === v.id && <EvidenceStrip evidencePath={v.evidence_path} fallbackUrl={v.snapshot_url} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
