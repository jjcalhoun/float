-- ============================================================================
-- Show a loan's whole payment under one category.
--
-- A mortgage payment is one payment, but the home screen had it in three
-- places: the transfer under "Debt payments", the escrow counter-charge under
-- Housing, and the interest nowhere at all. That split is exactly what the
-- Debt tab is for — principal against interest against escrow is the whole
-- question there. On the home screen it is noise: $583.57 left the account
-- once, and it is a housing cost.
--
-- Naming a category here moves the WHOLE payment under it and drops that
-- account's own splits, because escrow and interest are already inside the
-- payment. Counting both showed $814 of chart for a $583.57 payment.
--
-- Null keeps the existing behaviour, so nothing changes for a loan you have
-- not named a category for. The Debt tab ignores this column entirely.
-- ============================================================================

alter table public.accounts
  add column payment_category_id uuid references public.categories (id);

comment on column public.accounts.payment_category_id is
  'Home screen: show this account''s whole payment under this category instead of as a debt line. Null keeps it under Debt payments.';
