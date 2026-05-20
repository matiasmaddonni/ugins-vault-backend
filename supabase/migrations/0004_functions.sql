-- ───────────────────────────────────────────────────────────────────────────
-- 0004_functions.sql — read-side RPC
--
-- owned_prices(): the join the read API needs — every price row, within a
-- window, for the cards the CALLING user owns. SECURITY INVOKER means RLS still
-- applies and auth.uid() resolves to the caller's JWT, so a user can only ever
-- pull prices for their own owned cards. One round-trip, no giant `IN (...)`
-- URL from the client. The Vercel API does the finish-merge + movers math in TS
-- (so it stays byte-for-byte aligned with the iOS computeHistory).
-- ───────────────────────────────────────────────────────────────────────────

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
  select p.card_id, o.quantity, p.finish, p.date, p.retail, p.currency
  from public.prices p
  join public.owned  o
    on o.card_id = p.card_id
  where o.user_id = (select auth.uid())
    and p.source  = p_source
    and p.date   >= p_since
$$;

grant execute on function public.owned_prices(text, date) to authenticated;

-- replace_owned(): atomic "replace MY whole owned list" for PUT /v1/owned.
-- One function body == one transaction, so there is never a window where the
-- list is empty. SECURITY INVOKER keeps RLS in force and pins every row to the
-- caller via auth.uid(); a client can never write another user's rows.
create or replace function public.replace_owned(p_cards jsonb)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
  n   int;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  delete from public.owned where user_id = uid;

  insert into public.owned (user_id, card_id, quantity, updated_at)
  select uid,
         (elem ->> 'cardId')::uuid,
         greatest(1, coalesce((elem ->> 'quantity')::int, 1)),
         now()
  from jsonb_array_elements(coalesce(p_cards, '[]'::jsonb)) as elem
  on conflict (user_id, card_id)
    do update set quantity = excluded.quantity, updated_at = now();

  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function public.replace_owned(jsonb) to authenticated;
