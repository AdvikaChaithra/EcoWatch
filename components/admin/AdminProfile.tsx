"use client";
import { useState, useEffect } from "react";
import { Shield, Mail, Badge, MapPin, Clock, Activity, Loader2, RefreshCw } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useEcoStore } from "@/lib/store";
import { cn, formatDateTime } from "@/lib/utils";
import { ACTION_TEXT } from "@/components/super/AuditLog";

// FIX 1: Removed last_login — column does not exist in schema.sql
interface AdminProfile {
  id: string; name: string; email: string; admin_id: string;
  ward_jurisdiction: string; designation: string; created_at: string;
}

interface AuditEntry {
  action: string; entity: string; timestamp: string; type: "violation" | "report" | "dispatch" | "verify";
}

export function AdminProfile() {
  const user = useEcoStore((s) => s.currentUser);
  const [profile, setProfile] = useState<AdminProfile | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // FIX 2: avgResponseH removed — no DB source; totalActions no longer has fake +12
  const [stats, setStats] = useState({ totalActions: 0, disputesResolved: 0, workersSupervised: 0 });

  useEffect(() => { loadProfile(); }, [user]); // eslint-disable-line

  async function loadProfile() {
    if (!user?.id) { setLoading(false); return; }
    setLoading(true);
    try {
      // Everything here is about THIS admin: their account, their workers, their recorded actions.
      const [admRes, actions, resolved, workers, recent] = await Promise.all([
        supabase.from("admins").select("id,name,email,admin_id,ward_jurisdiction,designation,created_at").eq("id", user.id).maybeSingle(),
        supabase.from("audit_log").select("id", { count: "exact", head: true }).eq("actor_id", user.id),
        supabase.from("violations").select("id", { count: "exact", head: true }).eq("reviewed_by", user.id).in("status", ["Dismissed", "Upheld"]),
        supabase.from("workers").select("id", { count: "exact", head: true }).eq("admin_id", user.id).eq("active", true),
        supabase.from("audit_log").select("action,target_type,details,created_at").eq("actor_id", user.id)
          .order("created_at", { ascending: false }).limit(10),
      ]);
      if (admRes.data) setProfile(admRes.data);
      setStats({
        totalActions:      actions.count ?? 0,
        disputesResolved:  resolved.count ?? 0,
        workersSupervised: workers.count ?? 0,
      });
      setAuditLog((recent.data ?? []).map((e: { action: string; target_type: string | null; details: Record<string, unknown> | null; created_at: string }) => {
        const d = e.details ?? {};
        const what = [d.worker, d.category, d.email, d.employee_id, d.area, d.reason].filter(Boolean).join(" · ");
        const type: AuditEntry["type"] = e.action.startsWith("REPORT_") ? "verify"
          : e.action.startsWith("WORKER_") ? "dispatch"
          : e.action.startsWith("EVENT_") ? "violation" : "report";
        return { action: ACTION_TEXT[e.action] ?? e.action, entity: what || (e.target_type ?? ""), timestamp: e.created_at, type };
      }));
    } catch (e: any) {
      console.warn("[AdminProfile] could not load profile:", e?.message);
    } finally { setLoading(false); }
  }

  const AUDIT_COLORS: Record<string, string> = {
    violation: "bg-red-500/10 text-red-400 border-red-500/20",
    report:    "bg-orange-500/10 text-orange-400 border-orange-500/20",
    dispatch:  "bg-blue-500/10 text-blue-400 border-blue-500/20",
    verify:    "bg-eco-500/10 text-eco-400 border-eco-500/20",
  };

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 text-blue-400 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      {/* Officer Card */}
      <div className="glass-card p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-600 to-blue-400 flex items-center justify-center text-3xl font-bold text-white shadow-lg">
            {profile?.name?.[0] ?? "A"}
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="font-display text-2xl font-bold text-slate-100">{profile?.name ?? "—"}</h2>
              <span className="badge bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs">
                <Shield className="w-3 h-3" /> {profile?.designation ?? "Admin Officer"}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
              {[
                { icon: Mail,   label: "Email",        value: profile?.email       },
                { icon: Badge,  label: "Admin ID",     value: profile?.admin_id    },
                { icon: MapPin, label: "Jurisdiction", value: profile?.ward_jurisdiction },
                { icon: Clock,  label: "Member Since", value: profile?.created_at ? new Date(profile.created_at).toLocaleDateString("en-IN", { year: "numeric", month: "long" }) : "—" },
              ].map(({ icon: Icon, label, value }) => (
                <div key={label} className="flex items-center gap-2.5">
                  <Icon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="text-xs text-slate-400">{label}:</span>
                  <span className="text-xs font-medium text-slate-200 truncate">{value ?? "—"}</span>
                </div>
              ))}
            </div>
          </div>
          <button onClick={loadProfile} className="p-2 rounded-xl hover:bg-white/5 text-slate-400">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* KPI Stats — FIX 2: removed avgResponseH (no DB source) */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: "My Recorded Actions",       value: stats.totalActions,      color: "text-blue-400",   bg: "bg-blue-500/10  border-blue-500/20"   },
          { label: "Disputes I Resolved",       value: stats.disputesResolved,  color: "text-eco-400",    bg: "bg-eco-500/10   border-eco-500/20"    },
          { label: "Active Workers I Supervise", value: stats.workersSupervised, color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
        ].map(({ label, value, color, bg }) => (
          <div key={label} className={cn("glass-card p-4 border rounded-2xl", bg)}>
            <p className="text-xs text-slate-400">{label}</p>
            <p className={cn("font-display text-2xl font-bold mt-1", color)}>{value}</p>
          </div>
        ))}
      </div>

      {/* Audit Log */}
      <div className="glass-card p-5">
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-blue-400" />
          <h3 className="font-display font-semibold text-slate-100">My Recent Actions</h3>
          <span className="badge bg-blue-500/10 text-blue-400 border-blue-500/20 text-xs ml-auto">{auditLog.length} recent actions</span>
        </div>
        <div className="space-y-2">
          {auditLog.length === 0 ? (
            <div className="text-center text-slate-500 py-6 space-y-1">
              <p className="text-sm">No actions recorded yet</p>
              <p className="text-xs">Approving cleanups, managing workers and reviewing camera events are recorded here.</p>
            </div>
          ) : auditLog.map((entry, i) => (
            <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-white/3 border border-white/5 hover:border-white/10 transition-colors">
              <span className={cn("badge text-[10px] shrink-0 mt-0.5", AUDIT_COLORS[entry.type])}>{entry.type}</span>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-200 font-medium truncate">{entry.action}</p>
                <p className="text-[10px] text-slate-500 mt-0.5 truncate">{entry.entity}</p>
              </div>
              <span className="text-[10px] text-slate-500 whitespace-nowrap shrink-0">{formatDateTime(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
