"use client";
import { useEcoStore } from "@/lib/store";

/**
 * Sector scoping for the admin console.
 * - An admin owns the sectors where sectors.admin_id = their id.
 * - `inScope(sectorId)` is true when the record belongs to the selected sector
 *   (or to any of the admin's sectors when "All my sectors" is selected).
 * - An admin with no sectors configured is not restricted (so the console still works
 *   before sectors are set up).
 * Note: this filters in the app (demo mode). Database-level enforcement would use RLS.
 */
export function useSectorScope() {
  const mySectors = useEcoStore((s) => s.mySectors);
  const filter = useEcoStore((s) => s.sectorFilter);

  const ids = filter === "all" ? mySectors.map((s) => s.id) : [filter];
  const restricted = mySectors.length > 0;

  const inScope = (sectorId?: string | null) => !restricted || (!!sectorId && ids.includes(sectorId));
  return { inScope, key: `${filter}:${mySectors.length}`, restricted, mySectors, filter };
}
