import { Loader2 } from "lucide-react";

export default function SurveillanceLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center pt-20">
      <div className="flex flex-col items-center gap-4 animate-fade-in-up">
        <Loader2 className="w-8 h-8 text-red-500 animate-spin" />
        <p className="text-sm font-medium tracking-wide text-slate-400 uppercase">Initializing Surveillance Network...</p>
      </div>
    </div>
  );
}
