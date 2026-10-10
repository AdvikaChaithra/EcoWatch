"use client";
import { cn } from "@/lib/utils";
import { Power } from "lucide-react";

interface Props {
  onDuty: boolean;
  onToggle: () => void;
  loading?: boolean;
}

export function ShiftToggle({ onDuty, onToggle, loading }: Props) {
  return (
    <button
      onClick={onToggle}
      disabled={loading}
      className={cn(
        "w-32 h-32 rounded-full flex flex-col items-center justify-center gap-2 border-4 transition-all duration-300 font-bold text-sm relative",
        onDuty
          ? "border-eco-500 bg-eco-500/20 text-eco-400 shadow-[0_0_40px_rgba(16,185,129,0.4)] animate-glow-pulse"
          : "border-slate-600 bg-slate-800/50 text-slate-400 hover:border-slate-500"
      )}
    >
      <Power className={cn("w-10 h-10 transition-transform", loading && "animate-spin opacity-40")} />
      <span className="text-xs tracking-widest">{onDuty ? "ON DUTY" : "START SHIFT"}</span>
      {onDuty && (
        <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-eco-400 border-2 border-civic-950 animate-pulse" />
      )}
    </button>
  );
}
