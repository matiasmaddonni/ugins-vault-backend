-- ───────────────────────────────────────────────────────────────────────────
-- 0005_price_queue.sql — on-demand price fetch queue
--
-- Goal: when a user adds a card, fetch its MTGJSON prices ASAP instead of
-- waiting for the next daily cron. MTGJSON has no per-card API — the on-demand
-- ingest still streams the dumps — but it can run within seconds of the insert
-- (GitHub repository_dispatch) and scope itself to just the new cards.
--
-- Flow:
--   insert into owned  ──(trigger)──▶  enqueue card_id IF it has no price rows
--   PUT /v1/owned       ──(API)──────▶  if queue non-empty, fire repository_dispatch
--   on-demand workflow  ──(ingest)───▶  drains queue, upserts prices, clears ids
--
-- The daily cron + manual backfill are unchanged; this only shortens the
-- time-to-first-price for newly added cards.
-- ───────────────────────────────────────────────────────────────────────────

-- GLOBAL work queue. One row per card awaiting an on-demand price fetch. Written
-- only by the enqueue trigger (SECURITY DEFINER) and drained by the ingest
-- (service_role, BYPASSRLS). RLS is enabled with NO policy, so authenticated
-- clients can neither read nor write it.
--
-- last_attempt_at: cards MTGJSON has no paper price for (tokens, art cards,
-- some promos) never get a price row, so the trigger below would re-enqueue
-- them on every collection save. After a fruitless fetch the ingest stamps
-- last_attempt_at instead of deleting the row; claims/dispatch then skip it for
-- a cooldown (see PRICE_RETRY_COOLDOWN). Cards that DID get a price are deleted
-- (and won't re-enqueue — they now have rows in `prices`).
create table if not exists public.price_backfill_queue (
  card_id         uuid primary key,
  enqueued_at     timestamptz not null default now(),
  last_attempt_at timestamptz
);

alter table public.price_backfill_queue enable row level security;
-- No policies: only service_role (BYPASSRLS) and the definer trigger touch it.

-- Enqueue a freshly inserted owned card for an on-demand price fetch, but ONLY
-- when the global prices table has nothing for it yet. `replace_owned` re-inserts
-- a user's whole list on every PUT, so without this guard we would re-enqueue
-- the entire collection on each edit; the `not exists` keeps the queue to cards
-- that genuinely have no price to show. SECURITY DEFINER so it can write the
-- service-only queue regardless of the calling user's RLS.
create or replace function public.enqueue_missing_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.prices p where p.card_id = new.card_id) then
    insert into public.price_backfill_queue (card_id)
    values (new.card_id)
    on conflict (card_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists owned_enqueue_price on public.owned;
create trigger owned_enqueue_price
  after insert on public.owned
  for each row
  execute function public.enqueue_missing_price();

-- Lets the read API (user-scoped client) learn whether a dispatch is worth
-- firing after a PUT, without exposing the queue contents. Counts only
-- *claimable* rows (never attempted, or past the 7-day cooldown) so a queue of
-- cards still in cooldown doesn't fire empty jobs on every save. SECURITY
-- DEFINER so it can count the service-only table; returns just an integer.
create or replace function public.price_queue_size()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.price_backfill_queue
  where last_attempt_at is null
     or last_attempt_at < now() - interval '7 days'
$$;

grant execute on function public.price_queue_size() to authenticated;
