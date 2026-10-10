-- ============================================================================
-- EcoWatch PostgreSQL Schema v3 — Production Grade
-- Run this ENTIRE file in Supabase → SQL Editor → Run All
--
-- TEXT PRIMARY KEY strategy: compatible with both custom IDs (CIT-001)
-- and uuid_generate_v4()::text, eliminating 22P02 type cast errors.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ═══════════════════════════════════════════════════════════════════════════
-- DROP existing tables (clean slate for fresh deployment)
-- CAUTION: Comment out in production if preserving existing data
-- ═══════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS rewards       CASCADE;
DROP TABLE IF EXISTS violations    CASCADE;
DROP TABLE IF EXISTS dump_reports  CASCADE;
DROP TABLE IF EXISTS workers       CASCADE;
DROP TABLE IF EXISTS citizens      CASCADE;
DROP TABLE IF EXISTS admins        CASCADE;
DROP FUNCTION IF EXISTS match_citizen_face;

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: admins
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE admins (
    id                TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    name              TEXT NOT NULL,
    email             TEXT UNIQUE NOT NULL,
    password_hash     TEXT NOT NULL DEFAULT 'admin123',
    admin_id          TEXT UNIQUE,
    ward_jurisdiction TEXT,
    designation       TEXT,
    totp_secret       TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: citizens
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE citizens (
    id              TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    name            TEXT NOT NULL,
    phone           TEXT UNIQUE NOT NULL,
    email           TEXT UNIQUE,
    address         TEXT,
    ward            TEXT,
    gov_id          TEXT,
    face_embedding  vector(512),
    eco_points      INTEGER NOT NULL DEFAULT 0,
    tier            TEXT NOT NULL DEFAULT 'Bronze',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_citizens_phone ON citizens(phone);
CREATE INDEX idx_citizens_email ON citizens(email);
CREATE INDEX idx_citizens_face  ON citizens USING ivfflat (face_embedding vector_cosine_ops)
    WITH (lists = 10);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: workers
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE workers (
    id              TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    admin_id        TEXT REFERENCES admins(id),
    name            TEXT NOT NULL,
    phone           TEXT UNIQUE NOT NULL,
    employee_id     TEXT UNIQUE NOT NULL,
    pin_hash        TEXT NOT NULL DEFAULT '1234',
    ward            TEXT,
    status          TEXT NOT NULL DEFAULT 'On Duty',
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    lat             DOUBLE PRECISION DEFAULT 12.9716,
    lng             DOUBLE PRECISION DEFAULT 77.6412,
    tasks_completed INTEGER NOT NULL DEFAULT 0,
    eco_points      INTEGER NOT NULL DEFAULT 0,
    bonus_accrued   NUMERIC(10,2) NOT NULL DEFAULT 0,
    tier            TEXT NOT NULL DEFAULT 'Bronze',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_workers_status      ON workers(status);
CREATE INDEX idx_workers_ward        ON workers(ward);
CREATE INDEX idx_workers_employee_id ON workers(employee_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: dump_reports
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE dump_reports (
    id                  TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    citizen_id          TEXT REFERENCES citizens(id),
    reported_by         TEXT,                          -- display name fallback
    category            TEXT NOT NULL,
    severity            TEXT NOT NULL,
    location_name       TEXT,
    lat                 DOUBLE PRECISION NOT NULL,
    lng                 DOUBLE PRECISION NOT NULL,
    geom                GEOMETRY(Point, 4326) GENERATED ALWAYS AS
                            (ST_SetSRID(ST_MakePoint(lng, lat), 4326)) STORED,
    status              TEXT NOT NULL DEFAULT 'Submitted',
    reported_image_url  TEXT,
    cleaned_image_url   TEXT,
    assigned_worker_id  TEXT REFERENCES workers(id),
    eco_points_awarded  INTEGER NOT NULL DEFAULT 50,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_dump_reports_status  ON dump_reports(status);
CREATE INDEX idx_dump_reports_citizen ON dump_reports(citizen_id);
CREATE INDEX idx_dump_reports_worker  ON dump_reports(assigned_worker_id);
CREATE INDEX idx_dump_reports_geom    ON dump_reports USING GIST (geom);
CREATE INDEX idx_dump_reports_created ON dump_reports(created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: violations
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE violations (
    id               TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    citizen_id       TEXT REFERENCES citizens(id) ON DELETE CASCADE,
    timestamp        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    location_name    TEXT,
    lat              DOUBLE PRECISION,
    lng              DOUBLE PRECISION,
    geom             GEOMETRY(Point, 4326) GENERATED ALWAYS AS (
                         CASE WHEN lat IS NOT NULL AND lng IS NOT NULL
                         THEN ST_SetSRID(ST_MakePoint(lng, lat), 4326)
                         ELSE NULL END
                     ) STORED,
    fine_amount      NUMERIC(10,2) NOT NULL DEFAULT 200.00,
    status           TEXT NOT NULL DEFAULT 'Pending',
    snapshot_url     TEXT,
    confidence_score NUMERIC(5,2),
    dispute_reason   TEXT,
    disputed_at      TIMESTAMPTZ,
    payment_method   TEXT,
    paid_at          TIMESTAMPTZ,
    transaction_ref  TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_violations_citizen   ON violations(citizen_id);
CREATE INDEX idx_violations_status    ON violations(status);
CREATE INDEX idx_violations_timestamp ON violations(timestamp DESC);
CREATE INDEX idx_violations_geom      ON violations USING GIST (geom);

-- ═══════════════════════════════════════════════════════════════════════════
-- TABLE: rewards
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE rewards (
    id            TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
    title         TEXT NOT NULL,
    category      TEXT NOT NULL,
    points_cost   INTEGER NOT NULL,
    voucher_code  TEXT,
    target_role   TEXT NOT NULL DEFAULT 'citizen',
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rewards_role   ON rewards(target_role);
CREATE INDEX idx_rewards_active ON rewards(active);

-- ═══════════════════════════════════════════════════════════════════════════
-- FUNCTION: match_citizen_face
-- Returns TEXT id (compatible with TEXT PK citizens)
-- ═══════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION match_citizen_face(
    query_embedding vector(512),
    match_threshold float DEFAULT 0.70,
    match_count     int   DEFAULT 1
)
RETURNS TABLE(
    id         TEXT,
    name       TEXT,
    phone      TEXT,
    ward       TEXT,
    eco_points INTEGER,
    tier       TEXT,
    similarity float
)
LANGUAGE sql STABLE AS $$
    SELECT
        id, name, phone, ward, eco_points, tier,
        1 - (face_embedding <=> query_embedding) AS similarity
    FROM citizens
    WHERE face_embedding IS NOT NULL
      AND 1 - (face_embedding <=> query_embedding) > match_threshold
    ORDER BY face_embedding <=> query_embedding
    LIMIT match_count;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- DISABLE ROW LEVEL SECURITY (development mode)
-- Re-enable per-table policies in production
-- ═══════════════════════════════════════════════════════════════════════════
ALTER TABLE admins        DISABLE ROW LEVEL SECURITY;
ALTER TABLE citizens      DISABLE ROW LEVEL SECURITY;
ALTER TABLE workers       DISABLE ROW LEVEL SECURITY;
ALTER TABLE dump_reports  DISABLE ROW LEVEL SECURITY;
ALTER TABLE violations    DISABLE ROW LEVEL SECURITY;
ALTER TABLE rewards       DISABLE ROW LEVEL SECURITY;

-- ═══════════════════════════════════════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Admins ────────────────────────────────────────────────────
INSERT INTO admins (id, name, email, password_hash, admin_id, ward_jurisdiction, designation)
VALUES
    ('ADM-BBMP-001', 'Rajesh Venkataraman', 'admin@bbmp.gov.in',   'admin123', 'ADM-BBMP-001', 'Bengaluru South Zone', 'Zonal Commissioner'),
    ('ADM-BBMP-002', 'Sunitha Krishnamurthy','sunitha@bbmp.gov.in','admin123', 'ADM-BBMP-002', 'Bengaluru North Zone', 'Deputy Commissioner')
ON CONFLICT (email) DO NOTHING;

-- ── Citizens ──────────────────────────────────────────────────
INSERT INTO citizens (id, name, phone, email, address, ward, gov_id, eco_points, tier)
VALUES
    ('CIT-001', 'Rahul Sharma',   '+919876543210', 'rahul@example.com',   '12 MG Road, Bengaluru',          'Ward 68', 'AADH-1234-5678', 450,  'Bronze'),
    ('CIT-002', 'Priya Patel',    '+919876543211', 'priya@example.com',   '45 Indiranagar 12th Main',       'Ward 72', 'AADH-2345-6789', 1650, 'Silver'),
    ('CIT-003', 'Vikram Nair',    '+919876543212', 'vikram@example.com',  '78 Koramangala 5th Block',       'Ward 55', 'AADH-3456-7890', 3200, 'Gold'),
    ('CIT-004', 'Ananya Reddy',   '+919876543213', 'ananya@example.com',  '23 Jayanagar 4th T Block',       'Ward 61', 'AADH-4567-8901', 5800, 'Eco-Champion'),
    ('CIT-005', 'Mohammed Faizal','+919876543214', 'faizal@example.com',  '156 Shivajinagar Main Road',     'Ward 84', 'AADH-5678-9012', 120,  'Bronze')
ON CONFLICT (phone) DO NOTHING;

-- ── Workers ───────────────────────────────────────────────────
INSERT INTO workers (id, admin_id, name, phone, employee_id, pin_hash, ward, status, lat, lng, tasks_completed, eco_points, bonus_accrued)
VALUES
    ('WRK-001', 'ADM-BBMP-001', 'Ravi Kumar',   '+918765432100', 'EW-WRK-001', '1234', 'Ward 68', 'On Duty',  12.9716, 77.6408, 23, 2300, 4600.00),
    ('WRK-002', 'ADM-BBMP-001', 'Lakshmi Devi', '+918765432101', 'EW-WRK-002', '1234', 'Ward 72', 'On Duty',  12.9783, 77.6412, 18, 1800, 3600.00),
    ('WRK-003', 'ADM-BBMP-001', 'Suresh Babu',  '+918765432102', 'EW-WRK-003', '1234', 'Ward 55', 'Off Duty', 12.9346, 77.6267, 31, 3100, 6200.00)
ON CONFLICT (employee_id) DO NOTHING;

-- ── Dump Reports ──────────────────────────────────────────────
INSERT INTO dump_reports (id, citizen_id, reported_by, category, severity, location_name, lat, lng, status, eco_points_awarded)
VALUES
    ('RPT-001', 'CIT-001', 'Rahul Sharma',   'Illegal Dump Yard','Critical','Near Silk Board Junction',          12.9176, 77.6233, 'Submitted',           50),
    ('RPT-002', 'CIT-002', 'Priya Patel',    'Overflowing Bin',  'High',    '80 Feet Road, Indiranagar',         12.9783, 77.6408, 'Worker Assigned',     50),
    ('RPT-003', 'CIT-003', 'Vikram Nair',    'Plastic Waste',    'Medium',  'Koramangala Water Tank Road',       12.9346, 77.6267, 'Cleaning in Progress',50),
    ('RPT-004', 'CIT-004', 'Ananya Reddy',   'Hazardous Debris', 'High',    'Whitefield EPIP Zone Gate 3',       12.9715, 77.7499, 'Pending Verification',50),
    ('RPT-005', 'CIT-001', 'Rahul Sharma',   'Illegal Dump Yard','Critical','Majestic Bus Stand Underpass',      12.9767, 77.5713, 'Cleaned & Verified',  50),
    ('RPT-006', 'CIT-002', 'Priya Patel',    'Plastic Waste',    'Low',     'Jayanagar Shopping Complex',        12.9253, 77.5938, 'Submitted',           50),
    ('RPT-007', 'CIT-003', 'Vikram Nair',    'Overflowing Bin',  'Medium',  'Marathahalli Bridge',               12.9561, 77.7010, 'Submitted',           50),
    ('RPT-008', 'CIT-005', 'Mohammed Faizal','Hazardous Debris', 'Critical','Hebbal Lake Road',                  13.0435, 77.5960, 'Worker Assigned',     50)
ON CONFLICT (id) DO NOTHING;

-- Update assigned worker for RPT-002 and RPT-008
UPDATE dump_reports SET assigned_worker_id = 'WRK-001' WHERE id = 'RPT-002';
UPDATE dump_reports SET assigned_worker_id = 'WRK-002' WHERE id = 'RPT-008';

-- ── Violations ────────────────────────────────────────────────
INSERT INTO violations (id, citizen_id, location_name, lat, lng, fine_amount, status, confidence_score)
VALUES
    ('VIO-001', 'CIT-001', 'Indiranagar 100 Feet Road',   12.9783, 77.6408, 200, 'Pending',   95.4),
    ('VIO-002', 'CIT-002', 'Koramangala Forum Mall Exit',  12.9346, 77.6267, 200, 'Paid',      91.2),
    ('VIO-003', 'CIT-003', 'MG Road Brigade Junction',     12.9758, 77.6059, 200, 'Disputed',  87.8),
    ('VIO-004', 'CIT-001', 'Silk Board Signal',            12.9176, 77.6233, 200, 'Pending',   93.1),
    ('VIO-005', 'CIT-004', 'Whitefield Hopefarm Signal',   12.9715, 77.7499, 200, 'Paid',      96.7),
    ('VIO-006', 'CIT-005', 'Majestic Bus Stand',           12.9767, 77.5713, 200, 'Dismissed', 72.3),
    ('VIO-007', 'CIT-002', 'Jayanagar JP Nagar Road',      12.9253, 77.5938, 200, 'Pending',   89.5),
    ('VIO-008', 'CIT-003', 'Hebbal Flyover',               13.0435, 77.5960, 200, 'Upheld',    94.2)
ON CONFLICT (id) DO NOTHING;

-- Mark paid violations with payment info
UPDATE violations SET 
    payment_method  = 'UPI / GPay',
    paid_at         = NOW() - INTERVAL '2 days',
    transaction_ref = 'TXN-VIO002-PAID'
WHERE id = 'VIO-002';

UPDATE violations SET
    payment_method  = 'Debit Card',
    paid_at         = NOW() - INTERVAL '5 days',
    transaction_ref = 'TXN-VIO005-PAID'
WHERE id = 'VIO-005';

UPDATE violations SET
    dispute_reason = 'I was not at this location at that time. The person in the snapshot is not me.',
    disputed_at    = NOW() - INTERVAL '1 day'
WHERE id = 'VIO-003';

-- ── Rewards: Citizens ─────────────────────────────────────────
INSERT INTO rewards (id, title, category, points_cost, voucher_code, target_role)
VALUES
    ('RWD-C-001', 'Municipal Property Tax Rebate 10%',    'Tax Benefit', 500,  'ECO-TAX-2026-ALPHA',   'citizen'),
    ('RWD-C-002', 'Free 2-Month Metro Transit Pass',      'Transport',   750,  'ECO-MTR-2026-BRAVO',   'citizen'),
    ('RWD-C-003', 'Water Utility Bill Discount 15%',      'Utility',     400,  'ECO-WAT-2026-CHARLIE', 'citizen'),
    ('RWD-C-004', 'Free Smart Parking Credits (₹500)',    'Transport',   300,  'ECO-PRK-2026-DELTA',   'citizen'),
    ('RWD-C-005', 'BDA Plot Registration Fee Waiver 5%',  'Property',    2000, 'ECO-BDA-2026-ECHO',    'citizen'),
    ('RWD-C-006', 'BBMP Solid Waste Certificate',         'Certificate', 200,  'ECO-CERT-2026-FOXT',   'citizen')
ON CONFLICT (id) DO NOTHING;

-- ── Rewards: Workers ──────────────────────────────────────────
INSERT INTO rewards (id, title, category, points_cost, voucher_code, target_role)
VALUES
    ('RWD-W-001', 'Monthly Grocery / Ration Kit (₹1,200)',      'Welfare',    500,  'EW-GRC-2026-001',  'worker'),
    ('RWD-W-002', 'Free Comprehensive Medical Health Checkup',   'Healthcare', 300,  'EW-MED-2026-002',  'worker'),
    ('RWD-W-003', 'Performance Uniform Allowance (₹800)',        'Equipment',  200,  'EW-UNI-2026-003',  'worker'),
    ('RWD-W-004', 'Festival Bonus Voucher (₹500)',               'Bonus',      750,  'EW-FEST-2026-004', 'worker')
ON CONFLICT (id) DO NOTHING;
