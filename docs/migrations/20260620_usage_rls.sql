-- Apply this once to deployments that were initialized before usage RLS was added.
alter table public.usage enable row level security;

drop policy if exists "own usage" on public.usage;
create policy "own usage" on public.usage
  for select using (auth.uid() = user_id);
