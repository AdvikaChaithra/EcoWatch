"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEcoStore } from "@/lib/store";
import { Shield, Loader2 } from "lucide-react";
import { ForceChangeCredential } from "@/components/auth/ForceChangeCredential";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { currentUser, isAuthenticated } = useEcoStore();
  // Hydration fix: the saved session is only known in the browser, so render the
  // same placeholder as the server until mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated || (currentUser?.role !== "admin" && currentUser?.role !== "super_admin")) {
      router.replace("/auth/admin");
    }
  }, [isAuthenticated, currentUser, router]);

  if (!mounted || !isAuthenticated || (currentUser?.role !== "admin" && currentUser?.role !== "super_admin")) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <Shield className="w-12 h-12 text-blue-400/40" />
        <p className="text-slate-400 text-sm">Redirecting to Admin Login…</p>
        <Loader2 className="w-5 h-5 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (currentUser?.must_change) return <ForceChangeCredential kind="password" />;
  return <>{children}</>;
}
