-- ============================================================================
-- EcoWatch migration 002 — reliable face search
-- The original IVFFlat index (lists=100) was built on an (almost) empty table. IVFFlat only
-- searches `ivfflat.probes` (default 1) of its lists, so with few enrolled faces most camera
-- queries probed an empty list and returned NO candidates (=> every event "NO_MATCH").
-- HNSW has no such training step and returns correct nearest neighbours on small tables.
-- Index change only; no data is modified. Safe to re-run.
-- ============================================================================
DROP INDEX IF EXISTS idx_citizens_face;
CREATE INDEX IF NOT EXISTS idx_citizens_face_hnsw
    ON citizens USING hnsw (face_embedding vector_cosine_ops);
