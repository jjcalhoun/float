-- ============================================================================
-- Which merchants are fixed costs. Yours to decide, not the app's.
--
-- The detector finds rhythms well, but a rhythm is not a commitment: three
-- grocery runs a fortnight apart look exactly like a subscription, and a
-- credit-card payment is regular money that is already answered elsewhere.
-- Any threshold that lets the mortgage in also lets some of those in, and
-- being told your groceries are a fixed cost is worse than being told nothing.
--
-- So the detector proposes and this table decides. Nothing is a fixed cost
-- until it appears here as 'fixed'.
--
-- The useful consequence is that the detector no longer has to be RIGHT, only
-- useful. A false suggestion costs one ignored row, so it can afford to be
-- generous — two occurrences, quarterly rhythms, things it is only half sure
-- of — where before every threshold had to be defensive.
--
-- Keyed on the NORMALISED payee, not a transaction or an account: the thing
-- you are judging is "Philo", once, for every charge it will ever make. The
-- amount and the cadence stay inferred from history, so when child support
-- moves from $412 fortnightly to $231 weekly the flag stays put and the
-- figures follow on their own.
-- ============================================================================

create table public.recurring_payees (
  user_id    uuid not null references auth.users (id) on delete cascade,
  payee_key  text not null,
  -- 'fixed'     — a real obligation; counts against safe-to-spend
  -- 'dismissed' — not an obligation; never suggest it again
  decision   text not null check (decision in ('fixed', 'dismissed')),
  -- what it looked like when you decided, for showing "you ticked this when
  -- it was $25 monthly" if it later drifts. Never used for maths.
  noted_amount  numeric(12,2),
  noted_cadence text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, payee_key)
);

alter table public.recurring_payees enable row level security;

create policy "owner_all" on public.recurring_payees
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

comment on table public.recurring_payees is
  'v2: merchants the user has marked as fixed costs, or dismissed. The detector proposes; this decides.';
