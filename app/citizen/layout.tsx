"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useEcoStore } from "@/lib/store";
import { UserCheck, Loader2 } from "lucide-react";

export default function CitizenLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated } = useEcoStore();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated || currentUser?.role !== "citizen") {
      router.replace("/auth/citizen");
    }
  }, [isAuthenticated, currentUser, router]);

  if (!isAuthenticated || currentUser?.role !== "citizen") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <UserCheck className="w-12 h-12 text-eco-400/40" />
        <p className="text-slate-400 text-sm">Redirecting to Citizen Login…</p>
        <Loader2 className="w-5 h-5 text-eco-400 animate-spin" />
      </div>
    );
  }

  return <>{children}</>;
}
