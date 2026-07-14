-- Rode no SQL Editor do Supabase (uma vez).
-- Cria a tabela de sincronização do app Estoque & Cotação.

create table if not exists public.app_state (
  id text primary key default 'main',
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_state (id, payload)
values ('main', '{}'::jsonb)
on conflict (id) do nothing;

alter table public.app_state enable row level security;

-- Acesso aberto via anon key (app interno com senha própria).
-- Se quiser restringir depois, troque por auth.users do Supabase.
drop policy if exists "app_state_select" on public.app_state;
drop policy if exists "app_state_insert" on public.app_state;
drop policy if exists "app_state_update" on public.app_state;

create policy "app_state_select" on public.app_state
  for select to anon, authenticated using (true);

create policy "app_state_insert" on public.app_state
  for insert to anon, authenticated with check (true);

create policy "app_state_update" on public.app_state
  for update to anon, authenticated using (true) with check (true);

-- Realtime
alter publication supabase_realtime add table public.app_state;
