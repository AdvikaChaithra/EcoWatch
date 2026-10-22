-- 008: Record how a worker's cleanup proof was located.
--   gps         = device GPS at capture time, 50 m geofence checked
--   manual_site = worker chose the dump-site location (demo / no GPS); geofence NOT verified -
--                 shown to the admin on the verification card and stamped on the photo.
alter table public.dump_reports add column if not exists proof_location_source text
  check (proof_location_source is null or proof_location_source in ('gps', 'manual_site'));
