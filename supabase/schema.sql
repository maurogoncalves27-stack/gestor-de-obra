-- Gestor de Obra — dados por usuário (JSON completo da obra)
-- Execute no SQL Editor do Supabase

create table if not exists public.obra_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists obra_data_updated_at_idx on public.obra_data (updated_at desc);

alter table public.obra_data enable row level security;

drop policy if exists "obra_data_select_own" on public.obra_data;
drop policy if exists "obra_data_insert_own" on public.obra_data;
drop policy if exists "obra_data_update_own" on public.obra_data;

create policy "obra_data_select_own"
  on public.obra_data for select
  using (auth.uid() = user_id);

create policy "obra_data_insert_own"
  on public.obra_data for insert
  with check (auth.uid() = user_id);

create policy "obra_data_update_own"
  on public.obra_data for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
