import { NextRequest, NextResponse } from "next/server";
import { serverSupabase, fail, serverError, readJson, extractEmbedding } from "@/lib/server";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<{ imageBase64?: string }>(req);
    const imageBase64 = typeof body?.imageBase64 === "string" ? body.imageBase64 : "";
    if (!imageBase64) return fail("No image provided.", 400);

    const result = await extractEmbedding(imageBase64);
    if (!result.ok) {
      if (result.reason === "no_face") return fail(result.message, 422);
      if (result.reason === "offline") return fail(result.message, 503);
      return fail(result.message, 502);
    }

    const supabase = serverSupabase();
    const { data, error } = await supabase.rpc("match_citizen_face", {
      query_embedding: result.embedding,
      match_threshold: 0.7,
      match_count: 1,
    });
    if (error) throw error;

    if (!data || data.length === 0) {
      return fail("Face not recognized. Similarity below threshold.", 401);
    }
    const match = data[0];
    return NextResponse.json({
      success: true,
      citizen: {
        id: match.id,
        name: match.name,
        phone: match.phone,
        ward: match.ward,
        eco_points: match.eco_points,
        tier: match.tier,
        similarity: match.similarity,
      },
    });
  } catch (e) {
    return serverError(e, "face-login");
  }
}
