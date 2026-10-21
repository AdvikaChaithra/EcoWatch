"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Crown, Loader2 } from "lucide-react";
import { useEcoStore } from "@/lib/store";
import { ForceChangeCredential } from "@/components/auth/ForceChangeCredential";

/** Super Admin portal guard: only the Municipal Commissioner (role super_admin). */
export default function SuperLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated } = useEcoStore();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const router = useRouter();
  const allowed = isAuthenticated && currentUser?.role === "super_admin" && !!currentUser?.token;

  useEffect(() => {
    if (mounted && !allowed) router.replace("/auth/admin");
  }, [mounted, allowed, router]);

  if (!mounted || !allowed) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Crown className="w-12 h-12 text-amber-400/40" />
        <p className="text-slate-400 text-sm">Super Admin access only. Redirecting to login…</p>
        <Loader2 className="w-5 h-5 text-amber-400 animate-spin" />
      </div>
    );
  }
  if (currentUser?.must_change) return <ForceChangeCredential kind="password" />;
  return <>{children}</>;
}
