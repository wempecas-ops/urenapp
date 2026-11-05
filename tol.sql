-- Tolposten uit de DKV "E-List of passages" (tabblad Tol). Supabase -> SQL Editor -> Run (eenmalig).
create table if not exists public.tolposten (
  id text primary key,          -- kenteken + tijd oprit
  kenteken text,
  in_op text,
  uit_op text,
  datum date,
  land text,
  route text,
  km numeric,
  lucht numeric,
  bedrag numeric,
  dkv_factuur text,
  created_at timestamptz default now()
);
create index if not exists tolposten_datum on public.tolposten(datum);
alter table public.tolposten enable row level security;
drop policy if exists "tolposten beheer" on public.tolposten;
create policy "tolposten beheer" on public.tolposten for all to authenticated using (public.is_beheer()) with check (public.is_beheer());
