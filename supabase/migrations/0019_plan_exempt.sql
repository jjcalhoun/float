-- ============================================================================
-- A deposit that is not from the plan, and should stop being asked about.
--
-- The home screen flags income that arrived unlinked while a plan line of
-- about the same size is still open, because that combination counts the money
-- twice: once as the line, once as the deposit. When the deposit IS that line,
-- matching fixes it.
--
-- But sometimes it genuinely is not. A $500 deposit can look exactly like a
-- $500 payday allocation and be something else entirely, and there was no way
-- to say so — the card's only action was Match, so the prompt returned every
-- time the screen was opened, forever, on money that was never wrong.
--
-- This marks a deposit as extra income, deliberately. It changes no total:
-- unlinked income already counts as extra. It only stops the asking.
-- ============================================================================

alter table public.transactions
  add column plan_exempt boolean not null default false;

comment on column public.transactions.plan_exempt is
  'Income the user has confirmed is NOT from the plan. Suppresses the unmatched-income prompt; affects no total.';
