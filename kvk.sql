-- KvK-nummer bij de klant (Klanten -> Wijzig / Nieuwe klant, met "Ophalen bij KvK").
-- Supabase -> SQL Editor -> Run (eenmalig).
alter table public.klanten add column if not exists kvk text;
