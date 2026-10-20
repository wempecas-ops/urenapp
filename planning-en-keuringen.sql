-- Planning-archief en keuringen/vervaldata, alleen voor beheer. Supabase -> SQL Editor -> Run.
create table if not exists public.planningen (
  id text primary key,
  datum date,
  medewerker_id text,
  medewerker_naam text,
  tekst text not null,
  soort text default 'versturen',
  verstuurd_op timestamptz default now(),
  verstuurd_door text
);
alter table public.planningen enable row level security;
drop policy if exists "planningen beheer" on public.planningen;
create policy "planningen beheer" on public.planningen for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
revoke all on public.planningen from anon;

create table if not exists public.vervaldata (
  id text primary key,
  type text not null,
  ref_id text not null,
  soort text not null,
  omschrijving text,
  vervaldatum date not null,
  opmerking text,
  created_at timestamptz default now()
);
alter table public.vervaldata enable row level security;
drop policy if exists "vervaldata beheer" on public.vervaldata;
create policy "vervaldata beheer" on public.vervaldata for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
revoke all on public.vervaldata from anon;
