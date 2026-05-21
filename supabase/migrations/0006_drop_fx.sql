-- ───────────────────────────────────────────────────────────────────────────
-- 0006_drop_fx.sql — remove the FX feature
--
-- The backend is now auth + prices only; currency conversion is no longer a
-- backend concern. Dropping the table also drops its RLS policy and grants.
-- Irreversible: the stored ARS/EUR rates are discarded. The GET /v1/fx route
-- and the FX ingest were removed in the same change.
-- ───────────────────────────────────────────────────────────────────────────

drop table if exists public.fx;
