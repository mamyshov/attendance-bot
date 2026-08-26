-- Выполните это целиком в Supabase: SQL Editor -> New query -> вставить -> Run

create table if not exists office (
  id int primary key default 1,
  lat double precision,
  lon double precision,
  radius int
);

create table if not exists employees (
  chat_id bigint primary key,
  name text,
  inside boolean default false
);

create table if not exists events (
  id bigserial primary key,
  chat_id bigint,
  name text,
  type text,
  ts timestamptz default now()
);
