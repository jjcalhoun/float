import type { Transaction } from "@/lib/types";
import { monthKey } from "@/lib/aggregations";
import type { Commitment, CommitmentKind } from "./types";

/* The free-to-spend ledger, over commitments.
 *
 *   expected income (commitments)
 * − commitments (planned until their transaction posts, then the actual)
 * = baseline
 * − discretionary spend (unlinked, cash-view)
 * + extra income (actual income beyond the plan)
 * = free to spend
 *
 * Two things differ from the month-plan version this replaces:
 *
 *  1. ONE source of truth. Links are `transactions.commitment_id` and nothing
 *     else — the render-time autoLinkByRule overlay is gone, so the ledger and
 *     the picker can no longer disagree about whether a bill is paid.
 *
 *  2. Dates carry little weight. A linked transaction counts toward its
 *     COMMITMENT's period, whatever date it actually posted, so a bill due the
 *     31st that clears on the 1st lands in the month that expected it. Only
 *     unlinked spending is bucketed by its own date.
 *
 * TWO VIEWS OF A CREDIT CARD.
 *
 *   CASH  — when did money leave your pocket? A card purchase doesn't reduce
 *           free-to-spend; the monthly card payment does. True to your bank
 *           balance, but a week of swiping shows up as nothing at all, and
 *           spending on a card with no payment line vanishes entirely.
 *
 *   SPEND — that, PLUS the purchases as you make them.
 *
 * The card payment keeps counting in both, and it is worth being clear why,
 * because the first version of this got it wrong. When a card is paid in full
 * every month, the purchases and the payment that clears them are one event
 * seen twice, and counting both would double-charge. WHEN A BALANCE IS
 * CARRIED THEY ARE DIFFERENT MONEY: the payment retires debt you already owe,
 * while this month's purchases create new debt. Both are real claims on this
 * month's income, so both count — that is what "don't overspend, and pay the
 * cards down" actually requires.
 *
 * (Building it the other way made turning the toggle ON raise free-to-spend,
 * because dropping the payment gave back more than the purchases took. A
 * setting called "count card spending" that increases what you can spend is
 * its own proof of a wrong model.)
 *
 * LOAN accounts are excluded from spending in BOTH views. Interest and escrow
 * post as charges against the loan, but they are consequences of a payment
 * that already counted — they belong in the category rollup (so escrow shows
 * under Housing) and nowhere near free-to-spend.
 *
 * Transfers between cash accounts are neutral in both.
 */

export interface LedgerItem {
  id: string;
  series_id: string;
  name: string;
  kind: CommitmentKind;
  amount: number; // planned, signed
  due_hint?: string | null;
  variable: boolean;
  /** named `excluded` for continuity with the screens; stored as `skipped` */
  excluded: boolean;
  /** settled by a payment that primarily fulfills another occurrence */
  coveredBy?: string | null;
  status: "expected" | "paid";
  /** signed actual from linked transactions (null until something links) */
  actual: number | null;
  /** what the ledger counts: actual when paid, planned otherwise */
  effective: number;
  /** transactions fulfilling this commitment */
  linked: Transaction[];
}

export interface Ledger {
  expectedIncome: number;
  commitmentsPlanned: number;
  baseline: number;
  incomeEffective: number;
  commitmentsEffective: number;
  extraIncome: number;
  discretionary: number;
  freeToSpend: number;
  items: LedgerItem[];
}

export interface LedgerContext {
  creditAccountIds: Set<string>;
  loanAccountIds: Set<string>;
  savingsAccountIds: Set<string>;
}

export interface LedgerOptions {
  /** SPEND view: count card purchases as they post, on top of everything the
   *  cash view already counts. Default false. */
  countCardPurchases?: boolean;
}

/** Identifies a transfer by the PAIR it belongs to rather than by the row.
 *
 *  A transfer is two rows — money leaving one account and arriving at another
 *  — and only one of them carries the link to the plan. Both describe one
 *  payment, so both have to resolve to the same key.
 *
 *  Deliberately DATELESS. Keying on the date too was the weak point of this:
 *  a feed that posts the legs a day apart — money leaves on the 2nd, lands on
 *  the 3rd — produced two keys, the pair went unrecognised, and the payment
 *  was charged to the month twice again. The date is compared separately,
 *  with room to move. */
const transferKey = (t: Transaction): string => {
  const a = t.account_id;
  const b = t.transfer_account_id ?? "";
  const [x, y] = a < b ? [a, b] : [b, a];
  return `${x}|${y}|${Math.abs(t.amount).toFixed(2)}`;
};

/** How far apart the two legs of one transfer may post and still be one
 *  payment. Wide enough for a weekend, narrow enough that two genuinely
 *  separate transfers of the same amount between the same accounts — a
 *  standing weekly payment, say — are not mistaken for each other. */
const PAIR_DAYS = 4;

const daysBetween = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/** Signed actual from linked transactions. A two-sided transfer may have either
 *  or both legs linked; prefer the outflow legs so a pair isn't double-counted. */
function linkedActual(kind: CommitmentKind, linked: Transaction[]): number | null {
  if (linked.length === 0) return null;
  if (kind === "income") return linked.reduce((s, t) => s + t.amount, 0);
  const out = linked.filter((t) => t.amount < 0);
  const legs = out.length > 0 ? out : linked;
  return -legs.reduce((s, t) => s + Math.abs(t.amount), 0);
}

export function ledger(
  commitments: Commitment[],
  transactions: Transaction[],
  period: string,
  ctx: LedgerContext,
  opts: LedgerOptions = {},
): Ledger {
  const spendView = opts.countCardPurchases ?? false;
  const inPeriod = commitments.filter((c) => c.period === period);
  const ids = new Set(inPeriod.map((c) => c.id));

  // Linked rows count toward their commitment's period regardless of date.
  const linkedByCommitment = new Map<string, Transaction[]>();
  for (const t of transactions) {
    const id = t.commitment_id;
    if (!id || !ids.has(id)) continue;
    const arr = linkedByCommitment.get(id);
    if (arr) arr.push(t);
    else linkedByCommitment.set(id, [t]);
  }

  /* A transfer pair that settles a commitment must count ONCE.
   *
   * The paying leg carries the link and is counted as the commitment's actual.
   * The arriving leg is unlinked, and the second pass below counts unlinked
   * money landing in a loan, card or savings account as cash committed — so a
   * mortgage payment was charged to the month twice, once as its plan line and
   * again as its own arrival. On real data that understated free-to-spend by
   * $883.57 across a mortgage and a HELOC, silently, in the one number this
   * whole screen exists to get right.
   *
   * Both legs share a key, so the arriving leg can recognise that its own
   * payment has already been counted. */
  const settledTransfers = new Map<string, string[]>();
  for (const t of transactions) {
    if (t.type !== "transfer" || !t.commitment_id) continue;
    // ANY period's commitment, not just this one. A payment linked to August's
    // line whose arriving leg lands in September was counted by August as its
    // commitment AND by September as cash committed — the same money charged
    // to two months.
    const key = transferKey(t);
    const dates = settledTransfers.get(key);
    if (dates) dates.push(t.date);
    else settledTransfers.set(key, [t.date]);
  }

  /** Is this unlinked leg the other half of a payment the plan already counted? */
  const alreadySettled = (t: Transaction): boolean =>
    (settledTransfers.get(transferKey(t)) ?? []).some(
      (d) => daysBetween(d, t.date) <= PAIR_DAYS,
    );

  let expectedIncome = 0;
  let commitmentsPlanned = 0;
  let incomeEffective = 0;
  let commitmentsEffective = 0;

  const items: LedgerItem[] = inPeriod.map((c) => {
    const linked = c.skipped ? [] : (linkedByCommitment.get(c.id) ?? []);
    // A week settled by someone else's lump payment counts ZERO here: the
    // primary line carries the whole amount, so the cash lands once.
    const covered = !!c.covered_by;
    const actual = covered ? 0 : linkedActual(c.kind, linked);
    const effective = c.skipped || covered ? 0 : (actual ?? c.amount);
    if (!c.skipped && !covered) {
      if (c.kind === "income") {
        expectedIncome += c.amount;
        incomeEffective += effective;
      } else {
        commitmentsPlanned += -c.amount;
        commitmentsEffective += -effective;
      }
    }
    return {
      id: c.id,
      series_id: c.series_id,
      name: c.name,
      kind: c.kind,
      amount: c.amount,
      due_hint: c.due_hint,
      variable: c.variable,
      excluded: c.skipped,
      coveredBy: c.covered_by ?? null,
      status: covered || actual !== null ? "paid" : "expected",
      actual,
      effective,
      linked,
    };
  });

  // Unlinked actuals — the flows nothing promised — bucketed by their own date.
  let extraIncome = 0;
  let discretionary = 0;
  for (const t of transactions) {
    if (t.commitment_id) continue;
    if (monthKey(t.date) !== period) continue;

    if (t.type === "income") {
      extraIncome += t.amount;
      continue;
    }
    if (t.type === "transfer") {
      // Money landing in a loan/credit/savings account is cash committed.
      // Count the destination leg only, so a pair counts once. This includes a
      // card payment in both views: paying down a carried balance is real cash
      // leaving, whatever was bought this month.
      // ...unless the plan already counted it: this is the other half of a
      // payment linked to a commitment, not a second payment.
      if (alreadySettled(t)) continue;
      if (
        t.amount > 0 &&
        (ctx.loanAccountIds.has(t.account_id) ||
          ctx.creditAccountIds.has(t.account_id) ||
          ctx.savingsAccountIds.has(t.account_id))
      ) {
        discretionary += t.amount;
      }
      continue;
    }
    // Expense / refund via splits.
    //
    // A LOAN account is skipped in both views: interest and escrow are
    // consequences of a payment that already counted, so counting their splits
    // again would double-charge free-to-spend. They still reach the category
    // rollup, which is what puts mortgage escrow under Housing without
    // inflating spending.
    if (ctx.loanAccountIds.has(t.account_id)) continue;
    // A CARD purchase is the one thing the toggle moves: counted as you make
    // it in the spend view, invisible until the payment in the cash one.
    if (!spendView && ctx.creditAccountIds.has(t.account_id)) continue;
    for (const split of t.splits ?? []) discretionary += -split.amount;
  }

  const baseline = expectedIncome - commitmentsPlanned;
  const freeToSpend = incomeEffective + extraIncome - commitmentsEffective - discretionary;

  return {
    expectedIncome,
    commitmentsPlanned,
    baseline,
    incomeEffective,
    commitmentsEffective,
    extraIncome,
    discretionary,
    freeToSpend,
    items,
  };
}
