import { create } from "zustand";
import { supabase } from "./supabase";

export type Role = "citizen" | "admin" | "super_admin" | "worker" | "surveillance";

export interface LiveAlert {
  id: string;
  type: "violation" | "report" | "task" | "biometric";
  message: string;
  location?: string;
  timestamp: string;
  citizenName?: string;
  confidence?: number;
  snapshotUrl?: string;
  bbox?: { person?: number[]; waste?: number[] };
}

export interface Sector { id: string; area: string; name: string; corporation?: string | null; admin_id?: string | null; lat?: number; lng?: number; }

export interface AuthUser {
  id: string;
  role: Role;
  name: string;
  email?: string;
  phone?: string;
  ward?: string;
  employee_id?: string;
  eco_points?: number;
  tier?: string;
  designation?: string;
  /** server-signed session token (sent as Bearer on privileged API calls) */
  token?: string;
  /** first login with a temporary password / one-time PIN: must change it before continuing */
  must_change?: boolean;
  sector_id?: string | null;
}

const STORAGE_KEY = "ecowatch_session";

function loadSession(): { currentUser: AuthUser | null; activeRole: Role } {
  if (typeof window === "undefined") return { currentUser: null, activeRole: "citizen" };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { currentUser: null, activeRole: "citizen" };
    return JSON.parse(raw);
  } catch {
    return { currentUser: null, activeRole: "citizen" };
  }
}

function saveSession(user: AuthUser | null, role: Role) {
  if (typeof window === "undefined") return;
  if (user) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ currentUser: user, activeRole: role }));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

interface EcoWatchStore {
  // Auth
  currentUser: AuthUser | null;
  activeRole: Role;
  isAuthenticated: boolean;
  setCurrentUser: (user: AuthUser | null) => void;
  setActiveRole: (role: Role) => void;
  logout: () => void;

  // Admin sector scope
  mySectors: Sector[];
  sectorFilter: string; // "all" or a sector id
  setMySectors: (s: Sector[]) => void;
  setSectorFilter: (id: string) => void;

  // Live Stats (WebSocket-fed)
  totalViolationsToday: number;
  activeDumpReports: number;
  workersOnDuty: number;
  liveAlerts: LiveAlert[];

  setTotalViolationsToday: (n: number) => void;
  setActiveDumpReports: (n: number) => void;
  setWorkersOnDuty: (n: number) => void;
  addLiveAlert: (alert: LiveAlert) => void;
  clearAlerts: () => void;

  // Live worker GPS locations (updated via WebSocket worker_location events)
  workerLocations: Record<string, { lat: number; lng: number; name: string; ward: string }>;
  setWorkerLocation: (workerId: string, data: { lat: number; lng: number; name: string; ward: string }) => void;

  // Notification banner (camera AI events)
  notificationBanner: { message: string; visible: boolean } | null;
  showNotificationBanner: (msg: string) => void;
  hideNotificationBanner: () => void;
}

const initial = loadSession();

export const useEcoStore = create<EcoWatchStore>((set, get) => ({
  currentUser:     initial.currentUser,
  activeRole:      initial.activeRole,
  isAuthenticated: initial.currentUser !== null,

  setCurrentUser: (user) => {
    const role = user?.role ?? get().activeRole;
    saveSession(user, role);
    set({ currentUser: user, isAuthenticated: user !== null, activeRole: role });
  },
  setActiveRole: (role) => {
    saveSession(get().currentUser, role);
    set({ activeRole: role });
  },
  logout: () => {
    saveSession(null, "citizen");
    set({ currentUser: null, isAuthenticated: false, activeRole: "citizen" });
  },

  mySectors: [],
  sectorFilter: "all",
  setMySectors: (s) => set({ mySectors: s, sectorFilter: "all" }),
  setSectorFilter: (id) => set({ sectorFilter: id }),

  totalViolationsToday: 0,
  activeDumpReports: 0,
  workersOnDuty: 0,
  liveAlerts: [],

  setTotalViolationsToday: (n) => set({ totalViolationsToday: n }),
  setActiveDumpReports:    (n) => set({ activeDumpReports: n }),
  setWorkersOnDuty:        (n) => set({ workersOnDuty: n }),
  addLiveAlert: (alert) =>
    set((state) => ({ liveAlerts: [alert, ...state.liveAlerts].slice(0, 50) })),
  clearAlerts: () => set({ liveAlerts: [] }),

  workerLocations: {},
  setWorkerLocation: (workerId, data) =>
    set((state) => ({ workerLocations: { ...state.workerLocations, [workerId]: data } })),

  notificationBanner: null,
  showNotificationBanner: (msg) => set({ notificationBanner: { message: msg, visible: true } }),
  hideNotificationBanner: () => set({ notificationBanner: { message: "", visible: false } }),
}));

// ─── Bootstrap global stats from Supabase ──────────────────────────────────
export async function bootstrapGlobalStats() {
  const store = useEcoStore.getState();
  try {
    // Start of the user's local day, as an ISO instant (not the UTC date).
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const today = startOfDay.toISOString();
    const [{ count: violations, error: e1 }, { count: reports, error: e2 }, { count: workers, error: e3 }] = await Promise.all([
      supabase.from("violations").select("id", { count: "exact", head: true }).gte("timestamp", today),
      supabase.from("dump_reports").select("id", { count: "exact", head: true }).not("status", "eq", "Cleaned & Verified"),
      supabase.from("workers").select("id", { count: "exact", head: true }).eq("status", "On Duty").eq("active", true),
    ]);
    if (e1 || e2 || e3) throw e1 || e2 || e3;
    store.setTotalViolationsToday(violations ?? 0);
    store.setActiveDumpReports(reports ?? 0);
    store.setWorkersOnDuty(workers ?? 0);
  } catch (e) { console.warn("[EcoWatch] Could not bootstrap global stats:", e); }
}
