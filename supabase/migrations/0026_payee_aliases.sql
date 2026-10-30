-- ============================================================================
-- "This is the same bill as that one."
--
-- The app merges two bank descriptions into one payee when it can see the
-- resemblance: one name inside the other, or the same words once routing
-- prefixes are stripped. That covers the common shapes and will never cover
-- all of them — a bank can rename "Ellettsville Uti" to "Town of
-- Ellettsville" and the two share nothing at all.
--
-- When that happens a kept bill silently stops being counted, which is the
-- worst failure this app has: the number goes UP and nothing says why.
--
-- So the resemblance can be asserted. You point at a merchant, name the bill
-- it belongs to, and that link is consulted before any of the automatic
-- rules and overrides them. Keyed on normalised payees, not transactions,
-- because the thing being said is about the name — every past and future
-- charge under it moves too.
-- ============================================================================

create table public.payee_aliases (
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- the name to fold away
  payee_key     text not null,
  -- the name it should be counted under
  canonical_key text not null,
  created_at    timestamptz not null default now(),
  primary key (user_id, payee_key),
  -- a name cannot be its own alias; chains are collapsed in code
  constraint payee_alias_not_self check (payee_key <> canonical_key)
);

alter table public.payee_aliases enable row level security;

create policy "own aliases" on public.payee_aliases
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

comment on table public.payee_aliases is
  'User-asserted "same payee as" links. Consulted before the automatic name matching and overriding it.';
