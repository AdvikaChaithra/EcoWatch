"use client";
import { useState } from "react";
import { LayoutDashboard, ClipboardList, Clock, Gavel, Users, Shield, UserCircle } from "lucide-react";
import { KPIOverview } from "@/components/admin/KPIOverview";
import { TaskDispatch } from "@/components/admin/TaskDispatch";
import { SLAMonitor } from "@/components/admin/SLAMonitor";
import { DisputeTribunal } from "@/components/admin/DisputeTribunal";
import { WorkerManagement } from "@/components/shared/WorkerManagement";
import { AdminProfile } from "@/components/admin/AdminProfile";
import { SectorFilter } from "@/components/admin/SectorFilter";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "kpi",       label: "Operations",  icon: LayoutDashboard, color: "text-blue-400"   },
  { id: "dispatch",  label: "Dispatch",    icon: ClipboardList,   color: "text-eco-400"    },
  { id: "sla",       label: "SLA Monitor", icon: Clock,           color: "text-orange-400" },
  { id: "tribunal",  label: "Tribunal",    icon: Gavel,           color: "text-red-400"    },
  { id: "workforce", label: "Workforce",   icon: Users,           color: "text-purple-400" },
  { id: "profile",   label: "My Profile",  icon: UserCircle,      color: "text-blue-300"   },
] as const;

type Tab = typeof TABS[number]["id"];

export default function AdminDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("kpi");

  return (
    <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center gap-3 mb-8">
        <div className="p-2.5 rounded-xl bg-blue-600/20 border border-blue-500/30">
          <Shield className="w-5 h-5 text-blue-400" />
        </div>
        <div>
          <h1 className="font-display text-3xl font-bold text-slate-100">Municipal Admin Console</h1>
          <p className="text-slate-400 text-sm mt-0.5">Manage violations, dispatch workers, and monitor SLA compliance</p>
        </div>
        <div className="ml-auto"><SectorFilter /></div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-civic-900/60 rounded-2xl border border-white/8 mb-8 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon, color }) => (
          <button
            key={id}
            id={`admin-tab-${id}`}
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all duration-200 flex-1 justify-center",
              activeTab === id
                ? "bg-blue-600/15 text-blue-300 border border-blue-500/20"
                : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
            )}
          >
            <Icon className={cn("w-4 h-4", activeTab === id ? "text-blue-400" : color)} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      <div className="animate-fade-in-up">
        {activeTab === "kpi"       && <KPIOverview />}
        {activeTab === "dispatch"  && <TaskDispatch />}
        {activeTab === "sla"       && <SLAMonitor />}
        {activeTab === "tribunal"  && <DisputeTribunal />}
        {activeTab === "workforce" && <WorkerManagement scope="admin" />}
        {activeTab === "profile"   && <AdminProfile />}
      </div>
    </div>
  );
}
