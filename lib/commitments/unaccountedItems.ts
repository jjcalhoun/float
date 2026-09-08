import type { Transaction } from "@/lib/types";
import { monthKey } from "@/lib/aggregations";
import type { LedgerContext, LedgerOptions } from "./ledger";
import type { Commitment } from "./types";

/* What is actually inside the donut's "not in a category" wedge.
 *
 * That wedge started life as a subtraction — income, less the wedges, less
 * free-to-spend — which made it the one slice you could not open. Tapping a
 * wedge should show what is in it, and a residual has nothing in it.
 *
 * It turns out to be enumerable, because the residual is not mysterious. Both
 * sides count the same transactions; they just count them differently:
 *
 *   the LEDGER counts money as it leaves — a settled commitment at what it
 *   actually cost, an unlinked purchase by its splits, a transfer into a
 *   loan, card or savings account as cash committed.
 *
 *   the RING counts what a category can hold — split amounts, plus loan
 *   transfers via the debt petal.
 *
 * Anything the first counts and the second doesn't is a row here, and the
 * usual causes are ordinary: a savings transfer (real money, no category), a
 * card payment (likewise), a bill settled from the plan whose transaction was
 * never given a category. Per transaction the difference is what's missing;
 * summed, it is the wedge.
 */

export interface UnaccountedRow {
  id: string;
  label: string;
  date: string;
  /** what the ledger counted as leaving */
  ledger: number;
  /** what reached a category or the debt petal */
  ring: number;
  /** the part with nowhere to show — ledger minus ring */
  gap: number;
}

const splitTotal = (t: Transaction) =>
  (t.splits ?? []).reduce((s, sp) => s + -sp.amount, 0);

const nameOf = (t: Transaction) =>
  t.merchant || t.description || "Transaction";

/** Same pair key as ledger.ts — both legs of one transfer resolve to it, and
 *  deliberately without the date, which is compared separately. */
const transferKey = (t: Transaction): string => {
  const a = t.account_id;
  const b = t.transfer_account_id ?? "";
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${x}|${y}|${Math.abs(t.amount).toFixed(2)}`;
};

const PAIR_DAYS = 4;

const daysBetween = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/** What the ledger counts this transaction as putting out this month.
 *  Mirrors ledger.ts — if that changes, this has to change with it. */
function ledgerOutflow(
  t: Transaction,
  ctx: LedgerContext,
  spendView: boolean,
  alreadySettled: (t: Transaction) => boolean,
  outflowLegExists: (t: Transaction) => boolean,
): number {
  if (t.type === "income") return 0;

  // Settled commitments are counted at what they actually cost, whatever shape
  // the payment took. linkedActual prefers the OUTFLOW legs of a transfer, so
  // an arriving leg counts only when there is no outflow leg to prefer —
  // otherwise a pair linked to one line would be counted twice here, and the
  // wedge and the sheet would drift apart again.
  if (t.commitment_id) {
    if (t.type !== "transfer") return Math.max(0, -t.amount);
    if (t.amount < 0) return Math.abs(t.amount);
    return outflowLegExists(t) ? 0 : Math.abs(t.amount);
  }

  if (t.type === "transfer") {
    // The other half of a payment the plan already counted is not a second
    // payment. Mirrors the same guard in ledger.ts.
    if (alreadySettled(t)) return 0;
    // Money landing in a loan, card or savings account is cash committed.
    // The destination leg only, so a pair counts once.
    if (
      t.amount > 0 &&
      (ctx.loanAccountIds.has(t.account_id) ||
        ctx.creditAccountIds.has(t.account_id) ||
        ctx.savingsAccountIds.has(t.account_id))
    ) {
      return t.amount;
    }
    return 0;
  }

  // Interest and escrow on a loan are consequences of a payment that already
  // counted; the card view decides whether purchases count as they post.
  if (ctx.loanAccountIds.has(t.account_id)) return 0;
  if (!spendView && ctx.creditAccountIds.has(t.account_id)) return 0;
  return Math.max(0, splitTotal(t));
}

/** What of this transaction reaches a wedge: a category split, or the debt or
 *  savings petals. A card payment reaches neither, which is why it shows up.
 *
 *  A loan payment is a PAIR — money leaving checking and money arriving at the
 *  loan — and the debt petal counts the arriving leg. Recognising only that
 *  leg here reported the departing one as unaccounted for, so a mortgage
 *  payment appeared in two wedges at once. Both legs describe one event, so
 *  both have to see the debt petal that already shows it. */
function ringAmount(
  t: Transaction,
  ctx: LedgerContext,
  payTo: Record<string, string>,
): number {
  if (t.type === "income") return 0;
  if (t.type === "transfer") {
    const into = (ids: Set<string> | Record<string, unknown>) => {
      const has = (id: string) => (ids instanceof Set ? ids.has(id) : !!ids[id]);
      return (
        (t.amount > 0 && has(t.account_id)) ||
        (t.amount < 0 && has(t.transfer_account_id ?? ""))
      );
    };
    // Loans and cards both reach the debt petal; savings has its own; and a
    // payment shown under a category has a slice like any other.
    return into(ctx.loanAccountIds) ||
      into(ctx.creditAccountIds) ||
      into(ctx.savingsAccountIds) ||
      into(payTo)
      ? Math.abs(t.amount)
      : 0;
  }
  return Math.max(0, splitTotal(t));
}

/** Rows behind the "not in a category" wedge, largest first.
 *
 *  Takes commitments because the ledger does not bucket everything by date: a
 *  LINKED payment counts toward its commitment's period whatever day it
 *  cleared, so a bill paid on the 2nd of the next month is still this month's.
 *  Filtering by transaction date alone missed those entirely — they were
 *  counted by the ledger, absent from this list, and the wedge and the sheet
 *  disagreed by exactly that much. */
export function unaccountedItems(
  commitments: Commitment[],
  transactions: Transaction[],
  period: string,
  ctx: LedgerContext,
  opts: LedgerOptions & { paymentCategoryByAccount?: Record<string, string> } = {},
): UnaccountedRow[] {
  const spendView = opts.countCardPurchases ?? false;
  const payTo = opts.paymentCategoryByAccount ?? {};
  const out: UnaccountedRow[] = [];

  // Skipped and covered lines count zero in the ledger, so their payments
  // cannot leave a hole. Everything else in this period is fair game.
  // Linked transfer legs, by pair. Any period's commitment counts, same as
  // ledger.ts — a payment linked to another month's line is still that
  // month's, not a second payment here.
  const linkedLegs = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (t.type !== "transfer" || !t.commitment_id) continue;
    const key = transferKey(t);
    const arr = linkedLegs.get(key);
    if (arr) arr.push(t);
    else linkedLegs.set(key, [t]);
  }
  const near = (t: Transaction) =>
    (linkedLegs.get(transferKey(t)) ?? []).filter(
      (l) => l.id !== t.id && daysBetween(l.date, t.date) <= PAIR_DAYS,
    );
  const alreadySettled = (t: Transaction) => near(t).length > 0;
  const outflowLegExists = (t: Transaction) =>
    near(t).some((l) => l.amount < 0 && l.commitment_id === t.commitment_id);

  const counted = new Set(
    commitments
      .filter((c) => c.period === period && !c.skipped && !c.covered_by)
      .map((c) => c.id),
  );

  for (const t of transactions) {
    // A linked row belongs to its COMMITMENT's month; an unlinked one to its
    // own date. Same rule as ledger.ts.
    if (t.commitment_id) {
      if (!counted.has(t.commitment_id)) continue;
    } else if (monthKey(t.date) !== period) continue;

    const ledger = ledgerOutflow(t, ctx, spendView, alreadySettled, outflowLegExists);
    if (ledger <= 0) continue;
    const ring = ringAmount(t, ctx, payTo);
    const gap = ledger - ring;
    if (gap <= 0.005) continue; // fully accounted for, or rounding
    out.push({ id: t.id, label: nameOf(t), date: t.date, ledger, ring, gap });
  }

  return out.sort((a, b) => b.gap - a.gap);
}

export const unaccountedTotal = (rows: UnaccountedRow[]): number =>
  rows.reduce((s, r) => s + r.gap, 0);
