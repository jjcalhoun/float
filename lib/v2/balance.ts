/* Which balance to believe.
 *
 * A bank publishes two figures and they mean different things:
 *
 *   posted     what has settled
 *   available  posted, less pending authorisations and holds
 *
 * Chase's app shows available. Float showed posted, and so said $225 while
 * the bank said $159.87 — the $65 gap being card authorisations that had hit
 * the account but not yet settled. For "how much can I spend right now",
 * available is the only defensible answer: a pending charge is money that is
 * already gone, and a number that disagrees with the bank app is worth
 * nothing however carefully it was derived.
 *
 * The fallbacks matter as much as the preference. Not every institution
 * publishes available; nothing publishes anything before the first sync. The
 * last resort is the balance computed from transactions, which drifts
 * whenever the feed misses a row — but treating a missing figure as ZERO
 * would show a confident and catastrophically wrong number instead.
 *
 * Credit cards are deliberately not run through this. On a card, "available"
 * means available CREDIT, which is a different quantity entirely and would
 * turn "owed" into nonsense.
 */

export interface BalanceAccount {
  id: string;
  live_balance?: number | null;
  live_available_balance?: number | null;
}

export type BalanceSource = "available" | "posted" | "computed";

export interface SpendableBalance {
  total: number;
  /** the weakest source any account fell back to */
  source: BalanceSource;
  /** posted minus available: held by the bank, not yet settled.
   *
   *  A LOWER BOUND, not a measurement. Banks clamp available at zero, so
   *  when pending exceeds the posted balance this reports only as much of it
   *  as the subtraction can see. Presenting it as the exact figure is how
   *  "$1,268 pending" came to be shown against a $1,268 balance — arithmetic
   *  reported as a fact from the bank. */
  pending: number;
  /** the posted total, for showing beside the available one */
  posted: number;
  /** available is zero while something has posted — so pending is clamped
   *  and the true figure is unknown */
  clamped: boolean;
}

const RANK: Record<BalanceSource, number> = { available: 0, posted: 1, computed: 2 };

export function spendableBalance(
  accounts: BalanceAccount[],
  computed: Record<string, number> = {},
): SpendableBalance {
  let total = 0;
  let pending = 0;
  let posted = 0;
  let clamped = false;
  let source: BalanceSource = "available";

  for (const a of accounts) {
    let used: BalanceSource;
    if (a.live_available_balance != null) {
      const avail = Number(a.live_available_balance);
      total += avail;
      used = "available";
      if (a.live_balance != null) {
        pending += Number(a.live_balance) - avail;
        posted += Number(a.live_balance);
        if (avail === 0 && Number(a.live_balance) !== 0) clamped = true;
      } else {
        posted += avail;
      }
    } else if (a.live_balance != null) {
      total += Number(a.live_balance);
      posted += Number(a.live_balance);
      used = "posted";
    } else {
      const c = Number(computed[a.id] ?? 0);
      total += c;
      posted += c;
      used = "computed";
    }
    if (RANK[used] > RANK[source]) source = used;
  }

  // With nothing to read, claiming "available" would overstate what is known.
  if (accounts.length === 0) source = "computed";

  return { total, source, pending, posted, clamped };
}
