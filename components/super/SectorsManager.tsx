"use client";
import { useEffect, useState } from "react";
import { Loader2, Plus, MapPin, ArrowRightLeft, Pencil, Archive, ArchiveRestore, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { authFetch } from "@/lib/api";
import { getBestPosition } from "@/lib/geo";
import { ErrorNote } from "@/components/layout/ErrorNote";
import { Modal } from "@/components/shared/WorkerManagement";
import { cn } from "@/lib/utils";

interface Sector { id: string; area: string; name: string; admin_id: string | null; lat: number; lng: number; active: boolean }
interface AdminLite { id: string; name: string; role: string; active: boolean }

/**
 * Super admin: sectors are the unit of control. Each sector has ONE responsible admin; its workers,
 * dump reports, cameras and violations are routed to that admin by location (nearest sector centre).
 */
export function SectorsManager() {
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [admins, setAdmins] = useState<AdminLite[]>([]);
  const [workerCount, setWorkerCount] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ area: "", name: "Sector 1", lat: "", lng: "", admin_id: "" });
  const [reassign, setReassign] = useState<Sector | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [editing, setEditing] = useState<Sector | null>(null);
  const [locating, setLocating] = useState(false);

  const cityAdmins = admins.filter((a) => a.role === "admin" && a.active);
  const adminName = (id: string | null) => admins.find((a) => a.id === id)?.name ?? "Unassigned";

  async function load() {
    setLoading(true);
    try {
      const [{ admins }, sec, wk] = await Promise.all([
        authFetch<{ admins: AdminLite[] }>("/api/super/admins"),
        supabase.from("sectors").select("id,area,name,admin_id,lat,lng,active").order("area"),
        supabase.from("workers").select("sector_id").eq("active", true),
      ]);
      if (sec.error) throw sec.error;
      if (wk.error) throw wk.error;
      setAdmins(admins);
      setSectors((sec.data ?? []) as Sector[]);
      const c: Record<string, number> = {};
      (wk.data ?? []).forEach((w: any) => { if (w.sector_id) c[w.sector_id] = (c[w.sector_id] ?? 0) + 1; });
      setWorkerCount(c);
      setError("");
    } catch (e: any) { setError(`Could not load sectors: ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function fillFromGps(target: "form" | "edit") {
    setLocating(true); setError("");
    try {
      const fix = await getBestPosition(50, 10000);
      if (target === "form") setForm((f) => ({ ...f, lat: fix.lat.toFixed(6), lng: fix.lng.toFixed(6) }));
      else setEditing((s) => (s ? { ...s, lat: Number(fix.lat.toFixed(6)), lng: Number(fix.lng.toFixed(6)) } : s));
      setInfo(`Centre set from this device's GPS (±${Math.round(fix.accuracy)} m).`);
    } catch (e: any) { setError(e?.message ?? "Could not get location"); }
    finally { setLocating(false); }
  }

  async function create() {
    setBusy("add"); setError("");
    try {
      const r = await authFetch<{ sector: Sector }>("/api/super/sectors", {
        method: "POST", body: JSON.stringify({ ...form, lat: Number(form.lat), lng: Number(form.lng), admin_id: form.admin_id || null }),
      });
      setSectors((s) => [...s, r.sector].sort((a, b) => a.area.localeCompare(b.area)));
      setInfo(`Sector ${r.sector.area} — ${r.sector.name} created (${r.sector.id}).`);
      setForm({ area: "", name: "Sector 1", lat: "", lng: "", admin_id: "" });
      setShowAdd(false);
    } catch (e: any) { setError(e?.message ?? "Could not create sector"); }
    finally { setBusy(null); }
  }

  async function act(s: Sector, body: Record<string, unknown>, label: string) {
    setBusy(s.id + label); setError(""); setInfo("");
    try {
      const r = await authFetch<{ sector: Sector; workers_moved: number }>(`/api/super/sectors/${s.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setSectors((xs) => xs.map((x) => (x.id === s.id ? r.sector : x)));
      setInfo(`${label} done for ${s.area} — ${s.name}${r.workers_moved ? ` (${r.workers_moved} worker(s) now report to ${adminName(r.sector.admin_id)})` : ""}.`);
      return true;
    } catch (e: any) { setError(e?.message ?? `${label} failed`); return false; }
    finally { setBusy(null); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-amber-400 animate-spin" /></div>;

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      {info && <p className="text-sm text-eco-300">{info}</p>}
      <div className="flex items-center">
        <div className="mr-auto">
          <h2 className="text-xl font-display font-bold text-slate-100">Sectors</h2>
          <p className="text-xs text-slate-500">Reports, violations and cameras are routed to the sector whose centre is nearest; that sector&apos;s admin controls them and its workers.</p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-eco py-1.5 text-sm"><Plus className="w-4 h-4" /> Add Sector</button>
      </div>

      {showAdd && (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-200">New sector</p>
            <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
            <input className="input-civic" placeholder="Area (e.g. Vijayanagar)" value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} />
            <input className="input-civic" placeholder="Sector name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="input-civic" placeholder="Centre latitude" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} />
            <input className="input-civic" placeholder="Centre longitude" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} />
            <select className="input-civic" value={form.admin_id} onChange={(e) => setForm({ ...form, admin_id: e.target.value })}>
              <option value="">Responsible admin (optional)</option>
              {cityAdmins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => fillFromGps("form")} disabled={locating} className="flex items-center gap-1 text-xs text-eco-300 hover:text-eco-200 mr-auto">
              {locating ? <Loader2 className="w-3 h-3 animate-spin" /> : <MapPin className="w-3 h-3" />} Use this device&apos;s GPS as the centre
            </button>
            <button onClick={create} disabled={busy === "add" || !form.area || !form.lat || !form.lng} className="btn-eco py-1.5 text-sm disabled:opacity-40">
              {busy === "add" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create sector
            </button>
          </div>
        </div>
      )}

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-civic-900/80 text-xs text-slate-400">
            <tr><th className="text-left p-3">Sector</th><th className="text-left p-3">Centre</th><th className="text-left p-3">Responsible admin</th><th className="p-3">Active workers</th><th className="text-right p-3">Actions</th></tr>
          </thead>
          <tbody>
            {sectors.map((s) => (
              <tr key={s.id} className={cn("border-t border-white/5", !s.active && "opacity-50")}>
                <td className="p-3 text-slate-200">{s.area} — {s.name}{!s.active && " (retired)"}<span className="block text-[10px] font-mono text-slate-500">{s.id}</span></td>
                <td className="p-3 font-mono text-[11px] text-slate-400">{Number(s.lat).toFixed(5)}, {Number(s.lng).toFixed(5)}</td>
                <td className={cn("p-3 text-xs", s.admin_id ? "text-slate-300" : "text-orange-300")}>{adminName(s.admin_id)}</td>
                <td className="p-3 text-center text-slate-300">{workerCount[s.id] ?? 0}</td>
                <td className="p-3">
                  <div className="flex justify-end gap-1">
                    <button title="Edit name / centre" onClick={() => setEditing({ ...s })} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-blue-300"><Pencil className="w-4 h-4" /></button>
                    <button title="Assign / reassign admin" disabled={!s.active}
                            onClick={() => { setReassign(s); setReassignTo(cityAdmins.find((a) => a.id !== s.admin_id)?.id ?? ""); }}
                            className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-purple-300 disabled:opacity-30"><ArrowRightLeft className="w-4 h-4" /></button>
                    {s.active ? (
                      <button title="Retire sector" onClick={() => { if (confirm(`Retire ${s.area} — ${s.name}? New reports will no longer be routed here.`)) act(s, { action: "deactivate" }, "Retire"); }}
                              className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400"><Archive className="w-4 h-4" /></button>
                    ) : (
                      <button title="Re-activate sector" onClick={() => act(s, { action: "activate" }, "Re-activate")}
                              className="p-1.5 rounded-lg hover:bg-eco-500/10 text-slate-400 hover:text-eco-300"><ArchiveRestore className="w-4 h-4" /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {reassign && (
        <Modal title={`Assign admin for ${reassign.area} — ${reassign.name}`} onClose={() => setReassign(null)}>
          <p className="text-xs text-slate-400">Currently: <strong className="text-slate-200">{adminName(reassign.admin_id)}</strong>. The sector&apos;s {workerCount[reassign.id] ?? 0} worker(s), reports and violations move to the new admin.</p>
          <select className="input-civic" value={reassignTo} onChange={(e) => setReassignTo(e.target.value)}>
            {cityAdmins.filter((a) => a.id !== reassign.admin_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button className="btn-eco w-full justify-center" disabled={!reassignTo || busy === reassign.id + "Reassign"}
                  onClick={async () => { if (await act(reassign, { action: "reassign", admin_id: reassignTo }, "Reassign")) setReassign(null); }}>
            <ArrowRightLeft className="w-4 h-4" /> Assign
          </button>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.id}`} onClose={() => setEditing(null)}>
          <input className="input-civic" value={editing.area} onChange={(e) => setEditing({ ...editing, area: e.target.value })} placeholder="Area" />
          <input className="input-civic" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Sector name" />
          <div className="grid grid-cols-2 gap-2">
            <input className="input-civic" value={editing.lat} onChange={(e) => setEditing({ ...editing, lat: e.target.value as any })} placeholder="Latitude" />
            <input className="input-civic" value={editing.lng} onChange={(e) => setEditing({ ...editing, lng: e.target.value as any })} placeholder="Longitude" />
          </div>
          <button onClick={() => fillFromGps("edit")} disabled={locating} className="flex items-center gap-1 text-xs text-eco-300 hover:text-eco-200">
            {locating ? <Loader2 className="w-3 h-3 animate-spin" /> : <MapPin className="w-3 h-3" />} Use this device&apos;s GPS
          </button>
          <button className="btn-eco w-full justify-center" disabled={busy === editing.id + "Update"}
                  onClick={async () => { if (await act(editing, { action: "update", area: editing.area, name: editing.name, lat: Number(editing.lat), lng: Number(editing.lng) }, "Update")) setEditing(null); }}>
            Save changes
          </button>
        </Modal>
      )}
    </div>
  );
}
