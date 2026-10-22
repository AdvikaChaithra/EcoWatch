-- 010: Broadcast dump_reports changes (admin SLA Monitor + worker portal update live).
-- workers is deliberately NOT published: realtime sends whole rows and workers holds pin_hash.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'dump_reports') then
    alter publication supabase_realtime add table public.dump_reports;
  end if;
end $$;
