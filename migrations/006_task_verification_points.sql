-- 006: Worker task verification record + points per task, and routing clean-up.
--
-- 1) dump_reports gets who verified a cleanup, when, and the eco-points the worker earned for it
--    (shown in the worker's Work History). Points: 50 base + severity bonus (Low 50, Medium 60,
--    High 75, Critical 100) - computed on the server when an admin approves the proof.
alter table public.dump_reports add column if not exists verified_at   timestamptz;
alter table public.dump_reports add column if not exists verified_by   uuid;
alter table public.dump_reports add column if not exists worker_points integer;
create index if not exists idx_dump_reports_worker_status on public.dump_reports (assigned_worker_id, status);

-- 2) Reports filed before Bengaluru was pre-divided (migration 005) were routed to the nearest of
--    only 4-5 sectors. Re-route every report to its nearest ACTIVE sector centre.
update public.dump_reports r
set sector_id = (
  select s.id from public.sectors s
  where s.active
  order by (s.lat - r.lat)^2 + ((s.lng - r.lng) * cos(radians(r.lat)))^2
  limit 1)
where r.lat is not null and r.lng is not null;

-- 3) Tasks marked "Worker Assigned" / "Cleaning in Progress" with no worker can never progress:
--    put them back in the dispatch queue.
update public.dump_reports
set status = 'Submitted'
where assigned_worker_id is null and status in ('Worker Assigned', 'Cleaning in Progress');
