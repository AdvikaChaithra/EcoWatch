-- ============================================================================
-- EcoWatch migration 004 — Super Admin, account lifecycle, audit log
-- Additive and idempotent. No data is removed.
-- ============================================================================

-- Admin accounts: role (admin | super_admin), active flag, forced password change on first login
ALTER TABLE admins ADD COLUMN IF NOT EXISTS role                 TEXT    NOT NULL DEFAULT 'admin';
ALTER TABLE admins ADD COLUMN IF NOT EXISTS active               BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS phone                TEXT;
ALTER TABLE admins DROP CONSTRAINT IF EXISTS admins_role_check;
ALTER TABLE admins ADD CONSTRAINT admins_role_check CHECK (role IN ('admin', 'super_admin'));

-- Workers: one-time PIN must be changed on first login
ALTER TABLE workers ADD COLUMN IF NOT EXISTS must_change_pin BOOLEAN NOT NULL DEFAULT FALSE;

-- Sectors: can be retired without deleting history
ALTER TABLE sectors ADD COLUMN IF NOT EXISTS active     BOOLEAN     NOT NULL DEFAULT TRUE;
ALTER TABLE sectors ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Audit log of privileged actions (who did what, to what, when)
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    TEXT NOT NULL,
    actor_role  TEXT NOT NULL,
    actor_name  TEXT,
    action      TEXT NOT NULL,          -- e.g. ADMIN_CREATED, SECTOR_REASSIGNED, WORKER_TRANSFERRED
    target_type TEXT,                   -- admin | sector | worker
    target_id   TEXT,
    details     JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at DESC);
ALTER TABLE audit_log DISABLE ROW LEVEL SECURITY;  -- demo mode (written only by server routes)

-- Credentials must never be readable from the browser (publishable key).
-- NOTE: the app's server routes use the same key in demo mode, so these REVOKEs are applied only
-- when SUPABASE_SERVICE_ROLE_KEY is configured (see docs). Left commented for the demo:
-- REVOKE SELECT (password_hash, totp_secret) ON admins  FROM anon, authenticated;
-- REVOKE SELECT (pin_hash)                   ON workers FROM anon, authenticated;
