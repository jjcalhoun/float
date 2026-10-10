-- ============================================================================
-- The two numbers screen 1 needs from you.
--
--   floor         never count the last of it. One figure, no maintenance, and
--                 it is what absorbs the bills nobody can predict — the
--                 annual insurance that three occurrences will not find until
--                 its third year. Cheaper and more honest than pretending to
--                 forecast them.
--
--   card payment  what you intend to pay the card this cycle. The detector
--                 cannot help here: 11 payments in four months averaging $659
--                 with a $370 spread is not a rhythm, it is a decision you
--                 make each time. In a cash view the card payment is the only
--                 moment card spending touches the balance, so leaving it to
--                 a guess would make the number read high every month.
--
-- Columns on `settings` rather than a new table: it is already one row per
-- user, and two numbers do not warrant their own machinery. The v2_ prefix
-- marks what belongs to the rewrite, so the eventual clean-up is obvious.
-- ============================================================================

alter table public.settings
  add column v2_floor        numeric(12,2) not null default 300,
  add column v2_card_payment numeric(12,2) not null default 0;

comment on column public.settings.v2_floor is
  'Safe-to-spend never counts the last of the balance. Absorbs unpredictable lumpy bills.';
comment on column public.settings.v2_card_payment is
  'What the user intends to pay the card this cycle. Subtracted from safe-to-spend.';
