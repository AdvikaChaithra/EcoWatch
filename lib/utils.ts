import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(isoString: string): string {
  return new Date(isoString).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatTime(isoString: string): string {
  return new Date(isoString).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export function getDayOfWeek(isoString: string): string {
  return new Date(isoString).toLocaleDateString("en-IN", { weekday: "long" });
}

export function severityColor(severity: string): string {
  switch (severity?.toLowerCase()) {
    case "critical": return "text-red-400 bg-red-500/10 border-red-500/30";
    case "high":     return "text-orange-400 bg-orange-500/10 border-orange-500/30";
    case "medium":   return "text-yellow-400 bg-yellow-500/10 border-yellow-500/30";
    case "low":      return "text-green-400 bg-green-500/10 border-green-500/30";
    default:         return "text-slate-400 bg-slate-500/10 border-slate-500/30";
  }
}

export function statusColor(status: string): string {
  switch (status?.toLowerCase()) {
    case "pending":               return "text-yellow-400 bg-yellow-500/10 border-yellow-500/30";
    case "paid":                  return "text-green-400 bg-green-500/10 border-green-500/30";
    case "disputed":              return "text-orange-400 bg-orange-500/10 border-orange-500/30";
    case "dismissed":             return "text-slate-400 bg-slate-500/10 border-slate-500/30";
    case "submitted":             return "text-blue-400 bg-blue-500/10 border-blue-500/30";
    case "worker assigned":       return "text-purple-400 bg-purple-500/10 border-purple-500/30";
    case "cleaning in progress":  return "text-yellow-400 bg-yellow-500/10 border-yellow-500/30";
    case "pending verification":  return "text-orange-400 bg-orange-500/10 border-orange-500/30";
    case "cleaned & verified":    return "text-green-400 bg-green-500/10 border-green-500/30";
    case "on duty":               return "text-green-400 bg-green-500/10 border-green-500/30";
    case "off duty":              return "text-slate-400 bg-slate-500/10 border-slate-500/30";
    default:                      return "text-slate-400 bg-slate-500/10 border-slate-500/30";
  }
}

export function tierColor(tier: string): string {
  switch (tier?.toLowerCase()) {
    case "eco-champion": return "text-emerald-300 bg-emerald-500/20 border-emerald-400/40";
    case "gold":         return "text-yellow-300 bg-yellow-500/20 border-yellow-400/40";
    case "silver":       return "text-slate-300 bg-slate-400/20 border-slate-400/40";
    case "bronze":       return "text-orange-300 bg-orange-500/20 border-orange-400/40";
    default:             return "text-slate-400 bg-slate-500/10 border-slate-500/30";
  }
}

export function tierPoints(tier: string): { min: number; max: number } {
  switch (tier?.toLowerCase()) {
    case "eco-champion": return { min: 5000, max: 10000 };
    case "gold":         return { min: 2000, max: 5000 };
    case "silver":       return { min: 500,  max: 2000 };
    case "bronze":       return { min: 0,    max: 500 };
    default:             return { min: 0,    max: 500 };
  }
}

export function truncate(str: string, n: number): string {
  return str?.length > n ? str.substring(0, n - 1) + "…" : str;
}

export function generateId(): string {
  return `VIO-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
}
