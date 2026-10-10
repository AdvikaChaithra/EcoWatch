"use client";
import { useEffect } from "react";
import { useEcoStore } from "@/lib/store";
import { X, AlertTriangle } from "lucide-react";

export function NotificationBanner() {
  const banner = useEcoStore((s) => s.notificationBanner);
  const hide = useEcoStore((s) => s.hideNotificationBanner);

  if (!banner?.visible) return null;

  return (
    <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 w-full max-w-2xl px-4 animate-slide-right">
      <div className="flex items-start gap-3 p-4 rounded-2xl border border-red-500/40 bg-red-950/90 backdrop-blur-md shadow-2xl">
        <div className="p-1.5 rounded-lg bg-red-500/20">
          <AlertTriangle className="w-5 h-5 text-red-400" />
        </div>
        <div className="flex-1">
          <p className="text-xs font-bold text-red-400 uppercase tracking-wider mb-0.5">
            🚨 EcoWatch SMS Alert
          </p>
          <p className="text-sm text-slate-200 leading-relaxed">{banner.message}</p>
          <p className="mt-1.5 text-xs text-red-300/70">
            Pay fine at{" "}
            <span className="font-mono text-red-300">ecowatch.gov.in/dashboard</span>
          </p>
        </div>
        <button onClick={hide} className="text-slate-400 hover:text-slate-200">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
