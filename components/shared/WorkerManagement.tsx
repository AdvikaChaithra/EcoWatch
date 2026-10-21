"use client";
import { useEffect, useMemo, useState } from "react";
import { Users, Plus, Loader2, KeyRound, ArrowRightLeft, UserMinus, UserCheck, Pencil, X, Search, MapPin, Copy } from "lucide-react";
import { supabase, haversineMeters } from "@/lib/supabase";
import { authFetch } from "@/lib/api";
import { useEcoStore } from "@/lib/store";
import { getBestPosition } from "@/lib/geo";
import { ErrorNote } from "@/components/layout/ErrorNote";
import { cn, statusColor } from "@/lib/utils";
import { SectorOptions } from "@/components/shared/SectorOptions";
import { Portal } from "@/components/shared/Portal";

interface Sector { id: string; area: string; name: string; corporation?: string | null; admin_id: string | null; lat: number; lng: number; active?: boolean }
interface Worker {
  id: string; name: string; phone: string; employee_id: string; status: string; active: boolean;
  sector_id: string | null; admin_id: string | null; tasks_completed: number; bonus_accrued: number;
  must_change_pin?: boolean;
}
interface AdminLite { id: string; name: string }

const COLS = "id,name,phone,employee_id,status,active,sector_id,admin_id,tasks_completed,bonus_accrued,must_change_pin";

/**
 * Worker management shared by the admin console (scope = the admin's own sectors) and the
 * super admin portal (scope = everything). All changes go through server routes that re-check
 * the caller's role and sector ownership, and are written to the audit log.
 */
export function WorkerManagement({ scope }: { scope: "admin" | "super" }) {
  const user = useEcoStore((s) => s.currentUser);
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [admins, setAdmins] = useState<AdminLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [filterSector, setFilterSector] = useState("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "inactive" | "On Duty">("active");
  const [q, setQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", sector_id: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ title: string; lines: [string, string][] } | null>(null);
  const [editing, setEditing] = useState<Worker | null>(null);
  const [transfer, setTransfer] = useState<Worker | null>(null);
  const [transferTo, setTransferTo] = useState("");
  const [locating, setLocating] = useState(false);

  const sectorById = useMemo(() => Object.fromEntries(sectors.map((s) => [s.id, s])), [sectors]);
  const adminName = (id: string | null) => admins.find((a) => a.id === id)?.name ?? "—";

  async function load() {
    if (!user?.id) return;
    setLoading(true);
    try {
      let sq = supabase.from("sectors").select("id,area,name,corporation,admin_id,lat,lng,active").order("area");
      if (scope === "admin") sq = sq.eq("admin_id", user.id);
      const { data: sData, error: sErr } = await sq;
      if (sErr) throw sErr;
      setSectors((sData ?? []) as Sector[]);

      let wq = supabase.from("workers").select(COLS).order("name");
      if (scope === "admin") {
        const ids = (sData ?? []).map((s: any) => s.id);
        wq = ids.length ? wq.in("sector_id", ids) : wq.eq("admin_id", user.id);
      }
      const { data: wData, error: wErr } = await wq;
      if (wErr) throw wErr;
      setWorkers((wData ?? []) as Worker[]);

      if (scope === "super") {
        const r = await authFetch<{ admins: AdminLite[] }>("/api/super/admins");
        setAdmins(r.admins);
      }
      setError("");
    } catch (e: any) {
      setError(`Could not load workers: ${e?.message ?? e}`);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [user?.id, scope]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeSectors = sectors.filter((s) => s.active !== false);
  const shown = workers.filter((w) =>
    (filterSector === "all" || w.sector_id === filterSector) &&
    (filterStatus === "all" || (filterStatus === "active" && w.active) || (filterStatus === "inactive" && !w.active)
      || (filterStatus === "On Duty" && w.active && w.status === "On Duty")) &&
    (!q.trim() || `${w.name} ${w.employee_id} ${w.phone}`.toLowerCase().includes(q.trim().toLowerCase())));

  async function act(w: Worker, body: Record<string, unknown>, label: string) {
    setBusy(w.id + label); setError(""); setInfo("");
    try {
      const r = await authFetch<{ worker: Worker; one_time_pin?: string }>(`/api/workers/${w.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setWorkers((ws) => ws.map((x) => (x.id === w.id ? { ...x, ...r.worker } : x)));
      if (r.one_time_pin) setSecret({ title: `New one-time PIN for ${w.name}`, lines: [["Employee ID", w.employee_id], ["One-time PIN", r.one_time_pin]] });
      else setInfo(`${label} done for ${w.name}.`);
      return true;
    } catch (e: any) {
      setError(e?.message ?? `${label} failed`);
      return false;
    } finally { setBusy(null); }
  }

  async function addWorker() {
    setBusy("add"); setError(""); setInfo("");
    try {
      const r = await authFetch<{ worker: Worker; one_time_pin: string }>("/api/workers", { method: "POST", body: JSON.stringify(form) });
      setWorkers((ws) => [...ws, r.worker].sort((a, b) => a.name.localeCompare(b.name)));
      setSecret({ title: `Worker "${r.worker.name}" added`, lines: [["Employee ID", r.worker.employee_id], ["One-time PIN", r.one_time_pin]] });
      setForm({ name: "", phone: "", sector_id: form.sector_id });
      setShowAdd(false);
    } catch (e: any) {
      setError(e?.message ?? "Could not add worker");
    } finally { setBusy(null); }
  }

  async function pickNearestSector() {
    setLocating(true); setError("");
    try {
      const fix = await getBestPosition(50, 10000);
      if (!activeSectors.length) throw new Error("No sectors available.");
      const nearest = activeSectors.reduce((best, s) =>
        haversineMeters(fix.lat, fix.lng, s.lat, s.lng) < haversineMeters(fix.lat, fix.lng, best.lat, best.lng) ? s : best);
      setForm((f) => ({ ...f, sector_id: nearest.id }));
      setInfo(`Nearest sector: ${nearest.area} — ${nearest.name} (${Math.round(haversineMeters(fix.lat, fix.lng, nearest.lat, nearest.lng))} m away, GPS ±${Math.round(fix.accuracy)} m).`);
    } catch (e: any) {
      setError(e?.message ?? "Could not get location");
    } finally { setLocating(false); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-blue-400 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      {info && <p className="text-sm text-eco-300">{info}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-display font-bold text-slate-100 flex items-center gap-2 mr-auto">
          <Users className="w-5 h-5 text-purple-400" /> {scope === "super" ? "All Workers" : "Sanitation Workforce"}
          <span className="badge text-xs bg-white/5 border-white/10 text-slate-400">{shown.length} shown</span>
        </h2>
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input className="input-civic py-1.5 pl-8 text-sm w-48" placeholder="Search name / ID / phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input-civic py-1.5 text-sm w-auto" value={filterSector} onChange={(e) => setFilterSector(e.target.value)}>
          <option value="all">All sectors</option>
          <SectorOptions sectors={sectors} />
        </select>
        <select className="input-civic py-1.5 text-sm w-auto" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as any)}>
          <option value="active">Active</option><option value="On Duty">On duty</option>
          <option value="inactive">Deactivated</option><option value="all">All</option>
        </select>
        <button onClick={() => { setShowAdd(true); setForm((f) => ({ ...f, sector_id: f.sector_id || activeSectors[0]?.id || "" })); }}
                disabled={!activeSectors.length} className="btn-eco py-1.5 text-sm disabled:opacity-40">
          <Plus className="w-4 h-4" /> Add Worker
        </button>
      </div>
      {!activeSectors.length && (
        <p className="text-xs text-orange-300">
          {scope === "admin" ? "No sectors are assigned to you yet. Ask the Municipal Commissioner (super admin) to assign one." : "No active sectors - re-activate one in the Sectors tab."}
        </p>
      )}

      {/* Add worker */}
      {showAdd && (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-200">Add a worker</p>
            <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid sm:grid-cols-3 gap-2">
            <input className="input-civic" placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="input-civic" placeholder="Phone (+91XXXXXXXXXX)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <select className="input-civic" value={form.sector_id} onChange={(e) => setForm({ ...form, sector_id: e.target.value })}>
              <SectorOptions sectors={activeSectors} suffix={scope === "super" ? (s) => ` · ${adminName(s.admin_id)}` : undefined} />
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={pickNearestSector} disabled={locating} className="flex items-center gap-1 text-xs text-eco-300 hover:text-eco-200">
              {locating ? <Loader2 className="w-3 h-3 animate-spin" /> : <MapPin className="w-3 h-3" />} Pick nearest sector from this device&apos;s GPS
            </button>
            <span className="text-[11px] text-slate-500 ml-auto">Employee ID and a one-time PIN are generated; the worker sets their own PIN at first login.</span>
            <button onClick={addWorker} disabled={busy === "add" || !form.name || !form.phone || !form.sector_id} className="btn-eco py-1.5 text-sm disabled:opacity-40">
              {busy === "add" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create worker
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-civic-900/80 text-xs text-slate-400">
            <tr>
              <th className="text-left p-3">Worker</th><th className="text-left p-3">Employee ID</th>
              <th className="text-left p-3">Sector</th>{scope === "super" && <th className="text-left p-3">Admin</th>}
              <th className="text-left p-3">Status</th><th className="text-left p-3">Tasks</th><th className="text-right p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => {
              const sec = w.sector_id ? sectorById[w.sector_id] : null;
              return (
                <tr key={w.id} className={cn("border-t border-white/5", !w.active && "opacity-50")}>
                  <td className="p-3"><p className="text-slate-200">{w.name}</p><p className="text-[11px] text-slate-500">{w.phone}</p></td>
                  <td className="p-3 font-mono text-xs text-slate-300">{w.employee_id}{w.must_change_pin && <span className="ml-1 text-[10px] text-orange-300">(PIN not set yet)</span>}</td>
                  <td className="p-3 text-xs text-slate-300">{sec ? `${sec.area} — ${sec.name}` : <span className="text-orange-300">Unassigned</span>}</td>
                  {scope === "super" && <td className="p-3 text-xs text-slate-300">{adminName(w.admin_id)}</td>}
                  <td className="p-3">
                    <span className={cn("badge text-[10px]", w.active ? statusColor(w.status) : "bg-slate-500/10 text-slate-400 border-slate-500/30")}>
                      {w.active ? w.status : "Deactivated"}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-slate-300">{w.tasks_completed} · ₹{Number(w.bonus_accrued ?? 0).toLocaleString()}</td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      <button title="Edit" onClick={() => setEditing({ ...w })} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-blue-300"><Pencil className="w-4 h-4" /></button>
                      <button title="Reset PIN" disabled={!w.active || busy === w.id + "Reset PIN"}
                              onClick={() => act(w, { action: "reset_pin" }, "Reset PIN")}
                              className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-yellow-300 disabled:opacity-30"><KeyRound className="w-4 h-4" /></button>
                      <button title="Transfer to another sector" disabled={!w.active}
                              onClick={() => { setTransfer(w); setTransferTo(activeSectors.find((s) => s.id !== w.sector_id)?.id ?? ""); }}
                              className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-purple-300 disabled:opacity-30"><ArrowRightLeft className="w-4 h-4" /></button>
                      {w.active ? (
                        <button title="Deactivate" disabled={busy === w.id + "Deactivate"}
                                onClick={() => { if (confirm(`Deactivate ${w.name}? They will not be able to log in.`)) act(w, { action: "deactivate" }, "Deactivate"); }}
                                className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400"><UserMinus className="w-4 h-4" /></button>
                      ) : (
                        <button title="Reactivate" onClick={() => act(w, { action: "activate" }, "Reactivate")}
                                className="p-1.5 rounded-lg hover:bg-eco-500/10 text-slate-400 hover:text-eco-300"><UserCheck className="w-4 h-4" /></button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr><td colSpan={scope === "super" ? 7 : 6} className="p-8 text-center text-slate-500">No workers match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Edit modal */}
      {editing && (
        <Modal title={`Edit ${editing.employee_id}`} onClose={() => setEditing(null)}>
          <input className="input-civic" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Full name" />
          <input className="input-civic" value={editing.phone} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} placeholder="Phone" />
          <button className="btn-eco w-full justify-center" disabled={busy === editing.id + "Update"}
                  onClick={async () => { if (await act(editing, { action: "update", name: editing.name, phone: editing.phone }, "Update")) setEditing(null); }}>
            Save changes
          </button>
        </Modal>
      )}

      {/* Transfer modal */}
      {transfer && (
        <Modal title={`Transfer ${transfer.name}`} onClose={() => setTransfer(null)}>
          <p className="text-xs text-slate-400">
            The worker will report to the new sector&apos;s admin. Their open tasks go back to the dispatch queue.
            {scope === "admin" && " You can transfer only between your own sectors; ask the super admin for other admins' sectors."}
          </p>
          <select className="input-civic" value={transferTo} onChange={(e) => setTransferTo(e.target.value)}>
            <SectorOptions sectors={activeSectors.filter((s) => s.id !== transfer.sector_id)}
                           suffix={scope === "super" ? (s) => ` · ${adminName(s.admin_id)}` : undefined} />
          </select>
          <button className="btn-eco w-full justify-center" disabled={!transferTo || busy === transfer.id + "Transfer"}
                  onClick={async () => { if (await act(transfer, { action: "transfer", sector_id: transferTo }, "Transfer")) setTransfer(null); }}>
            <ArrowRightLeft className="w-4 h-4" /> Transfer
          </button>
        </Modal>
      )}

      {/* One-time credentials (shown once) */}
      {secret && (
        <Modal title={secret.title} onClose={() => setSecret(null)}>
          <p className="text-xs text-orange-300">Give these to the worker now — the PIN is shown only once and is stored encrypted. They must set their own PIN at first login.</p>
          {secret.lines.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2">
              <span className="text-xs text-slate-400">{k}</span>
              <span className="font-mono text-lg text-eco-300 select-all">{v}</span>
              <button onClick={() => navigator.clipboard?.writeText(v)} className="text-slate-400 hover:text-white" title="Copy"><Copy className="w-4 h-4" /></button>
            </div>
          ))}
          <button className="btn-eco w-full justify-center" onClick={() => setSecret(null)}>Done</button>
        </Modal>
      )}
    </div>
  );
}

/** Dialog rendered into <body> (see Portal) so it is always centred on the screen. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md glass-card p-5 space-y-3 animate-fade-in-up">
        <div className="flex items-center justify-between">
          <h3 className="font-display font-bold text-slate-100">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5 text-slate-400" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </div>
    </Portal>
  );
}
