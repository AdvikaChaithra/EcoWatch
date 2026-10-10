"use client";
import Link from "next/link";
import {
  Leaf, Camera, LayoutDashboard, HardHat, User,
  ShieldCheck, Zap, Map, Award, ArrowRight, TrendingUp,
  AlertTriangle, CheckCircle2, Clock
} from "lucide-react";

const ROLES = [
  {
    href: "/citizen",
    label: "Citizen Portal",
    icon: User,
    desc: "Report dumps, track cleanups, earn Eco-Points and redeem civic rewards.",
    color: "from-emerald-500 to-teal-600",
    border: "border-emerald-500/20 hover:border-emerald-400/40",
    bg: "bg-emerald-500/5",
    badge: "👤 Citizen",
  },
  {
    href: "/admin",
    label: "Admin Console",
    icon: LayoutDashboard,
    desc: "Manage violations, dispatch workers, review SLA timers and tribunal appeals.",
    color: "from-blue-500 to-indigo-600",
    border: "border-blue-500/20 hover:border-blue-400/40",
    bg: "bg-blue-500/5",
    badge: "🏛️ Municipal Admin",
  },
  {
    href: "/worker",
    label: "Worker Portal",
    icon: HardHat,
    desc: "View assigned tasks, navigate to dump sites, and upload cleaned proof photos.",
    color: "from-yellow-500 to-amber-600",
    border: "border-yellow-500/20 hover:border-yellow-400/40",
    bg: "bg-yellow-500/5",
    badge: "🧹 Sanitation Worker",
  },
  {
    href: "/surveillance",
    label: "AI Surveillance",
    icon: Camera,
    desc: "Live 4-camera grid with YOLOv8 trash detection and ArcFace face matching.",
    color: "from-red-500 to-rose-600",
    border: "border-red-500/20 hover:border-red-400/40",
    bg: "bg-red-500/5",
    badge: "🤖 AI Engine",
  },
];

const STATS = [
  { label: "Violations Today",   value: "847",  icon: AlertTriangle, color: "text-red-400"    },
  { label: "Reports Resolved",   value: "2,341",icon: CheckCircle2,  color: "text-green-400"  },
  { label: "Active Workers",     value: "128",  icon: HardHat,       color: "text-yellow-400" },
  { label: "Avg. Response Time", value: "3.2h", icon: Clock,         color: "text-blue-400"   },
];

const FEATURES = [
  { icon: Camera,     title: "YOLOv8 + ArcFace",    desc: "Real-time trash detection & face biometric offender identification at street level." },
  { icon: Map,        title: "OpenStreetMap Heatmap",desc: "Ward-level pollution density layers with color-coded Leaflet.js visualization." },
  { icon: ShieldCheck,title: "Geofenced Proof",      desc: "Workers must be within 50m of the cleanup site to submit verified after-photos." },
  { icon: Award,      title: "Eco-Points Rewards",   desc: "Redeem points for tax rebates, metro passes, medical checkups, and ration kits." },
  { icon: Zap,        title: "WebSocket Real-time",  desc: "Live violation streams, worker updates, and civic index across all 4 dashboards." },
  { icon: TrendingUp, title: "SLA Analytics",        desc: "Municipal dashboard with countdown timers, breach alerts, and performance metrics." },
];

export default function LandingPage() {
  return (
    <div className="relative overflow-hidden">
      {/* Hero */}
      <section className="relative py-20 px-4 sm:px-6 lg:px-8 text-center max-w-7xl mx-auto">
        {/* Background orbs */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-eco-700/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute bottom-0 left-1/4 w-[400px] h-[300px] bg-blue-700/8 rounded-full blur-3xl pointer-events-none" />

        <div className="relative">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-eco-500/30 bg-eco-500/8 mb-6 animate-fade-in-up">
            <span className="w-2 h-2 rounded-full bg-eco-400 animate-pulse" />
            <span className="text-eco-300 text-sm font-medium">AI Surveillance System • Live</span>
          </div>

          <h1 className="font-display text-5xl sm:text-6xl lg:text-7xl font-bold tracking-tight mb-6 animate-fade-in-up">
            <span className="bg-gradient-to-r from-eco-300 via-eco-400 to-teal-300 bg-clip-text text-transparent">
              EcoWatch
            </span>
            <br />
            <span className="text-slate-200 text-3xl sm:text-4xl lg:text-5xl font-semibold">
              Cleaner Cities. Smarter Civic Tech.
            </span>
          </h1>

          <p className="max-w-2xl mx-auto text-slate-400 text-lg leading-relaxed mb-10 animate-fade-in-up">
            AI-powered CCTV surveillance, YOLOv8 trash detection, ArcFace biometric identification,
            real-time penalty dispatch, and a full municipal management platform — all in one civic system.
          </p>

          <div className="flex flex-wrap justify-center gap-3 mb-16 animate-fade-in-up">
            <Link href="/citizen" className="btn-eco text-base px-6 py-3">
              Get Started as Citizen <ArrowRight className="w-4 h-4" />
            </Link>
            <Link href="/surveillance" className="btn-eco-outline text-base px-6 py-3">
              View AI Surveillance <Camera className="w-4 h-4" />
            </Link>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto stagger-children">
            {STATS.map(({ label, value, icon: Icon, color }) => (
              <div key={label} className="glass-card-sm p-4 animate-fade-in-up">
                <Icon className={`w-5 h-5 mb-2 mx-auto ${color}`} />
                <div className={`text-2xl font-bold font-display mb-0.5 ${color}`}>{value}</div>
                <div className="text-xs text-slate-400">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Role Selector */}
      <section className="py-16 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="text-center mb-10">
          <h2 className="font-display text-3xl font-bold text-slate-100 mb-3">
            Choose Your Dashboard
          </h2>
          <p className="text-slate-400">Four specialized interfaces for every role in the civic ecosystem</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          {ROLES.map(({ href, label, icon: Icon, desc, color, border, bg, badge }) => (
            <Link
              key={href}
              href={href}
              className={`relative rounded-2xl border ${border} ${bg} p-6 flex flex-col gap-4 transition-all duration-300 hover:scale-[1.02] hover:shadow-2xl group`}
            >
              <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${color} flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform`}>
                <Icon className="w-6 h-6 text-white" />
              </div>
              <div>
                <span className="text-[10px] font-mono font-semibold text-slate-500 tracking-widest uppercase">{badge}</span>
                <h3 className="font-display text-lg font-bold text-slate-100 mt-0.5">{label}</h3>
                <p className="text-sm text-slate-400 mt-2 leading-relaxed">{desc}</p>
              </div>
              <div className="flex items-center gap-1 text-xs font-semibold text-slate-400 group-hover:text-eco-400 transition-colors mt-auto">
                Open Dashboard <ArrowRight className="w-3.5 h-3.5 group-hover:translate-x-1 transition-transform" />
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="py-16 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto">
        <div className="text-center mb-10">
          <h2 className="font-display text-3xl font-bold text-slate-100 mb-3">
            System Capabilities
          </h2>
          <p className="text-slate-400">Full-stack AI infrastructure for modern civic management</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="glass-card p-6 flex gap-4 hover:border-eco-500/20 transition-colors">
              <div className="p-2.5 rounded-xl bg-eco-500/10 border border-eco-500/20 h-fit">
                <Icon className="w-5 h-5 text-eco-400" />
              </div>
              <div>
                <h3 className="font-semibold text-slate-100 mb-1.5">{title}</h3>
                <p className="text-sm text-slate-400 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/8 py-8 px-4 text-center">
        <div className="flex items-center justify-center gap-2 mb-2">
          <Leaf className="w-4 h-4 text-eco-500" />
          <span className="font-display font-bold text-eco-400">EcoWatch</span>
        </div>
        <p className="text-xs text-slate-500">
          AI-Powered Civic Cleanliness Surveillance Platform · Built with Next.js 14 + FastAPI + YOLOv8 + Supabase
        </p>
      </footer>
    </div>
  );
}
