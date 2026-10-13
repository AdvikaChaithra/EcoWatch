# EcoWatch — Demo Script (5 minutes) + Viva notes

## One-time setup (≈10 minutes)
1. Supabase dashboard → **SQL Editor** → paste `migrations/001_demo.sql` → Run. (Safe: additive, re-runnable.)
2. `python scripts/preflight.py` — everything must say PASS except "enrolled face" (next step).
3. Start the app: `powershell -ExecutionPolicy Bypass -File .\start_demo.ps1`
   (or the three commands in `docs/PROJECT_GUIDE.md`). Open http://localhost:3000.
4. **Enroll yourself:** `/auth/citizen` → Register → fill details → "Optional: enroll face…" → tick consent →
   capture (face the webcam, good light) → Register. Re-run preflight: "At least one enrolled face" = PASS.
5. **Backup clip (recommended):** record yourself doing the drop once (see below), save as `demo/clip.mp4`.
   Replay with `.\start_demo.ps1 -Source "demo\clip.mp4"` — the SAME real pipeline runs on the recorded clip.

## Staging the live drop (the camera must see your face)
- Webcam at chest/eye height, ~1–1.5 m away, face lit from the front, plain background.
- Stand in frame holding an empty plastic bottle for ~2 s (association), **look at the camera**,
  lower your hand and let the bottle fall/place it on the floor, step back 2–3 steps and walk out of frame.
- Keep the bottle visible and still for >2 s after you leave (dwell). Rehearse 5–10 times.
- Tune in `backend/.env` if needed: `LITTER_DWELL_SECONDS`, `FACE_MATCH_THRESHOLD` (see numbers shown on
  `/surveillance` after each attempt).

## Walk-through for the evaluator
1. **Surveillance** (`/surveillance`): live camera, real FPS/latency, boot stages. Walk normally → nothing happens.
   Pick the bottle up → no violation (PICKUP). Explain: waste visible ≠ littering; it needs the full sequence.
2. Open a second browser window logged in as the citizen (`/citizen` → Violations tab). Keep it visible.
3. Perform the drop. `/surveillance` shows LITTERING CONFIRMED → "IDENTIFYING…" → **IDENTITY: MATCHED**
   (masked name, similarity %, fine ₹200). The citizen window shows the new violation instantly (Supabase Realtime)
   with the 3 evidence frames (holding → dropped → leaving).
4. Show a **different citizen's** window: nothing appears (alert is account-specific).
5. Citizen: open the violation → **Dispute** with a reason (or **Pay** — clearly a *demo payment*).
6. Admin (`/auth/admin` → `/admin`): Tribunal tab shows the dispute with the evidence strip → Uphold / Dismiss.
   Show "Unidentified littering events" list (cases where the face could not be matched: no fine issued).
7. Dump-report loop: Citizen → *Report Dump* (photo + GPS) → routed to the owning sector's admin → Dispatch →
   worker portal shows photo + location → worker submits cleaned proof → admin SLA tab approves → points credited.
8. Rewards tab: use Eco-Points to reduce a pending fine (10 pts = ₹1, max 50%). Civic Map tab: most/least polluted sectors.

## Honest limitations (say these before they ask)
- Face matching is only as good as the face pixels the camera gets; thresholds were tuned on a few rehearsal
  runs, not a large validation set. Uncertain/no-face cases never produce a fine (they go to an admin review list).
- Stock COCO YOLO detects bottles/cups as litter; a fine-tuned litter model would improve accuracy.
- No liveness detection (a printed photo could fool enrollment/recognition); login is email+phone (demo level);
  database row-level security is not enabled; payments are a demo.
- Sectors are routed by nearest sector centre, not polygons.

## Likely viva questions
- *How do you avoid false fines?* Multi-stage temporal state machine; face quality gate; threshold + margin over
  runner-up; uncertain → no fine; one fine per event (unique index); dispute + admin review with 3 frames.
- *Why not recognise faces every frame?* Cost and privacy: face work runs once, at a confirmed event, on crops
  of the responsible person's track only.
- *Where is biometric data stored?* Only a 512-D numeric template in Postgres (pgvector), not the photo; consent
  required; one face per account.
- *What would you do next?* Supabase Auth + RLS, liveness, fine-tuned litter detector, polygon sectors, real payments.
