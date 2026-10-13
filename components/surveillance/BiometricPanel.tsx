"use client";
import { Cpu, AlertCircle, Clock, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";

export interface FaceMatchData {
  name: string;
  citizenId: string | null;
  phone: string;
  confidence: number;   // 0–100
  snapshotDataUrl?: string;
}

interface LitteringEventPending {
  event_id:         string;
  person_track_id:  number;
  waste_track_id:   number;
  event_confidence: number;
  timestamp:        string;
  location:         { name: string };
  identity_status:  string;  // "PENDING" in Part 1
  confidence_breakdown?: {
    association: number; separation: number;
    stationary: number; departure: number; dwell_seconds: number;
  };
}

/** Real result of the backend identity pipeline for one littering event (WebSocket `identity_result`). */
export interface IdentityResultMsg {
  event_id: string;
  identity_status: "MATCH" | "UNCERTAIN" | "NO_MATCH" | "NO_FACE" | "ERROR";
  reason?: string;
  similarity?: number | null;
  runner_up?: number | null;
  faces_used?: number;
  crops_received?: number;
  notes?: string[];
  citizen_name?: string | null;   // masked by the backend
  violation_id?: string | null;
  fine_amount?: number | null;
  sms_status?: "NOT_CONFIGURED" | "SENT" | "FAILED";
}

interface Props {
  match:        FaceMatchData | null;
  /** Backend identity result for the current event (null while pending) */
  identity?:    IdentityResultMsg | null;
  running:      boolean;
  /** Part 1: confirmed littering event with identity_status = PENDING */
  pendingEvent?: LitteringEventPending | null;
}

/**
 * BiometricPanel
 * Part 1: shows LITTERING DETECTED / IDENTITY PENDING when a littering event arrives.
 * Part 2: shows full ArcFace match result (citizen name, cosine similarity bar).
 * No fake data — PENDING state is the honest representation of Part 1 status.
 */
export function BiometricPanel({ match, running, pendingEvent, identity }: Props) {
  const idForEvent = identity && pendingEvent && identity.event_id === pendingEvent.event_id ? identity : null;
  const hasPendingEvent = running && !!pendingEvent;
  const hasMatch        = running && match;

  const confidenceColor = !match
    ? "bg-slate-700"
    : match.confidence >= 85 ? "bg-eco-500"
    : match.confidence >= 70 ? "bg-yellow-500"
    : "bg-orange-500";

  const statusLabel = hasMatch
    ? match?.citizenId
      ? `MATCHED — ${match.confidence.toFixed(1)}%`
      : "UNIDENTIFIED"
    : hasPendingEvent
    ? "LITTERING DETECTED"
    : running ? "STANDBY" : "OFFLINE";

  const statusClass = hasMatch && match?.citizenId
    ? "bg-red-500/10 text-red-400 border-red-500/20"
    : hasPendingEvent
    ? "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
    : "bg-slate-500/10 text-slate-400 border-slate-500/20";

  return (
    <div className="glass-card p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-400 flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-orange-400" />
          Biometric ID
        </p>
        <span className={cn("badge text-[10px]", statusClass)}>
          {statusLabel}
        </span>
      </div>

      {/* ── Part 2: full ArcFace match ─────────────────────────────────── */}
      {hasMatch && match ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            {match.snapshotDataUrl ? (
              <div className="w-14 h-14 rounded-xl overflow-hidden border-2 border-orange-500/40 shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={match.snapshotDataUrl} alt="Offender face" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div className="w-14 h-14 rounded-xl bg-gradient-to-br from-orange-600 to-red-600 flex items-center justify-center text-white font-bold text-lg shrink-0 border-2 border-orange-500/40">
                {match.name.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-slate-100 text-sm truncate">{match.name}</p>
              {match.citizenId ? (
                <>
                  <p className="text-[10px] text-slate-400 font-mono truncate">
                    {match.citizenId.slice(0, 16).toUpperCase()}
                  </p>
                  {match.phone && (
                    <p className="text-[10px] text-slate-500 truncate">{match.phone}</p>
                  )}
                </>
              ) : (
                <div className="flex items-center gap-1 mt-0.5">
                  <AlertCircle className="w-3 h-3 text-orange-400" />
                  <p className="text-[10px] text-orange-400">Not in citizen DB</p>
                </div>
              )}
            </div>
          </div>
          <div>
            <div className="flex justify-between items-center mb-1">
              <span className="text-[10px] text-slate-400">Cosine Similarity</span>
              <span className="text-xs font-bold text-eco-400">{match.confidence.toFixed(1)}%</span>
            </div>
            <div className="h-2 rounded-full bg-civic-800 overflow-hidden">
              <div className={cn("h-full rounded-full transition-all duration-500", confidenceColor)}
                style={{ width: `${match.confidence}%` }} />
            </div>
            <p className="text-[10px] text-slate-500 mt-1 text-center">
              InsightFace buffalo_l · 512-D ArcFace embedding
            </p>
          </div>
          {match.citizenId && (
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/20">
              <span className="text-xs text-red-400 font-semibold">Fine issued</span>
            </div>
          )}
        </div>

      ) : hasPendingEvent && pendingEvent ? (
        /* ── Part 1: PENDING identity state ─────────────────────────────── */
        <div className="space-y-3">
          {/* Event summary */}
          <div className="p-3 rounded-xl bg-yellow-500/5 border border-yellow-500/20 space-y-1.5">
            <p className="text-xs text-yellow-300 font-semibold">⚠ LITTERING CONFIRMED</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
              <span className="text-slate-400">Person:</span>
              <span className="text-slate-200 font-mono">Track #{pendingEvent.person_track_id}</span>
              <span className="text-slate-400">Waste:</span>
              <span className="text-slate-200 font-mono">Track #{pendingEvent.waste_track_id}</span>
              <span className="text-slate-400">Confidence:</span>
              <span className="text-yellow-300 font-mono">
                {(pendingEvent.event_confidence * 100).toFixed(1)}%
              </span>
            </div>
            {pendingEvent.confidence_breakdown && (
              <div className="mt-1.5 space-y-1">
                {[
                  { k: "Association", v: pendingEvent.confidence_breakdown.association },
                  { k: "Separation",  v: pendingEvent.confidence_breakdown.separation  },
                  { k: "Stationary",  v: pendingEvent.confidence_breakdown.stationary  },
                  { k: "Departure",   v: pendingEvent.confidence_breakdown.departure   },
                ].map(({ k, v }) => (
                  <div key={k} className="flex items-center gap-2">
                    <span className="text-[9px] text-slate-500 w-20 shrink-0">{k}</span>
                    <div className="flex-1 h-1 rounded bg-civic-800">
                      <div className="h-full rounded bg-yellow-500/60" style={{ width: `${v * 100}%` }} />
                    </div>
                    <span className="text-[9px] text-slate-400 w-8 text-right">{(v * 100).toFixed(0)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Identity (real backend result) */}
          {!idForEvent ? (
            <div className="p-3 rounded-xl bg-slate-800/60 border border-slate-600/30">
              <p className="text-[10px] text-slate-400 font-mono text-center">
                IDENTITY: <span className="text-yellow-400">IDENTIFYING…</span>
              </p>
              <p className="text-[9px] text-slate-600 text-center mt-1">
                Face crops → ArcFace → pgvector (runs only on confirmed events)
              </p>
            </div>
          ) : (
            <div className={cn(
              "p-3 rounded-xl border space-y-1.5",
              idForEvent.identity_status === "MATCH" ? "bg-red-500/10 border-red-500/30"
              : idForEvent.identity_status === "ERROR" ? "bg-orange-500/10 border-orange-500/30"
              : "bg-slate-800/60 border-slate-600/30"
            )}>
              <p className="text-[11px] font-mono text-center">
                IDENTITY: <span className={cn(
                  idForEvent.identity_status === "MATCH" ? "text-red-300" : "text-yellow-300")}>
                  {idForEvent.identity_status === "MATCH" ? "MATCHED" : idForEvent.identity_status}
                </span>
              </p>
              {idForEvent.identity_status === "MATCH" && (
                <>
                  <p className="text-xs text-slate-100 text-center font-semibold">{idForEvent.citizen_name}</p>
                  <p className="text-[10px] text-slate-300 text-center">
                    similarity {((idForEvent.similarity ?? 0) * 100).toFixed(1)}% · fine ₹{idForEvent.fine_amount ?? 0} issued
                  </p>
                  <p className="text-[10px] text-slate-400 text-center">
                    Citizen dashboard alert: sent · SMS: {idForEvent.sms_status ?? "NOT_CONFIGURED"}
                  </p>
                </>
              )}
              {idForEvent.identity_status !== "MATCH" && (
                <p className="text-[10px] text-slate-400 text-center">
                  {idForEvent.reason}{idForEvent.identity_status !== "ERROR" ? " — no citizen fine issued" : ""}
                </p>
              )}
              {idForEvent.faces_used !== undefined && (
                <p className="text-[9px] text-slate-600 text-center">
                  {idForEvent.faces_used}/{idForEvent.crops_received ?? 0} face crops usable
                  {idForEvent.notes && idForEvent.notes.length ? ` · ${idForEvent.notes.slice(0,3).join(", ")}` : ""}
                </p>
              )}
            </div>
          )}

          {/* Location + time */}
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <MapPin className="w-3 h-3 shrink-0" />
            <span className="truncate">{pendingEvent.location.name}</span>
            <Clock className="w-3 h-3 shrink-0 ml-auto" />
            <span className="shrink-0">
              {new Date(pendingEvent.timestamp).toLocaleTimeString()}
            </span>
          </div>
        </div>

      ) : (
        /* ── Standby / Offline ──────────────────────────────────────────── */
        <div className="h-20 flex flex-col items-center justify-center text-slate-600 gap-2">
          <Cpu className="w-6 h-6 opacity-30" />
          <p className="text-xs">
            {running ? "Scanning for littering…" : "Start inference to activate"}
          </p>
        </div>
      )}
    </div>
  );
}
