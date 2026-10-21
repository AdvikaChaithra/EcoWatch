"use client";

export interface SectorLike { id: string; area: string; name: string; corporation?: string | null; active?: boolean }

/** Short label for a city corporation ("Bengaluru West City Corporation" -> "West"). */
export function corpLabel(c?: string | null) {
  if (!c) return "Other";
  return c.replace(/^Bengaluru /, "").replace(/ City Corporation$/, "");
}

/** Group sectors by city corporation, each group sorted by area. */
export function groupByCorporation<T extends SectorLike>(sectors: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  sectors.forEach((s) => {
    const k = s.corporation || "Other";
    m.set(k, [...(m.get(k) ?? []), s]);
  });
  return Array.from(m.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, xs]) => [k, xs.sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name))]);
}

/** <option>s for a sector <select>, grouped City Corporation -> Area — Sector. */
export function SectorOptions<T extends SectorLike>({ sectors, suffix }: { sectors: T[]; suffix?: (s: T) => string }) {
  return (
    <>
      {groupByCorporation(sectors).map(([corp, xs]) => (
        <optgroup key={corp} label={`${corpLabel(corp)} (${xs.length})`}>
          {xs.map((s) => (
            <option key={s.id} value={s.id}>
              {s.area} — {s.name}{s.active === false ? " (retired)" : ""}{suffix ? suffix(s) : ""}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}
