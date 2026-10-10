"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useEcoStore } from "@/lib/store";
import { Shield, Loader2 } from "lucide-react";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated } = useEcoStore();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated || currentUser?.role !== "admin") {
      router.replace("/auth/admin");
    }
  }, [isAuthenticated, currentUser, router]);

  if (!isAuthenticated || currentUser?.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Shield className="w-12 h-12 text-blue-400/40" />
        <p className="text-slate-400 text-sm">Redirecting to Admin Login…</p>
        <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
