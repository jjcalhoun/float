/**
 * Debt helpers shared by the Debt planner.
 *
 * Schema has no per-account minimum payment by default, so we estimate one as
 * max($25, 2% of the balance) — a common credit-card convention — when a debt
 * has no explicit minimum set.
 */

export type DebtStrategy = "avalanche" | "snowball";

const MIN_FLOOR = 25;
const MIN_RATE = 0.02;

export function minPayment(balance: number): number {
  return Math.min(balance, Math.max(MIN_FLOOR, balance * MIN_RATE));
}

/** The payment terms the payoff math needs from an account. */
export interface PaymentTerms {
  min_payment?: number | null;
  monthly_payment?: number | null;
  escrow_amount?: number | null;
}

/** How much of a monthly payment actually reduces the debt.
 *
 *  Two things the gross payment hides:
 *   - paying ABOVE the minimum is the biggest lever on a payoff date, so the
 *     actual figure wins over the contractual one;
 *   - escrow (property taxes and insurance) leaves your account with the rest
 *     of the payment but never touches the principal, so it comes off the top.
 *
 *  Falls back to the minimum, then to a 2%-of-balance estimate. */
/** What actually leaves the account each month, escrow included.
 *
 *  debtPayment() is the PAYDOWN — what reaches the principal — which is the
 *  right number for a payoff projection and the wrong one for a chart of
 *  money spent. The donut's Debt wedge measures gross payments made, so its
 *  target has to be gross too; comparing a $583.57 payment against a $352.66
 *  paydown made every month look overspent. */
export function grossPayment(terms: PaymentTerms, balance: number): number {
  return terms.monthly_payment ?? terms.min_payment ?? minPayment(balance);
}

export function debtPayment(terms: PaymentTerms, balance: number): number {
  const gross = terms.monthly_payment ?? terms.min_payment ?? minPayment(balance);
  const escrow = terms.escrow_amount ?? 0;
  return Math.max(0, gross - escrow);
}
