"use client";
import { useState } from "react";
import { ImageOff } from "lucide-react";

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

const FRAMES = [
  { file: "1_assoc.jpg",     label: "1 · Holding the item" },
  { file: "2_drop.jpg",      label: "2 · Item dropped" },
  { file: "3_confirmed.jpg", label: "3 · Item left, person leaves" },
] as const;

/**
 * Real evidence frames written by the vision engine (bounding boxes are drawn on the
 * frames by the engine itself). Nothing is overlaid or invented here.
 */
export function EvidenceStrip({ evidencePath, fallbackUrl }: { evidencePath?: string | null; fallbackUrl?: string | null }) {
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  if (!evidencePath) {
    return fallbackUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={fallbackUrl} alt="Violation snapshot" className="w-full rounded-xl border border-white/10" />
    ) : (
      <div className="rounded-xl border border-white/10 bg-civic-800 p-6 text-center text-sm text-slate-500">
        <ImageOff className="w-8 h-8 mx-auto mb-2 opacity-40" />
        No evidence frames stored for this record.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {FRAMES.map(({ file, label }) => (
        <div key={file} className="rounded-xl overflow-hidden border border-white/10 bg-black">
          {broken[file] ? (
            <div className="aspect-video flex items-center justify-center text-[11px] text-slate-500">Frame unavailable</div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${BACKEND}/evidence/${evidencePath}/${file}`}
              alt={label}
              className="w-full aspect-video object-cover"
              onError={() => setBroken((b) => ({ ...b, [file]: true }))}
            />
          )}
          <p className="px-2 py-1 text-[10px] text-slate-400 bg-civic-900">{label}</p>
        </div>
      ))}
    </div>
  );
}
