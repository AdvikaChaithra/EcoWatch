-- ============================================================================
-- EcoWatch migration 001 — demo MVP (identity -> violation -> citizen alert, sectors)
-- ADDITIVE and idempotent: safe to run more than once. Does NOT drop any data.
-- Run in Supabase -> SQL Editor (after schema.sql has been applied).
-- ============================================================================

-- ── 1. Violations: identity + evidence + review fields ──────────────────────
ALTER TABLE violations ADD COLUMN IF NOT EXISTS event_id        TEXT;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS camera_id       TEXT;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS face_similarity NUMERIC(6,4);
ALTER TABLE violations ADD COLUMN IF NOT EXISTS evidence_path   TEXT;      -- e.g. "ab12cd34" under /evidence/
ALTER TABLE violations ADD COLUMN IF NOT EXISTS identity_status TEXT NOT NULL DEFAULT 'MATCHED';
                                                                          -- MATCHED | UNCERTAIN | NO_MATCH | NO_FACE
ALTER TABLE violations ADD COLUMN IF NOT EXISTS sector_id       TEXT;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS reviewed_by     TEXT;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS reviewed_at     TIMESTAMPTZ;
ALTER TABLE violations ADD COLUMN IF NOT EXISTS admin_reason    TEXT;

-- One fine per littering event (idempotency enforced by the database, not just code).
CREATE UNIQUE INDEX IF NOT EXISTS ux_violations_event_id ON violations(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_violations_identity ON violations(identity_status);

-- ── 2. Notifications (per-citizen alerts) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
    id           TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    user_id      TEXT NOT NULL,                 -- citizens.id
    type         TEXT NOT NULL,                 -- VIOLATION | DISPUTE | SYSTEM
    title        TEXT NOT NULL,
    message      TEXT NOT NULL,
    violation_id TEXT,
    read         BOOLEAN NOT NULL DEFAULT FALSE,
    sms_status   TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',   -- NOT_CONFIGURED | SENT | FAILED
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;   -- demo mode, same as the other tables

-- ── 3. Sectors (area -> sector, one admin per sector) ───────────────────────
CREATE TABLE IF NOT EXISTS sectors (
    id        TEXT PRIMARY KEY,
    area      TEXT NOT NULL,
    name      TEXT NOT NULL,
    admin_id  TEXT REFERENCES admins(id),
    lat       DOUBLE PRECISION NOT NULL,        -- sector centre, used for nearest-sector routing
    lng       DOUBLE PRECISION NOT NULL
);
ALTER TABLE sectors DISABLE ROW LEVEL SECURITY;

ALTER TABLE workers      ADD COLUMN IF NOT EXISTS sector_id TEXT REFERENCES sectors(id);
ALTER TABLE dump_reports ADD COLUMN IF NOT EXISTS sector_id TEXT REFERENCES sectors(id);
CREATE INDEX IF NOT EXISTS idx_workers_sector      ON workers(sector_id);
CREATE INDEX IF NOT EXISTS idx_dump_reports_sector ON dump_reports(sector_id);

INSERT INTO sectors (id, area, name, admin_id, lat, lng) VALUES
    ('SEC-IND-1', 'Indiranagar',  'Sector 1', 'ADM-BBMP-001', 12.9783, 77.6408),
    ('SEC-IND-2', 'Indiranagar',  'Sector 2', 'ADM-BBMP-002', 12.9719, 77.6412),
    ('SEC-KOR-1', 'Koramangala',  'Sector 1', 'ADM-BBMP-001', 12.9346, 77.6267),
    ('SEC-KOR-2', 'Koramangala',  'Sector 2', 'ADM-BBMP-002', 12.9279, 77.6271)
ON CONFLICT (id) DO NOTHING;

-- Put the seeded workers / reports into sectors so the admin filters have data.
UPDATE workers SET sector_id = 'SEC-IND-1' WHERE employee_id = 'EW-WRK-001' AND sector_id IS NULL;
UPDATE workers SET sector_id = 'SEC-IND-1' WHERE employee_id = 'EW-WRK-002' AND sector_id IS NULL;
UPDATE workers SET sector_id = 'SEC-KOR-1' WHERE employee_id = 'EW-WRK-003' AND sector_id IS NULL;

-- Nearest sector centre for any report that has none (haversine-free planar approximation is fine here).
UPDATE dump_reports r SET sector_id = (
    SELECT s.id FROM sectors s ORDER BY (s.lat - r.lat)^2 + (s.lng - r.lng)^2 LIMIT 1
) WHERE r.sector_id IS NULL;

-- ── 4. Face matching: top-K candidates (thresholds/margin decided server-side) ─
CREATE OR REPLACE FUNCTION match_face_candidates(
    query_embedding vector(512),
    k int DEFAULT 2
)
RETURNS TABLE(id TEXT, name TEXT, similarity float)
LANGUAGE sql STABLE AS $$
    SELECT c.id, c.name, 1 - (c.face_embedding <=> query_embedding) AS similarity
    FROM citizens c
    WHERE c.face_embedding IS NOT NULL
    ORDER BY c.face_embedding <=> query_embedding
    LIMIT k;
$$;

-- Duplicate-face check at enrollment (is this face already registered to someone else?)
CREATE OR REPLACE FUNCTION find_duplicate_face(
    query_embedding vector(512),
    exclude_citizen TEXT DEFAULT '',
    min_similarity float DEFAULT 0.6
)
RETURNS TABLE(id TEXT, similarity float)
LANGUAGE sql STABLE AS $$
    SELECT c.id, 1 - (c.face_embedding <=> query_embedding) AS similarity
    FROM citizens c
    WHERE c.face_embedding IS NOT NULL
      AND c.id <> exclude_citizen
      AND 1 - (c.face_embedding <=> query_embedding) >= min_similarity
    ORDER BY c.face_embedding <=> query_embedding
    LIMIT 1;
$$;

-- ── 5. Citizen consent flag ─────────────────────────────────────────────────
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS face_enrolled   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE citizens ADD COLUMN IF NOT EXISTS face_consent_at TIMESTAMPTZ;

-- ── 6. Realtime: let the citizen dashboard receive INSERTs ──────────────────
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
                   AND schemaname = 'public' AND tablename = 'violations') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE violations;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime'
                   AND schemaname = 'public' AND tablename = 'notifications') THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
    END IF;
END $$;

-- ── 7. Points used to reduce a fine (cap is enforced in the app) ─────────────
ALTER TABLE violations ADD COLUMN IF NOT EXISTS points_discount NUMERIC(10,2) NOT NULL DEFAULT 0;
