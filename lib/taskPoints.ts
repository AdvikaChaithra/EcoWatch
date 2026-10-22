/** Eco-points a worker earns for a verified cleanup: 50 base, more for heavier jobs. */
export const TASK_POINTS: Record<string, number> = { Low: 50, Medium: 60, High: 75, Critical: 100 };

/** Rupee bonus credited to the worker for each verified cleanup. */
export const TASK_BONUS_RUPEES = 200;

export const pointsFor = (severity?: string | null) => TASK_POINTS[severity ?? ""] ?? 50;
