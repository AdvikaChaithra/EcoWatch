import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { imageBase64 } = await req.json();
    // imageBase64 is the captured frame from the browser webcam

    if (!imageBase64) {
      return NextResponse.json({ success: false, error: "No image provided." }, { status: 400 });
    }

    // ── Option A: Extract embedding via Python FastAPI backend ───────────
    // If the FastAPI backend is running, delegate embedding extraction there.
    let embedding: number[] | null = null;

    try {
      const pyRes = await fetch("http://localhost:8000/api/auth/extract-embedding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: imageBase64 }),
        signal: AbortSignal.timeout(8000),
      });
      if (pyRes.ok) {
        const pyData = await pyRes.json();
        embedding = pyData.embedding ?? null;
      }
    } catch {
      // FastAPI offline — will do DB-only lookup (demo mode without embedding)
    }

    // ── Option B: Query Supabase RPC with embedding (if extracted) ───────
    if (embedding) {
      const { data, error } = await supabase.rpc("match_citizen_face", {
        query_embedding: embedding,
        match_threshold: 0.70,
        match_count: 1,
      });

      if (error) throw error;

      if (data && data.length > 0) {
        const match = data[0];
        return NextResponse.json({
          success: true,
          citizen: {
            id:         match.id,
            name:       match.name,
            phone:      match.phone,
            ward:       match.ward,
            eco_points: match.eco_points,
            tier:       match.tier,
            similarity: match.similarity,
          },
        });
      }
      return NextResponse.json({ success: false, error: "Face not recognized. Similarity below threshold." }, { status: 401 });
    }

    // ── Demo/Fallback: Return first citizen if no backend running ─────────
    // Removed: production must have FastAPI backend for real face matching.
    return NextResponse.json({
      success: false,
      error: "Face recognition backend offline. Start backend/main.py and try again.",
    }, { status: 503 });

  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
