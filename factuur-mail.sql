-- Facturen mailen: verzendgeschiedenis per factuur. Supabase -> SQL Editor -> Run (eenmalig).
alter table public.facturen add column if not exists verzendingen jsonb default '[]'::jsonb;
