"use client";
import { ErrorNote, errMsg } from "@/components/layout/ErrorNote";
import { useState, useEffect } from "react";
import {
  AlertTriangle, Eye, CreditCard, FileText, Loader2, X,
  CheckCircle2, Download, Printer
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { EvidenceStrip } from "@/components/shared/EvidenceStrip";
import { cn, formatDateTime, statusColor, formatCurrency } from "@/lib/utils";

interface Violation {
  id: string; citizen_id: string; timestamp: string; location_name: string;
  fine_amount: number; status: string; snapshot_url?: string;
  confidence_score: number; dispute_reason?: string;
  person_bbox?: number[] | null;
  evidence_path?: string | null; face_similarity?: number | null; identity_status?: string;
  trash_bbox?:  number[] | null;
  // Payment fields — populated after payment is made
  payment_method?: string; paid_at?: string; transaction_ref?: string;
}

interface Receipt {
  receipt_number: string; violation_id: string; location: string;
  timestamp: string; paid_at: string; fine_amount: number;
  payment_method: string; transaction_ref: string;
  citizen_name?: string;
}

type ModalType = "snapshot" | "payment" | "dispute" | null;

/** Generate and trigger a real HTML → PDF receipt download via print API */
function downloadReceipt(receipt: Receipt, citizenName?: string) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>EcoWatch Municipal Receipt — ${receipt.receipt_number}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #fff; color: #1e293b; padding: 40px; max-width: 680px; margin: auto; }
    .header { display: flex; align-items: center; justify-content: space-between; border-bottom: 3px solid #10b981; padding-bottom: 20px; margin-bottom: 28px; }
    .logo { display: flex; align-items: center; gap: 12px; }
    .logo-icon { width: 48px; height: 48px; background: #10b981; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: white; font-size: 22px; }
    .logo-text h1 { font-size: 20px; font-weight: 700; color: #10b981; }
    .logo-text p { font-size: 12px; color: #64748b; }
    .badge { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .title { text-align: center; margin-bottom: 28px; }
    .title h2 { font-size: 22px; font-weight: 700; color: #1e293b; }
    .title p { font-size: 12px; color: #64748b; margin-top: 4px; }
    .section { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
    .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; margin-bottom: 14px; }
    .row { display: flex; justify-content: space-between; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid #f1f5f9; }
    .row:last-child { border-bottom: none; }
    .row label { font-size: 13px; color: #64748b; }
    .row value, .row span { font-size: 13px; font-weight: 600; color: #1e293b; text-align: right; max-width: 55%; }
    .amount { text-align: center; padding: 20px; background: #f0fdf4; border: 2px solid #bbf7d0; border-radius: 12px; margin-bottom: 16px; }
    .amount p { font-size: 12px; color: #64748b; }
    .amount .sum { font-size: 42px; font-weight: 700; color: #15803d; }
    .paid-stamp { text-align: center; background: #15803d; color: white; padding: 10px; border-radius: 8px; font-weight: 700; font-size: 16px; letter-spacing: 0.15em; margin-bottom: 16px; }
    .footer { text-align: center; font-size: 11px; color: #94a3b8; padding-top: 20px; border-top: 1px solid #e2e8f0; line-height: 1.6; }
    .qr-placeholder { width: 80px; height: 80px; border: 2px dashed #cbd5e1; display: flex; align-items: center; justify-content: center; border-radius: 8px; margin: 0 auto 12px; font-size: 10px; color: #94a3b8; }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">
      <div class="logo-icon">🌿</div>
      <div class="logo-text">
        <h1>EcoWatch</h1>
        <p>Municipal Civic Platform · Government of India</p>
      </div>
    </div>
    <span class="badge">✓ PAID</span>
  </div>

  <div class="title">
    <h2>Municipal Clearance Receipt</h2>
    <p>Official record of litter fine payment · AI-verified evidence</p>
  </div>

  <div class="paid-stamp">✅ PENALTY CLEARED — ACCOUNT IN GOOD STANDING</div>

  <div class="amount">
    <p>Total Fine Paid</p>
    <div class="sum">₹${receipt.fine_amount.toLocaleString("en-IN")}</div>
    <p style="margin-top:4px;font-size:11px;">Rupees ${amountInWords(receipt.fine_amount)} Only</p>
  </div>

  <div class="section">
    <div class="section-title">Receipt Details</div>
    ${row("Receipt Number", receipt.receipt_number)}
    ${row("Transaction Ref", receipt.transaction_ref)}
    ${row("Violation ID", receipt.violation_id.slice(0, 8).toUpperCase())}
    ${row("Payment Method", receipt.payment_method)}
    ${row("Paid At", new Date(receipt.paid_at).toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" }))}
  </div>

  <div class="section">
    <div class="section-title">Citizen & Violation Details</div>
    ${row("Citizen Name", citizenName ?? "—")}
    ${row("Location of Offence", receipt.location)}
    ${row("Offence Date", new Date(receipt.timestamp).toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" }))}
    ${row("Offence Type", "Littering in Public Space")}
    ${row("Detection Method", "AI CCTV — YOLOv8 + ArcFace")}
  </div>

  <div class="footer">
    <div class="qr-placeholder">QR<br/>Verify</div>
    <p>This is a computer-generated receipt. Verify authenticity at <strong>ecowatch.gov.in/verify/${receipt.receipt_number}</strong></p>
    <p>Issued by: EcoWatch Civic Platform · Ministry of Urban Development · Government of India</p>
    <p>For disputes: tribunal@ecowatch.gov.in | Help: 1800-ECO-HELP</p>
  </div>
</body>
</html>`;

  const win = window.open("", "_blank", "width=720,height=900");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 500);
}

function row(label: string, value: string) {
  return `<div class="row"><label>${label}</label><span>${value}</span></div>`;
}

function amountInWords(n: number): string {
  const words = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty",
    "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  if (n <= 20) return words[n] ?? n.toString();
  if (n < 100) return words[18 + Math.floor(n / 10)] + (n % 10 ? " " + words[n % 10] : "");
  if (n < 1000) return words[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + amountInWords(n % 100) : "");
  return n.toString();
}

export function ViolationHub() {
  const user = useEcoStore((s) => s.currentUser);
  const [violations,    setViolations]    = useState<Violation[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [loadError,     setLoadError]     = useState("");
  const [selected,      setSelected]      = useState<Violation | null>(null);
  const [modal,         setModal]         = useState<ModalType>(null);
  const [disputeReason, setDisputeReason] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [payMethod,     setPayMethod]     = useState("UPI / GPay");
  const [receipt,       setReceipt]       = useState<Receipt | null>(null);
  const [newAlert,      setNewAlert]      = useState<string | null>(null);

  // Initial load
  useEffect(() => { loadViolations(); }, [user]); // eslint-disable-line

  // ── Real-time Supabase subscription ──────────────────────────────────────
  useEffect(() => {
    const channel = supabase
      .channel("public:violations")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "violations" },
        (payload) => {
          const newVio = payload.new as Violation;
          // Only show citizen's own violations (or all if no user filter)
          if (!user?.id || newVio.citizen_id === user.id) {
            setViolations((prev) => [newVio, ...prev]);
            setNewAlert(`New violation detected at ${newVio.location_name} — Fine ₹${newVio.fine_amount}`);
            setTimeout(() => setNewAlert(null), 6000);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]); // eslint-disable-line

  async function loadViolations() {
    setLoading(true);
    try {
      let q = supabase.from("violations").select("*").order("timestamp", { ascending: false });
      if (user?.id) q = q.eq("citizen_id", user.id);
      const { data, error } = await q;
      if (error) throw error;
      setViolations(data ?? []);
      setLoadError("");
    } catch (e) {
      // An empty list would read as "no fines" — tell the user the load failed instead.
      setViolations([]);
      setLoadError(errMsg(e, "Could not load your violations."));
    } finally { setLoading(false); }
  }

  async function handlePayFine() {
    if (!selected) return;
    setActionLoading(true);
    try {
      const txnRef = `TXN-${selected.id.slice(0, 6).toUpperCase()}-${Date.now()}`;
      const paidAt = new Date().toISOString();

      // FIX 3: Check for Supabase error before treating as success
      const { data: updated, error } = await supabase.from("violations").update({
        status:          "Paid",
        payment_method:  payMethod,
        paid_at:         paidAt,
        transaction_ref: txnRef,
      }).eq("id", selected.id).neq("status", "Paid").select("id");

      if (error) throw error;
      if (!updated || updated.length === 0) throw new Error("This fine was already paid or is no longer available.");

      const receiptData: Receipt = {
        receipt_number:  `MCR-${selected.id.slice(0, 6).toUpperCase()}`,
        violation_id:    selected.id,
        location:        selected.location_name,
        timestamp:       selected.timestamp,
        paid_at:         paidAt,
        fine_amount:     selected.fine_amount,
        payment_method:  payMethod,
        transaction_ref: txnRef,
        citizen_name:    user?.name,
      };

      setReceipt(receiptData);
      setViolations((v) => v.map((x) => x.id === selected.id
        ? { ...x, status: "Paid", payment_method: payMethod, paid_at: paidAt, transaction_ref: txnRef }
        : x
      ));
    } catch (err: any) {
      console.error("[ViolationHub] Payment failed:", err?.message);
      alert(`Payment failed: ${err?.message ?? "Unknown error"}. Please try again.`);
    } finally { setActionLoading(false); }
  }

  async function handleDispute() {
    if (!selected || !disputeReason) return;
    setActionLoading(true);
    try {
      const { data: updated, error } = await supabase.from("violations").update({
        status:         "Disputed",
        dispute_reason: disputeReason,
        disputed_at:    new Date().toISOString(),
      }).eq("id", selected.id).eq("status", "Pending").select("id");
      if (error) throw error;
      if (!updated || updated.length === 0) throw new Error("This violation can no longer be disputed.");
      setViolations((v) => v.map((x) => x.id === selected.id ? { ...x, status: "Disputed" } : x));
      setTimeout(() => { setModal(null); setDisputeReason(""); }, 2000);
    } catch (err: any) {
      console.error("[ViolationHub] Dispute failed:", err?.message);
      alert(`Could not submit dispute: ${err?.message ?? "Unknown error"}. Please try again.`);
    } finally { setActionLoading(false); }
  }

  function closeModal() { setModal(null); setReceipt(null); setDisputeReason(""); setActionLoading(false); }

  if (loading) return <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 text-eco-400 animate-spin" /></div>;

  return (
    <>
      {/* Real-time Violation Alert Banner */}
      {newAlert && (
        <div className="mb-4 flex items-start gap-3 p-4 rounded-2xl bg-red-900/90 border border-red-500/40 animate-fade-in-up">
      <ErrorNote message={loadError} onDismiss={() => setLoadError("")} />
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5 animate-pulse" />
          <div>
            <p className="text-xs font-bold text-red-400">📡 LIVE CAMERA DETECTION</p>
            <p className="text-sm text-red-200 mt-0.5">{newAlert}</p>
          </div>
        </div>
      )}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-display font-bold text-slate-100">Violation & Penalty Hub</h2>
            <p className="text-sm text-slate-400 mt-0.5">{violations.length} violation{violations.length !== 1 ? "s" : ""} on record</p>
          </div>
          <button onClick={loadViolations} className="p-2 rounded-xl hover:bg-white/5 text-slate-400"><Loader2 className="w-4 h-4" /></button>
        </div>

        {violations.length === 0 ? (
          <div className="glass-card p-12 text-center">
            <CheckCircle2 className="w-12 h-12 text-eco-400 mx-auto mb-3 opacity-40" />
            <p className="text-slate-400">No violations on record. Keep it clean! 🌿</p>
          </div>
        ) : (
          <div className="glass-card overflow-x-auto">
            <table className="civic-table">
              <thead className="bg-civic-900/80">
                <tr>
                  <th>Violation ID</th><th>Date & Time</th><th>Location</th>
                  <th>Fine</th><th>AI Confidence</th><th>Status</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {violations.map((v) => (
                  <tr key={v.id}>
                    <td className="font-mono text-xs text-slate-400">{v.id.slice(0, 8).toUpperCase()}</td>
                    <td className="text-xs">{formatDateTime(v.timestamp)}</td>
                    <td className="max-w-48 truncate text-xs">{v.location_name}</td>
                    <td className="font-semibold text-orange-400">{formatCurrency(v.fine_amount)}</td>
                    <td>
                      <div className={cn("badge text-xs", (v.confidence_score ?? 0) >= 85 ? "bg-red-500/10 text-red-400 border-red-500/20" : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20")}>
                        {(v.confidence_score ?? 0).toFixed(1)}%
                      </div>
                    </td>
                    <td><span className={cn("badge text-xs", statusColor(v.status))}>{v.status}</span></td>
                    <td>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setSelected(v); setModal("snapshot"); }} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-eco-400" title="View Snapshot">
                          <Eye className="w-4 h-4" />
                        </button>
                        {v.status === "Pending" && (
                          <>
                            <button onClick={() => { setSelected(v); setModal("payment"); setReceipt(null); }} className="p-1.5 rounded-lg hover:bg-green-500/10 text-slate-400 hover:text-green-400" title="Pay Fine">
                              <CreditCard className="w-4 h-4" />
                            </button>
                            <button onClick={() => { setSelected(v); setModal("dispute"); }} className="p-1.5 rounded-lg hover:bg-orange-500/10 text-slate-400 hover:text-orange-400" title="Dispute">
                              <FileText className="w-4 h-4" />
                            </button>
                          </>
                        )}
                        {v.status === "Paid" && (
                          <button
                            onClick={() => {
                              // FIX 3: Use actual stored payment_method and transaction_ref from DB row
                              downloadReceipt({
                                receipt_number:  `MCR-${v.id.slice(0,6).toUpperCase()}`,
                                violation_id:    v.id,
                                location:        v.location_name,
                                timestamp:       v.timestamp,
                                paid_at:         v.paid_at ?? v.timestamp,
                                fine_amount:     v.fine_amount,
                                payment_method:  v.payment_method ?? "UPI",
                                transaction_ref: v.transaction_ref ?? `TXN-${v.id.slice(0,6).toUpperCase()}`,
                              }, user?.name);
                            }}
                            className="p-1.5 rounded-lg hover:bg-eco-500/10 text-slate-400 hover:text-eco-400"
                            title="Download Receipt"
                          >
                            <Download className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modals */}
      {modal && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="w-full max-w-lg glass-card p-6 animate-fade-in-up">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-display font-bold text-lg text-slate-100">
                {modal === "snapshot" ? "Evidence Snapshot" : modal === "payment" ? "Pay Fine" : "Contest Violation"}
              </h3>
              <button onClick={closeModal} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400"><X className="w-5 h-5" /></button>
            </div>

            {/* Snapshot Modal — with SVG bounding box overlay */}
            {modal === "snapshot" && (
              <div className="space-y-4">
                <EvidenceStrip evidencePath={selected.evidence_path} fallbackUrl={selected.snapshot_url} />
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {[
                    { label: "Location",      value: selected.location_name },
                    { label: "Captured",      value: formatDateTime(selected.timestamp) },
                    { label: "AI Confidence", value: `${(selected.confidence_score ?? 0).toFixed(1)}%` },
                    { label: "Fine Amount",   value: formatCurrency(selected.fine_amount ?? 200) },
                  ].map(({ label, value }) => (
                    <div key={label} className="glass-card-sm p-3">
                      <p className="text-xs text-slate-400">{label}</p>
                      <p className="text-slate-200 font-medium mt-0.5 text-sm">{value}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Payment Modal */}
            {modal === "payment" && (
              <div className="space-y-4">
                {receipt ? (
                  /* ── Payment Success + Receipt Download ── */
                  <div className="flex flex-col items-center gap-4 py-4 text-center">
                    <div className="w-16 h-16 rounded-full bg-eco-500/20 border border-eco-500/30 flex items-center justify-center">
                      <CheckCircle2 className="w-8 h-8 text-eco-400" />
                    </div>
                    <div>
                      <p className="text-eco-300 font-semibold text-lg">Payment Successful!</p>
                      <p className="text-xs text-slate-400 mt-1">Receipt No: {receipt.receipt_number}</p>
                      <p className="text-xs text-slate-400">Txn: {receipt.transaction_ref}</p>
                    </div>
                    <div className="flex gap-3 w-full">
                      <button
                        onClick={() => downloadReceipt(receipt, user?.name)}
                        className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-eco-600 hover:bg-eco-500 text-white font-semibold text-sm"
                      >
                        <Printer className="w-4 h-4" /> Print / Download PDF
                      </button>
                      <button onClick={closeModal} className="flex-1 py-2.5 rounded-xl border border-white/10 text-slate-400 hover:bg-white/5 text-sm">
                        Close
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="p-4 rounded-xl bg-orange-500/10 border border-orange-500/20 text-center">
                      <p className="text-xs text-slate-400 mb-1">Outstanding Fine</p>
                      <p className="text-4xl font-display font-bold text-orange-400">₹{selected.fine_amount}</p>
                      <p className="text-xs text-slate-400 mt-1">Violation at {selected.location_name}</p>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {["UPI / GPay", "Net Banking", "Debit Card"].map((method) => (
                        <button
                          key={method}
                          onClick={() => setPayMethod(method)}
                          className={cn(
                            "p-3 rounded-xl border text-xs text-center transition-all",
                            payMethod === method
                              ? "border-eco-500/50 bg-eco-500/10 text-eco-300"
                              : "border-white/10 hover:border-eco-500/30 bg-white/3 text-slate-300"
                          )}
                        >
                          {method}
                        </button>
                      ))}
                    </div>
                    <button onClick={handlePayFine} disabled={actionLoading} className="btn-eco w-full justify-center">
                      {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
                      {actionLoading ? "Processing Payment..." : `Pay ₹${selected.fine_amount} via ${payMethod}`}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Dispute Modal */}
            {modal === "dispute" && (
              <div className="space-y-4">
                {actionLoading ? (
                  <div className="flex flex-col items-center gap-3 py-6 text-center">
                    <CheckCircle2 className="w-12 h-12 text-blue-400" />
                    <p className="text-blue-300 font-semibold">Dispute submitted! Admin tribunal will review within 48 hours.</p>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-slate-400">Contest this violation within 48 hours. Provide a clear reason. The Admin Tribunal will review and respond.</p>
                    <textarea
                      className="input-civic min-h-[120px] resize-none"
                      placeholder="Describe why this violation is incorrect (e.g., I was not at this location, incorrect face match, trash was already there)..."
                      value={disputeReason}
                      onChange={(e) => setDisputeReason(e.target.value)}
                    />
                    <button
                      onClick={handleDispute}
                      disabled={!disputeReason}
                      className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-white font-semibold text-sm transition-all active:scale-95 disabled:opacity-50"
                    >
                      <FileText className="w-4 h-4" /> Submit Dispute
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
