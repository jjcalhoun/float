-- ============================================================================
-- Telling the app something it cannot know yet.
--
-- Amounts are inferred from history, which is right almost always and wrong
-- exactly when something has just changed. A raise, or child support going
-- from $412 a fortnight to $231 a week, takes three occurrences to move the
-- median — and in the meantime the app predicts the old figure with complete
-- confidence. You already know the new one.
--
-- So: an override. Set it and it is used; clear it and inference resumes, so
-- the override is a correction rather than a second system to maintain.
--
-- For a BILL this changes the number directly. For income it only changes
-- what is displayed, because the paycheck amount never enters safe-to-spend
-- — income sets the horizon date and nothing else.
--
-- The floor also defaults to zero now, as asked. It was 300 on the reasoning
-- that a cushion absorbs the lumpy bills inference cannot find; that is still
-- true, and it is still one tap away on the screen. But a default that
-- quietly subtracts $300 from the one number the app exists to report is a
-- strong opinion to hold on someone else's behalf.
-- ============================================================================

-- `if not exists` because this one was applied by hand before it was a file,
-- and a migration that cannot be replayed over its own result is a trap.
alter table public.recurring_payees
  add column if not exists override_amount numeric(12,2);

comment on column public.recurring_payees.override_amount is
  'Replaces the detected amount. Null means keep inferring from history.';

alter table public.settings
  alter column v2_floor set default 0;

update public.settings set v2_floor = 0 where v2_floor = 300;
