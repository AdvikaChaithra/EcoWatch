import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, extractEmbedding } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<Record<string, any>>(req);
    if (!body) return fail("Invalid request body.", 400);
    const { name, phone, address, ward, gov_id, imageBase64 } = body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";

    if (!name || !phone) return fail("Name and phone are required.", 400);
    if (!email) return fail("Email is required to enable login.", 400);

    const supabase = serverSupabase();

    const { data: existingPhone, error: e1 } = await supabase
      .from("citizens").select("id, name").eq("phone", phone).maybeSingle();
    if (e1) throw e1;
    if (existingPhone) return fail(`Phone already registered to ${existingPhone.name}.`, 409);

    const { data: existingEmail, error: e2 } = await supabase
      .from("citizens").select("id, name").eq("email", email).maybeSingle();
    if (e2) throw e2;
    if (existingEmail) return fail(`Email already registered to ${existingEmail.name}. Try logging in instead.`, 409);

    // If a photo was supplied, enrollment must succeed — never silently create an
    // account that can't use face login.
    let faceEmbedding: number[] | null = null;
    if (imageBase64) {
      if (body.consent !== true) return fail("Consent is required to store face data.", 400);
      const result = await extractEmbedding(imageBase64);
      if (!result.ok) {
        const status = result.reason === "no_face" ? 422 : result.reason === "offline" ? 503 : 502;
        return fail(result.message, status);
      }
      faceEmbedding = result.embedding;

      // One face = one account: block enrolling a face that already belongs to someone else.
      const { data: dup, error: dupErr } = await supabase.rpc("find_duplicate_face", {
        query_embedding: faceEmbedding, exclude_citizen: null, min_similarity: 0.6,
      });
      if (dupErr) throw dupErr;
      if (dup && dup.length > 0) return fail("This face is already registered to another account.", 409);
    }

    const payload: Record<string, any> = {
      name, phone, email, address, ward, gov_id,
      eco_points: 0,
      tier: "Bronze",
    };
    if (faceEmbedding) {
      payload.face_embedding = faceEmbedding;
      payload.face_enrolled = true;
      payload.face_consent_at = new Date().toISOString();
    }

    const { data: citizen, error } = await supabase
      .from("citizens")
      .insert([payload])
      .select("id, name, phone, email, ward, eco_points, tier")
      .single();
    if (error) {
      // Unique-constraint race between the checks above and the insert.
      if ((error as any).code === "23505") return fail("Phone or email is already registered.", 409);
      throw error;
    }

    return NextResponse.json({ success: true, citizen, hasEmbedding: !!faceEmbedding });
  } catch (e) {
    return serverError(e, "register-face");
  }
}
