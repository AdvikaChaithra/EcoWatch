/** Rewards for verified worker cleanups and citizen dump reports (shared by UI and server). */

/** Suggested eco-points per verified cleanup, by severity. The admin can change it within the limits. */
export const TASK_POINTS: Record<string, number> = { Low: 40, Medium: 60, High: 75, Critical: 100 };
export const TASK_POINTS_MIN = 40;
export const TASK_POINTS_MAX = 200;

/** Suggested rupee bonus per verified cleanup; the admin can set 0 - 1000. */
export const TASK_BONUS_RUPEES = 200;
export const TASK_BONUS_MIN = 0;
export const TASK_BONUS_MAX = 1000;

/** Eco-points a citizen earns for submitting a dump report. */
export const REPORT_POINTS = 40;

export const pointsFor = (severity?: string | null) => TASK_POINTS[severity ?? ""] ?? TASK_POINTS_MIN;

/** Whole number within [min, max], or null if it is not a valid number in range. */
export function inRange(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
