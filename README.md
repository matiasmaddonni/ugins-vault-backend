# Ugin's Vault — price backend

Personal, multi-user price backend for the **Ugin's Vault** iOS app (a Magic:
The Gathering collection tracker). It ingests MTGJSON prices **server-side** and
serves each user's owned-card prices + history + movers as a **few-KB JSON**, so
the phone downloads kilobytes instead of the ~1.2 GB MTGJSON dump.

The **collection lives on the backend** (source of truth): the full collection —
every card in its stack — is read back via `GET /v1/collection`, so a fresh
install restores everything and it syncs across devices. The backend is a **thin
id + ownership store**: it keeps **zero card metadata** (the app re-hydrates
names/art/sets from Scryfall by id) and treats every enum-ish field as an
**opaque string** it round-trips verbatim. This backend is **auth + prices only**.

```
              ┌──────────────────────── GitHub Actions (free) ───────────────────────┐
              │  daily cron: AllPricesToday.json.gz  ─┐                                │
 MTGJSON  ───▶│  manual:     AllPrices.json.gz       ─┤ stream + map uuid→scryfallId  │
              │  AllIdentifiers.json.gz  (uuid map)  ─┘ upsert prices (service)        │
              └───────────────────────────────────────────┬───────────────────────────┘
                                                           ▼
 iOS app  ──(Supabase JWT)──▶  Vercel read API  ──(JWT, RLS)──▶  Supabase Postgres + Auth
   GET/PUT /v1/collection · GET /v1/prices · GET /v1/movers        (free tier)
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
api/                      Vercel serverless functions (TypeScript)
  _lib/                   shared (auth/JWT verify, http, pricing+movers port, dispatch)
  v1/collection.ts        GET + PUT  /v1/collection
  v1/prices.ts            GET  /v1/prices
  v1/movers.ts            GET  /v1/movers
  health.ts               GET  /api/health
ingest/src/               GitHub Actions ingest (TypeScript, streaming)
  daily.ts                AllPricesToday → today's prices + prune
  backfill.ts             AllPrices → seed ~90 days (manual)
  onDemand.ts             drains price_backfill_queue → new cards' prices ASAP
  lib/                    config, db (service role), download, mtgjson stream
supabase/migrations/      0001 schema · 0002 RLS · 0003 auth trigger · 0004 RPC
                          · 0005 on-demand price queue · 0006 drop fx
                          · 0007 collection store · 0008 drop owned
.github/workflows/        ingest-daily.yml (cron) · backfill.yml (manual)
                          · ingest-on-demand.yml (repository_dispatch)
vercel.json               rewrites /v1/* → /api/v1/*
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
| `price_backfill_queue` | global | `card_id` PK. Cards added but with no price yet, awaiting the on-demand ingest. Written by a `collection_items`-insert trigger; drained by the ingest. No RLS policy → invisible to clients |

- **Sources:** `cardkingdom`, `tcgplayer`, `cardmarket`. **Finishes (prices):**
  `normal`, `foil`, `etched` (MTGJSON's, distinct from the opaque item `finish`).
- Prices are stored **per finish**; the read API **merges** finishes per day
  (`etched > foil > normal`) to match the app's on-device merge. ~90 days kept;
  older pruned daily.
- **`owned_prices()` RPC** scopes `prices` to the caller's collection, summing
  `quantity` per `card_id` across their items. `/v1/prices` + `/v1/movers` read it.
- **Movers are computed on read** from the user's collection × global `prices`
  (few users today). A per-user precompute can be added later if needed.

---

## Setup

### 1. Supabase

1. Create a free project at [supabase.com](https://supabase.com). Note the
   **Project URL** and, under **Settings → API keys**, the **publishable/anon**
   key and the **secret/service-role** key.
2. **Run the migrations** in order (SQL Editor, paste each file, or use the
   Supabase CLI — see below):
   - `supabase/migrations/0001_schema.sql`
   - `supabase/migrations/0002_rls.sql`
   - `supabase/migrations/0003_auth_trigger.sql`
   - `supabase/migrations/0004_functions.sql`
   - `supabase/migrations/0005_price_queue.sql`
   - `supabase/migrations/0006_drop_fx.sql`
   - `supabase/migrations/0007_collection.sql`
   - `supabase/migrations/0008_drop_owned.sql`  *(run after 0007)*
3. **Auth config** (Authentication → Providers / Sign In):
   - Enable **Email** (password) and, for passwordless, **Magic Link**. These are
     sensible defaults for a personal app; add an OAuth provider later if wanted.
   - For local/dev simplicity you may turn **off** "Confirm email" so the first
     user can sign in immediately. Turn it back on for anything public.
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
   | `GH_DISPATCH_TOKEN` | *(optional)* fine-grained PAT, `Actions: read and write` on this repo — lets `PUT /v1/collection` trigger the on-demand ingest |
   | `GH_REPO` | *(optional)* `owner/name` of this repo |

   > Do **not** put the service-role key in Vercel. The API only ever verifies
   > JWTs and queries under the caller's RLS. `GH_DISPATCH_TOKEN` is a separate,
   > narrowly scoped GitHub token (not the service-role key); if it's unset the
   > API simply skips the dispatch and prices arrive via the daily cron.
3. Deploy. Public routes are `/v1/...` (rewritten to `/api/v1/...`). Smoke test:
   `curl https://<your-app>.vercel.app/api/health`.

### 3. Configure ingest (GitHub Actions)

In the GitHub repo → **Settings → Secrets and variables → Actions**:

- **Secrets:**
  - `SUPABASE_URL` — `https://<ref>.supabase.co`
  - `SUPABASE_SERVICE_ROLE_KEY` — the **secret / service-role** key (bypasses RLS)
- **Variables (optional):**
  - `PRICE_SOURCES` — e.g. `cardkingdom,tcgplayer,cardmarket` (default if unset)

Then:

1. Add cards as a user (via the app, or `PUT /v1/collection`) so the
   collection-union is non-empty.
2. Run **Backfill price history** once (Actions tab → *Backfill price history* →
   *Run workflow*). Seeds ~90 days for the collection-union.
3. The **Daily price ingest** runs on cron (`09:00 UTC`) and keeps things fresh.
   It also keeps the Supabase project awake.

### On-demand prices (new cards show ASAP)

So a freshly added card doesn't wait until the next `09:00 UTC` cron:

```
PUT /v1/collection ─▶ replace_collection ─▶ trigger enqueues card_ids with NO price yet
      │                                            (price_backfill_queue)
      └─ if queue non-empty ─▶ GitHub repository_dispatch "new-cards"
                                     │
                                     ▼
                       ingest-on-demand.yml ─▶ onDemand.ts
                         AllPricesToday (current) then AllPrices (history),
                         scoped to the queued ids ─▶ upsert ─▶ clear queue
```

- The `collection_items`-insert trigger (migration `0007`, reusing the
  `enqueue_missing_price` fn from `0005`) only enqueues cards that have **no**
  price rows, so re-saving an unchanged collection enqueues nothing and fires no
  job. Items sharing a card_id collapse to one queue row (`ON CONFLICT`).
- Cards MTGJSON has no paper price for (tokens, art cards) can't get a price
  row, so they'd otherwise re-enqueue on every save. The ingest stamps them
  with a **7-day cooldown** instead of deleting them, and the dispatch check
  ignores cooled-down rows — so they're retried at most weekly, not per save.
- One `PUT` ⇒ at most one dispatch. The on-demand workflow shares the `ingest`
  concurrency group with daily/backfill, so the three never write at once and a
  burst of dispatches collapses (each run drains the whole queue; later runs
  find it empty).
- **Latency is minutes, not seconds, by design.** MTGJSON has no per-card API —
  the job still streams the dumps (just filtered to the new ids). The dispatch
  fires within seconds; runner spin-up + streaming `AllPricesToday` is what
  gates the first price. History (`AllPrices`, ~135 MB gz) follows in the same
  run.
- **Setup:** create a fine-grained PAT (`Actions: read and write` on this repo),
  set it as `GH_DISPATCH_TOKEN` + `GH_REPO` on Vercel (above). Without them the
  trigger is skipped and the daily cron remains the backstop. The queue table
  needs no extra GitHub config on the Supabase side — the dispatch comes from
  the Vercel API.

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
and operate on the authenticated user. HTTPS only. JSON in/out.

The app authenticates with Supabase (via `supabase-swift` or the Auth REST
endpoint), then sends the resulting access token as the bearer. The API verifies
it (`getClaims`, ES256 local verify) and derives `user_id` from the `sub` claim;
RLS scopes every query.

> **Opaque fields.** Except `cardId`/`stackId`/`commanderCardId` (UUIDs) every
> field below — `kind`, `finish`, `condition`, `format`, `colors`, `language`,
> etc. — is an **opaque string the app owns**. The backend stores and returns
> them verbatim and never validates or enumerates their values.

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
```jsonc
{
  "stacks": [
    {
      "id": "1111....", "name": "Commander — Atraxa", "kind": "deck",
      "sortOrder": 0, "createdAt": "2026-05-21T15:00:00+00:00",
      "format": "commander", "colors": ["W", "U", "B", "G"],
      "commander": "Atraxa, Praetors' Voice", "commanderCardId": "abcd....",
      "person": null, "since": null
    }
  ],
  "items": [
    {
      "id": "2222....", "cardId": "0000abcd....", "stackId": "1111....",
      "quantity": 1, "finish": "nonfoil", "condition": "NM", "language": "en",
      "acquiredAt": null, "notes": null
    }
  ]
}
```
The authoritative collection — a fresh install restores every card in its stack
from here. The app re-hydrates display data (name/art/set/printings) from
Scryfall by `cardId`.

### `PUT /v1/collection` — replace my whole collection
```jsonc
// request
{ "stacks": [ Stack, ... ], "items": [ CollectionItem, ... ] }
// response
{ "ok": true, "stacks": 3, "items": 142, "dispatched": true }
```
Atomic replace (delete-all + insert in one transaction). Validates: every `id`,
`cardId`, `stackId` is a UUID; `quantity` is an int ≥ 1; every `item.stackId`
appears in the `stacks` payload. Duplicate ids are de-duplicated (last wins).
`user_id` always comes from the JWT — any `user_id` in the payload is ignored.
`stacks`/`items` echo the inserted row counts. `dispatched` is `true` when this
save enqueued at least one new-to-price card and the on-demand ingest was
triggered (see *On-demand prices*); `false` otherwise.

### `GET /v1/prices?window=35&source=tcgplayer`
```jsonc
{
  "source": "tcgplayer",
  "window": 35,
  "cards": [
    {
      "cardId": "0000abcd-....",
      "source": "tcgplayer",
      "currency": "USD",
      "current": 12.34,
      "history": [ { "date": "2026-04-15", "price": 11.90 }, ... ]   // ascending
    }
  ]
}
```
Only collection cards **with data** for the chosen source are returned (the app
falls back to on-device Scryfall prices for the rest). Finishes are merged per
day (`etched > foil > normal`).

**Maps to the app's `PriceSnapshot`** — each `history` point becomes
`PriceSnapshot { cardID: cardId, source, date, currency, retail: price }`, and
`current` is the latest. Feed these into the existing `PriceCatalogueSource`
(add an `APIPriceCatalogueSource`); `RealDashboardRepository.computeHistory`
then runs unchanged on device.

> Pass `source=<the user's preferred source>` so numbers match the app, which
> computes on a single preferred source. Default is `tcgplayer` (USD).

### `GET /v1/movers?source=tcgplayer&window=35&threshold=1`
```jsonc
{
  "source": "tcgplayer",
  "currency": "USD",
  "days": 31,
  "weekDeltaUSD": 4.50,
  "weekDeltaPct": 1.8,
  "monthSparkline": [ 240.10, 241.00, ... ],   // portfolio value per sampled day (≤24)
  "gainers": [ { "cardId": "...", "deltaUSD": 3.20, "pct": 12.5 }, ... ],  // top 5
  "losers":  [ { "cardId": "...", "deltaUSD": -2.10, "pct": -8.0 }, ... ]  // top 5
}
```
Server-side mirror of `computeHistory`: per-unit 7-day delta (carry-forward last
known price ≤ target day), `|delta| ≥ threshold` (default `$1`), gainers by `pct`
desc / losers by `pct` asc. `cardId` is the Scryfall id — resolve name/setCode
from the on-device catalogue. (`weekDeltaUSD` keeps the app's field name even
when the source currency is EUR.)

This endpoint is a convenience; the canonical dashboard numbers come from the app
running `computeHistory` locally on `/v1/prices`. They agree for cards the
backend has data for; the app additionally has Scryfall fallback prices the
backend does not.

---

## Notes

**ID mapping (critical).** MTGJSON keys cards by its own MTGJSON UUID, not the
Scryfall id. The ingest streams `AllIdentifiers.json.gz` to build a
`mtgjsonUuid → scryfallId` map (restricted to the collection-union via
`identifiers.scryfallId`), then keys/serves every price by **scryfallId** —
which is what `collection_items.card_id` holds. `scryfallId` is not unique across
multi-faced cards (several MTGJSON uuids share one); those collapse onto the same
price row, which is correct (faces share a price). The ingest **dedupes by
`(card_id, source, finish, date)` before upserting** so the many-to-one collapse
can't put a duplicate conflict key in one statement (Postgres `ON CONFLICT` can't
touch the same row twice).

**Free-tier margins.** Prices are stored for the **union of all users' collection
cards × 3 sources × ~90 days**. One user ≈ 40–200 MB, comfortably under the
500 MB free DB. Watch this at scale: if the collection-union approaches the full
~90k-card universe it would be ~3.6 GB → either Supabase Pro or keep ingest
scoped to the collection-union (the default here). App egress + Vercel bandwidth
are tiny per user.

**Verified limits (May 2026).** Supabase free: 500 MB DB, ~50k Auth MAU, pauses
after 7 days idle (the daily write prevents this). Vercel Hobby: 300 s / 2 GB
per function, 4.5 MB response cap (responses here are KB), daily cron available.

**iOS login flow** is out of scope for the backend but the contract is fixed:
authenticate with Supabase → send `Authorization: Bearer <access token>` → the
API scopes to that user. Add the login UI to the app separately.
