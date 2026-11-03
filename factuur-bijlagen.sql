-- Bijlagen bij facturen (is al uitgevoerd op de database; dit bestand is alleen ter administratie)
alter table public.facturen add column if not exists bijlagen jsonb default '[]'::jsonb;
