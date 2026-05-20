# Ugin's Vault — price backend

Personal, multi-user price backend for the **Ugin's Vault** iOS app (a Magic:
The Gathering collection tracker). It ingests MTGJSON prices **server-side** and
serves each user's owned-card prices + history + movers + FX as a **few-KB
JSON**, so the phone downloads kilobytes instead of the ~1.2 GB MTGJSON dump.

The card **catalogue stays on device** (seeded from Scryfall). This backend is
**auth + prices + FX only**.

```
              ┌──────────────────────── GitHub Actions (free) ───────────────────────┐
              │  daily cron: AllPricesToday.json.gz  ─┐                                │
 MTGJSON  ───▶│  manual:     AllPrices.json.gz       ─┤ stream + map uuid→scryfallId  │
              │  AllIdentifiers.json.gz  (uuid map)  ─┘ upsert prices / FX (service)  │
              └───────────────────────────────────────────┬───────────────────────────┘
                                                           ▼
 iOS app  ──(Supabase JWT)──▶  Vercel read API  ──(JWT, RLS)──▶  Supabase Postgres + Auth
   PUT /v1/owned · GET /v1/prices · GET /v1/movers · GET /v1/fx        (free tier)
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
  _lib/                   shared (auth/JWT verify, http, pricing+movers port)
  v1/owned.ts             PUT  /v1/owned
  v1/prices.ts            GET  /v1/prices
  v1/movers.ts            GET  /v1/movers
  v1/fx.ts                GET  /v1/fx
  health.ts               GET  /api/health
ingest/src/               GitHub Actions ingest (TypeScript, streaming)
  daily.ts                AllPricesToday → today's prices + FX + prune
  backfill.ts             AllPrices → seed ~90 days (manual)
  onDemand.ts             drains price_backfill_queue → new cards' prices ASAP
  fxOnly.ts               FX-only refresh
  lib/                    config, db (service role), download, mtgjson stream, fx
supabase/migrations/      0001 schema · 0002 RLS · 0003 auth trigger · 0004 RPC
                          · 0005 on-demand price queue
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
| `owned`    | per-user | `(user_id, card_id)` PK, `quantity`. `card_id` = **Scryfall printing UUID**. RLS: a user sees only their rows |
| `prices`   | global  | `(card_id, source, finish, date)` PK, `retail`, `currency`. Readable by any authenticated user; only the ingest (service role) writes |
| `fx`       | global  | `quote` PK (`ARS`/`EUR`), `rate` (USD→quote), `fetched_at` |
| `price_backfill_queue` | global | `card_id` PK. Cards added but with no price yet, awaiting the on-demand ingest. Written by an `owned`-insert trigger; drained by the ingest. No RLS policy → invisible to clients |

- **Sources:** `cardkingdom`, `tcgplayer`, `cardmarket`. **Finishes:** `normal`,
  `foil`, `etched`.
- Prices are stored **per finish**; the read API **merges** finishes per day
  (`etched > foil > normal`) to match the app's on-device merge. ~90 days kept;
  older pruned daily.
- **Movers are computed on read** from the user's `owned` × global `prices`
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
   | `GH_DISPATCH_TOKEN` | *(optional)* fine-grained PAT, `Actions: read and write` on this repo — lets `PUT /v1/owned` trigger the on-demand ingest |
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

1. Add cards as a user (via the app, or `PUT /v1/owned`) so the owned-union is
   non-empty.
2. Run **Backfill price history** once (Actions tab → *Backfill price history* →
   *Run workflow*). Seeds ~90 days for the owned-union.
3. The **Daily price ingest** runs on cron (`09:00 UTC`) and keeps things fresh.
   It also keeps the Supabase project awake.

### On-demand prices (new cards show ASAP)

So a freshly added card doesn't wait until the next `09:00 UTC` cron:

```
PUT /v1/owned ─▶ replace_owned ─▶ trigger enqueues card_ids with NO price yet
      │                                     (price_backfill_queue)
      └─ if queue non-empty ─▶ GitHub repository_dispatch "new-cards"
                                     │
                                     ▼
                       ingest-on-demand.yml ─▶ onDemand.ts
                         AllPricesToday (current) then AllPrices (history),
                         scoped to the queued ids ─▶ upsert ─▶ clear queue
```

- The `owned`-insert trigger (migration `0005`) only enqueues cards that have
  **no** price rows, so re-saving an unchanged collection enqueues nothing and
  fires no job.
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
npm run ingest:fx          # FX only (cheap smoke test)
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

### `PUT /v1/owned` — replace my owned list
```jsonc
// request
{ "cards": [ { "cardId": "0000abcd-....", "quantity": 2 }, ... ] }
// response
{ "ok": true, "count": 123 }
```
Atomic replace (delete-then-insert in one transaction). `cardId` = Scryfall
printing UUID. Duplicate ids are de-duplicated (last wins).

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
Only owned cards **with data** for the chosen source are returned (the app falls
back to on-device Scryfall prices for the rest). Finishes are merged per day
(`etched > foil > normal`).

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

### `GET /v1/fx`
```jsonc
{ "ars": 1180.0, "eur": 0.92, "fetchedAt": "2026-05-20T09:00:11Z" }
```
Global USD→ARS ("blue", `dolarapi.com.ar`) and USD→EUR (`frankfurter.app`).

---

## Notes

**ID mapping (critical).** MTGJSON keys cards by its own MTGJSON UUID, not the
Scryfall id. The ingest streams `AllIdentifiers.json.gz` to build a
`mtgjsonUuid → scryfallId` map (restricted to the owned-union via
`identifiers.scryfallId`), then keys/serves every price by **scryfallId** —
which is what `owned.card_id` holds. `scryfallId` is not unique across
multi-faced cards (several MTGJSON uuids share one); those collapse onto the same
price row, which is correct (faces share a price).

**Free-tier margins.** Prices are stored for the **union of all users' owned
cards × 3 sources × ~90 days**. One user ≈ 40–200 MB, comfortably under the
500 MB free DB. Watch this at scale: if the owned-union approaches the full
~90k-card universe it would be ~3.6 GB → either Supabase Pro or keep ingest
scoped to the owned-union (the default here). App egress + Vercel bandwidth are
tiny per user.

**Verified limits (May 2026).** Supabase free: 500 MB DB, ~50k Auth MAU, pauses
after 7 days idle (the daily write prevents this). Vercel Hobby: 300 s / 2 GB
per function, 4.5 MB response cap (responses here are KB), daily cron available.

**iOS login flow** is out of scope for the backend but the contract is fixed:
authenticate with Supabase → send `Authorization: Bearer <access token>` → the
API scopes to that user. Add the login UI to the app separately.
