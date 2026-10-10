import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { name, phone, email, address, ward, gov_id, imageBase64 } = await req.json();

    if (!name || !phone) {
      return NextResponse.json({ success: false, error: "Name and phone are required." }, { status: 400 });
    }
    if (!email) {
      return NextResponse.json({ success: false, error: "Email is required to enable login." }, { status: 400 });
    }

    // ── Check for duplicate phone ─────────────────────────────────────────
    const { data: existingPhone } = await supabase
      .from("citizens")
      .select("id, name")
      .eq("phone", phone)
      .maybeSingle();

    if (existingPhone) {
      return NextResponse.json({ success: false, error: `Phone already registered to ${existingPhone.name}.` }, { status: 409 });
    }

    // ── Check for duplicate email ─────────────────────────────────────────
    const { data: existingEmail } = await supabase
      .from("citizens")
      .select("id, name")
      .eq("email", email.trim().toLowerCase())
      .maybeSingle();

    if (existingEmail) {
      return NextResponse.json({ success: false, error: `Email already registered to ${existingEmail.name}. Try logging in instead.` }, { status: 409 });
    }

    // ── Extract face embedding via FastAPI ────────────────────────────────
    let faceEmbedding: number[] | null = null;

    if (imageBase64) {
      try {
        const pyRes = await fetch("http://localhost:8000/api/auth/extract-embedding", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image_base64: imageBase64 }),
          signal: AbortSignal.timeout(8000),
        });
        if (pyRes.ok) {
          const pyData = await pyRes.json();
          faceEmbedding = pyData.embedding ?? null;
        }
      } catch {
        // FastAPI offline — register without face embedding (text-only citizen)
      }
    }

    // ── Insert new citizen ────────────────────────────────────────────────
    const payload: Record<string, any> = {
      name,
      phone,
      email:   email.trim().toLowerCase(),
      address, ward, gov_id,
      eco_points: 0,
      tier:       "Bronze",
    };
    if (faceEmbedding) payload.face_embedding = faceEmbedding;

    const { data: citizen, error } = await supabase
      .from("citizens")
      .insert([payload])
      .select("id, name, phone, email, ward, eco_points, tier")
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, citizen, hasEmbedding: !!faceEmbedding });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
