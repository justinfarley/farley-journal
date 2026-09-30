-- Run this in Supabase SQL Editor.
create table if not exists public.journal_data (
  user_id uuid primary key references auth.users(id) on delete cascade,
  trades jsonb not null default '[]'::jsonb,
  accounts jsonb not null default '[]'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.journal_data
  add column if not exists accounts jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';

alter table public.journal_data enable row level security;

drop policy if exists "Users can read their own journal" on public.journal_data;
drop policy if exists "Users can insert their own journal" on public.journal_data;
drop policy if exists "Users can update their own journal" on public.journal_data;
drop policy if exists "Users can delete their own journal" on public.journal_data;

create policy "Users can read their own journal"
  on public.journal_data for select
  using (auth.uid() = user_id);

create policy "Users can insert their own journal"
  on public.journal_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own journal"
  on public.journal_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own journal"
  on public.journal_data for delete
  using (auth.uid() = user_id);

-- Automatically set the authenticated user's ID on inserts/upserts.
create or replace function public.set_journal_user_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_journal_user_id on public.journal_data;
create trigger set_journal_user_id
before insert or update on public.journal_data
for each row execute function public.set_journal_user_id();

-- Web Push subscriptions are per device; one account can register several devices.
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
drop policy if exists "Users manage their own push subscriptions" on public.push_subscriptions;
create policy "Users manage their own push subscriptions"
  on public.push_subscriptions for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
grant select, insert, update, delete on public.push_subscriptions to authenticated;

create table if not exists public.scheduled_alerts (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  title text not null check (char_length(title) between 1 and 100),
  starts_at timestamptz not null,
  time_zone text not null,
  repeat_type text not null check (repeat_type in ('once', 'daily', 'weekdays', 'weekly')),
  next_fire_at timestamptz,
  claim_until timestamptz,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists scheduled_alerts_due_idx
  on public.scheduled_alerts (next_fire_at)
  where next_fire_at is not null;

alter table public.scheduled_alerts enable row level security;
drop policy if exists "Users manage their own scheduled alerts" on public.scheduled_alerts;
create policy "Users manage their own scheduled alerts"
  on public.scheduled_alerts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
grant select, insert, update, delete on public.scheduled_alerts to authenticated;

create or replace function public.claim_due_push_alerts()
returns setof public.scheduled_alerts
language sql
security definer
set search_path = public
as $$
  with due as (
    select user_id, id
    from public.scheduled_alerts
    where next_fire_at <= now()
      and (claim_until is null or claim_until < now())
    order by next_fire_at
    limit 100
    for update skip locked
  )
  update public.scheduled_alerts as alert
  set claim_until = now() + interval '2 minutes'
  from due
  where alert.user_id = due.user_id and alert.id = due.id
  returning alert.*;
$$;

revoke all on function public.claim_due_push_alerts() from public, anon, authenticated;
grant execute on function public.claim_due_push_alerts() to service_role;
