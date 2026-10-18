import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
// New Supabase projects issue a "publishable" key; the legacy anon key is still accepted.
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

// ─── Citizen helpers ──────────────────────────────────────────────────────────

// Safe columns only — excludes face_embedding (512-D vector) and gov_id (PII)
const CITIZEN_SAFE_COLS = "id,name,phone,email,address,ward,eco_points,tier,created_at";

export async function getCitizens() {
  const { data, error } = await supabase
    .from("citizens")
    .select(CITIZEN_SAFE_COLS)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function getCitizenById(id: string) {
  const { data, error } = await supabase
    .from("citizens")
    .select(CITIZEN_SAFE_COLS)
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export async function createCitizen(payload: {
  name: string;
  phone: string;
  email: string;
  address: string;
  ward: string;
  gov_id: string;
}) {
  const { data, error } = await supabase
    .from("citizens")
    .insert([{ ...payload, eco_points: 0, tier: "Bronze" }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateCitizenEcoPoints(id: string, delta: number) {
  const { data: citizen, error: readErr } = await supabase
    .from("citizens")
    .select("eco_points")
    .eq("id", id)
    .single();
  if (readErr) throw readErr;
  const newPoints = (citizen?.eco_points ?? 0) + delta;
  let tier = "Bronze";
  if (newPoints >= 5000) tier = "Eco-Champion";
  else if (newPoints >= 2000) tier = "Gold";
  else if (newPoints >= 500) tier = "Silver";
  const { error } = await supabase
    .from("citizens")
    .update({ eco_points: newPoints, tier })
    .eq("id", id);
  if (error) throw error;
  return newPoints;
}

// ─── Violations ───────────────────────────────────────────────────────────────

export async function getViolations(citizenId?: string) {
  let query = supabase
    .from("violations")
    .select("*")
    .order("timestamp", { ascending: false });
  if (citizenId) query = query.eq("citizen_id", citizenId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function createViolation(payload: {
  citizen_id?: string;
  location_name: string;
  lat: number;
  lng: number;
  snapshot_url?: string;
  confidence_score: number;
}) {
  const { data, error } = await supabase
    .from("violations")
    .insert([
      {
        ...payload,
        fine_amount: 500,
        status: "Pending",
        timestamp: new Date().toISOString(),
      },
    ])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateViolationStatus(
  id: string,
  status: "Pending" | "Paid" | "Disputed" | "Dismissed" | "Upheld",
  extra?: Record<string, unknown>
) {
  const { error } = await supabase
    .from("violations")
    .update({ status, ...extra })
    .eq("id", id);
  if (error) throw error;
}

// ─── Dump Reports ─────────────────────────────────────────────────────────────

export async function getDumpReports(citizenId?: string) {
  let query = supabase
    .from("dump_reports")
    .select("*, workers(name)")
    .order("created_at", { ascending: false });
  if (citizenId) query = query.eq("citizen_id", citizenId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ─── Sectors ─────────────────────────────────────────────────────────────────

export interface SectorRow { id: string; area: string; name: string; admin_id: string | null; lat: number; lng: number; }

export async function getSectors(): Promise<SectorRow[]> {
  const { data, error } = await supabase.from("sectors").select("id,area,name,admin_id,lat,lng");
  if (error) throw error;
  return (data ?? []) as SectorRow[];
}

/** Nearest sector centre to a point (used to route reports to the owning admin). */
export async function getNearestSectorId(lat: number, lng: number): Promise<string | null> {
  try {
    const sectors = await getSectors();
    if (sectors.length === 0) return null;
    return sectors.reduce((best, s) =>
      haversineMeters(lat, lng, s.lat, s.lng) < haversineMeters(lat, lng, best.lat, best.lng) ? s : best
    ).id;
  } catch {
    return null; // sectors not set up yet - report is still saved
  }
}

export async function createDumpReport(payload: {
  sector_id?: string | null;
  citizen_id: string;
  category: string;
  severity: string;
  location_name: string;
  lat: number;
  lng: number;
  reported_image_url: string;
}) {
  const { data, error } = await supabase
    .from("dump_reports")
    .insert([
      {
        ...payload,
        status: "Submitted",
        created_at: new Date().toISOString(),
      },
    ])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function assignWorkerToReport(reportId: string, workerId: string) {
  const { error } = await supabase
    .from("dump_reports")
    .update({ assigned_worker_id: workerId, status: "Worker Assigned" })
    .eq("id", reportId);
  if (error) throw error;
}

export async function completeReport(
  reportId: string,
  cleanedImageUrl: string
) {
  const { error } = await supabase
    .from("dump_reports")
    .update({
      status: "Pending Verification",
      cleaned_image_url: cleanedImageUrl,
    })
    .eq("id", reportId);
  if (error) throw error;
}

export async function verifyReport(reportId: string, approved: boolean) {
  const { error } = await supabase
    .from("dump_reports")
    .update({ status: approved ? "Cleaned & Verified" : "Submitted" })
    .eq("id", reportId);
  if (error) throw error;
}

// ─── Workers ──────────────────────────────────────────────────────────────────

// Safe columns only — excludes pin_hash (credential)
const WORKER_SAFE_COLS = "id,name,phone,ward,employee_id,status,active,lat,lng,tasks_completed,eco_points,bonus_accrued,tier,admin_id,sector_id,created_at,updated_at";

export async function getWorkers(wardFilter?: string) {
  let query = supabase
    .from("workers")
    .select(WORKER_SAFE_COLS)
    .order("created_at", { ascending: false });
  if (wardFilter) query = query.eq("ward", wardFilter);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getWorkerById(id: string) {
  const { data, error } = await supabase
    .from("workers")
    .select(WORKER_SAFE_COLS)
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export async function createWorker(payload: {
  name: string;
  phone: string;
  ward: string;
  employee_id: string;
  admin_id: string;
  pin_hash: string;
}) {
  const { data, error } = await supabase
    .from("workers")
    .insert([{ ...payload, status: "Off Duty", tasks_completed: 0, eco_points: 0, bonus_accrued: 0 }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateWorkerStatus(
  id: string,
  status: "On Duty" | "Off Duty"
) {
  const { error } = await supabase
    .from("workers")
    .update({ status })
    .eq("id", id);
  if (error) throw error;
}

// ─── Admins ───────────────────────────────────────────────────────────────────

// Safe columns only — excludes password_hash and totp_secret (credentials)
const ADMIN_SAFE_COLS = "id,name,email,admin_id,ward_jurisdiction,designation,created_at";

export async function getAdmins() {
  const { data, error } = await supabase.from("admins").select(ADMIN_SAFE_COLS);
  if (error) throw error;
  return data;
}

export async function getAdminByEmail(email: string) {
  const { data, error } = await supabase
    .from("admins")
    .select(ADMIN_SAFE_COLS)
    .eq("email", email)
    .single();
  if (error) throw error;
  return data;
}

// ─── Rewards ──────────────────────────────────────────────────────────────────

export async function getRewards(role?: string) {
  let query = supabase.from("rewards").select("*");
  if (role) query = query.eq("target_role", role);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

// ─── Duplicate-report proximity check (Haversine) ────────────────────────────

export function haversineMeters(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function checkDuplicateReport(lat: number, lng: number): Promise<boolean> {
  // Fetch recent reports from last 24h and check proximity
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("dump_reports")
    .select("lat, lng")
    .gte("created_at", since);
  // Surface the failure: silently returning false would let duplicates through during an outage.
  if (error) throw error;
  if (!data) return false;
  return data.some(
    (r) => r.lat != null && r.lng != null && haversineMeters(lat, lng, r.lat, r.lng) < 15
  );
}
