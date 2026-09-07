-- ============================================================================
-- A category for escrow, so it stops needing one by hand every month.
--
-- Escrow posts monthly against the loan account (lib/escrow.ts) to offset the
-- part of a mortgage payment that never touches principal. It has always been
-- written with NO category split, on the same reasoning as interest: the money
-- was already counted when the payment left checking, so counting it again
-- would double-charge free-to-spend.
--
-- That reasoning is about SPENDING, and it still holds — the ledger skips loan
-- accounts outright, so a split here cannot reach free-to-spend. But the
-- category rollup does read these splits, which is what would put escrow under
-- Housing in the breakdown. Without one, several hundred dollars a month of
-- genuinely housing-shaped money shows up nowhere at all.
--
-- So: name the category once, on the account, and let the monthly posting
-- attach it.
--
-- The backfill takes the answer from whatever was already categorised by hand
-- rather than guessing at a category by name — if an escrow row on this
-- account has a split, that split's category IS the intended answer.
-- ============================================================================

begin;

alter table public.accounts
  add column escrow_category_id uuid references public.categories (id);

comment on column public.accounts.escrow_category_id is
  'Category attached to the monthly escrow posting. Null posts it uncategorised, as before.';

-- 1. Adopt the category from any escrow row already categorised by hand.
update public.accounts a
set escrow_category_id = sub.category_id
from (
  select distinct on (t.account_id)
         t.account_id,
         s.category_id
  from public.transactions t
  join public.transaction_splits s on s.transaction_id = t.id
  where t.external_id like 'escrow:%'
  order by t.account_id, t.date desc
) sub
where a.id = sub.account_id
  and a.escrow_category_id is null;

-- 2. Give the escrow rows that have no split the category we just learned.
--    Same shape the app writes: one split for the whole amount, bucket 'needs'
--    (a mortgage is not discretionary).
insert into public.transaction_splits (user_id, transaction_id, category_id, bucket, amount)
select t.user_id, t.id, a.escrow_category_id, 'needs', t.amount
from public.transactions t
join public.accounts a on a.id = t.account_id
where t.external_id like 'escrow:%'
  and a.escrow_category_id is not null
  and not exists (
    select 1 from public.transaction_splits s where s.transaction_id = t.id
  );

commit;
