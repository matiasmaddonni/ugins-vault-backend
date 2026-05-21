-- ───────────────────────────────────────────────────────────────────────────
-- 0009_collection_deltas.sql — incremental collection ops + price status
--
-- Full-replace (replace_collection, 0007) stays for first import / hard reset,
-- but day-to-day the app mutates incrementally: add a batch of cards, drop the
-- ones it sold. These RPCs do partial upsert/delete per id. They mirror
-- replace_collection's safety: SECURITY INVOKER so RLS applies and auth.uid()
-- pins ownership; user_id is always the caller; dedupe by id (last-wins) so a
-- duplicate id in one batch can't make ON CONFLICT touch a row twice; and the
-- DO UPDATE is guarded to the caller's rows so a colliding id from another user
-- can never be clobbered.
--
-- Also adds price_status(): the caller learns which of THEIR cards are still
-- being fetched vs have no MTGJSON price, so the app can show "fetching" and
-- poll instead of falling back to anything client-side. SECURITY DEFINER so it
-- can read the service-only price_backfill_queue.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.upsert_collection_items(p_items jsonb)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
  n   int;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  insert into public.collection_items
    (user_id, id, card_id, stack_id, quantity, finish, condition, language, acquired_at, notes)
  select uid,
         (e ->> 'id')::uuid,
         (e ->> 'cardId')::uuid,
         (e ->> 'stackId')::uuid,
         greatest(1, coalesce((e ->> 'quantity')::int, 1)),
         e ->> 'finish',
         e ->> 'condition',
         e ->> 'language',
         nullif(e ->> 'acquiredAt', '')::timestamptz,
         e ->> 'notes'
  from (
    select distinct on (j.elem ->> 'id') j.elem as e
    from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as j(elem, ord)
    order by (j.elem ->> 'id'), j.ord desc
  ) s
  on conflict (id) do update set
    card_id     = excluded.card_id,
    stack_id    = excluded.stack_id,
    quantity    = excluded.quantity,
    finish      = excluded.finish,
    condition   = excluded.condition,
    language    = excluded.language,
    acquired_at = excluded.acquired_at,
    notes       = excluded.notes
  where public.collection_items.user_id = uid;   -- never touch another user's row

  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.delete_collection_items(p_ids jsonb)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
  n   int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  delete from public.collection_items
  where user_id = uid
    and id = any (array(select jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)))::uuid[]);
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.upsert_collection_stacks(p_stacks jsonb)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
  n   int;
begin
  if uid is null then raise exception 'not authenticated'; end if;

  insert into public.stacks
    (user_id, id, name, kind, sort_order, created_at, format, colors,
     commander, commander_card_id, person, since)
  select uid,
         (e ->> 'id')::uuid,
         e ->> 'name',
         e ->> 'kind',
         coalesce((e ->> 'sortOrder')::int, 0),
         coalesce((e ->> 'createdAt')::timestamptz, now()),
         e ->> 'format',
         case
           when jsonb_typeof(e -> 'colors') = 'array'
             then array(select jsonb_array_elements_text(e -> 'colors'))
           else '{}'::text[]
         end,
         e ->> 'commander',
         nullif(e ->> 'commanderCardId', '')::uuid,
         e ->> 'person',
         nullif(e ->> 'since', '')::timestamptz
  from (
    select distinct on (j.elem ->> 'id') j.elem as e
    from jsonb_array_elements(coalesce(p_stacks, '[]'::jsonb)) with ordinality as j(elem, ord)
    order by (j.elem ->> 'id'), j.ord desc
  ) s
  on conflict (id) do update set
    name              = excluded.name,
    kind              = excluded.kind,
    sort_order        = excluded.sort_order,
    created_at        = excluded.created_at,
    format            = excluded.format,
    colors            = excluded.colors,
    commander         = excluded.commander,
    commander_card_id = excluded.commander_card_id,
    person            = excluded.person,
    since             = excluded.since
  where public.stacks.user_id = uid;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Deleting a stack also removes that stack's items (no orphans). Returns the
-- number of stacks deleted.
create or replace function public.delete_collection_stacks(p_ids jsonb)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
  ids uuid[] := array(select jsonb_array_elements_text(coalesce(p_ids, '[]'::jsonb)))::uuid[];
  n   int;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  delete from public.collection_items where user_id = uid and stack_id = any(ids);
  delete from public.stacks           where user_id = uid and id       = any(ids);
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.upsert_collection_items(jsonb)  to authenticated;
grant execute on function public.delete_collection_items(jsonb)  to authenticated;
grant execute on function public.upsert_collection_stacks(jsonb) to authenticated;
grant execute on function public.delete_collection_stacks(jsonb) to authenticated;

-- ── price_status(): per-caller fetch state ───────────────────────────────────
-- pending  = the caller's cards sitting in the queue, not yet attempted (still
--            "fetching"). noData = attempted but MTGJSON had no paper price
--            (cooling down) — the app should stop showing "fetching" for these.
-- A card with a price is in neither list (the ingest clears it from the queue).
-- updatedAt = latest price date across the caller's priced cards.
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
  )
  select jsonb_build_object(
    'pending',   coalesce((select jsonb_agg(card_id) from q where last_attempt_at is null), '[]'::jsonb),
    'noData',    coalesce((select jsonb_agg(card_id) from q where last_attempt_at is not null), '[]'::jsonb),
    'updatedAt', (select max(p.date) from public.prices p join mine m on m.card_id = p.card_id)
  )
$$;

grant execute on function public.price_status() to authenticated;
