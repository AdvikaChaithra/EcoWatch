"use client";
import { useState, useEffect } from "react";
import { AlertTriangle, Camera, Map, Award, ClipboardList, RefreshCw } from "lucide-react";
import { ViolationHub } from "@/components/citizen/ViolationHub";
import { ReportTool } from "@/components/citizen/ReportTool";
import { ReportTracker } from "@/components/citizen/ReportTracker";
import { CivicHeatmap } from "@/components/citizen/CivicHeatmap";
import { RewardsHub } from "@/components/citizen/RewardsHub";
import { useEcoStore } from "@/lib/store";
import { bootstrapGlobalStats } from "@/lib/store";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "violations", label: "Violations", icon: AlertTriangle, color: "text-red-400"     },
  { id: "report",     label: "Report Dump", icon: Camera,       color: "text-eco-400"     },
  { id: "tracker",    label: "My Reports",  icon: ClipboardList,color: "text-blue-400"    },
  { id: "heatmap",    label: "Civic Map",   icon: Map,          color: "text-purple-400"  },
  { id: "rewards",    label: "Rewards",     icon: Award,        color: "text-yellow-400"  },
] as const;

type Tab = typeof TABS[number]["id"];

export default function CitizenDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>("violations");
  const store = useEcoStore();

  useEffect(() => { bootstrapGlobalStats(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const user = store.currentUser;

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="font-display text-3xl font-bold text-slate-100">
            Citizen Portal
          </h1>
          <p className="text-slate-400 mt-1">
            {user ? `Welcome back, ${user.name.split(" ")[0]} 👋` : "Report violations, track progress, earn rewards."}
          </p>
        </div>
        {user && (
          <div className="flex items-center gap-3">
            <div className="glass-card-sm px-4 py-2 flex items-center gap-2">
              <Award className="w-4 h-4 text-yellow-400" />
              <span className="text-sm font-semibold text-yellow-300">{user.eco_points ?? 0} Eco-Points</span>
              <span className={cn("badge text-xs ml-1", user.tier === "Gold" ? "text-yellow-300 bg-yellow-500/10 border-yellow-500/20" : user.tier === "Silver" ? "text-slate-300 bg-slate-400/10 border-slate-400/20" : "text-orange-300 bg-orange-500/10 border-orange-500/20")}>
                {user.tier}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Tab Nav */}
      <div className="flex gap-1 p-1 bg-civic-900/60 rounded-2xl border border-white/8 mb-8 overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon, color }) => (
          <button
            key={id}
            id={`citizen-tab-${id}`}
            onClick={() => setActiveTab(id)}
            className={cn(
              "flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all duration-200 flex-1 justify-center",
              activeTab === id
                ? "bg-eco-600/20 text-eco-300 border border-eco-500/20 shadow-sm"
                : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
            )}
          >
            <Icon className={cn("w-4 h-4", activeTab === id ? "text-eco-400" : color)} />
            <span className="hidden sm:inline">{label}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="animate-fade-in-up">
        {activeTab === "violations" && <ViolationHub />}
        {activeTab === "report"     && <ReportTool />}
        {activeTab === "tracker"    && <ReportTracker />}
        {activeTab === "heatmap"    && <CivicHeatmap />}
        {activeTab === "rewards"    && <RewardsHub />}
      </div>
    </div>
  );
}
