-- ============================================================================
-- Wempe op Pad - update: tarieven alleen voor beheer, foto's, automatische back-up
-- ============================================================================
-- Uitvoeren: Supabase -> SQL Editor -> New query -> plak alles -> Run.
-- Veilig om nog eens te draaien.

-- 1. TARIEVEN: alleen de beheerder mag ze zien -------------------------------
create table if not exists public.diensten_tarief (
  dienst_id text primary key references public.diensten(id) on delete cascade,
  tarief numeric not null default 35
);
alter table public.diensten_tarief enable row level security;
drop policy if exists "tarief beheer" on public.diensten_tarief;
create policy "tarief beheer" on public.diensten_tarief
  for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
revoke all on public.diensten_tarief from anon;

-- bestaande tarieven overnemen en uit de open tabel halen
insert into public.diensten_tarief (dienst_id, tarief)
  select id, coalesce(tarief, 35) from public.diensten
  on conflict (dienst_id) do nothing;
alter table public.diensten alter column tarief drop default;
update public.diensten set tarief = null;

-- 2. FOTO'S: besloten bucket "bijlagen" ------------------------------------
insert into storage.buckets (id, name, public) values ('bijlagen', 'bijlagen', false)
  on conflict (id) do nothing;

drop policy if exists "bijlagen lezen" on storage.objects;
create policy "bijlagen lezen" on storage.objects for select to authenticated
  using (bucket_id = 'bijlagen' and (public.is_beheer() or (storage.foldername(name))[1] = public.mijn_werknemer_id()));

drop policy if exists "bijlagen uploaden" on storage.objects;
create policy "bijlagen uploaden" on storage.objects for insert to authenticated
  with check (bucket_id = 'bijlagen' and public.is_actief()
              and (public.is_beheer() or (storage.foldername(name))[1] = public.mijn_werknemer_id()));

drop policy if exists "bijlagen verwijderen" on storage.objects;
create policy "bijlagen verwijderen" on storage.objects for delete to authenticated
  using (bucket_id = 'bijlagen' and public.is_beheer());

-- 3. BACK-UPS: besloten bucket "backups" (zonder regels: alleen de server erbij) ---
insert into storage.buckets (id, name, public) values ('backups', 'backups', false)
  on conflict (id) do nothing;
