-- ───────────────────────────────────────────────────────────────────────────
-- 0010_price_status_fix.sql — price_status must defer to actual prices
--
-- Bug: cards that HAVE prices were left in price_backfill_queue stamped
-- `noData` — the on-demand early-return (uuidMap empty) stamped EVERY claimed
-- card, including ones already priced by backfill/daily, and daily/backfill
-- never clear the queue. price_status() then reported those priced cards as
-- noData, so the app showed "no price" even though /v1/prices returns a value.
--
-- Fix: a card with ANY price row is never pending/noData. Plus a prune RPC the
-- ingest calls (so it can't recur) and a one-time cleanup of the stale rows.
-- ───────────────────────────────────────────────────────────────────────────

-- Drop queue rows for cards that now have a price. Called by the ingest after
-- it upserts; also run once below to fix the current stale state.
create or replace function public.prune_priced_queue()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  delete from public.price_backfill_queue q
  where exists (select 1 from public.prices p where p.card_id = q.card_id);
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.prune_priced_queue() to service_role;

-- One-time cleanup: remove already-priced cards from the queue right now so
-- price_status is correct the moment this migration is applied.
select public.prune_priced_queue();

-- price_status(): a card with a price is in NEITHER list (defensive — even if a
-- stale queue row exists, prices win). pending = queued, no price, never tried;
-- noData = queued, no price, already tried (MTGJSON has none).
create or replace function public.price_status()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select distinct card_id from public.collection_items where user_id = (select auth.uid())
  ),
  q as (
    select m.card_id, bq.last_attempt_at
    from mine m
    join public.price_backfill_queue bq on bq.card_id = m.card_id
    where not exists (select 1 from public.prices p where p.card_id = m.card_id)
  )
  select jsonb_build_object(
    'pending',   coalesce((select jsonb_agg(card_id) from q where last_attempt_at is null), '[]'::jsonb),
    'noData',    coalesce((select jsonb_agg(card_id) from q where last_attempt_at is not null), '[]'::jsonb),
    'updatedAt', (select max(p.date) from public.prices p join mine m on m.card_id = p.card_id)
  )
$$;
