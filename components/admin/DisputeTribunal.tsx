"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { EvidenceStrip } from "@/components/shared/EvidenceStrip";
import { useSectorScope } from "@/hooks/useSectorScope";
import { useEcoStore } from "@/lib/store";
import { useState, useEffect } from "react";
import { Gavel, Eye, X, CheckCircle2, XCircle, Loader2, ScanFace, Ban } from "lucide-react";
import { getViolations, updateViolationStatus } from "@/lib/supabase";
import { authFetch } from "@/lib/api";
import { cn, formatDateTime, statusColor } from "@/lib/utils";
import { Portal } from "@/components/shared/Portal";

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
  const [unidBusy, setUnidBusy] = useState<string | null>(null);
  const [unidMsg, setUnidMsg] = useState<Record<string, { ok: boolean; text: string }>>({});

  /** Unidentified camera events: retry face identification, or close as a false alarm. */
  async function unidAction(v: Violation, action: "reidentify" | "dismiss") {
    if (action === "dismiss" && !confirm("Dismiss this event as a false alarm? No one will be fined.")) return;
    setUnidBusy(v.id + action);
    try {
      const r = await authFetch<{ dismissed?: boolean; fined?: boolean; identity_status?: string; reason?: string;
        similarity?: number | null; citizen_name?: string }>(`/api/violations/${v.id}`, { method: "PATCH", body: JSON.stringify({ action }) });
      if (r.dismissed) {
        setUnidentified((u) => u.filter((x) => x.id !== v.id));
        setSuccess("Event dismissed as a false alarm.");
        setTimeout(() => setSuccess(""), 3000);
      } else if (r.fined) {
        setUnidentified((u) => u.filter((x) => x.id !== v.id));
        setSuccess(`Identified ${r.citizen_name ?? "the citizen"} (similarity ${Math.round((r.similarity ?? 0) * 100)}%). Fine issued and the citizen was alerted.`);
        setTimeout(() => setSuccess(""), 5000);
      } else {
        setUnidMsg((m) => ({ ...m, [v.id]: { ok: false, text: `Still not identified: ${r.identity_status}${r.similarity != null ? ` (best similarity ${Math.round(r.similarity * 100)}%)` : ""} — ${r.reason ?? ""}. No fine issued.` } }));
        setUnidentified((u) => u.map((x) => (x.id === v.id ? { ...x, identity_status: r.identity_status, face_similarity: r.similarity ?? null } as Violation : x)));
      }
    } catch (e) {
      setUnidMsg((m) => ({ ...m, [v.id]: { ok: false, text: errMsg(e, "Could not complete this action.") } }));
    } finally { setUnidBusy(null); }
  }

  const { inScope, key: scopeKey } = useSectorScope();
  const admin = useEcoStore((st) => st.currentUser);
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
      await updateViolationStatus(selected.id, dismiss ? "Dismissed" : "Upheld", {
        reviewed_by: admin?.id ?? null,
        reviewed_at: new Date().toISOString(),
        admin_reason: dismiss ? "Dispute accepted after reviewing evidence" : "Dispute rejected after reviewing evidence",
      }, "Disputed");
      setSuccess(dismiss ? "Penalty waived. The citizen sees the decision on their dashboard." : "Fine upheld. The citizen sees the decision on their dashboard.");
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
      {success && !selected && <p className="text-sm text-eco-300">{success}</p>}
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
        <Portal>
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
        </Portal>
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
                {unidMsg[v.id] && <p className="text-xs text-orange-300">{unidMsg[v.id].text}</p>}
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => unidAction(v, "reidentify")} disabled={!!unidBusy}
                          className="btn-eco-outline text-xs px-3 py-1.5 disabled:opacity-40">
                    {unidBusy === v.id + "reidentify" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanFace className="w-3.5 h-3.5" />}
                    Retry identification
                  </button>
                  <button onClick={() => unidAction(v, "dismiss")} disabled={!!unidBusy}
                          className="text-xs px-3 py-1.5 rounded-xl border border-red-500/30 text-red-300 hover:bg-red-500/10 flex items-center gap-1.5 disabled:opacity-40">
                    {unidBusy === v.id + "dismiss" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Ban className="w-3.5 h-3.5" />}
                    Dismiss (false alarm)
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
