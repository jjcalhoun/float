-- ============================================================================
-- The other balance.
--
-- SimpleFIN publishes two figures per account and we were only ever reading
-- one of them:
--
--   balance            what has POSTED
--   available-balance  posted, less pending authorisations and holds
--
-- Chase's own app shows available. Float showed posted, so Float said $225
-- while the bank said $159.87 — a $65 gap of card authorisations that had
-- hit the account but not yet settled.
--
-- For an app whose whole job is "how much can I spend right now", available
-- is the only defensible number: a pending charge is money that is gone, and
-- a figure that disagrees with the bank app is worth nothing however
-- defensible its derivation.
--
-- Both are kept. Posted is the right basis for reconciling against a list of
-- transactions, which is what v1's ledger does, and clobbering it would
-- break that to fix this. Not every institution sends available, so the
-- reader falls back to posted and says which it used.
-- ============================================================================

alter table public.accounts
  add column if not exists live_available_balance numeric(12,2);

comment on column public.accounts.live_available_balance is
  'SimpleFIN available-balance: posted less pending. Null when the bank does not publish it.';
