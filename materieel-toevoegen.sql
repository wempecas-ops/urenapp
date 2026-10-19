-- Materieel / kentekens (keuzelijst bij elke klus). Supabase -> SQL Editor -> Run.
create table if not exists public.materieel (
  id text primary key,
  kenteken text not null,
  omschrijving text,
  actief boolean default true,
  created_at timestamptz default now()
);
create unique index if not exists materieel_kenteken_uniek on public.materieel (upper(regexp_replace(kenteken, '[^A-Za-z0-9]', '', 'g')));
alter table public.materieel enable row level security;
drop policy if exists "materieel lezen" on public.materieel;
create policy "materieel lezen" on public.materieel for select to authenticated using (public.is_actief());
drop policy if exists "materieel beheer" on public.materieel;
create policy "materieel beheer" on public.materieel for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
revoke all on public.materieel from anon;
