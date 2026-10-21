"use client";
import { useEffect, useState } from "react";
import { Loader2, Plus, KeyRound, UserMinus, UserCheck, Pencil, Copy, X } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { authFetch } from "@/lib/api";
import { ErrorNote } from "@/components/layout/ErrorNote";
import { Modal } from "@/components/shared/WorkerManagement";
import { cn, formatDate } from "@/lib/utils";

interface Admin {
  id: string; name: string; email: string; phone: string | null; admin_id: string; ward_jurisdiction: string | null;
  designation: string | null; role: string; active: boolean; must_change_password: boolean; created_at: string;
}

/** Super admin: create and control municipal admin accounts. */
export function AdminsManager() {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [sectorsByAdmin, setSectorsByAdmin] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", designation: "Ward Officer", phone: "", ward_jurisdiction: "" });
  const [editing, setEditing] = useState<Admin | null>(null);
  const [secret, setSecret] = useState<{ title: string; email: string; password: string } | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [{ admins }, sec] = await Promise.all([
        authFetch<{ admins: Admin[] }>("/api/super/admins"),
        supabase.from("sectors").select("id,area,name,admin_id,active").eq("active", true),
      ]);
      if (sec.error) throw sec.error;
      setAdmins(admins);
      const map: Record<string, string[]> = {};
      (sec.data ?? []).forEach((s: any) => { if (s.admin_id) (map[s.admin_id] ??= []).push(`${s.area} — ${s.name}`); });
      setSectorsByAdmin(map);
      setError("");
    } catch (e: any) { setError(`Could not load admins: ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function create() {
    setBusy("add"); setError("");
    try {
      const r = await authFetch<{ admin: Admin; temporary_password: string }>("/api/super/admins", { method: "POST", body: JSON.stringify(form) });
      setAdmins((a) => [...a, r.admin]);
      setSecret({ title: `Admin account created for ${r.admin.name}`, email: r.admin.email, password: r.temporary_password });
      setForm({ name: "", email: "", designation: "Ward Officer", phone: "", ward_jurisdiction: "" });
      setShowAdd(false);
    } catch (e: any) { setError(e?.message ?? "Could not create admin"); }
    finally { setBusy(null); }
  }

  async function act(a: Admin, body: Record<string, unknown>, label: string) {
    setBusy(a.id + label); setError(""); setInfo("");
    try {
      const r = await authFetch<{ admin: Admin; temporary_password?: string }>(`/api/super/admins/${a.id}`, { method: "PATCH", body: JSON.stringify(body) });
      setAdmins((xs) => xs.map((x) => (x.id === a.id ? r.admin : x)));
      if (r.temporary_password) setSecret({ title: `Password reset for ${a.name}`, email: a.email, password: r.temporary_password });
      else setInfo(`${label} done for ${a.name}.`);
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
        <h2 className="text-xl font-display font-bold text-slate-100 mr-auto">Municipal Admins</h2>
        <button onClick={() => setShowAdd(true)} className="btn-eco py-1.5 text-sm"><Plus className="w-4 h-4" /> Add Admin</button>
      </div>

      {showAdd && (
        <div className="glass-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-200">New admin account</p>
            <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-white"><X className="w-4 h-4" /></button>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
            <input className="input-civic" placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <input className="input-civic" placeholder="Official email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <input className="input-civic" placeholder="Designation" value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} />
            <input className="input-civic" placeholder="Phone (optional)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <input className="input-civic" placeholder="Jurisdiction (e.g. West Zone)" value={form.ward_jurisdiction} onChange={(e) => setForm({ ...form, ward_jurisdiction: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <p className="text-[11px] text-slate-500 mr-auto">A temporary password is generated; the admin must change it at first login. Assign sectors in the Sectors tab.</p>
            <button onClick={create} disabled={busy === "add" || !form.name || !form.email} className="btn-eco py-1.5 text-sm disabled:opacity-40">
              {busy === "add" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create admin
            </button>
          </div>
        </div>
      )}

      <div className="glass-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-civic-900/80 text-xs text-slate-400">
            <tr><th className="text-left p-3">Admin</th><th className="text-left p-3">Designation</th><th className="text-left p-3">Sectors</th><th className="text-left p-3">Status</th><th className="text-right p-3">Actions</th></tr>
          </thead>
          <tbody>
            {admins.map((a) => {
              const isSuper = a.role === "super_admin";
              const owned = sectorsByAdmin[a.id] ?? [];
              return (
                <tr key={a.id} className={cn("border-t border-white/5", !a.active && "opacity-50")}>
                  <td className="p-3"><p className="text-slate-200">{a.name}{isSuper && <span className="ml-2 badge text-[10px] bg-amber-500/10 text-amber-300 border-amber-500/30">Super Admin</span>}</p>
                    <p className="text-[11px] text-slate-500">{a.email}{a.phone ? ` · ${a.phone}` : ""} · since {formatDate(a.created_at)}</p></td>
                  <td className="p-3 text-xs text-slate-300">{a.designation ?? "—"}<span className="block text-slate-500">{a.ward_jurisdiction ?? ""}</span></td>
                  <td className="p-3 text-xs text-slate-300">{isSuper ? "All (city-wide)" : owned.length ? owned.join(", ") : <span className="text-orange-300">None assigned</span>}</td>
                  <td className="p-3 text-xs">
                    <span className={cn("badge text-[10px]", a.active ? "bg-eco-500/10 text-eco-300 border-eco-500/30" : "bg-slate-500/10 text-slate-400 border-slate-500/30")}>{a.active ? "Active" : "Deactivated"}</span>
                    {a.must_change_password && <span className="block mt-1 text-[10px] text-orange-300">Password not set yet</span>}
                  </td>
                  <td className="p-3">
                    <div className="flex justify-end gap-1">
                      <button title="Edit" onClick={() => setEditing({ ...a })} className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-blue-300"><Pencil className="w-4 h-4" /></button>
                      {!isSuper && (<>
                        <button title="Reset password" disabled={!a.active} onClick={() => act(a, { action: "reset_password" }, "Reset password")}
                                className="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-yellow-300 disabled:opacity-30"><KeyRound className="w-4 h-4" /></button>
                        {a.active ? (
                          <button title={owned.length ? "Reassign this admin's sectors before deactivating" : "Deactivate"}
                                  onClick={() => { if (confirm(`Deactivate ${a.name}? They will not be able to log in.`)) act(a, { action: "deactivate" }, "Deactivate"); }}
                                  className="p-1.5 rounded-lg hover:bg-red-500/10 text-slate-400 hover:text-red-400"><UserMinus className="w-4 h-4" /></button>
                        ) : (
                          <button title="Reactivate" onClick={() => act(a, { action: "activate" }, "Reactivate")}
                                  className="p-1.5 rounded-lg hover:bg-eco-500/10 text-slate-400 hover:text-eco-300"><UserCheck className="w-4 h-4" /></button>
                        )}
                      </>)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <input className="input-civic" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Full name" />
          <input className="input-civic" value={editing.designation ?? ""} onChange={(e) => setEditing({ ...editing, designation: e.target.value })} placeholder="Designation" />
          <input className="input-civic" value={editing.phone ?? ""} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} placeholder="Phone" />
          <input className="input-civic" value={editing.ward_jurisdiction ?? ""} onChange={(e) => setEditing({ ...editing, ward_jurisdiction: e.target.value })} placeholder="Jurisdiction" />
          <p className="text-[11px] text-slate-500">Email is the login ID and cannot be changed here.</p>
          <button className="btn-eco w-full justify-center" disabled={busy === editing.id + "Update"}
                  onClick={async () => {
                    if (await act(editing, { action: "update", name: editing.name, designation: editing.designation ?? "", phone: editing.phone ?? "", ward_jurisdiction: editing.ward_jurisdiction ?? "" }, "Update")) setEditing(null);
                  }}>Save changes</button>
        </Modal>
      )}

      {secret && (
        <Modal title={secret.title} onClose={() => setSecret(null)}>
          <p className="text-xs text-orange-300">Share these with the admin securely. The temporary password is shown only once; they must change it at first login.</p>
          {([["Login email", secret.email], ["Temporary password", secret.password]] as const).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 gap-3">
              <span className="text-xs text-slate-400">{k}</span>
              <span className="font-mono text-sm text-eco-300 select-all break-all">{v}</span>
              <button onClick={() => navigator.clipboard?.writeText(v)} className="text-slate-400 hover:text-white" title="Copy"><Copy className="w-4 h-4" /></button>
            </div>
          ))}
          <button className="btn-eco w-full justify-center" onClick={() => setSecret(null)}>Done</button>
        </Modal>
      )}
    </div>
  );
}
