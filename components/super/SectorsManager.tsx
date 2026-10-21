"use client";
import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, MapPin, ArrowRightLeft, Pencil, Archive, ArchiveRestore, X, Search, UserPlus, Building2 } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { authFetch } from "@/lib/api";
import { getBestPosition } from "@/lib/geo";
import { ErrorNote } from "@/components/layout/ErrorNote";
import { Modal } from "@/components/shared/WorkerManagement";
import { groupByCorporation, corpLabel } from "@/components/shared/SectorOptions";
import { cn } from "@/lib/utils";

interface Sector { id: string; area: string; name: string; corporation: string | null; admin_id: string | null; lat: number; lng: number; active: boolean }
interface AdminLite { id: string; name: string; role: string; active: boolean }
interface WorkerLite { id: string; name: string; employee_id: string; sector_id: string | null; active: boolean }

const validCentre = (lat: unknown, lng: unknown) => {
  if (String(lat ?? "").trim() === "" || String(lng ?? "").trim() === "") return false;
  const a = Number(lat), o = Number(lng);
  return Number.isFinite(a) && Number.isFinite(o) && Math.abs(a) <= 90 && Math.abs(o) <= 180 && !(a === 0 && o === 0);
};

/**
 * Super admin: Bengaluru is pre-divided into sectors (real localities with OpenStreetMap centres,
 * grouped by city corporation - migrations/005). The job here is ASSIGNMENT: one responsible admin
 * per sector (or per whole corporation), and workers into sectors. Reports, cameras and violations
 * are routed to the nearest active sector centre, so that sector's admin controls them.
 */
export function SectorsManager() {
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [admins, setAdmins] = useState<AdminLite[]>([]);
  const [workers, setWorkers] = useState<WorkerLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [corpFilter, setCorpFilter] = useState("all");
  const [showRetired, setShowRetired] = useState(false);
  const [corpAssign, setCorpAssign] = useState<Record<string, string>>({});
  const [reassign, setReassign] = useState<Sector | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [assignWorkers, setAssignWorkers] = useState<Sector | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [workerQ, setWorkerQ] = useState("");
  const [editing, setEditing] = useState<Sector | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ area: "", name: "Sector 1", corporation: "", lat: "", lng: "", admin_id: "" });
  const [locating, setLocating] = useState(false);

  const cityAdmins = admins.filter((a) => a.role === "admin" && a.active);
  const adminName = (id: string | null) => admins.find((a) => a.id === id)?.name ?? "Unassigned";
  const sectorLabel = (id: string | null) => { const s = sectors.find((x) => x.id === id); return s ? `${s.area} — ${s.name}` : "Unassigned"; };
  const workerCount = useMemo(() => {
    const c: Record<string, number> = {};
    workers.forEach((w) => { if (w.active && w.sector_id) c[w.sector_id] = (c[w.sector_id] ?? 0) + 1; });
    return c;
  }, [workers]);
  const corporations = useMemo(() => groupByCorporation(sectors).map(([c]) => c), [sectors]);

  async function load() {
    setLoading(true);
    try {
      const [{ admins }, sec, wk] = await Promise.all([
        authFetch<{ admins: AdminLite[] }>("/api/super/admins"),
        supabase.from("sectors").select("id,area,name,corporation,admin_id,lat,lng,active").order("area"),
        supabase.from("workers").select("id,name,employee_id,sector_id,active").order("name"),
      ]);
      if (sec.error) throw sec.error;
      if (wk.error) throw wk.error;
      setAdmins(admins);
      setSectors((sec.data ?? []) as Sector[]);
      setWorkers((wk.data ?? []) as WorkerLite[]);
      setError("");
    } catch (e: any) { setError(`Could not load sectors: ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  const shown = sectors.filter((s) =>
    (showRetired || s.active) &&
    (corpFilter === "all" || (s.corporation || "Other") === corpFilter) &&
    (!q.trim() || `${s.area} ${s.name} ${s.id} ${adminName(s.admin_id)}`.toLowerCase().includes(q.trim().toLowerCase())));
  const groups = groupByCorporation(shown);

  async function act(s: Sector, body: Record<string, unknown>, label: string) {
    setBusy(s.id + label); setError(""); setInfo("");
    try {
      const r = await authFetch<{ sector: Sector; workers_moved: number; rerouted?: { to: string; reports: number; violations: number } }>(
        `/api/super/sectors/${s.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setSectors((xs) => xs.map((x) => (x.id === s.id ? r.sector : x)));
      const moved = r.workers_moved ? ` (${r.workers_moved} worker(s) now report to ${adminName(r.sector.admin_id)})` : "";
      const handed = r.rerouted && (r.rerouted.reports || r.rerouted.violations)
        ? ` Open work handed to ${sectorLabel(r.rerouted.to)}: ${r.rerouted.reports} report(s), ${r.rerouted.violations} violation(s).` : "";
      setInfo(`${label} done for ${s.area} — ${s.name}${moved}.${handed}`);
      return true;
    } catch (e: any) { setError(e?.message ?? `${label} failed`); return false; }
    finally { setBusy(null); }
  }

  async function assignCorporation(corporation: string) {
    const adminId = corpAssign[corporation];
    if (!adminId) return;
    const n = sectors.filter((s) => s.active && (s.corporation || "Other") === corporation).length;
    if (!confirm(`Assign all ${n} active sectors of ${corpLabel(corporation)} to ${adminName(adminId)}? Their workers will report to this admin.`)) return;
    setBusy("corp" + corporation); setError(""); setInfo("");
    try {
      const r = await authFetch<{ sectors_assigned: number; workers_moved: number }>("/api/super/sectors", {
        method: "PATCH", body: JSON.stringify({ corporation, admin_id: adminId }),
      });
      setSectors((xs) => xs.map((x) => (x.active && (x.corporation || "Other") === corporation ? { ...x, admin_id: adminId } : x)));
      setInfo(`${corpLabel(corporation)}: ${r.sectors_assigned} sector(s) and ${r.workers_moved} worker(s) now under ${adminName(adminId)}.`);
    } catch (e: any) { setError(e?.message ?? "Assignment failed"); }
    finally { setBusy(null); }
  }

  async function moveWorkersIn() {
    if (!assignWorkers || !picked.length) return;
    const target = assignWorkers;
    setBusy("workers"); setError(""); setInfo("");
    const done: string[] = []; const failed: string[] = [];
    for (const id of picked) {
      try {
        await authFetch(`/api/workers/${id}`, { method: "PATCH", body: JSON.stringify({ action: "transfer", sector_id: target.id }) });
        done.push(id);
      } catch (e: any) { failed.push(`${workers.find((w) => w.id === id)?.name ?? id}: ${e?.message ?? "failed"}`); }
    }
    setWorkers((ws) => ws.map((w) => (done.includes(w.id) ? { ...w, sector_id: target.id } : w)));
    if (done.length) setInfo(`${done.length} worker(s) assigned to ${target.area} — ${target.name}; they now report to ${adminName(target.admin_id)}.`);
    if (failed.length) setError(failed.join(" · "));
    setBusy(null); setAssignWorkers(null); setPicked([]);
  }

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
      setSectors((s) => [...s, r.sector]);
      setInfo(`Custom sector ${r.sector.area} — ${r.sector.name} created (${r.sector.id}).`);
      setForm({ area: "", name: "Sector 1", corporation: "", lat: "", lng: "", admin_id: "" });
      setShowAdd(false);
    } catch (e: any) { setError(e?.message ?? "Could not create sector"); }
    finally { setBusy(null); }
  }

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-amber-400 animate-spin" /></div>;

  const activeCount = sectors.filter((s) => s.active).length;
  const unassigned = sectors.filter((s) => s.active && !s.admin_id).length;
  const candidates = assignWorkers
    ? workers.filter((w) => w.active && w.sector_id !== assignWorkers.id &&
        (!workerQ.trim() || `${w.name} ${w.employee_id}`.toLowerCase().includes(workerQ.trim().toLowerCase())))
    : [];

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      {info && <p className="text-sm text-eco-300">{info}</p>}

      <div>
        <h2 className="text-xl font-display font-bold text-slate-100">Bengaluru Sectors</h2>
        <p className="text-xs text-slate-500">
          The city is pre-divided into {activeCount} active sectors across {corporations.length} city corporations, each centred on its real
          locality (OpenStreetMap). Assign an admin to each sector or a whole corporation, then assign workers to sectors.
          Reports, cameras and violations go to the nearest sector&apos;s admin.
          {unassigned > 0 && <span className="text-orange-300"> {unassigned} sector(s) have no admin yet.</span>}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input className="input-civic py-1.5 pl-8 text-sm w-56" placeholder="Search locality / ID / admin" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input-civic py-1.5 text-sm w-auto" value={corpFilter} onChange={(e) => setCorpFilter(e.target.value)}>
          <option value="all">All corporations</option>
          {corporations.map((c) => <option key={c} value={c}>{corpLabel(c)}</option>)}
        </select>
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired
        </label>
      </div>

      {groups.map(([corp, xs]) => {
        const owners = Array.from(new Set(xs.filter((s) => s.active).map((s) => adminName(s.admin_id))));
        return (
          <div key={corp} className="glass-card overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 p-3 bg-civic-900/60 border-b border-white/5">
              <Building2 className="w-4 h-4 text-amber-400" />
              <div className="mr-auto">
                <p className="text-sm font-semibold text-slate-100">{corp} <span className="text-xs text-slate-500">· {xs.length} sector(s)</span></p>
                <p className="text-[11px] text-slate-500">Admins: {owners.join(", ") || "—"}</p>
              </div>
              <select className="input-civic py-1 text-xs w-auto" value={corpAssign[corp] ?? ""} onChange={(e) => setCorpAssign({ ...corpAssign, [corp]: e.target.value })}>
                <option value="">Assign whole corporation to…</option>
                {cityAdmins.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button onClick={() => assignCorporation(corp)} disabled={!corpAssign[corp] || busy === "corp" + corp} className="btn-eco py-1 text-xs disabled:opacity-40">
                {busy === "corp" + corp ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRightLeft className="w-3 h-3" />} Assign
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400">
                  <tr><th className="text-left p-3">Sector</th><th className="text-left p-3">Centre</th><th className="text-left p-3">Responsible admin</th><th className="p-3">Workers</th><th className="text-right p-3">Actions</th></tr>
                </thead>
                <tbody>
                  {xs.map((s) => (
                    <tr key={s.id} className={cn("border-t border-white/5", !s.active && "opacity-50")}>
                      <td className="p-3 text-slate-200">{s.area} — {s.name}{!s.active && " (retired)"}<span className="block text-[10px] font-mono text-slate-500">{s.id}</span></td>
                      <td className="p-3 font-mono text-[11px]">
                        <a className="text-slate-400 hover:text-eco-300" target="_blank" rel="noreferrer"
                           href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=15/${s.lat}/${s.lng}`}>
                          {Number(s.lat).toFixed(5)}, {Number(s.lng).toFixed(5)}
                        </a>
                      </td>
                      <td className={cn("p-3 text-xs", s.admin_id ? "text-slate-300" : "text-orange-300")}>{adminName(s.admin_id)}</td>
                      <td className="p-3 text-center text-slate-300">{workerCount[s.id] ?? 0}</td>
                      <td className="p-3">
                        <div className="flex justify-end gap-1">
                          <button title="Assign / reassign admin" disabled={!s.active}
                                  onClick={() => { setReassign(s); setReassignTo(cityAdmins.find((a) => a.id !== s.admin_id)?.id ?? ""); }}
                                  className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-purple-300 disabled:opacity-30"><ArrowRightLeft className="w-4 h-4" /></button>
                          <button title="Assign workers to this sector" disabled={!s.active || !s.admin_id}
                                  onClick={() => { setAssignWorkers(s); setPicked([]); setWorkerQ(""); }}
                                  className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-eco-300 disabled:opacity-30"><UserPlus className="w-4 h-4" /></button>
                          <button title="Edit name / centre" onClick={() => setEditing({ ...s })} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-blue-300"><Pencil className="w-4 h-4" /></button>
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
          </div>
        );
      })}
      {groups.length === 0 && <p className="text-center text-sm text-slate-500 py-8">No sectors match these filters.</p>}

      {/* Custom sector: secondary, only for localities not already covered */}
      {!showAdd ? (
        <button onClick={() => setShowAdd(true)} className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
          <Plus className="w-3 h-3" /> Locality not listed? Add a custom sector
        </button>
      ) : (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-200">Custom sector</p>
            <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            <input className="input-civic" placeholder="Locality (e.g. Hennur)" value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} />
            <input className="input-civic" placeholder="Sector name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <select className="input-civic" value={form.corporation} onChange={(e) => setForm({ ...form, corporation: e.target.value })}>
              <option value="">City corporation</option>
              {corporations.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
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
            <button onClick={create} disabled={busy === "add" || !form.area.trim() || !validCentre(form.lat, form.lng)} className="btn-eco py-1.5 text-sm disabled:opacity-40">
              {busy === "add" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create sector
            </button>
          </div>
        </div>
      )}

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

      {assignWorkers && (
        <Modal title={`Assign workers to ${assignWorkers.area} — ${assignWorkers.name}`} onClose={() => setAssignWorkers(null)}>
          <p className="text-xs text-slate-400">
            Selected workers move to this sector and report to <strong className="text-slate-200">{adminName(assignWorkers.admin_id)}</strong>.
            Their open tasks go back to the dispatch queue. New workers are added from the Workers tab.
          </p>
          <input className="input-civic py-1.5 text-sm" placeholder="Search name / employee ID" value={workerQ} onChange={(e) => setWorkerQ(e.target.value)} />
          <div className="max-h-64 overflow-y-auto space-y-1">
            {candidates.map((w) => (
              <label key={w.id} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm cursor-pointer">
                <input type="checkbox" checked={picked.includes(w.id)}
                       onChange={(e) => setPicked((p) => (e.target.checked ? [...p, w.id] : p.filter((x) => x !== w.id)))} />
                <span className="text-slate-200">{w.name}</span>
                <span className="font-mono text-[11px] text-slate-500">{w.employee_id}</span>
                <span className="ml-auto text-[11px] text-slate-500">{sectorLabel(w.sector_id)}</span>
              </label>
            ))}
            {candidates.length === 0 && <p className="text-xs text-slate-500 text-center py-4">No other active workers.</p>}
          </div>
          <button className="btn-eco w-full justify-center disabled:opacity-40" disabled={!picked.length || busy === "workers"} onClick={moveWorkersIn}>
            {busy === "workers" ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />} Assign {picked.length || ""} worker(s)
          </button>
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.id}`} onClose={() => setEditing(null)}>
          <input className="input-civic" value={editing.area} onChange={(e) => setEditing({ ...editing, area: e.target.value })} placeholder="Area" />
          <input className="input-civic" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Sector name" />
          <select className="input-civic" value={editing.corporation ?? ""} onChange={(e) => setEditing({ ...editing, corporation: e.target.value || null })}>
            <option value="">City corporation</option>
            {corporations.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input className="input-civic" value={editing.lat} onChange={(e) => setEditing({ ...editing, lat: e.target.value as any })} placeholder="Latitude" />
            <input className="input-civic" value={editing.lng} onChange={(e) => setEditing({ ...editing, lng: e.target.value as any })} placeholder="Longitude" />
          </div>
          <button onClick={() => fillFromGps("edit")} disabled={locating} className="flex items-center gap-1 text-xs text-eco-300 hover:text-eco-200">
            {locating ? <Loader2 className="w-3 h-3 animate-spin" /> : <MapPin className="w-3 h-3" />} Use this device&apos;s GPS
          </button>
          <button className="btn-eco w-full justify-center disabled:opacity-40"
                  disabled={busy === editing.id + "Update" || !String(editing.area).trim() || !validCentre(editing.lat, editing.lng)}
                  onClick={async () => { if (await act(editing, { action: "update", area: editing.area, name: editing.name, corporation: editing.corporation ?? "", lat: Number(editing.lat), lng: Number(editing.lng) }, "Update")) setEditing(null); }}>
            Save changes
          </button>
        </Modal>
      )}
    </div>
  );
}
