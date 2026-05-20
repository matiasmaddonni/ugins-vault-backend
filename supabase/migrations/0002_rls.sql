-- ───────────────────────────────────────────────────────────────────────────
-- 0002_rls.sql — Row-Level Security
--
-- Model:
--   profiles, owned  -> per-user. A user reads/writes ONLY their own rows.
--   prices, fx       -> GLOBAL. Any authenticated user reads; nobody but the
--                       service_role writes (service_role has BYPASSRLS, so it
--                       needs no policy — the absence of a write policy blocks
--                       every other role).
--
-- auth.uid() returns the `sub` claim of the caller's JWT. Wrapping it in a
-- scalar subquery `(select auth.uid())` lets Postgres cache it per statement.
-- ───────────────────────────────────────────────────────────────────────────

-- Explicit grants (belt-and-suspenders; Supabase also grants via default privs).
-- Everything here requires a logged-in user, so we grant to `authenticated` only.
grant usage on schema public to authenticated;
grant select, insert, update          on public.profiles to authenticated;
grant select, insert, update, delete  on public.owned    to authenticated;
grant select                          on public.prices   to authenticated;
grant select                          on public.fx       to authenticated;

-- ── profiles ────────────────────────────────────────────────────────────────
alter table public.profiles enable row level security;

create policy profiles_select on public.profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy profiles_update on public.profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── owned ────────────────────────────────────────────────────────────────────
alter table public.owned enable row level security;

create policy owned_select on public.owned
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy owned_insert on public.owned
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy owned_update on public.owned
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy owned_delete on public.owned
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- ── prices (global read-only to clients) ─────────────────────────────────────
alter table public.prices enable row level security;

create policy prices_read on public.prices
  for select to authenticated
  using (true);
-- No insert/update/delete policy: only service_role (BYPASSRLS) writes.

-- ── fx (global read-only to clients) ─────────────────────────────────────────
alter table public.fx enable row level security;

create policy fx_read on public.fx
  for select to authenticated
  using (true);
-- No write policy: only service_role writes.
