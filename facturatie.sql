-- Facturatie: producten, facturen, bedrijfsgegevens en doorlopende factuurnummers.
-- Alles alleen voor beheer. Supabase -> SQL Editor -> Run (eenmalig).

-- Btw-nummer bij de klant (nodig bij btw verlegd)
alter table public.klanten add column if not exists btwnummer text;

create table if not exists public.producten (
  id text primary key,
  naam text not null,
  omschrijving text,
  eenheid text default 'stuk',
  prijs numeric default 0,
  btw text default '21',            -- '21', '9', '0' of 'verlegd'
  actief boolean default true,
  created_at timestamptz default now()
);

create table if not exists public.facturen (
  id text primary key,
  nummer text unique,               -- leeg zolang het een concept is
  soort text default 'factuur',     -- 'factuur' of 'credit'
  status text default 'concept',    -- 'concept', 'open', 'betaald', 'gecrediteerd'
  klant_id text,
  klant jsonb,                      -- klantgegevens zoals ze op de factuur staan
  factuurdatum date,
  vervaldatum date,
  regels jsonb default '[]'::jsonb,
  totaal_excl numeric default 0,
  totaal_btw numeric default 0,
  totaal_incl numeric default 0,
  opmerking text,
  klus_ids jsonb default '[]'::jsonb,
  credit_van text,
  betaald_op date,
  verstuurd_op timestamptz,
  pdf_pad text,
  created_at timestamptz default now()
);

create table if not exists public.instellingen (
  id text primary key,
  waarde jsonb
);

create table if not exists public.factuur_teller (
  id int primary key,
  volgend bigint not null
);

-- Een definitieve factuur mag niet meer veranderen (behalve status, betaaldatum en verzenddatum).
create or replace function public.factuur_vergrendeld() returns trigger language plpgsql as $$
begin
  if old.status <> 'concept' then
    if new.nummer is distinct from old.nummer or new.regels is distinct from old.regels
       or new.totaal_incl is distinct from old.totaal_incl or new.klant is distinct from old.klant
       or new.factuurdatum is distinct from old.factuurdatum or new.soort is distinct from old.soort then
      raise exception 'Een definitieve factuur kan niet worden gewijzigd; maak een creditnota';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists factuur_vergrendeld on public.facturen;
create trigger factuur_vergrendeld before update on public.facturen for each row execute function public.factuur_vergrendeld();

create or replace function public.factuur_niet_verwijderen() returns trigger language plpgsql as $$
begin
  if old.status <> 'concept' then raise exception 'Een definitieve factuur kan niet worden verwijderd'; end if;
  return old;
end $$;
drop trigger if exists factuur_niet_verwijderen on public.facturen;
create trigger factuur_niet_verwijderen before delete on public.facturen for each row execute function public.factuur_niet_verwijderen();

-- Volgend factuurnummer: ophalen en ophogen in één stap, zodat er nooit dubbele nummers ontstaan.
create or replace function public.volgend_factuurnummer() returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if not public.is_beheer() then raise exception 'Alleen voor beheer'; end if;
  update public.factuur_teller set volgend = volgend + 1 where id = 1 returning volgend - 1 into n;
  return n;
end $$;
revoke all on function public.volgend_factuurnummer() from public, anon;
grant execute on function public.volgend_factuurnummer() to authenticated;

-- Rechten: alleen beheer
alter table public.producten enable row level security;
alter table public.facturen enable row level security;
alter table public.instellingen enable row level security;
alter table public.factuur_teller enable row level security;
drop policy if exists "producten beheer" on public.producten;
create policy "producten beheer" on public.producten for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
drop policy if exists "facturen beheer" on public.facturen;
create policy "facturen beheer" on public.facturen for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
drop policy if exists "instellingen beheer" on public.instellingen;
create policy "instellingen beheer" on public.instellingen for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
drop policy if exists "factuur_teller beheer" on public.factuur_teller;
create policy "factuur_teller beheer" on public.factuur_teller for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
revoke all on public.producten, public.facturen, public.instellingen, public.factuur_teller from anon;
