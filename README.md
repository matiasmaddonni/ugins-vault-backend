# Ugin's Vault — price backend

Personal, multi-user price backend for the **Ugin's Vault** iOS app (a Magic:
The Gathering collection tracker). It ingests MTGJSON prices **server-side** and
serves each user's owned-card prices + history + movers as a **few-KB JSON**, so
the phone downloads kilobytes instead of the ~1.2 GB MTGJSON dump.

The **collection lives on the backend** (source of truth): the full collection —
every card in its stack — is read back via `GET /v1/collection`, so a fresh
install restores everything and it syncs across devices. The app mutates it
**incrementally** (add a batch, remove what was sold) via the items/stacks delta
routes. The backend is a **thin id + ownership store**: it keeps **zero card
metadata** (the app re-hydrates names/art/sets from Scryfall by id) and treats
every enum-ish field as an **opaque string** it round-trips verbatim. This
backend is **auth + prices only** (no client-side price fallback — see status).

```
              ┌──────────────────────── GitHub Actions (free) ───────────────────────┐
              │  daily cron: AllPricesToday.json.gz  ─┐                                │
 MTGJSON  ───▶│  manual:     AllPrices.json.gz       ─┤ stream + map uuid→scryfallId  │
              │  AllIdentifiers.json.gz  (uuid map)  ─┘ upsert prices (service)        │
              └───────────────────────────────────────────┬───────────────────────────┘
                                                           ▼
 iOS app  ──(Supabase JWT)──▶  Vercel read API  ──(JWT, RLS)──▶  Supabase Postgres + Auth
   /v1/collection (GET/PUT, +/items +/stacks deltas) · /v1/prices (+/status) · /v1/movers
```

- **Supabase** (free): Postgres + Auth (user management) + Row-Level Security.
- **Vercel** (Hobby): thin TypeScript read API, authenticated by the Supabase JWT.
- **GitHub Actions** (free): the heavy ingest cron (no serverless time limit).
  The daily write also keeps the free Supabase project from pausing.

Everything is **TypeScript**. Big MTGJSON files are **streamed** (`stream-json`
+ inline gunzip), never loaded whole into memory.

---

## Layout

```
api/                       Vercel serverless functions (TypeScript)
  _lib/                    shared (auth/JWT, http, pricing+movers port, dispatch, collection)
  v1/collection.ts         GET + PUT  /v1/collection            (full read / replace)
  v1/collection/items.ts   POST + DELETE  /v1/collection/items  (incremental)
  v1/collection/stacks.ts  POST + DELETE  /v1/collection/stacks (incremental)
  v1/prices.ts             GET  /v1/prices
  v1/prices/status.ts      GET  /v1/prices/status               (fetch state)
  v1/movers.ts             GET  /v1/movers
  health.ts                GET  /api/health
ingest/src/                GitHub Actions ingest (TypeScript, streaming)
  daily.ts                 AllPricesToday → today's prices + prune
  backfill.ts              AllPrices → seed ~90 days (manual)
  onDemand.ts              drains price_backfill_queue → new cards' prices ASAP
  lib/                     config, db (service role), download, mtgjson stream
supabase/migrations/       0001 schema · 0002 RLS · 0003 auth trigger · 0004 RPC
                           · 0005 price queue · 0006 drop fx · 0007 collection
                           · 0008 drop owned · 0009 collection deltas + price status
.github/workflows/         ingest-daily.yml (cron) · backfill.yml (manual)
                           · ingest-on-demand.yml (repository_dispatch)
vercel.json                rewrites /v1/* → /api/v1/*
```

---

## Data model (Postgres)

| Table      | Scope   | Notes |
|------------|---------|-------|
| `auth.users` | —     | managed by Supabase Auth |
| `profiles` | per-user | `user_id` PK → `auth.users`; auto-created on signup (trigger) |
| `stacks`   | per-user | `id` PK + `user_id`. App's groupings (decks/binders/…). Fields `name`, `kind`, `sort_order`, `format`, `colors[]`, `commander`, `commander_card_id`, `person`, `since` — all **opaque** (app-owned), stored verbatim. RLS: owner-only |
| `collection_items` | per-user | `id` PK + `user_id`. `card_id` = **Scryfall printing UUID** — the *only* server-meaningful field (feeds the price queue). Plus `stack_id`, `quantity` (≥1), opaque `finish`/`condition`/`language`, `acquired_at`, `notes`. A card_id may repeat across items/stacks. RLS: owner-only |
| `prices`   | global  | `(card_id, source, finish, date)` PK, `retail`, `currency`. Readable by any authenticated user; only the ingest (service role) writes |
| `price_backfill_queue` | global | `card_id` PK + `last_attempt_at`. Cards added but with no price yet, awaiting the on-demand ingest. Written by a `collection_items`-insert trigger; drained by the ingest. No RLS policy → invisible to clients (read per-user via `price_status()`) |

- **Sources:** `cardkingdom`, `tcgplayer`, `cardmarket`. **Finishes (prices):**
  `normal`, `foil`, `etched` (MTGJSON's, distinct from the opaque item `finish`).
- Prices are stored **per finish**; the read API **merges** finishes per day
  (`etched > foil > normal`). ~90 days kept; older pruned daily.
- **`owned_prices()` RPC** scopes `prices` to the caller's collection, summing
  `quantity` per `card_id` across their items. `/v1/prices` + `/v1/movers` read it.
- **Movers are computed on read** from the user's collection × global `prices`.

---

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com). Note the
   **Project URL** and, under **Settings → API keys**, the **publishable/anon**
   key and the **secret/service-role** key.
2. **Run the migrations** in order (SQL Editor, or the Supabase CLI):
   - `0001_schema.sql` · `0002_rls.sql` · `0003_auth_trigger.sql`
   - `0004_functions.sql` · `0005_price_queue.sql` · `0006_drop_fx.sql`
   - `0007_collection.sql` · `0008_drop_owned.sql` *(after 0007)*
   - `0009_collection_deltas.sql`
3. **Auth config** (Authentication → Providers / Sign In):
   - Enable **Email** (password) and, for passwordless, **Magic Link**.
   - For local/dev you may turn **off** "Confirm email" so the first user can
     sign in immediately. Turn it back on for anything public.
   - New projects use **asymmetric JWT signing keys (ES256)** by default — the
     API verifies tokens locally, no extra config needed.

Using the Supabase CLI instead of the dashboard:

```bash
supabase link --project-ref <your-ref>
supabase db push           # applies supabase/migrations/*
```

### 2. Deploy the read API (Vercel)

1. Import the repo into Vercel (Hobby). It auto-detects the functions in `api/`.
2. Set **Environment Variables** (Project → Settings → Environment Variables):

   | Name | Value |
   |------|-------|
   | `SUPABASE_URL` | `https://<ref>.supabase.co` |
   | `SUPABASE_ANON_KEY` | the **publishable / anon** key (safe; cannot bypass RLS) |
   | `GH_DISPATCH_TOKEN` | *(optional)* fine-grained PAT, **`Contents: Read and write`** on this repo — lets a collection write trigger the on-demand ingest |
   | `GH_REPO` | *(optional)* `owner/name` of this repo |

   > Do **not** put the service-role key in Vercel. The API only ever verifies
   > JWTs and queries under the caller's RLS. `GH_DISPATCH_TOKEN` is a separate,
   > narrowly scoped GitHub token (not the service-role key); if it's unset the
   > API skips the dispatch and prices arrive via the daily cron.
   > **Note:** `repository_dispatch` needs the PAT's **Contents** permission
   > (write), not Actions.
3. Deploy. Public routes are `/v1/...` (rewritten to `/api/v1/...`). Smoke test:
   `curl https://<your-app>.vercel.app/api/health`.

### 3. Configure ingest (GitHub Actions)

In the GitHub repo → **Settings → Secrets and variables → Actions**:

- **Secrets:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (the **service-role** key).
- **Variables (optional):** `PRICE_SOURCES` (e.g. `cardkingdom,tcgplayer,cardmarket`).

Then add cards (app or API), run **Backfill price history** once, and the
**Daily price ingest** (`09:00 UTC`) keeps things fresh + the project awake.

### On-demand prices (new cards show ASAP)

A collection write that introduces a new card kicks an immediate fetch:

```
POST /v1/collection/items (or PUT /v1/collection)
   └─ collection_items insert ─▶ trigger enqueues card_ids with NO price yet
        └─ if queue non-empty ─▶ GitHub repository_dispatch "new-cards"
              └─ ingest-on-demand.yml ─▶ onDemand.ts: AllPricesToday then
                 AllPrices (scoped to queued ids) ─▶ upsert ─▶ clear queue
```

- Trigger (`0007`, fn from `0005`) enqueues only cards with **no** price rows;
  re-saving unchanged cards enqueues nothing. Cards MTGJSON has no price for get
  a **7-day cooldown** (stamped, not deleted) so they don't re-fire every save.
- One write ⇒ at most one dispatch. The workflow shares the `ingest` concurrency
  group with daily/backfill (never two writers; bursts collapse).
- **Latency is minutes, not seconds, by design** — MTGJSON has no per-card API,
  so the job still streams the dumps (filtered to the new ids).
- **Setup:** a fine-grained PAT with **`Contents: Read and write`** as
  `GH_DISPATCH_TOKEN` + `GH_REPO` on Vercel. Without it the daily cron backstops.

### Local runs

```bash
cp env.example .env        # fill in real values (service-role key for ingest)
npm install
npm run typecheck
npm run ingest:backfill    # full backfill locally (downloads ~135 MB gz)
npm run ingest:daily       # daily ingest locally
```

---

## API contract (for the iOS app)

All routes require `Authorization: Bearer <Supabase JWT>` (except `/api/health`)
and operate on the authenticated user. HTTPS only. JSON in/out. RLS scopes every
query to the `sub` claim.

> **Opaque fields.** Except `cardId`/`stackId`/`commanderCardId` (UUIDs) every
> field below — `kind`, `finish`, `condition`, `format`, `colors`, `language`,
> etc. — is an **opaque string the app owns**. The backend stores/returns them
> verbatim and never validates or enumerates their values.

```
Stack          = { id: uuid, name: string, kind: string, sortOrder: int,
                   createdAt: ISO8601, format: string|null, colors: string[],
                   commander: string|null, commanderCardId: uuid|null,
                   person: string|null, since: ISO8601|null }
CollectionItem = { id: uuid, cardId: uuid, stackId: uuid, quantity: int>=1,
                   finish: string, condition: string, language: string,
                   acquiredAt: ISO8601|null, notes: string|null }
```

### `GET /v1/collection` — my whole collection (restore)
`-> { stacks: Stack[], items: CollectionItem[] }`. Call on launch / after a
fresh install to restore everything. Re-hydrate display data from Scryfall by
`cardId`.

### `PUT /v1/collection` — replace my whole collection
`{ stacks: Stack[], items: CollectionItem[] } -> { ok, stacks:<int>, items:<int>, dispatched }`.
Atomic full replace (delete-all + insert). Use for first import / hard reset.
Validates: UUID ids; `quantity` int≥1; every `item.stackId` is in the `stacks`
payload. Duplicate ids deduped (last wins). `user_id` is from the JWT.

### Incremental — `POST`/`DELETE /v1/collection/items` · `…/stacks`
Day-to-day mutations (add a batch, remove what was sold). `id` is the row key —
**upsert = insert-or-update by id**; the app generates the UUIDs.
```jsonc
POST   /v1/collection/items   { "items":  [ CollectionItem, ... ] } -> { ok, upserted:<int>, dispatched }
DELETE /v1/collection/items   { "ids":    [ uuid, ... ] }           -> { ok, deleted:<int> }
POST   /v1/collection/stacks  { "stacks": [ Stack, ... ] }          -> { ok, upserted:<int> }
DELETE /v1/collection/stacks  { "ids":    [ uuid, ... ] }           -> { ok, deleted:<int> }
```
- Upsert validates UUID ids + `quantity` int≥1 (opaque fields verbatim);
  duplicate ids in one batch dedupe last-wins. Writes only your own rows.
- `POST items` enqueues any new-to-price card and may fire the on-demand ingest
  (`dispatched`).
- `DELETE /stacks` removes the stacks **and their items** (no orphans).

### `GET /v1/prices?source=tcgplayer&window=35`
```jsonc
{ "source": "tcgplayer", "window": 35,
  "cards": [ { "cardId": "...", "source": "tcgplayer", "currency": "USD",
              "current": 12.34, "history": [ { "date": "2026-04-15", "price": 11.90 } ] } ] }
```
Only collection cards **with data** for the source are returned. Cards still
being fetched are simply **absent** — show "fetching" and poll
`GET /v1/prices/status` (there is **no** client-side price fallback). Finishes
merged per day (`etched > foil > normal`). Each `history` point → your
`PriceSnapshot { cardID: cardId, source, date, currency, retail: price }`; feed
`computeHistory` unchanged.

### `GET /v1/prices/status` — fetch state for my cards
```jsonc
{ "pending": ["cardId", ...],   // enqueued, not yet fetched -> still "fetching"
  "noData":  ["cardId", ...],   // fetched, but MTGJSON has no price -> stop fetching
  "updatedAt": "2026-05-21" }   // latest price date across my cards, or null
```
A card with a price is in **neither** list (`/v1/prices` has it). App rule:
an owned card that is not priced and not in `noData` is still pending — keep
showing "fetching" and re-poll.

### `GET /v1/movers?source=tcgplayer&window=35&threshold=1`
```jsonc
{ "source", "currency", "days", "weekDeltaUSD", "weekDeltaPct",
  "monthSparkline": [ ... ], "gainers": [ { "cardId", "deltaUSD", "pct" } ], "losers": [ ... ] }
```
Server mirror of `computeHistory`: per-unit 7-day delta (carry-forward),
`|delta| ≥ threshold` (default `$1`), top-5 gainers/losers. Convenience; the
canonical numbers come from the app running `computeHistory` on `/v1/prices`.

---

## Notes

**ID mapping (critical).** MTGJSON keys cards by its own UUID. The ingest streams
`AllIdentifiers.json.gz` to build a `mtgjsonUuid → scryfallId` map (restricted to
the collection-union), then keys every price by **scryfallId** —
`collection_items.card_id`. `scryfallId` is not unique across multi-faced cards;
those collapse onto the same price row (faces share a price). The ingest
**dedupes by `(card_id, source, finish, date)` before upserting** so the
many-to-one collapse can't put a duplicate conflict key in one statement.

**Free-tier margins.** Prices stored for the **union of all users' collection
cards × 3 sources × ~90 days**. One user ≈ 40–200 MB, under the 500 MB free DB.

**Verified limits (May 2026).** Supabase free: 500 MB DB, ~50k Auth MAU, pauses
after 7 days idle (the daily write prevents this). Vercel Hobby: 300 s / 2 GB
per function, 4.5 MB response cap, daily cron available.

**iOS login flow** is out of scope for the backend but the contract is fixed:
authenticate with Supabase → send `Authorization: Bearer <access token>` → the
API scopes to that user.
