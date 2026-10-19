-- ============================================================================
-- UrenApp — Supabase setup (schone start)
-- ============================================================================
-- Uitvoeren: Supabase -> SQL Editor -> New query -> plak dit hele bestand -> Run.
-- Het script is veilig om nog eens te draaien (CREATE ... IF NOT EXISTS en
-- DROP POLICY IF EXISTS), maar het past GEEN bestaande tabellen aan. Staan er
-- al tabellen met dezelfde naam uit een eerdere poging, verwijder die dan eerst
-- (alleen als er geen data in staat die je wilt houden).
--
-- Rechten in het kort:
--   beheerder  : alles lezen en schrijven
--   medewerker : alleen eigen dagstaten lezen en indienen; eigen dagstaten
--                wijzigen zolang de status niet "verwerkt" is. Een wijziging
--                zet de status altijd terug op "in_afwachting".
--                Verwijderen kan alleen een beheerder.
-- ============================================================================

-- ---------- tabellen ----------

create table if not exists werknemers (
  id         text primary key,
  naam       text not null,
  pers_nr    text,
  functie    text,
  email      text,
  telefoon   text,
  actief     boolean default true,
  created_at timestamptz default now()
);

create table if not exists klanten (
  id         text primary key,
  naam       text not null,
  adres      text,
  postcode   text,
  plaats     text,
  contact    text,
  email      text,
  telefoon   text,
  actief     boolean default true,
  created_at timestamptz default now()
);
create index if not exists idx_klanten_naam   on klanten (lower(naam));
create index if not exists idx_klanten_plaats on klanten (lower(plaats));

create table if not exists diensten (
  id          text primary key,
  naam        text not null,
  omschrijving text,
  tarief      numeric default 35,
  eenheid     text default 'uur',
  actief      boolean default true,
  created_at  timestamptz default now()
);

-- De klussen van een dag zitten als lijst (jsonb) in de dagstaat zelf; zo werkt
-- de app nu ook.
create table if not exists dagstaten (
  id              text primary key,
  medewerker_id   text references werknemers(id),
  medewerker_naam text,
  datum           date not null,
  start_time      text,
  end_time        text,
  pauze_min       integer default 0,
  netto_uren      numeric,
  status          text default 'in_afwachting'
                  check (status in ('in_afwachting','goedgekeurd','verwerkt')),
  klussen         jsonb not null default '[]'::jsonb,
  created_at      timestamptz default now()
);
create index if not exists idx_dagstaten_medewerker_datum on dagstaten (medewerker_id, datum);
create index if not exists idx_dagstaten_status           on dagstaten (status);

-- Koppelt een inlogaccount (Supabase Auth) aan een rol en een werknemer.
-- Wordt gevuld door de beheerder via het tabblad "Accounts" in de app.
create table if not exists profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  gebruikersnaam text unique not null,
  naam           text,
  rol            text not null default 'medewerker' check (rol in ('beheer','medewerker')),
  werknemer_id   text references werknemers(id) on delete set null,
  actief         boolean not null default true,
  created_at     timestamptz default now()
);

-- ---------- hulpfuncties voor de beveiligingsregels ----------
-- security definer: ze mogen profiles lezen zonder dat de regels zichzelf
-- aanroepen (anders loopt het vast in een lus).

create or replace function public.is_actief() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.id = auth.uid() and p.actief is not false);
$$;

create or replace function public.is_beheer() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p
                 where p.id = auth.uid() and p.rol = 'beheer' and p.actief is not false);
$$;

create or replace function public.mijn_werknemer_id() returns text
language sql stable security definer set search_path = public as $$
  select p.werknemer_id from profiles p where p.id = auth.uid() and p.actief is not false;
$$;

-- ---------- beveiliging (Row Level Security) ----------

alter table werknemers enable row level security;
alter table klanten    enable row level security;
alter table diensten   enable row level security;
alter table dagstaten  enable row level security;
alter table profiles   enable row level security;

-- profiles: iedereen leest alleen zijn eigen profiel, beheerder leest alles.
-- Schrijven kan alleen via de serverfunctie (/api/admin-users), niet vanuit de browser.
drop policy if exists "profiles lezen" on profiles;
create policy "profiles lezen" on profiles
  for select to authenticated
  using (id = auth.uid() or public.is_beheer());

-- werknemers: medewerker ziet alleen zichzelf, beheerder ziet en wijzigt iedereen.
drop policy if exists "werknemers lezen" on werknemers;
create policy "werknemers lezen" on werknemers
  for select to authenticated
  using (public.is_beheer() or id = public.mijn_werknemer_id());

drop policy if exists "werknemers beheer" on werknemers;
create policy "werknemers beheer" on werknemers
  for all to authenticated
  using (public.is_beheer()) with check (public.is_beheer());

-- klanten: alle actieve accounts mogen lezen (nodig om een klant te kiezen), alleen beheer wijzigt.
drop policy if exists "klanten lezen" on klanten;
create policy "klanten lezen" on klanten
  for select to authenticated using (public.is_actief());

drop policy if exists "klanten beheer" on klanten;
create policy "klanten beheer" on klanten
  for all to authenticated
  using (public.is_beheer()) with check (public.is_beheer());

-- diensten: idem. NB: medewerkers kunnen hiermee ook de tarieven in de database zien.
drop policy if exists "diensten lezen" on diensten;
create policy "diensten lezen" on diensten
  for select to authenticated using (public.is_actief());

drop policy if exists "diensten beheer" on diensten;
create policy "diensten beheer" on diensten
  for all to authenticated
  using (public.is_beheer()) with check (public.is_beheer());

-- dagstaten
drop policy if exists "dagstaten lezen" on dagstaten;
create policy "dagstaten lezen" on dagstaten
  for select to authenticated
  using (public.is_beheer() or medewerker_id = public.mijn_werknemer_id());

drop policy if exists "dagstaten indienen" on dagstaten;
create policy "dagstaten indienen" on dagstaten
  for insert to authenticated
  with check (
    public.is_beheer()
    or (medewerker_id = public.mijn_werknemer_id() and status = 'in_afwachting')
  );

-- Wijzigen: een medewerker mag zijn eigen dagstaat aanpassen zolang die nog niet
-- "verwerkt" is, en de dagstaat moet daarna weer "in_afwachting" zijn.
drop policy if exists "dagstaten wijzigen" on dagstaten;
create policy "dagstaten wijzigen" on dagstaten
  for update to authenticated
  using (
    public.is_beheer()
    or (medewerker_id = public.mijn_werknemer_id() and status in ('in_afwachting','goedgekeurd'))
  )
  with check (
    public.is_beheer()
    or (medewerker_id = public.mijn_werknemer_id() and status = 'in_afwachting')
  );

drop policy if exists "dagstaten verwijderen" on dagstaten;
create policy "dagstaten verwijderen" on dagstaten
  for delete to authenticated
  using (public.is_beheer());

-- Niet-ingelogde bezoekers (rol "anon") krijgen nergens toegang toe.
revoke all on werknemers, klanten, diensten, dagstaten, profiles from anon;

-- ============================================================================
-- EERSTE BEHEERDER AANMAKEN (eenmalig)
-- ============================================================================
-- 1. Supabase -> Authentication -> Users -> "Add user" -> "Create new user"
--    E-mail:     beheer@urenapp.local   (of je eigen domein, zie STAPPENPLAN.md)
--    Wachtwoord: kies een sterk wachtwoord
--    Vink "Auto Confirm User" aan.
-- 2. Voer daarna dit uit (pas gebruikersnaam en naam aan als je wilt):
--
-- insert into profiles (id, gebruikersnaam, naam, rol, werknemer_id, actief)
-- select id, 'beheer', 'Beheerder', 'beheer', null, true
-- from auth.users where email = 'beheer@urenapp.local';
--
-- Daarna log je in de app in met gebruikersnaam "beheer" en dat wachtwoord, en
-- maak je de accounts van je personeel aan via het tabblad "Accounts".
-- ============================================================================
