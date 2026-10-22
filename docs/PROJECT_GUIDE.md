# EcoWatch — Project Guide

AI-assisted civic cleanliness platform for a municipality. A camera watches a public spot and detects
**littering** (not just "trash in view"); citizens report **illegal dumping** with geo-tagged photos;
municipal admins dispatch **workers**, verify cleanups and review **disputed fines**; citizens and
workers earn **Eco-Points** that they can redeem.

---

## 1. Architecture

```
                         ┌──────────────────────────── Supabase (Postgres + PostGIS + pgvector, Storage) ┐
                         │                                                                               │
 Browser (Next.js 14) ───┤ direct queries with the public key (citizens, workers, reports, violations)   │
  /citizen /worker       │                                                                               │
  /admin /surveillance   └───────────────────────────────────────────────────────────────────────────────┘
        │  ▲  \_ Next.js API routes (server): admin-login, worker-login, register-face, face-login
        │  │          │ fetch embedding
        │  │ WebSocket ▼
        │  └────────  FastAPI backend (port 8000)  ── REST routers: auth, violations, reports, workers
        │              /ws, /ws/alerts, /evidence (static), /api/vision/*, /api/littering_event, /health
        │                        ▲
        │ MJPEG (port 8001)      │ HTTP (X-Engine-API-Key)
        └──────────────  Vision Engine (python -m backend.vision_engine)
                          webcam/RTSP → OpenCV → YOLOv8 → ByteTrack → littering state machine
                          → evidence frames on disk → POST event → WebSocket → /surveillance
```

Three separately started processes: **Next.js** (3000), **FastAPI** (8000), **Vision Engine** (opens the camera,
serves the live MJPEG stream on 8001). Most citizen/admin/worker screens talk to Supabase directly from the
browser; FastAPI is mainly the real-time hub and the face-embedding service.

## 2. Tech stack

| Layer | Tech |
|---|---|
| Frontend | Next.js 14 (App Router), React 18, TypeScript, Tailwind, Zustand (state), Leaflet/react-leaflet (maps), Recharts, Radix UI |
| Backend | FastAPI, Uvicorn, Pydantic v2, httpx, psutil, python-dotenv |
| Database | Supabase: PostgreSQL + **PostGIS** (geo) + **pgvector** (512-D face embeddings), Storage bucket `evidence` |
| Vision | OpenCV, Ultralytics **YOLOv8** (`yolov8n.pt`) + **ByteTrack**, custom state machine |
| Face | InsightFace **ArcFace** (`buffalo_l`) → 512-D embeddings |
| Notifications | Twilio SMS (optional), WebSocket in-app banners |

## 3. Repository map

```
app/
  page.tsx                landing page
  auth/{citizen,worker,admin}/page.tsx   login/registration screens
  api/auth/*              Next.js server routes (admin-login, worker-login, register-face, face-login)
  citizen/ worker/ admin/ surveillance/  role dashboards (layout.tsx guards, loading.tsx)
components/
  citizen/   ViolationHub, ReportTool, ReportTracker, CivicHeatmap(+MapComponent), RewardsHub
  worker/    ShiftToggle, TaskCard, WorkerProfile
  admin/     KPIOverview, TaskDispatch, SLAMonitor, DisputeTribunal, WorkforceManager,
             OperationsHeatmap(+OpsMapComponent), AdminProfile
  surveillance/ CameraFeed, BiometricPanel, PenaltyTerminal
  layout/    GlobalHeader, NotificationBanner, RealtimeProvider, ErrorNote
hooks/       useRealtime (global WebSocket), useCamera, useGeolocation
lib/         supabase.ts (client + data helpers), store.ts (Zustand), server.ts (API-route helpers), utils.ts
backend/
  main.py                FastAPI app, WebSocket, vision/event endpoints, civic index, SMS
  database.py            lazy Supabase client + WebSocket ConnectionManager
  security.py            API-key guard, password/PIN hashing, Twilio helper
  models.py              Pydantic models
  routers/               auth.py, violations.py, reports.py, workers.py
  vision_engine.py       camera, YOLO, ByteTrack, evidence, MJPEG server, telemetry
  littering_detector.py  littering state machine (the core logic)
  camera_zones.py/.json  bin zones / no-litter zones; draw_zones.py = interactive editor
  telemetry.py           real CPU/RAM/FPS/latency/GPU measurements
schema.sql               full database schema + demo seed data (DROPS existing tables!)
docs/                    this guide, Part 2 prompt
```

## 4. What each portal does

**Citizen** (`/citizen`) — tabs: *Violations* (see fines with evidence, pay via demo payment, dispute),
*Report Dump* (in-app camera + GPS stamp + category/severity → +40 Eco-Points; duplicate reports within 15 m /
24 h are blocked), *My Reports* (status tracking, before/after slider), *Civic Map* (heat/marker map of reports,
place search), *Rewards* (redeem Eco-Points; tiers Bronze/Silver 500/Gold 2000/Eco-Champion 5000).
Registration captures details + an optional face photo; the embedding is stored for the camera pipeline.

**Worker** (`/worker`) — login with Employee ID + 4-digit PIN; on/off-duty shift toggle; task cards with the
report photo and location; submit a **cleanup proof photo** (GPS geofence 50 m) → status *Pending Verification*;
profile with points/bonus and rewards.

**Admin** (`/admin`) — tabs: *Operations* (KPIs, weekly chart, live map), *Dispatch* (assign nearest on-duty
worker to a submitted report), *SLA Monitor* (verify/reject cleanup proofs; bonus ₹200 + 100 points on approval),
*Tribunal* (uphold/dismiss disputed fines), *Workforce* (create/deactivate workers), *My Profile*.

**Surveillance** (`/surveillance`) — live MJPEG feed with real detections, boot stages, node telemetry
(FPS, latency, CPU/RAM, GPU, dropped frames), state-machine progress, evidence viewer, penalty log.

## 5. The camera pipeline (Part 1 — implemented)

```
Frame → YOLOv8 (person + waste classes) → ByteTrack IDs → per (person, waste) state machine
NORMAL → PERSON_NEAR_OBJECT → OBJECT_ASSOCIATED → OBJECT_SEPARATING → OBJECT_DROPPED
       → OBJECT_STATIONARY (dwell) → PERSON_MOVING_AWAY → LITTERING_CONFIRMED
```
- "Waste visible" never equals littering: an event needs association → separation → stationary → person departs.
- Terminal labels that do **not** create events: `PICKUP`, `PASS_BY`, `PLACE_IN_BIN`, track lost, timeout, false positive.
- Distances are multiples of the person's bbox height (scale-invariant); a 0.7 s grace period tolerates brief
  track loss; confirmed events have a 30 s per-pair cooldown (de-duplication).
- Event confidence is a deterministic weighted score of association, separation, stationary, departure signals
  (breakdown is sent with the event).
- Evidence frames (with a pre-event ring buffer) + `event.json` are written to `evidence_snapshots/<event>/`
  and served at `/evidence/...`. Every candidate/decision is audit-logged to `logs/littering_candidates.jsonl`.
- Bounded frame queue (size 3): stale frames are dropped to keep latency low. Real telemetry via psutil/torch.
- Boot stages and errors (`CAMERA_ERROR`, `YOLO_ERROR`, …) are reported to the UI; nothing is faked.
- **Current limit:** the engine only **broadcasts** the event with `identity_status = PENDING`. It does not yet
  identify the person, create a violation row, or notify a citizen — that is Part 2
  (see `docs/ECOWATCH_PART2_PROMPT_REVISED.md`).

## 6. Data model (schema.sql)

`admins`, `citizens` (`face_embedding vector(512)`), `workers` (admin_id, ward, status, lat/lng, points, bonus),
`dump_reports` (PostGIS `geom`, before/after image URLs, assigned worker, status), `violations` (fine, status,
snapshot, dispute and payment fields, `geom`), `rewards`, plus the SQL function `match_citizen_face` (pgvector
cosine match). Report status flow: *Submitted → Worker Assigned → (Cleaning in Progress) → Pending Verification →
Cleaned & Verified* (reject returns to *Submitted*). Violation flow: *Pending → Paid | Disputed → Upheld | Dismissed*.

## 7. API reference (FastAPI, port 8000)

| Endpoint | Purpose |
|---|---|
| `WS /ws`, `/ws/alerts` | real-time events (violation, report, worker_status, worker_location, civic_index, littering_event, node health, boot status) |
| `POST /api/vision/status|telemetry|pipeline_state`, `POST /api/littering_event` | engine → backend (needs `X-Engine-API-Key` if `ENGINE_API_KEY` set) |
| `GET /api/camera/config`, `GET /api/civic-index`, `GET /health` | camera metadata, city score, health |
| `/api/violations` (GET, POST, PATCH, `/{id}/pay`, `/{id}/dispute`) | violations |
| `/api/reports` (GET, POST, `/{id}/assign|status|complete|verify`) | dump reports |
| `/api/workers` (GET, POST, `/{id}/status|deactivate|location|bonus`) | workers |
| `/api/auth/*` (extract-embedding, register-face, face-login, otp/send|verify, admin/login, worker/login) | auth helpers |
| `POST /api/sms/dispatch` | manual SMS (`X-SMS-API-Key`) |
Mutating REST endpoints require `X-API-Key` when `BACKEND_API_KEY` is set. Docs: http://localhost:8000/api/docs

## 8. Setup

Prerequisites: Node 18+, Python 3.10+, a webcam, a Supabase project.

1. **Database:** Supabase → SQL Editor → run `schema.sql` (⚠ drops and recreates tables; seeds demo data).
   Create a Storage bucket named `evidence`.
2. **Frontend env** — `.env.local`:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or `..._ANON_KEY`), optional
   `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_WS_URL`, `BACKEND_URL`.
3. **Backend env** — copy `backend/.env.example` to `backend/.env` (Supabase, CORS, camera id/name/lat/lng/ward,
   model paths, thresholds, optional `ENGINE_API_KEY`, `BACKEND_API_KEY`, Twilio).
4. **Install:** `npm install`; `pip install -r backend/requirements.txt` (use the PyTorch GPU build if you have CUDA).
5. **(Optional) draw zones:** `python -m backend.draw_zones` to mark bins / no-litter areas on a real frame.

## 9. Run

```bash
# terminal 1 – API + WebSocket (run from the repo root)
python -m uvicorn backend.main:app --port 8000
# terminal 2 – vision engine (opens the camera, MJPEG on :8001)
python -m backend.vision_engine
# terminal 3 – web app
npm run dev          # http://localhost:3000
```
Open `/surveillance` to watch the pipeline. Demo logins from the seed data: admin `admin@bbmp.gov.in`,
workers `EW-WRK-001..003` (see `schema.sql`; change/remove before any real deployment).

## 10. Testing the camera logic

Perform each in front of the camera and watch `/surveillance` + `logs/littering_candidates.jsonl`:
1) walk normally → no event; 2) walk holding a bottle → no event; 3) hold bottle, drop it, stand away, leave →
`LITTERING_CONFIRMED`; 4) trash already on the floor, walk past → none; 5) pick trash up → `PICKUP`, none;
6) leave frame briefly → no false violation. Tune distances/dwell via `.env` after observing real footage.

## 11. Known gaps & caveats

- **No identity → violation → citizen alert yet** (Part 2). `violations` rows exist only from seeds/REST calls.
- Auth is application-level, not Supabase Auth; **row-level security is disabled**, so the public key can read
  sensitive tables (password/PIN hashes, face embeddings). Must be fixed before real use.
- Face login still exists but the intended design is face *enrollment only* (login via OTP/password).
- No sector/area model: admins have a single `ward_jurisdiction`; reports are not routed by sector.
- Stock COCO YOLO detects only bottles/cups as litter; accuracy needs evaluation/fine-tuning on your own footage.
- Demo payment only; Twilio optional; default worker PIN is `1234`.
- Windows/India note: some ISPs (e.g. Reliance Jio) fail to resolve `*.supabase.co`; use 1.1.1.1/8.8.8.8 DNS or a VPN.

## 12. Roadmap

Stage order in `docs/ECOWATCH_PART2_PROMPT_REVISED.md`: Supabase Auth + RLS → area/sector ownership →
optional consented face enrollment → offender face capture → calibrated pgvector match + idempotent violation →
per-citizen realtime notifications + disputes → sector-routed dump reports → points ledger → pollution rankings.
