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
  /** posted minus available: held by the bank, not yet settled */
  pending: number;
}

const RANK: Record<BalanceSource, number> = { available: 0, posted: 1, computed: 2 };

export function spendableBalance(
  accounts: BalanceAccount[],
  computed: Record<string, number> = {},
): SpendableBalance {
  let total = 0;
  let pending = 0;
  let source: BalanceSource = "available";

  for (const a of accounts) {
    let used: BalanceSource;
    if (a.live_available_balance != null) {
      total += Number(a.live_available_balance);
      used = "available";
      if (a.live_balance != null) {
        pending += Number(a.live_balance) - Number(a.live_available_balance);
      }
    } else if (a.live_balance != null) {
      total += Number(a.live_balance);
      used = "posted";
    } else {
      total += Number(computed[a.id] ?? 0);
      used = "computed";
    }
    if (RANK[used] > RANK[source]) source = used;
  }

  // With nothing to read, claiming "available" would overstate what is known.
  if (accounts.length === 0) source = "computed";

  return { total, source, pending };
}
