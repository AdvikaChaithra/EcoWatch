-- 009: Store the rupee bonus credited for each verified cleanup (shown in the worker's Work History).
alter table public.dump_reports add column if not exists worker_bonus numeric(10,2);
