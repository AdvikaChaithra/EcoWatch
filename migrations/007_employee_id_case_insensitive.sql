-- 007: Employee IDs are case-insensitive. Stored in capitals; one ID per worker regardless of case.
update public.workers set employee_id = upper(employee_id) where employee_id <> upper(employee_id);
create unique index if not exists uq_workers_employee_id_upper on public.workers (upper(employee_id));
