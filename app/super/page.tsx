"use client";
import { useState } from "react";
import { Crown, LayoutDashboard, UserCog, Map, Users, ScrollText } from "lucide-react";
import { SuperOverview } from "@/components/super/SuperOverview";
import { AdminsManager } from "@/components/super/AdminsManager";
import { SectorsManager } from "@/components/super/SectorsManager";
import { AuditLog } from "@/components/super/AuditLog";
import { WorkerManagement } from "@/components/shared/WorkerManagement";
import { cn } from "@/lib/utils";
import { KeepAliveTabs } from "@/components/shared/KeepAliveTabs";

const TABS = [
  { id: "overview", label: "Overview",  icon: LayoutDashboard },
  { id: "admins",   label: "Admins",    icon: UserCog },
  { id: "sectors",  label: "Sectors",   icon: Map },
  { id: "workers",  label: "Workers",   icon: Users },
  { id: "audit",    label: "Audit Log", icon: ScrollText },
] as const;
type Tab = typeof TABS[number]["id"];

export default function SuperAdminPortal() {
  const [tab, setTab] = useState<Tab>("overview");
  return (
    <div className="max-w-[1500px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center gap-3 mb-8">
        <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/30">
          <Crown className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h1 className="font-display text-3xl font-bold text-slate-100">Super Admin Portal</h1>
          <p className="text-slate-400 text-sm mt-0.5">Municipal Commissioner · manage admins, sectors and the city-wide workforce</p>
        </div>
      </div>

      <div className="flex gap-1 p-1 bg-civic-900/60 rounded-2xl border border-white/8 mb-8 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} id={`super-tab-${id}`} onClick={() => setTab(id)}
                  className={cn("flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap flex-1 justify-center transition-all",
                    tab === id ? "bg-amber-500/15 text-amber-300 border border-amber-500/25" : "text-slate-400 hover:text-slate-200 hover:bg-white/5")}>
            <Icon className="w-4 h-4" /><span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      <div className="animate-fade-in-up">
        {/* visited tabs stay loaded (instant switching) */}
        <KeepAliveTabs active={tab} panels={{
          overview: () => <SuperOverview />,
          admins:   () => <AdminsManager />,
          sectors:  () => <SectorsManager />,
          workers:  () => <WorkerManagement scope="super" />,
          audit:    () => <AuditLog />,
        }} />
      </div>
    </div>
  );
}
