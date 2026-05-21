-- ───────────────────────────────────────────────────────────────────────────
-- 0008_drop_owned.sql — remove the legacy flat owned list
--
-- The collection store (0007) replaced it: owned_prices now reads
-- collection_items, the price-enqueue trigger fires on collection_items, the
-- ingest reads collection_items, and PUT/GET /v1/owned is gone. Nothing
-- references `owned` or `replace_owned` anymore, so drop both. Must run AFTER
-- 0007. Irreversible.
-- ───────────────────────────────────────────────────────────────────────────

drop function if exists public.replace_owned(jsonb);
drop table    if exists public.owned;   -- cascades owned_card_idx + any trigger
