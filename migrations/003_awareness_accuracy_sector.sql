-- ============================================================================
-- EcoWatch migration 003 — awareness messages, GPS accuracy, local sector
-- Additive and idempotent. No data is removed.
-- ============================================================================

-- Short educational message attached to each fine (varies per violation).
ALTER TABLE violations   ADD COLUMN IF NOT EXISTS awareness_message TEXT;

-- GPS accuracy (metres) reported by the device when a dump report was submitted.
ALTER TABLE dump_reports ADD COLUMN IF NOT EXISTS location_accuracy_m DOUBLE PRECISION;

-- Sector covering the demo camera's real location (Bharathnagar / Byadarahalli, West Bengaluru).
INSERT INTO sectors (id, area, name, admin_id, lat, lng) VALUES
    ('SEC-BHN-1', 'Bharathnagar', 'Sector 1', (SELECT id FROM admins WHERE email = 'admin@bbmp.gov.in'), 12.980364, 77.480433)
ON CONFLICT (id) DO NOTHING;
