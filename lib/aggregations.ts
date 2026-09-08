/**
 * Core aggregation logic — ported from BudgetApp.jsx prototype.
 *
 * Rules (locked — from schema.sql and Design Brief):
 *  - Category/bucket spend = expense splits MINUS refund splits (refunds claw back).
 *  - Income = type:'income' only.
 *  - Transfers touch balances only — excluded from spending and income.
 *  - Account balance = starting_balance + transactions dated STRICTLY AFTER as_of_date.
 *  - Splits are SIGNED like the parent amount (expense splits are negative).
 *  - The "spend contribution" of a split is -split.amount
 *    (expense negative → positive spend; refund positive → negative spend = claw-back).
 */

import type { Transaction, Account, BucketType, Rollup } from "./types";

/** "YYYY-MM" key for a date string or Date */
export function monthKey(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date + "T00:00:00") : date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * Roll up a list of transactions (with their splits already joined) for a
 * given month key.  If monthKey is omitted, all transactions are included.
 *
 * Returns:
 *   byCat    — net spend per category_id
 *   byBucket — net spend per bucket
 *   income   — total income
 *   spend    — total net spend (sum of byCat values)
 */
export interface RollupOptions {
  /** account_id → category_id: show this account's whole payment under that
   *  category instead of as a separate debt line. */
  paymentCategoryByAccount?: Record<string, string>;
  /** credit-card accounts, so this can follow the same rule as the ledger */
  creditAccountIds?: Set<string>;
  /** SPEND view: card purchases count as they post. Matches LedgerOptions.
   *  Without it this counted purchases in BOTH views while the ledger counted
   *  them in one, so the chart showed spending free-to-spend did not. */
  countCardPurchases?: boolean;
}

export function rollup(
  txns: Transaction[],
  month?: string,
  catBucket?: Record<string, BucketType>, // fallback bucket lookup if split.bucket missing
  savingsAccountIds: Set<string> = new Set(), // accounts whose transfers move the savings bucket
  loanAccountIds: Set<string> = new Set(), // loan/HELOC accounts whose paydowns count as spend
  opts: RollupOptions = {},
): Rollup {
  /* A loan payment shown as ONE line under a category.
   *
   * A mortgage payment is one payment, but the app had it in three places: the
   * transfer under "Debt payments", the escrow counter-charge under Housing,
   * and interest nowhere. Useful on the Debt tab, where the split between
   * principal, interest and escrow is the whole point; wrong on the home
   * screen, where $583.57 left the account once and belongs under Housing.
   *
   * Naming a category for a LOAN moves the whole payment there and drops that
   * account's own splits, because escrow and interest are inside the payment
   * already — counting both showed $814 for a $583 payment.
   *
   * A CARD is not the same shape and must not drop its splits. Escrow is part
   * of a mortgage payment; last month's groceries are not part of a card
   * payment. They are separate money — which is exactly why the card toggle
   * counts both when a balance is carried — so the payment gets its category
   * and the purchases keep theirs. */
  const payTo = opts.paymentCategoryByAccount ?? {};
  const creditIds = opts.creditAccountIds ?? new Set<string>();
  const spendView = opts.countCardPurchases ?? false;
  const byCat: Record<string, number> = {};
  const byBucket: Record<BucketType, number> = { needs: 0, wants: 0, savings: 0 };
  let income = 0;
  let spend = 0;

  for (const txn of txns) {
    if (month && monthKey(txn.date) !== month) continue;

    if (txn.type === "income") {
      income += txn.amount;
      continue;
    }
    if (txn.type === "transfer") {
      // The savings bucket tracks net flow through savings accounts: money moving
      // INTO a savings account (that account's inflow, amount > 0) adds to the
      // bucket; money moving OUT (amount < 0) subtracts. We count only the
      // savings-account leg, so each transfer is counted once with its natural
      // sign. Transfers between non-savings accounts are budget-neutral.
      if (savingsAccountIds.has(txn.account_id)) {
        byBucket.savings += txn.amount;
        spend += txn.amount;
      } else if (
        txn.amount > 0 &&
        (loanAccountIds.has(txn.account_id) || creditIds.has(txn.account_id))
      ) {
        /* Money landing in a loan or a card is real money committed — the
         * borrowing was never expensed — so it reduces net available. Filed
         * under needs: a debt obligation.
         *
         * Cards used to be skipped here on the grounds that their purchases
         * already counted. That is only true in the CASH view, and this
         * function had no idea which view was on; meanwhile the ledger counts
         * a card payment in both. The result was a card payment inside the
         * donut's Debt wedge but absent from "Spending by bucket" — two cards
         * on one screen disagreeing. Both count it now, in both views, and
         * the toggle governs the PURCHASES instead, exactly as it does in the
         * ledger. */
        const cat = payTo[txn.account_id];
        if (cat) byCat[cat] = (byCat[cat] ?? 0) + txn.amount;
        byBucket.needs += txn.amount;
        spend += txn.amount;
      }
      continue;
    }

    // Escrow and interest on a LOAN whose payment is shown whole are INSIDE
    // that payment; counting their splits again would double-charge it. A
    // card's purchases are not inside its payment, so they stay.
    if (loanAccountIds.has(txn.account_id) && payTo[txn.account_id]) continue;

    // In the CASH view a card purchase is not spending yet — the payment that
    // settles it is. The ledger has always worked this way; this did not, so
    // with the toggle off the chart showed spending free-to-spend did not.
    if (!spendView && creditIds.has(txn.account_id)) continue;

    // expense + refund: aggregate via splits
    for (const split of txn.splits ?? []) {
      // expense split amount is negative → contrib is positive (spend)
      // refund split amount is positive  → contrib is negative (claw-back)
      const contrib = -(split.amount);
      byCat[split.category_id] = (byCat[split.category_id] ?? 0) + contrib;
      const bucket: BucketType =
        split.bucket ?? catBucket?.[split.category_id] ?? "wants";
      byBucket[bucket] += contrib;
      spend += contrib;
    }
  }

  return { byCat, byBucket, income, spend };
}

/** Total paid toward loan/HELOC accounts in a month (their paydown legs — a
 *  transfer into a loan account, amount > 0). Mirrors how rollup counts loan
 *  paydowns as spend; used for the budget view's "Debt payments" petal. */
export function loanPaydown(
  txns: Transaction[],
  loanAccountIds: Set<string>,
  month?: string,
): number {
  let total = 0;
  for (const t of txns) {
    if (month && monthKey(t.date) !== month) continue;
    if (t.type === "transfer" && t.amount > 0 && loanAccountIds.has(t.account_id)) {
      total += t.amount;
    }
  }
  return total;
}

/**
 * Compute account balance: starting_balance + sum of transactions
 * dated STRICTLY AFTER the account's as_of_date.
 */
export function accountBalance(account: Account, txns: Transaction[]): number {
  const acctTxns = txns.filter(
    (t) => t.account_id === account.id && t.date > account.as_of_date,
  );
  return account.starting_balance + acctTxns.reduce((s, t) => s + t.amount, 0);
}
