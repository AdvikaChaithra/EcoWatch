"use client";
import { useRef, useEffect } from "react";
import { Terminal } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LogEntry {
  ts: string;
  msg: string;
  type: "info" | "alert" | "match" | "fine" | "sms" | "error" | "sys";
}

interface Props {
  logs: LogEntry[];
  maxHeight?: string;
}

const TYPE_COLOR: Record<string, string> = {
  info:  "text-eco-400",
  sys:   "text-slate-400",
  alert: "text-red-400 font-semibold",
  match: "text-orange-400",
  fine:  "text-yellow-400",
  sms:   "text-blue-400",
  error: "text-red-500 font-semibold",
};

const TYPE_PREFIX: Record<string, string> = {
  info:  "[SYS]",
  sys:   "[SYS]",
  alert: "[YOLOv8]",
  match: "[ArcFace]",
  fine:  "[Supabase]",
  sms:   "[SMS]",
  error: "[ERROR]",
};

/**
 * PenaltyTerminal — live color-coded log stream from surveillance pipeline.
 * Displayed in the Surveillance Dashboard right panel.
 * Entries fed from WebSocket messages and local inference events.
 */
export function PenaltyTerminal({ logs, maxHeight = "h-52" }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs.length]);

  return (
    <div className="glass-card p-4 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400 flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-eco-400" />
          Pipeline Terminal
        </p>
        <span className="text-[10px] font-mono text-slate-600">
          {logs.length} entries
        </span>
      </div>

      {/* Log window */}
      <div className={cn(
        "bg-black/70 rounded-xl p-3 overflow-y-auto font-mono text-[10px] space-y-0.5 border border-white/5",
        maxHeight,
      )}>
        {logs.length === 0 ? (
          <p className="text-slate-600">Ready. Start inference to begin logging.</p>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className="flex gap-2 leading-snug">
              <span className="text-slate-600 shrink-0 tabular-nums">{entry.ts}</span>
              <span className={cn(
                TYPE_COLOR[entry.type] ?? "text-slate-300",
                "break-all",
              )}>
                <span className="opacity-60 mr-1">{TYPE_PREFIX[entry.type]}</span>
                {entry.msg}
              </span>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
