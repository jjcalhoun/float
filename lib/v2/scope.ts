/* What v2 is allowed to look at.
 *
 * One rule, in one place, because it had already been written three times and
 * two of them were wrong in different ways. Screen 1 and the Recurring screen
 * asked for "checking accounts with a SimpleFIN mapping", which was right.
 * Screen 2 needed the cards as well and asked for "checking with a mapping,
 * OR any credit account" — and the IUCU cards walked straight in through the
 * half of the condition that had no mapping test on it.
 *
 * The rule is: v2 reasons about accounts the Chase feed actually covers. A
 * mapping is what "covered" means, and it applies to every type, not to
 * whichever type I happened to be thinking about.
 *
 * Likewise the generated rows. `recurring`, `escrow` and `interest` are
 * postings v1 wrote for itself — a schedule, a split-out escrow portion, a
 * monthly interest charge against a loan. None is money leaving at a
 * merchant, and all three had to be excluded separately on each screen until
 * one of them was forgotten here.
 */

export interface ScopeAccount {
  id: string;
  type: string;
}

/** Rows v1 generated. Not purchases, not deposits — bookkeeping. */
export const GENERATED_SOURCES = ["recurring", "escrow", "interest"];

export const isGenerated = (source: string) => GENERATED_SOURCES.includes(source);

/** Accounts the bank feed covers, of the given types, in display order. */
export function scopedAccounts<T extends ScopeAccount>(
  accounts: T[],
  mappings: { account_id: string }[],
  types: string[],
): T[] {
  const synced = new Set(mappings.map((m) => m.account_id));
  return accounts.filter((a) => types.includes(a.type) && synced.has(a.id));
}

/** Where money is spent FROM: synced checking. Screen 1 and Recurring. */
export const cashAccounts = <T extends ScopeAccount>(
  accounts: T[],
  mappings: { account_id: string }[],
) => scopedAccounts(accounts, mappings, ["checking"]);

/** Everywhere spending SHOWS UP: synced checking and synced cards. Screen 2. */
export const spendAccounts = <T extends ScopeAccount>(
  accounts: T[],
  mappings: { account_id: string }[],
) => scopedAccounts(accounts, mappings, ["checking", "credit"]);
