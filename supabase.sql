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
