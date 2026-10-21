-- Opmerkingen van beheer bij klussen (niet zichtbaar voor medewerkers). Supabase -> SQL Editor -> Run.
create table if not exists public.klus_notities (
  id text primary key,            -- = id van de klus
  tekst text not null,
  bijgewerkt_op timestamptz default now(),
  bijgewerkt_door text
);
alter table public.klus_notities enable row level security;
drop policy if exists "klus_notities beheer" on public.klus_notities;
create policy "klus_notities beheer" on public.klus_notities for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
revoke all on public.klus_notities from anon;
