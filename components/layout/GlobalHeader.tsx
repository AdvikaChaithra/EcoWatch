"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Leaf, LayoutDashboard, HardHat, Camera, Bell, Wifi,
  TrendingUp, ChevronDown, LogOut, User, Shield
} from "lucide-react";
import { useEcoStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

const NAV = [
  { href: "/citizen",     label: "Citizen Portal",     icon: User,            color: "text-emerald-400" },
  { href: "/admin",       label: "Admin Console",      icon: LayoutDashboard, color: "text-blue-400"    },
  { href: "/worker",      label: "Worker Portal",      icon: HardHat,         color: "text-yellow-400"  },
  { href: "/surveillance",label: "AI Surveillance",    icon: Camera,          color: "text-red-400"     },
];

export function GlobalHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const civicIndex     = useEcoStore((s) => s.civicIndex);
  const liveAlerts     = useEcoStore((s) => s.liveAlerts);
  const totalViolations= useEcoStore((s) => s.totalViolationsToday);
  const workersOnDuty  = useEcoStore((s) => s.workersOnDuty);
  const currentUser    = useEcoStore((s) => s.currentUser);
  const logout         = useEcoStore((s) => s.logout);
  const isAuthenticated= useEcoStore((s) => s.isAuthenticated);

  const [alertsOpen, setAlertsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  // Hydration fix: Zustand reads localStorage on client but server has no session.
  // Defer ALL user-state-dependent UI until after mount so server & client render identically.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const civicColor =
    civicIndex >= 80 ? "text-green-400" :
    civicIndex >= 60 ? "text-yellow-400" :
    civicIndex >= 40 ? "text-orange-400" : "text-red-400";

  return (
    <header className="sticky top-0 z-40 w-full border-b border-white/8 bg-civic-950/95 backdrop-blur-xl">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-4">

          {/* Brand */}
          <Link href="/" className="flex items-center gap-2.5 shrink-0">
            <div className="p-1.5 rounded-xl bg-eco-600/20 border border-eco-500/30 animate-glow-pulse">
              <Leaf className="w-5 h-5 text-eco-400" />
            </div>
            <div>
              <span className="font-display font-bold text-lg tracking-tight bg-gradient-to-r from-eco-300 to-eco-500 bg-clip-text text-transparent">
                EcoWatch
              </span>
              <span className="hidden sm:block text-[10px] text-slate-500 leading-none -mt-0.5">
                AI Civic Surveillance
              </span>
            </div>
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden lg:flex items-center gap-1">
            {NAV.map(({ href, label, icon: Icon, color }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200",
                  pathname.startsWith(href)
                    ? "bg-eco-600/15 text-eco-300 border border-eco-500/20"
                    : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
                )}
              >
                <Icon className={cn("w-4 h-4", pathname.startsWith(href) ? "text-eco-400" : color)} />
                {label}
              </Link>
            ))}
          </nav>

          {/* Right Side */}
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Civic Index — show static shell until mounted to avoid hydration mismatch */}
            <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-white/8">
              <TrendingUp className="w-3.5 h-3.5 text-slate-400" />
              <span className="text-xs text-slate-400">Civic Index</span>
              {mounted
                ? <span className={cn("text-sm font-bold", civicColor)}>{civicIndex}</span>
                : <span className="text-sm font-bold text-slate-400">—</span>
              }
              <span className="text-xs text-slate-500">/100</span>
            </div>

            {/* Live Stats */}
            {mounted && (
              <div className="hidden md:flex items-center gap-1 px-3 py-1.5 rounded-xl bg-white/5 border border-white/8">
                <Wifi className="w-3 h-3 text-eco-400 animate-pulse" />
                <span className="text-xs text-slate-400 ml-1">
                  <span className="text-eco-400 font-semibold">{workersOnDuty}</span> on duty·
                  <span className="text-red-400 font-semibold ml-1">{totalViolations}</span> violations
                </span>
              </div>
            )}

            {/* Alerts Bell */}
            <div className="relative">
              <button
                id="alerts-bell"
                onClick={() => setAlertsOpen(!alertsOpen)}
                className="relative p-2 rounded-xl hover:bg-white/5 text-slate-400 hover:text-slate-200 transition-colors"
              >
                <Bell className="w-5 h-5" />
                {mounted && liveAlerts.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                    {liveAlerts.length > 9 ? "9+" : liveAlerts.length}
                  </span>
                )}
              </button>

              {alertsOpen && mounted && (
                <div className="absolute right-0 top-full mt-2 w-80 glass-card border border-white/10 shadow-2xl z-50 max-h-80 overflow-y-auto">
                  <div className="p-3 border-b border-white/8 flex items-center justify-between">
                    <span className="text-sm font-semibold text-slate-200">Live Alerts</span>
                    <span className="badge text-xs bg-red-500/10 text-red-400 border-red-500/20">
                      {liveAlerts.length} new
                    </span>
                  </div>
                  {liveAlerts.length === 0 ? (
                    <p className="p-4 text-sm text-slate-500 text-center">No alerts yet</p>
                  ) : (
                    liveAlerts.slice(0, 15).map((a) => (
                      <div key={a.id} className="p-3 border-b border-white/5 hover:bg-white/3 transition-colors">
                        <p className="text-xs text-slate-300">{a.message}</p>
                        <p className="text-[10px] text-slate-500 mt-0.5">
                          {new Date(a.timestamp).toLocaleTimeString("en-IN")}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Auth / Profile — only render after hydration to avoid server/client mismatch */}
            {!mounted ? (
              <Link href="/auth/citizen" className="btn-eco text-xs sm:text-sm px-3 py-1.5">Sign In</Link>
            ) : isAuthenticated && currentUser ? (
              <div className="flex items-center gap-2">
                <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-white/8">
                  {currentUser.role === "admin"  && <Shield className="w-3.5 h-3.5 text-blue-400" />}
                  {currentUser.role === "worker" && <HardHat className="w-3.5 h-3.5 text-yellow-400" />}
                  {currentUser.role === "citizen"&& <User    className="w-3.5 h-3.5 text-eco-400" />}
                  <span className="text-xs font-medium text-slate-200 max-w-[100px] truncate">{currentUser.name}</span>
                  <span className="text-[10px] text-slate-500 capitalize">{currentUser.role}</span>
                </div>
                <button
                  onClick={() => { logout(); router.push("/"); }}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm text-slate-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                  title="Sign Out"
                >
                  <LogOut className="w-4 h-4" />
                  <span className="hidden sm:inline">Logout</span>
                </button>
              </div>
            ) : (
              <Link href="/auth/citizen" className="btn-eco text-xs sm:text-sm px-3 py-1.5">Sign In</Link>
            )}

            {/* Mobile Menu */}
            <button
              onClick={() => setMobileOpen(!mobileOpen)}
              className="lg:hidden p-2 rounded-xl hover:bg-white/5 text-slate-400"
              aria-label="Menu"
            >
              <ChevronDown className={cn("w-5 h-5 transition-transform", mobileOpen && "rotate-180")} />
            </button>
          </div>
        </div>

        {/* Mobile Nav */}
        {mobileOpen && (
          <div className="lg:hidden pb-3 border-t border-white/8 pt-2 mt-1">
            <div className="flex flex-col gap-1">
              {NAV.map(({ href, label, icon: Icon, color }) => (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    "flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all",
                    pathname.startsWith(href)
                      ? "bg-eco-600/15 text-eco-300"
                      : "text-slate-400 hover:bg-white/5"
                  )}
                >
                  <Icon className={cn("w-4 h-4", color)} />
                  {label}
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
