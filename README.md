# EcoWatch — AI-Based Littering Detection, Offender Identification & Municipal Cleanliness Management

EcoWatch detects littering from a live camera, identifies the person responsible by face, issues a fine to
that citizen's own portal (with evidence photos, location and an awareness message), and runs the whole
cleanup workflow — citizen dump reports, sector-based dispatch, worker proof-of-cleanup, admin
verification and rewards — through four connected portals.

> Academic project (college major project). The system is a working prototype demonstrated with test data;
> see [Limitations](#14-limitations) before using it with real people's data.

---

## Table of contents

1. [Features](#1-features)
2. [How it works](#2-how-it-works)
3. [Architecture](#3-architecture)
4. [Technology stack](#4-technology-stack)
5. [Project structure](#5-project-structure)
6. [Getting started](#6-getting-started)
7. [Running the project](#7-running-the-project)
8. [Configuration reference](#8-configuration-reference)
9. [Roles and access](#9-roles-and-access)
10. [Database](#10-database)
11. [API overview](#11-api-overview)
12. [Security design](#12-security-design)
13. [Testing and checks](#13-testing-and-checks)
14. [Troubleshooting](#15-troubleshooting)
15. [Further documentation](#16-further-documentation)

---

## 1. Features

### AI camera (vision engine)
- Detects **people** (YOLOv8n) and tracks them across frames (ByteTrack).
- Detects **any littered object** — bottles, cans, cups, wrappers, bags, paper, food waste, books — with an
  open-vocabulary YOLO-World model (21 litter names baked in; editable).
- Confirms littering only after the **full sequence**: object held → object separates from the person →
  object lies still for 2 s → person walks away. Picking something up, walking past it, or putting it in a
  bin zone is **not** littering.
- **Ignores the background**: an object that stays still while nobody holds it (a poster, a note on the wall)
  is remembered as scene background (drawn grey, labelled `bg`) and can never start a case.
- Saves **three evidence frames** (holding → dropped → leaving) with the person/object boxes as they were at
  that moment, plus face crops of the person.
- Public **AI Surveillance** page (no login) with the live annotated video, detection list, boot stages and
  the status of each littering event.

### Face identification
- InsightFace **ArcFace (buffalo_l)** turns a face into a 512-dimensional embedding; matching uses
  **pgvector cosine search** (HNSW index) against the embeddings citizens stored when registering.
- A citizen is fined **only on a confident MATCH**; uncertain or unknown faces are never fined and go to an
  admin review list (with *Retry identification* / *Dismiss as false alarm* actions).

### Citizen portal
- Registration with **compulsory face enrolment and consent**; login with **email + phone** (not the face).
- **Violations**: each fine shows evidence photos, the camera's real GPS location, a rotating
  awareness message (a different 1–2 point message each time), and can be **paid**, **disputed**, or reduced
  with Eco-Points. Alerts arrive live (Supabase Realtime).
- **Report Dump**: photo (camera or upload) + GPS stamp (accuracy target 50 m) + category/severity →
  routed to the admin of the nearest sector; duplicate reports within 15 m / 24 h are blocked; **+40 Eco-Points**.
- **My Reports** tracker (live status steps with before/after photos), **Civic Map** (open reports),
  **Rewards** (tiers: Bronze → Silver → Gold → Eco-Champion), **Profile** (edit phone, email, address).

### Worker portal
- Login with Employee ID + 4-digit PIN (one-time PIN, forced change at first login).
- Shift toggle; task list with SLA countdown and navigation link.
- **Upload Proof**: opens the camera (or upload a photo), GPS-stamps it, checks the **50 m geofence** — or
  lets the worker choose **"Dump site location (manual)"** for demos (clearly labelled on the photo and shown
  to the admin).
- **Work History** (location, waste type, eco-points and ₹ bonus per verified task) and rewards profile.

### Admin portal (one admin per sector)
- **Operations** (KPIs + live map), **Dispatch** (assign nearest on-duty worker), **SLA Monitor**
  (verify cleanup proofs — before/after slider, set the worker's bonus ₹0–1000 and eco-points 40–200),
  **Tribunal** (disputes + unidentified camera events), **Workforce** (add workers, reset PIN, transfer,
  deactivate), **My Profile**.
- Everything is scoped to the admin's own sectors.

### Super Admin portal
- City-wide **Overview**, **Admins** (create with a temporary password, reset, deactivate), **Sectors**,
  **Workers**, and a full **Audit log** of every privileged action.
- **Bengaluru is pre-divided into ~50 sectors** (real localities with OpenStreetMap centres, grouped by the
  five city corporations). The job is *assignment*: give an admin a sector or a whole corporation, then assign
  workers to sectors. Custom sectors are a secondary option.

---

## 2. How it works

```
 camera frame
     │
     ▼
 YOLOv8n + ByteTrack ──► people (P#)          YOLO-World ──► litter objects (W#)
     │                                              │
     └──────────────► littering state machine ◄─────┘
        NEAR → ASSOCIATED → SEPARATING → DROPPED → STATIONARY → MOVING_AWAY → CONFIRMED
        (PICKUP, PASS_BY, PLACE_IN_BIN, FALSE_POSITIVE end a case without a violation)
                              │ confirmed event + evidence + face crops
                              ▼
                  FastAPI backend  /api/littering_event
                              │
                  ArcFace embedding → pgvector search
                              │
        MATCH (≥0.45 and ≥0.08 above runner-up)        otherwise
                 │                                        │
   violation (₹500) + notification                 "Unidentified" event
   → that citizen's portal (Realtime)              → admin Tribunal list
```

**Identity decision** (`backend/identity.py`)

| Result | Condition | Outcome |
|---|---|---|
| `MATCH` | similarity ≥ 0.45 **and** ≥ 0.08 above the next-best person | fine issued, citizen alerted |
| `UNCERTAIN` | similarity ≥ 0.32 but not a clear match | no fine; admin review |
| `NO_MATCH` | below 0.32 | no fine; admin review |
| `NO_FACE` | no usable face in the crops (too small, blurry, extreme angle) | no fine; admin review |

**Evidence gates before a fine**: association score ≥ 0.25 and overall confidence ≥ 0.65, otherwise the case
is discarded as a false positive.

**Cleanup workflow**: report → nearest active sector → that sector's admin dispatches a worker → worker
uploads a geotagged after-photo → admin approves (worker is paid a bonus + eco-points, once) or rejects
(back to the dispatch queue). SLA target: 6 hours from the report.

---

## 3. Architecture

```
┌──────────────────────┐   HTTP + WebSocket   ┌──────────────────────────┐
│  Website (Next.js 14)│◄────────────────────►│  FastAPI backend :8000   │
│  :3000               │                      │  face model, identity,   │
│  portals + /api/*    │                      │  WebSocket broadcast     │
│  server routes       │                      └───────────▲──────────────┘
└─────────┬────────────┘                                  │ POST events
          │ supabase-js / REST / Realtime                 │
          ▼                                  ┌────────────┴─────────────┐
┌──────────────────────┐                     │ Vision engine (Python)   │
│ Supabase             │◄────────────────────┤ camera → YOLO → state    │
│ Postgres + PostGIS + │   (via backend)     │ machine; MJPEG on :8001  │
│ pgvector + Realtime  │                     └──────────────────────────┘
└──────────────────────┘
```

- **Website server routes** (`app/api/*`) handle everything that must be checked on the server: logins,
  face registration, worker/admin/sector management, cleanup approval, unidentified-event actions.
- **FastAPI backend** hosts the heavy face model, runs identification, creates violations idempotently and
  broadcasts live events.
- **Vision engine** is a separate process because it needs the physical camera; it only talks to the backend.
- The website and the engine **share one webcam** on a single laptop: when a web page needs the camera the
  website asks the engine (port 8001) to release it and returns it afterwards.

---

## 4. Technology stack

| Layer | Technology |
|---|---|
| Website | Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, Zustand, Recharts, Leaflet / react-leaflet |
| Backend | Python 3.13, FastAPI, Uvicorn, httpx, pydantic |
| Computer vision | OpenCV, Ultralytics YOLOv8n + ByteTrack, YOLO-World (`yolov8s-worldv2`) |
| Face recognition | InsightFace (ArcFace `buffalo_l`), ONNX Runtime |
| Database | Supabase: PostgreSQL 17 with PostGIS, pgvector (HNSW) and Realtime |
| Auth | Signed (HMAC-SHA256) session tokens; PBKDF2-SHA256 hashes (120 000 iterations) |
| Tests | pytest (18 tests), `next lint`, `scripts/preflight.py` |

Tested on Windows 11 with Python 3.13 and Node 22.

---

## 5. Project structure

```
EcoWatchWeb/
├── app/                     Next.js pages and server routes
│   ├── citizen/ worker/ admin/ super/ surveillance/   the portals
│   ├── auth/{citizen,worker,admin}/                   login & registration pages
│   └── api/                                           server routes (auth, workers, reports, super, violations)
├── components/              UI by portal (citizen, worker, admin, super, surveillance, shared, layout)
├── hooks/  lib/             camera, geolocation, realtime hooks; Supabase client, auth/session helpers
├── backend/
│   ├── main.py              FastAPI app: WebSocket, engine endpoints, identity pipeline, camera location
│   ├── identity.py          face quality gate, matching decision, violation + notification creation
│   ├── vision_engine.py     camera → detection → tracking → evidence → backend
│   ├── littering_detector.py  the littering state machine
│   ├── routers/auth.py      face-embedding endpoint used by the website
│   ├── security.py  database.py  telemetry.py  camera_location.py  camera_zones.py
│   ├── .env.example         every backend setting, documented
│   └── requirements.txt
├── migrations/              001 … 010 — every database change, in order
├── scripts/                 preflight.py · build_litter_model.py · watch_events.py
├── tests/                   test_identity.py · test_littering_sm.py
├── docs/                    PROJECT_GUIDE.md · DEMO_SCRIPT.md
├── schema.sql               original base-schema reference (see Database)
├── start_demo.ps1           one-command launcher (Windows)
└── yolov8n.pt               person-detection weights (the other models are built locally)
```

---

## 6. Getting started

### 6.1 Prerequisites
- **Node.js 20+** (22 tested) and **npm**
- **Python 3.13** (the tested version) and **pip**
- A **webcam** (or a recorded video clip) for the vision engine
- A **Supabase** project (free tier is enough) with the `postgis` and `vector` extensions enabled
- ~2 GB of free disk space (models and `node_modules`); internet for the first run (model downloads)

### 6.2 Get the code and install
```bash
git clone https://github.com/AdvikaChaithra/EcoWatch.git
cd EcoWatch

# website
npm install

# backend + vision engine (a virtual environment is recommended)
python -m venv .venv
.venv\Scripts\activate            # Windows   (Linux/macOS: source .venv/bin/activate)
pip install -r backend/requirements.txt
```
The first backend start downloads the InsightFace `buffalo_l` model (~300 MB).

### 6.3 Environment files (never commit these)
Copy `backend/.env.example` to **`backend/.env`** and fill in at least:
```
SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable / anon key>
```
Create **`.env.local`** in the project root:
```
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable / anon key>
SESSION_SECRET=<a random string of 32+ characters>
```
Generate a secret with: `python -c "import secrets; print(secrets.token_urlsafe(48))"`.
Without `SESSION_SECRET` logins still work but are reset every time the website restarts.

### 6.4 Build the litter detector (one time)
```bash
python scripts/build_litter_model.py
```
This downloads `yolov8s-worldv2.pt` and CLIP once (~340 MB) and writes `ecowatch_litter_world.pt`. Then set in
`backend/.env`:
```
WASTE_MODEL_PATH=ecowatch_litter_world.pt
```
Without it the engine falls back to the basic COCO model, which only knows standard objects
(bottle, cup, bowl, book, …).

### 6.5 Database
Run the files in `migrations/` **in numeric order** (Supabase → SQL Editor). They are additive and safe to
re-run. They cover violation identity/evidence fields, notifications, sectors, the HNSW face index, the
Super Admin tables and audit log, the 50 Bengaluru sectors, task verification rewards, and Realtime
publication. See [Database](#10-database) for an important note about the base tables.

### 6.6 First Super Admin
Create the Municipal Commissioner account once (replace the password and email):
```bash
python -c "from backend.security import hash_secret; print(hash_secret('ChooseAStrongPassword1'))"
```
```sql
insert into admins (name, email, password_hash, role, active, must_change_password, designation, ward_jurisdiction, admin_id)
values ('Municipal Commissioner', 'superadmin@example.gov.in', '<hash from above>', 'super_admin', true, true,
        'Municipal Commissioner', 'All Zones', 'ADM-SUPER-001');
```
Sign in at `/auth/admin`; you are taken to `/super` and must set your own password. From there create admins,
assign sectors and add workers (each new account gets a one-time password/PIN shown once).

### 6.7 Register a citizen with a face
Open `/auth/citizen` → **Register** → fill the form → **Enroll Face** (good front lighting, face the camera) →
tick consent → **Register**. At least one enrolled face is needed for the camera to identify anyone.

### 6.8 Check everything
```bash
python scripts/preflight.py
```
Each line must say PASS (the "camera readable" check fails if the engine already holds the webcam).

---

## 7. Running the project

### 7.1 One command (Windows)
```powershell
powershell -ExecutionPolicy Bypass -File .\start_demo.ps1
```
Runs preflight, then opens three terminals: backend, vision engine and website (production build).
To replay a recorded clip instead of the webcam: `.\start_demo.ps1 -Source "demo\clip.mp4"`.

### 7.2 Manually (three terminals, from the project root)
```bash
# 1. backend  (loads the face model; wait for "ArcFace model ready")
python -m uvicorn backend.main:app --port 8000

# 2. vision engine  (opens the camera; MJPEG stream on :8001)
python -m backend.vision_engine

# 3. website
npx next build        # first time and after code changes
npm start             # production server (fast)   — or: npm run dev
```

| Service | URL |
|---|---|
| Website | http://localhost:3000 |
| Citizen / Worker / Admin / Super Admin | `/citizen` · `/worker` · `/admin` · `/super` |
| AI Surveillance (public, no login) | `/surveillance` |
| Backend health | http://127.0.0.1:8000/health |
| Camera status / stream | http://127.0.0.1:8001/camera/status · `/stream.mjpg` |

### 7.3 Trying the detection
1. Sit 1–2 m from the camera with your **face and the object both in view**; look at the camera briefly.
2. Hold a bottle at chest height for 2–3 s.
3. Put it down away from you, leave it still for 2 s, then walk out of frame.
4. The engine terminal prints `LITTERING CONFIRMED`; `/surveillance` shows the identity result; the matched
   citizen sees the ₹500 fine in their portal.

---

## 8. Configuration reference

All backend and engine settings are read from `backend/.env` (full list with comments in
`backend/.env.example`). The most useful:

| Setting | Default | Meaning |
|---|---|---|
| `LITTERING_FINE_AMOUNT` | 500 | Fine in ₹ |
| `FACE_MATCH_THRESHOLD` | 0.45 | Minimum cosine similarity for a MATCH |
| `FACE_REVIEW_THRESHOLD` | 0.32 | Below this = NO_MATCH |
| `FACE_MATCH_MARGIN` | 0.08 | Required gap to the runner-up |
| `LITTER_DWELL_SECONDS` | 2.0 | How long the object must lie still |
| `WASTE_MODEL_PATH` | `yolov8n.pt` | Set to `ecowatch_litter_world.pt` for any-litter detection |
| `WASTE_MODEL_CONF` | 0.15 | Litter-model confidence cut-off |
| `BACKGROUND_STILL_S` | 4 | Seconds still (not held) before an object counts as background |
| `CAMERA_SOURCE` | 0 | Webcam index, video file or RTSP URL |
| `CAMERA_LOOP` | false | Loop a video file (demo clips) |
| `DISPLAY_FPS` | 20 | Frame rate of the live view |
| `CAMERA_LATITUDE/LONGITUDE/LOCATION_NAME` | — | Fallback camera location (the Surveillance page can set the real one from device GPS) |
| `TWILIO_*` | — | Optional real SMS for violation alerts |
| `ENGINE_API_KEY` | — | Optional key the engine must send to the backend |

Website settings (`.env.local`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SESSION_SECRET`, and optionally `BACKEND_URL`, `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_WS_URL`,
`SUPABASE_SERVICE_ROLE_KEY` (server routes only — never expose it to the browser).

Reward rules live in one file, `lib/taskPoints.ts`: citizen report = 40 points; cleanup approval = bonus
₹0–1000 (default 200) and 40–200 points (default by severity: Low 40, Medium 60, High 75, Critical 100).
Eco-Points reduce fines at 10 points = ₹1, up to 50% of a fine.

---

## 9. Roles and access

| | Citizen | Worker | Admin | Super Admin | Public |
|---|:-:|:-:|:-:|:-:|:-:|
| Report dumps, see own fines, pay/dispute | ✔ | | | | |
| See and do assigned cleanups, upload proof | | ✔ | | | |
| Dispatch workers, verify proofs, handle disputes (own sectors) | | | ✔ | ✔ | |
| Manage workers (own sectors) | | | ✔ | ✔ | |
| Manage admins, sectors, all workers; audit log | | | | ✔ | |
| AI Surveillance page | | | | | ✔ |

Privileged actions are enforced **on the server** with signed tokens and an active-account check on every
call (a deactivated admin or worker loses access immediately).

---

## 10. Database

Main tables: `citizens` (with `face_embedding vector(512)`), `workers`, `admins` (roles `admin` /
`super_admin`), `sectors` (area, name, city corporation, centre lat/lng, responsible admin),
`dump_reports`, `violations`, `notifications`, `rewards`, `audit_log`.

- Violations are **idempotent per camera event** (unique `event_id`).
- Face search uses the `match_face_candidates` function over an HNSW index; `find_duplicate_face` stops one
  face being registered to two accounts.
- Realtime is enabled for `violations`, `notifications` and `dump_reports`.
- `workers` is deliberately **not** published to Realtime (the table holds PIN hashes).

> **Important — base tables.** The project was developed against a Supabase database whose ids are
> **UUIDs**, and the migrations in `migrations/` are written for that. `schema.sql` is the original base-schema
> reference and uses TEXT ids, so it should not be combined with the migrations unchanged. Setting up a
> brand-new database from scratch has not been verified end to end; the supported path is the existing
> project plus `migrations/001 … 010`.

---

## 11. API overview

**Website server routes** (`app/api`, signed token required unless noted)

| Route | Purpose |
|---|---|
| `POST /api/auth/admin-login` · `worker-login` | Sign in (public) |
| `POST /api/auth/register-face` | Citizen registration with face enrolment (public) |
| `POST /api/auth/change-password` · `change-pin` | Forced first-login credential change |
| `POST /api/workers` · `PATCH /api/workers/[id]` | Add / edit / reset PIN / transfer / deactivate workers |
| `POST /api/reports/[id]/verify` | Approve or reject a cleanup proof (once only; sets bonus and points) |
| `PATCH /api/violations/[id]` | Retry identification or dismiss an unidentified event |
| `/api/super/admins` · `sectors` · `audit` | Super Admin management and audit log |

**FastAPI backend** (port 8000)

| Route | Purpose |
|---|---|
| `WS /ws` | Live events (detections, identity results) |
| `POST /api/littering_event` | Confirmed event from the vision engine → identification → violation |
| `POST /api/violations/{id}/reidentify` | Re-run identification on saved evidence |
| `POST /api/auth/extract-embedding` | Face embedding for registration |
| `GET /api/camera/config` · `POST /api/camera/location` | Camera metadata and real location |
| `POST /api/vision/{status,telemetry,pipeline_state}` | Engine health and state |
| `GET /health` | Health check |

**Vision engine** (port 8001): `/stream.mjpg`, `/camera/status`, `/camera/pause`, `/camera/resume`.

---

## 12. Security design

- Passwords and PINs are stored as salted **PBKDF2** hashes; one-time credentials are shown once and must be
  changed at first login.
- Sessions are HMAC-signed tokens (12 h); roles are re-checked against the database on every privileged call.
- Sector ownership is enforced server-side; every privileged action is written to the audit log.
- A fine requires a confident face match; uncertain identities never reach an account, and the public
  Surveillance page only shows **masked** names.
- Face data: a numeric embedding (not the photo) is stored, with recorded consent.
- Secrets (`backend/.env`, `.env.local`, service-role key, database URL, Twilio token) must **never** be
  committed or exposed to the browser — they are excluded by `.gitignore`.

---

## 13. Testing and checks

```bash
python -m pytest tests -q        # 18 tests: identity decisions, idempotency, re-identification, littering state machine
npx next lint                    # lint (warnings about <img> are expected)
npx tsc --noEmit                 # type-check
npx next build                   # production build
python scripts/preflight.py      # environment, database, models and camera checks
python scripts/watch_events.py   # prints live backend events (debugging)
```
The state-machine tests include regression cases for a bottle put down on a desk with a close camera,
a bottle that is lifted again, an object left alone while a person walks past, and a poster on the wall
next to a seated person.

---


| Problem | What to check |
|---|---|
| "Failed to fetch" / "Could not reach the EcoWatch server" | The website (`npm start`) or backend is not running; restart it |
| Website shows old behaviour after code changes | Run `npx next build`, restart `npm start`, hard-refresh (Ctrl+F5) |
| "Face recognition backend offline" during registration | Start the backend and wait for "ArcFace model ready" |
| Camera feed black / "CAMERA_PAUSED" | Another program (or a web page) holds the webcam; close it or wait for auto-resume |
| Camera error in the browser: "Device in use" | The engine still holds the webcam; use *Upload Photo* instead |
| Events end as `NO_FACE` | Face not visible/too small in the crops; face the camera, closer, better light |
| Only some objects are detected | `WASTE_MODEL_PATH` is not set to `ecowatch_litter_world.pt` (run the build script) |
| Worker cannot sign in | Use the latest PIN from the admin (a reset invalidates the previous one); the ID is not case-sensitive |
| Logins reset when the website restarts | `SESSION_SECRET` is missing in `.env.local` |
| `next build` hangs or fails | Delete `.next` and rebuild; make sure no `npm start` is running while building |

---

## 14. Further documentation

- [`docs/PROJECT_GUIDE.md`](docs/PROJECT_GUIDE.md) — original project guide (architecture, repository map,
  roadmap). Where it differs from this README, **this README is current**.
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — 5-minute demo walkthrough and viva notes.
- [`backend/.env.example`](backend/.env.example) — every backend/engine setting with comments.
- [`migrations/`](migrations) — the database change history, in order.

---

**Author:** Advika Chaithra · [GitHub: AdvikaChaithra](https://github.com/AdvikaChaithra)
