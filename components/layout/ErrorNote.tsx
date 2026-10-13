"use client";
import { AlertCircle, X } from "lucide-react";

/** Inline error banner used by data-loading components instead of failing silently. */
export function ErrorNote({ message, onDismiss }: { message: string; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
    >
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss error" className="shrink-0 hover:text-red-100">
          <X className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}

export function errMsg(e: unknown, fallback: string): string {
  const m = (e as { message?: string } | null)?.message;
  return m ? `${fallback} (${m})` : fallback;
}
