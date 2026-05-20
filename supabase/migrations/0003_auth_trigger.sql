-- ───────────────────────────────────────────────────────────────────────────
-- 0003_auth_trigger.sql — auto-create a profile row on signup
--
-- Supabase Auth manages auth.users. We mirror a public.profiles row on insert
-- so the rest of the app always has a profile to scope against. SECURITY
-- DEFINER + empty search_path is the Supabase-recommended hardening for
-- triggers that write into public from the auth schema.
-- ───────────────────────────────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'display_name',
      nullif(split_part(coalesce(new.email, ''), '@', 1), '')
    )
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
