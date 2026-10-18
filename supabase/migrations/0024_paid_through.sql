-- ============================================================================
-- "I'm paid up through the 23rd."
--
-- The detector predicts a rhythm, and the settled rule drops an occurrence
-- once a payment has posted near its date. Neither can know about a payment
-- made EARLY to cover a date still in the future: one Zelle for $462 on the
-- 16th covering both the 16th and the 23rd leaves the 23rd looking unpaid,
-- because on the 23rd nothing will post.
--
-- A watermark rather than a row per settled occurrence. One date per payee:
-- everything due on or before it is covered, and the schedule carries on
-- untouched past it. Three reasons:
--
--   It is how the situation is actually described — "I paid two weeks last
--   Friday to cover the 16th and the 23rd" is a statement about being
--   covered until a date, not about two individual occurrences.
--
--   Nothing accumulates. A table of exceptions grows for ever and needs its
--   own tidying; a watermark is overwritten.
--
--   A row per occurrence is the model v1 used, and the one this rewrite
--   exists to get away from.
--
-- Deliberately NOT inferred from the amount. v1 tried reading $462 as two
-- payments of $231 and the repair script for when it guessed wrong is still
-- in scripts/. Being asked is cheaper than being wrong in a way that hides
-- an obligation.
-- ============================================================================

alter table public.recurring_payees
  add column if not exists paid_through date;

comment on column public.recurring_payees.paid_through is
  'Occurrences due on or before this date are settled, however early they were paid. Null means rely on posted payments alone.';
