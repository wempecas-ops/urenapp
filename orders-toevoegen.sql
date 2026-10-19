-- Orders (verzamelorders / tickets), alleen zichtbaar voor beheer. Supabase -> SQL Editor -> Run.
create table if not exists public.orders (
  id text primary key,
  ordernr text,
  titel text not null,
  klant_id text,
  status text default 'Nieuw',
  startdatum date,
  einddatum date,
  omschrijving text,
  notities text,
  regels jsonb default '[]'::jsonb,
  fotos jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);
alter table public.orders enable row level security;
drop policy if exists "orders beheer" on public.orders;
create policy "orders beheer" on public.orders for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
revoke all on public.orders from anon;
