"use client";
import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { authFetch } from "@/lib/api";
import { ErrorNote } from "@/components/layout/ErrorNote";
import { formatDateTime } from "@/lib/utils";

interface Entry { id: string; actor_name: string | null; actor_role: string; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown> | null; created_at: string }

const ACTION_TEXT: Record<string, string> = {
  ADMIN_CREATED: "created admin", ADMIN_UPDATE: "updated admin", ADMIN_RESET_PASSWORD: "reset admin password",
  ADMIN_DEACTIVATE: "deactivated admin", ADMIN_ACTIVATE: "re-activated admin",
  SECTOR_CREATED: "created sector", SECTOR_UPDATE: "edited sector", SECTOR_REASSIGN: "reassigned sector",
  SECTOR_DEACTIVATE: "retired sector", SECTOR_ACTIVATE: "re-activated sector",
  CORPORATION_ASSIGN: "assigned a whole city corporation",
  WORKER_CREATED: "added worker", WORKER_UPDATE: "edited worker", WORKER_RESET_PIN: "reset worker PIN",
  WORKER_TRANSFER: "transferred worker", WORKER_DEACTIVATE: "deactivated worker", WORKER_ACTIVATE: "re-activated worker",
  PASSWORD_CHANGED: "changed own password", PIN_CHANGED: "changed own PIN",
};

/** Super admin: who did what, when (written by every privileged server route). */
export function AuditLog() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    try { setEntries((await authFetch<{ entries: Entry[] }>("/api/super/audit")).entries); setError(""); }
    catch (e: any) { setError(`Could not load the audit log: ${e?.message ?? e}`); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <ErrorNote message={error} onDismiss={() => setError("")} />
      <div className="flex items-center">
        <h2 className="text-xl font-display font-bold text-slate-100 mr-auto">Audit Log</h2>
        <button onClick={load} className="flex items-center gap-1 text-sm text-slate-400 hover:text-white"><RefreshCw className="w-4 h-4" /> Refresh</button>
      </div>
      {loading ? <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-amber-400 animate-spin" /></div> : (
        <div className="glass-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-civic-900/80 text-xs text-slate-400">
              <tr><th className="text-left p-3">When</th><th className="text-left p-3">Who</th><th className="text-left p-3">Action</th><th className="text-left p-3">Details</th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-white/5 align-top">
                  <td className="p-3 text-xs text-slate-400 whitespace-nowrap">{formatDateTime(e.created_at)}</td>
                  <td className="p-3 text-xs text-slate-200">{e.actor_name ?? "—"}<span className="block text-slate-500">{e.actor_role.replace("_", " ")}</span></td>
                  <td className="p-3 text-xs text-slate-300">{ACTION_TEXT[e.action] ?? e.action}<span className="block font-mono text-[10px] text-slate-500">{e.target_type} {e.target_id?.slice(0, 12)}</span></td>
                  <td className="p-3 text-[11px] font-mono text-slate-400 break-all">{e.details && Object.keys(e.details).length ? JSON.stringify(e.details) : ""}</td>
                </tr>
              ))}
              {entries.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-slate-500">No actions recorded yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
