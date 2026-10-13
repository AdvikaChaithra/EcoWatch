# ECOWATCH — PART 2 (REVISED)
## Identity, Violations, Sector-Based Administration, Citizen/Worker Flows

You are continuing the EXISTING EcoWatch project (Next.js + FastAPI + Supabase + YOLOv8/ByteTrack engine).
Part 1 (single-camera littering state machine in `backend/vision_engine.py` and
`backend/littering_detector.py`) is done. Do NOT rewrite it. Only add the hooks listed in §2.
Inspect the repo first and reuse what works. No mocked data anywhere: if something cannot run,
show the real error state and report the blocker.

Work in the ordered stages below. Do not start a stage until the previous stage's acceptance
check passes. Report PASS/FAIL per stage with real measurements.

---

## STAGE 0 — Foundations (prerequisites for everything else)

0.1 **Real authentication.** Replace the localStorage "session" with Supabase Auth.
Row-level security and per-user Realtime are impossible without `auth.uid()`.
- Citizens: email/phone + OTP or password. **Face is NOT used to log in** (remove the `face-login`
  route/UI). Face is only an optional enrolled biometric used by the camera pipeline.
- Municipal admins and workers: accounts created by an admin (workers) or a super-admin (admins).
  Workers log in with employee ID + PIN mapped to a Supabase Auth user (server-side exchange);
  hash PINs, rate-limit attempts, support logout and account disable.
- One `profiles` table keyed by `auth.users.id` with `role` flags (`citizen`, `worker`, `admin`,
  `super_admin`). A worker may also act as a citizen when off duty (§7.4).

0.2 **Enable RLS on every table** and write policies (citizen: own rows; worker: assigned rows;
admin: rows in their sectors; super_admin: all). Remove the "DISABLE ROW LEVEL SECURITY" block in
`schema.sql`. Never ship the service-role key to the browser. Credentials/biometrics columns
(`password_hash`, `pin_hash`, `face_embedding`, `gov_id`) must be unreadable by `anon`/`authenticated`.
Add an automated test that proves a citizen cannot read another citizen's violations/notifications.

0.3 **Migrations**, not a single drop-and-recreate script. Keep versioned SQL files.

Acceptance: log in as two citizens; each sees only their own data; anonymous requests get nothing.

---

## STAGE 1 — Location hierarchy and sector ownership

Model (PostGIS enabled):
```
cities(id, name, state)
areas(id, city_id, name)                      -- e.g. Vijayanagar
sectors(id, area_id, name, geom POLYGON)      -- e.g. Sector 2
admin_sectors(admin_id, sector_id, is_primary, active_from, active_to)
workers.home_sector_id, workers.admin_id      -- each worker belongs to ONE admin/sector at a time
worker_assignment_history(worker_id, sector_id, admin_id, from, to)
cameras(id, name, lat, lng, sector_id, ward)  -- camera -> sector, set once at registration
```
Rules:
- Every report/violation gets `sector_id` **server-side**: `ST_Contains(sectors.geom, point)`;
  if outside all polygons, nearest sector within a configurable distance, else a "needs triage"
  queue visible to super_admin. Never trust a sector sent by the client.
- Camera violations take the camera's `sector_id`.
- RLS: an admin sees reports, violations, disputes, workers and tasks only where
  `sector_id IN (SELECT sector_id FROM admin_sectors WHERE admin_id = auth.uid())`.
  Super-admin sees all; area-level search is a filter (Area -> Sector), not a permission.
- 2-3 admins per area, each owning different sectors. Each admin has a worker pool; admins can
  transfer a worker to another sector/admin (history recorded). Optional backup admin per sector
  for leave/escalation.
- Admin UI: Area dropdown -> Sector dropdown -> that sector's admin, workers (status/location),
  open reports, SLA breaches, disputes. Search by area + sector.

Acceptance: a report at a point inside "Vijayanagar / Sector 2" appears only for that sector's admin;
other admins get zero rows via both UI and a direct API/DB query.

---

## STAGE 2 — Face enrollment (optional, consented)

Data (never in `citizens`, never sent to the browser):
```
citizen_face_embeddings(id, citizen_id, embedding vector(512), model_name, model_version,
  embedding_version, quality_score, is_active, created_at)   -- HNSW or IVFFlat cosine index
citizens.face_enrolled, citizens.face_consent_at, citizens.face_consent_text_version
```
- Explicit consent screen (India DPDP Act 2023 style: purpose, retention, withdrawal) before camera opens.
- Capture 3-5 frames in a guided flow (look straight, left, right). Reject: no face / >1 face,
  face width < 112 px, detector score low, blur (Laplacian variance), under/over-exposure,
  extreme yaw/pitch, occlusion. Show the exact rejection reason.
- Basic liveness (blink/head-turn challenge or passive anti-spoof model) so a printed photo of
  someone else cannot be enrolled. Enrollment requires an authenticated account.
- **Duplicate-face check:** before storing, search existing embeddings; if the same face already
  belongs to a different account, block and flag for admin.
- Store several embeddings per citizen (one per pose), L2-normalised, same model/preprocessing as
  recognition. Raw images: not kept by default; if kept, private bucket `biometric-enrollment`
  with a retention job. Citizen can delete all biometric data (hard delete + audit log entry).
- Pin the exact InsightFace package/model (e.g. `buffalo_l`) and record it per embedding. If the
  model version changes, mark old embeddings inactive and require re-enrollment.

Acceptance: enrolled embedding exists, is 512-D, unit-norm; a browser request for it returns nothing.

---

## STAGE 3 — Offender face capture in the engine (the part the original prompt got wrong)

A camera at littering distance rarely gives a usable face at the moment of the drop, and the person
often walks away facing backward. Running face recognition only "after the event" will mostly fail.
Design:
- While a **person track is alive** (not only after an event), run a cheap face detector on that
  person's ROI at ~2-3 Hz (never on the whole frame every frame, never ArcFace yet). Keep, per
  person track, a bounded **top-K face crop buffer** ranked by quality (size, sharpness, frontality,
  detector score). Drop buffers when the track ends.
- On `LITTERING_CONFIRMED`, take the responsible `person_track_id` (Part 1 association only; never
  "the largest face"), pull its best crops from the buffer (including crops from before the drop),
  run ArcFace on the top 1-3, and average/vote.
- If no crop passes the quality gate -> `identity_status = UNCERTAIN` (reason `NO_FACE` or
  `LOW_FACE_QUALITY`). Do not guess.
- Track-ID switches (occlusion/re-entry) can attach the wrong face: only use crops from the
  responsible track and from tracks Part 1 already merged/stitched with it; log the track lineage.
- Evidence: a **3-keyframe series + short clip** from the Part 1 ring buffer: (1) person holding the
  object, (2) object leaving the hand/dropped, (3) object stationary and person departing, each with
  boxes, timestamp, camera id, event id. Admins use this series to judge disputes. Store in the
  private `violation-evidence` bucket; keep only paths in the DB; serve via short-lived signed URLs.
- Measure and report real face detection rate, crop size distribution, and latency. State plainly
  if the camera hardware/placement cannot yield enough face pixels (consider a second tighter-zoom
  camera or a narrower field of view at entry points rather than lowering thresholds).

Acceptance: report the % of confirmed test events that had >=1 usable face crop. Below target means
fix the camera setup, not the threshold.

---

## STAGE 4 — Matching and violation creation (server-side, idempotent)

Transport: the engine sends the event + embedding(s) + evidence paths to the backend over an
authenticated channel (`ENGINE_API_KEY`, TLS in production). The **backend alone** decides identity
and creates the violation; the browser can never create a violation or set fine/confidence.

Matching (SQL function, `SECURITY DEFINER`, executable only by the backend role):
- cosine distance over active embeddings; return `citizen_id`, `similarity`, plus top-2 gap.
- Decision (all configurable): `MATCH` only if `similarity >= FACE_MATCH_THRESHOLD`
  AND `top1 - top2 >= FACE_MATCH_MARGIN` AND quality passed AND >=2 of the top-3 crops agree.
  Between `FACE_REVIEW_THRESHOLD` and the match threshold -> `UNCERTAIN`. Otherwise `NO_MATCH`.
- Calibrate thresholds on a labelled validation set (genuine vs impostor pairs, including this
  camera's distance/lighting): produce an ROC/DET curve and choose the threshold for a stated false
  match rate (e.g. <= 1 in 10,000). Commit the calibration script and results; do not invent numbers.
- Output of an unmatched/uncertain event: `unidentified_littering_events` row for admin review,
  **no citizen fine**.

Human-in-the-loop policy (configurable): `AUTO_ISSUE_MIN_SIMILARITY` — above it a fine is issued
immediately with status `PENDING`; between thresholds it goes to an admin review queue first.
Fines are legal-adjacent; wrongful fines are the system's biggest risk.

Violation record: id, citizen_id, event_id (UNIQUE), camera_id, sector_id, lat/lng/ward/location_name
(from the camera), person_track_id, waste_track_id, event_confidence, face_similarity,
evidence_paths[], fine_amount (from `LITTERING_FINE_AMOUNT`, stored once), status, created_at.
- Idempotency via a DB UNIQUE constraint on `event_id`; the insert+notification run in one transaction.
- Engine retries (with backoff) if the backend/DB is down; the event is persisted locally and never lost.

---

## STAGE 5 — Notifications and citizen experience

- `notifications(id, user_id, type, title, message, violation_id, read, created_at)` with RLS
  `user_id = auth.uid()`. The citizen dashboard subscribes to Supabase Realtime on this table
  (filtered by user and enforced by RLS) — no polling, no global broadcast.
- Violation alert shows camera location, date/time, fine, violation id; opens a detail page with
  the evidence series (signed URLs), a **DEMO PAYMENT** (clearly labelled) and "Dispute".
- SMS via Twilio only if configured; status `NOT_CONFIGURED | QUEUED | SENT | FAILED` stored per
  notification from the real API response. Never display "SMS sent" otherwise.
- Dispute: `PENDING -> DISPUTED -> UPHELD | DISMISSED` with `dispute_reason`, `reviewed_by`,
  `reviewed_at`, `admin_reason`; deadline (e.g. 15 days) configurable; admin sees the 3-keyframe
  series + similarity + sector-scoped queue. Dismissed -> fine voided, points/penalties restored;
  all decisions audit-logged. A wrongly-detected citizen can also report "this wasn't me".
- Demo payment confirmed by backend only; status `PAID`.

---

## STAGE 6 — Dump reports -> sector admin -> worker -> verification

- Citizen takes a photo (in-app camera, GPS stamp, accuracy radius recorded; reject low-accuracy
  fixes), submits; server assigns `sector_id` (Stage 1); duplicate detection (same area within
  radius/time) merges instead of duplicating.
- Sector admin sees it in their queue and assigns a worker from their own pool (suggest nearest
  on-duty workers by distance/load). Worker sees photo + map location + navigation.
- Worker submits "cleaned" proof: geofence check (within X m of the report), before/after photos,
  server-side timestamp (not client-supplied). Admin approves/rejects; rejection returns it to the
  worker with a reason. Eco-points are awarded only on admin approval, through the ledger (§7.1).
- SLA timers per severity with escalation to the backup admin / super-admin.

---

## STAGE 7 — Eco-points, rewards, roles

7.1 **Ledger, not counters:** `points_ledger(id, user_id, delta, reason, ref_type, ref_id, created_at)`
with balance = sum; redemptions are transactions (no read-modify-write races, full audit trail).
7.2 Citizen redemptions: reduce a penalty (capped, e.g. max 50% of a fine, policy-configurable),
event/programme tickets (inventory + one-time codes). Workers: salary bonus (payroll export),
vouchers/groceries. Separate reward catalogues per role.
7.3 Abuse controls: rate limits on reports, points only on verified outcomes, admin override log.
7.4 **Worker-as-citizen:** same auth user, two roles; separate point balances per role; shift state
decides which dashboard is shown.

---

## STAGE 8 — Pollution map and rankings (citizen portal)

- Hotspot score per sector = time-decayed, severity-weighted count of open + recent reports and
  verified violations, normalised by sector area (and population if available). Document the formula.
- Show most and least polluted sectors in the city, plus the viewer's sector rank within the area,
  city and state; "state" requires multiple cities in the data — show only ranks that exist.
- Heat map layer from real aggregates (server-side materialised view), refreshed on a schedule.

---

## CROSS-CUTTING REQUIREMENTS

- No mock/random data. Errors are shown as errors (`CAMERA_OFFLINE`, `YOLO_ERROR`, `TRACKER_ERROR`,
  `FACE_MODEL_ERROR`, `DATABASE_ERROR`, `PGVECTOR_ERROR`, `NO_FACE`, `LOW_FACE_QUALITY`, `NO_MATCH`,
  `UNCERTAIN_MATCH`, `VIOLATION_CREATED`, `SMS_NOT_CONFIGURED`).
- Secrets only server-side; private buckets + signed URLs; audit log for every admin decision and
  every biometric access; privacy notice and retention schedule; camera signage notice.
- Expensive work only on events (face crops buffer is the only continuous extra cost, bounded).
- Part 1 detector quality: the stock COCO model only knows bottle/cup. Before relying on it, evaluate
  on your own recorded clips (precision/recall of confirmed events per test in Part 1 §25) and
  consider fine-tuning on a litter dataset (e.g. TACO + your own frames). Report the numbers.
- Tests: automated RLS tests; unit tests for the match decision function with synthetic embeddings
  (clearly labelled test fixtures, not production data); recorded-clip replay tests for the
  state machine (Part 1 scenarios 1-7) so regressions are caught without a live camera.

## FINAL ACCEPTANCE (all must be demonstrated, with real records shown)
1. Two citizens (one enrolled, one not) and two admins in different sectors exist.
2. Enrolled citizen's embedding exists in pgvector; browser cannot read it.
3. Real camera: enrolled citizen performs the controlled drop -> event confirmed -> face crop from
   the responsible track -> MATCH -> violation row (event_id unique) -> notification row ->
   Realtime alert appears **only** for that citizen -> evidence series visible via signed URLs.
4. Unenrolled person drops litter -> `UNKNOWN`, no citizen fine, admin sees an unidentified event.
5. Blurred/occluded face -> `UNCERTAIN`, review queue, no automatic fine.
6. Enrolled person walking / carrying / picking up litter -> no violation.
7. Citizen disputes; the sector's admin (and only that sector's admin) reviews and decides.
8. Citizen photographs a dump in Sector 2 -> only Sector 2's admin sees it -> assigns a worker ->
   worker sees photo+location -> submits cleaned proof -> admin approves -> points ledger entries.
9. Report: measured FPS, inference latency, face-crop success rate, genuine/impostor similarity
   distributions, chosen thresholds with their false-match rate, remaining limitations.
