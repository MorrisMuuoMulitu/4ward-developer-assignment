create table if not exists public.city_group_members (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  city text not null,
  country text not null,
  interests jsonb,
  event_id text not null unique,
  created_at timestamptz not null default now()
);
