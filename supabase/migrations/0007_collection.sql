-- ───────────────────────────────────────────────────────────────────────────
-- 0007_collection.sql — server-side collection store (source of truth)
--
-- The collection becomes the backend's responsibility so a fresh iOS install can
-- restore the ENTIRE collection (every card in its correct stack) from the
-- server. This replaces the flat `owned` list (dropped in 0008).
--
-- THIN ID+OWNERSHIP STORE. We store ZERO card metadata: the only card-identifying
-- field is `card_id` (a Scryfall printing UUID); the app re-hydrates name/image/
-- set from Scryfall. All enum-ish fields (kind, finish, condition, format,
-- colors, language) are OPAQUE strings the app owns — we store and round-trip
-- them verbatim and never validate or enumerate their values. The only
-- server-meaningful field is collection_items.card_id (feeds the price queue).
-- ───────────────────────────────────────────────────────────────────────────

-- Per-user stacks (the app's groupings: decks, binders, "owned by", etc.).
create table if not exists public.stacks (
  user_id           uuid        not null references auth.users (id) on delete cascade,
  id                uuid        primary key,
  name              text        not null,
  kind              text        not null,   -- opaque (app-owned)
  sort_order        int         not null default 0,
  created_at        timestamptz not null default now(),
  format            text,                   -- opaque, nullable
  colors            text[]      not null default '{}',  -- opaque tokens, app-owned
  commander         text,                   -- nullable
  commander_card_id uuid,                   -- nullable (Scryfall id)
  person            text,                   -- nullable
  since             timestamptz             -- nullable
);

-- Per-user collection items. A card_id may appear in many items/stacks.
create table if not exists public.collection_items (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  id          uuid        primary key,
  card_id     uuid        not null,         -- Scryfall printing UUID (server-meaningful)
  stack_id    uuid        not null,         -- references a stacks.id in the same payload
  quantity    int         not null check (quantity >= 1),
  finish      text        not null,         -- opaque
  condition   text        not null,         -- opaque
  language    text        not null,         -- opaque
  acquired_at timestamptz,                  -- nullable
  notes       text                          -- nullable
);

-- Read/queue paths.
create index if not exists collection_items_user_idx          on public.collection_items (user_id);
create index if not exists collection_items_user_card_idx     on public.collection_items (user_id, card_id);
create index if not exists stacks_user_idx                    on public.stacks (user_id);

-- ── grants + RLS (owner-only, same style as `owned`) ─────────────────────────
grant select, insert, update, delete on public.stacks           to authenticated;
grant select, insert, update, delete on public.collection_items to authenticated;

alter table public.stacks           enable row level security;
alter table public.collection_items enable row level security;

create policy stacks_select on public.stacks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy stacks_insert on public.stacks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy stacks_update on public.stacks
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy stacks_delete on public.stacks
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy collection_items_select on public.collection_items
  for select to authenticated using ((select auth.uid()) = user_id);
create policy collection_items_insert on public.collection_items
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy collection_items_update on public.collection_items
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy collection_items_delete on public.collection_items
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ── replace_collection(): atomic "replace MY whole collection" ───────────────
-- Mirrors replace_owned: one function body == one transaction, so there is never
-- a window where the collection is half-written. SECURITY INVOKER keeps RLS in
-- force and pins every row to the caller via auth.uid(); a client can never
-- write another user's rows, and any user_id in the payload is ignored. Dedupe
-- by `id` (last-wins) before insert so a duplicate id in the payload can't make
-- ON CONFLICT touch the same row twice. Opaque fields are stored verbatim.
create or replace function public.replace_collection(p_stacks jsonb, p_items jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
  n_stacks int;
  n_items  int;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  delete from public.collection_items where user_id = uid;
  delete from public.stacks           where user_id = uid;

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
    order by (j.elem ->> 'id'), j.ord desc   -- last occurrence wins
  ) s;
  get diagnostics n_stacks = row_count;

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
  ) s;
  get diagnostics n_items = row_count;

  return jsonb_build_object('stacks', n_stacks, 'items', n_items);
end;
$$;

grant execute on function public.replace_collection(jsonb, jsonb) to authenticated;

-- ── repoint owned_prices() at the collection ─────────────────────────────────
-- /v1/prices and /v1/movers call this RPC unchanged; only its body moves off the
-- (soon-dropped) `owned` table. A card can sit in several items/stacks, so the
-- per-card quantity is the SUM across the caller's items. Output shape is
-- identical to 0004 (card_id, quantity, finish, date, retail, currency).
create or replace function public.owned_prices(p_source text, p_since date)
returns table (
  card_id  uuid,
  quantity int,
  finish   text,
  date     date,
  retail   numeric,
  currency text
)
language sql
stable
security invoker
set search_path = public
as $$
  select p.card_id, c.quantity, p.finish, p.date, p.retail, p.currency
  from public.prices p
  join (
    select ci.card_id, sum(ci.quantity)::int as quantity
    from public.collection_items ci
    where ci.user_id = (select auth.uid())
    group by ci.card_id
  ) c on c.card_id = p.card_id
  where p.source = p_source
    and p.date  >= p_since
$$;

-- ── rewire the price-enqueue trigger onto collection_items ───────────────────
-- enqueue_missing_price() (0005) is reused verbatim: on insert it enqueues
-- NEW.card_id iff `prices` has nothing for it. Many items can share a card_id;
-- the per-row trigger + ON CONFLICT DO NOTHING collapses them to one queue row.
drop trigger if exists owned_enqueue_price       on public.owned;
drop trigger if exists collection_enqueue_price  on public.collection_items;
create trigger collection_enqueue_price
  after insert on public.collection_items
  for each row
  execute function public.enqueue_missing_price();
