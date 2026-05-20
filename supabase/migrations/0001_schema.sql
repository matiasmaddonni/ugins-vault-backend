-- ───────────────────────────────────────────────────────────────────────────
-- 0001_schema.sql — tables
--
-- Ugin's Vault price/auth backend. All card ids are SCRYFALL printing UUIDs
-- (that is what the iOS app stores in `owned.card_id` and what we key prices by
-- after mapping MTGJSON uuid -> scryfallId during ingest).
-- ───────────────────────────────────────────────────────────────────────────

-- Per-user profile, 1:1 with auth.users. Auto-created by trigger (0003).
create table if not exists public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

-- Per-user owned list. card_id = Scryfall printing UUID. RLS-scoped (0002).
create table if not exists public.owned (
  user_id    uuid not null references auth.users (id) on delete cascade,
  card_id    uuid not null,
  quantity   int  not null default 1 check (quantity > 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, card_id)
);

-- Speeds the ingest's `select distinct card_id from owned` (the owned-union).
create index if not exists owned_card_idx on public.owned (card_id);

-- GLOBAL prices. One row per (card, source, finish, day). The read API merges
-- finishes (etched > foil > normal) per day to match the iOS app, which folds
-- finishes into a single daily price (see MTGJSONPriceParser.mergedFinishMap).
-- `retail` is unconstrained numeric to preserve MTGJSON precision 1:1 with the
-- app's Swift `Decimal`.
create table if not exists public.prices (
  card_id  uuid    not null,
  source   text    not null,   -- cardkingdom | tcgplayer | cardmarket
  finish   text    not null,   -- normal | foil | etched
  date     date    not null,
  retail   numeric not null,
  currency text    not null,   -- USD | EUR (read from MTGJSON, not assumed)
  primary key (card_id, source, finish, date)
);

-- Read path filters by (card_id, source, date-window); PK leads with finish so
-- this secondary index serves the window scan.
create index if not exists prices_card_source_date_idx
  on public.prices (card_id, source, date);

-- GLOBAL FX. rate is USD -> quote. quote in ('ARS','EUR').
create table if not exists public.fx (
  quote      text primary key,
  rate       numeric not null,
  fetched_at timestamptz not null default now()
);
