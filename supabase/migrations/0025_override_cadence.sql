-- ============================================================================
-- Telling the app the rhythm has changed.
--
-- 0022 let the AMOUNT be typed over. The same argument applies with more
-- force to the cadence, and there was no way to say it: child support moved
-- from $412 a fortnight to $231 a week, and ten fortnightly payments still
-- outvote two weekly ones, so the screen predicted $412 on dates that will
-- never have a payment. Both numbers wrong and the dates wrong too.
--
-- Detection is backward-looking by construction. It is always wrong for a
-- while after a real change, and confidently wrong — which is the one state
-- worth having an override for. Clear it and inference resumes, so this
-- stays a correction rather than a schedule to maintain by hand.
-- ============================================================================

alter table public.recurring_payees
  add column if not exists override_cadence text
  check (override_cadence in
    ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annual'));

comment on column public.recurring_payees.override_cadence is
  'Replaces the detected cadence. Null means keep inferring from history.';
