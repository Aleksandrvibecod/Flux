-- Flux Supabase Schema — все таблицы, RLS выключен для MVP (проверка через backend)
-- Выполни в Supabase SQL Editor

-- Users (расширяет auth.users, но для MVP храним telegram_id)
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  username text,
  first_name text,
  is_premium boolean default false,
  voice_used_today int default 0,
  voice_limit_date date default current_date,
  created_at timestamptz default now()
);

-- Transactions (расходы/доходы)
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade not null,
  type text check (type in ('expense','income')) not null,
  amount numeric(12,2) not null,
  category text not null,
  note text,
  created_at timestamptz default now()
);
create index on transactions(user_id, created_at desc);

-- Calories
create table if not exists calories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade not null,
  dish text not null,
  kcal int not null,
  protein int,
  fat int,
  carbs int,
  created_at timestamptz default now()
);
create index on calories(user_id, created_at desc);

-- Notes / Tasks (голосовые заметки)
create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade not null,
  kind text check (kind in ('task','idea','note')) not null,
  title text not null,
  content text,
  is_done boolean default false,
  created_at timestamptz default now()
);

-- Reminders
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade not null,
  text text not null,
  remind_at timestamptz not null,
  is_sent boolean default false,
  created_at timestamptz default now()
);
create index on reminders(remind_at) where is_sent = false;

-- Subscriptions (Telegram Stars)
create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade not null,
  provider text default 'telegram_stars',
  status text default 'active',
  expires_at timestamptz,
  created_at timestamptz default now()
);

-- Streaks & Bonuses (огоньки на главном)
create table if not exists streaks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade not null,
  habit text not null, -- например no_coffee_500
  streak int default 0, -- дней подряд
  best_streak int default 0,
  last_date date,
  total_bonus int default 0, -- накоплено бонусов
  updated_at timestamptz default now(),
  unique(user_id, habit)
);
create table if not exists bonuses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade not null,
  amount int not null, -- +50, -100
  reason text, -- streak_3, receipt_scan
  created_at timestamptz default now()
);

-- Цели-копилки
create table if not exists goals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id) on delete cascade not null,
  title text not null,
  target_amount numeric(12,2) not null,
  current_amount numeric(12,2) default 0,
  deadline date,
  created_at timestamptz default now()
);
-- Рефералка
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid references users(id) not null,
  referred_id uuid references users(id) not null unique,
  bonus_days int default 7,
  created_at timestamptz default now()
);

-- Включи RLS и разреши всё для service_role (backend использует service_key)
alter table users enable row level security;
alter table transactions enable row level security;
alter table calories enable row level security;
alter table notes enable row level security;
alter table reminders enable row level security;
alter table subscriptions enable row level security;
alter table streaks enable row level security;
alter table bonuses enable row level security;
alter table goals enable row level security;
alter table referrals enable row level security;

-- Политики для anon (через backend — service_role обходит RLS, но для Mini App через anon нужно)
create policy "allow all for anon" on users for all using (true) with check (true);
create policy "allow all for anon" on transactions for all using (true) with check (true);
create policy "allow all for anon" on calories for all using (true) with check (true);
create policy "allow all for anon" on notes for all using (true) with check (true);
create policy "allow all for anon" on reminders for all using (true) with check (true);
create policy "allow all for anon" on subscriptions for all using (true) with check (true);
create policy "allow all for anon" on streaks for all using (true) with check (true);
create policy "allow all for anon" on bonuses for all using (true) with check (true);
create policy "allow all for anon" on goals for all using (true) with check (true);
create policy "allow all for anon" on referrals for all using (true) with check (true);

-- докидываем колонки если база уже создана
alter table users add column if not exists message_used_today int default 0;
alter table users add column if not exists message_limit_date date default current_date;
alter table users add column if not exists bonus_balance int default 0;
alter table users add column if not exists monthly_budget int default 20000;
alter table users add column if not exists referral_code text unique;
