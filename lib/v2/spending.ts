import { normalisePayee, displayPayee, aliasMap } from "./payee";

/* Screen 2. Where it went.
 *
 * Screen 1 answers "what can I spend"; this answers the question you ask
 * immediately afterwards, which is "why is that number lower than I thought".
 * It is therefore a plain account of the recent past, not a budget: no
 * targets, no categories to maintain, no month boundaries. A rolling window
 * and a list of merchants, largest first.
 *
 * Three decisions do most of the work here:
 *
 * CARDS COUNT. Screen 1 is deliberately cash-only — a card purchase does not
 * move money out of checking, so it cannot move a figure meant to equal what
 * is spendable today. But "where did it go" with the card left out is a lie
 * by omission, because the card is where most of it went. So the two screens
 * disagree on purpose, and each is right about its own question.
 *
 * TRANSFERS NEVER COUNT. A card payment is not spending — the spending
 * happened when the card was swiped, and counting both charges you twice for
 * the same groceries. Same for anything moving between your own accounts.
 *
 * FIXED IS SEPARATED FROM EVERYDAY. The mortgage at the top of a list sorted
 * by size tells you nothing you can act on; it is the same every month and
 * you already know. What you want to see is that takeaway was $340. So the
 * merchants you kept on the Recurring screen are itemised apart, and the
 * everyday list is what is left — which is the part you can actually change.
 */

export interface SpendTxn {
  id: string;
  date: string;
  /** signed: negative is money out */
  amount: number;
  merchant?: string | null;
  description?: string | null;
  account_id: string;
  type: string;
  transfer_account_id?: string | null;
}

export interface SpendGroup {
  key: string;
  label: string;
  /** unsigned, refunds already netted off */
  total: number;
  count: number;
  lastDate: string;
  txns: SpendTxn[];
}

export interface SpendingResult {
  from: string;
  to: string;
  days: number;
  fixed: SpendGroup[];
  everyday: SpendGroup[];
  fixedTotal: number;
  everydayTotal: number;
  total: number;
  /** the window's rate expressed per 30 days, so 30 and 90 can be compared */
  perMonth: number;
}

export interface SpendingInput {
  txns: SpendTxn[];
  /** accounts in scope: synced checking plus the cards */
  accountIds: Set<string>;
  /** normalised payees kept as fixed costs on the Recurring screen */
  fixedKeys: Set<string>;
  today: string;
  days: number;
}

const DAY = 86400000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export function summariseSpending(input: SpendingInput): SpendingResult {
  const { txns, accountIds, fixedKeys, today, days } = input;
  const from = addDays(today, -days);

  const inWindow = txns.filter(
    (t) =>
      accountIds.has(t.account_id) &&
      t.date > from &&
      t.date <= today &&
      /* A transfer is money changing pockets. The card payment especially:
         the spending already appeared when the card was used. */
      t.type !== "transfer" &&
      !t.transfer_account_id,
  );

  const rawKey = (t: SpendTxn) => normalisePayee(t.merchant || t.description) || "unknown";

  /* The same merchant under two bank descriptions is one merchant. The alias
     map needs a typical amount per name to judge that, so it gets the mean. */
  const sums = new Map<string, { sum: number; n: number }>();
  for (const t of inWindow) {
    const k = rawKey(t);
    const s = sums.get(k) ?? { sum: 0, n: 0 };
    s.sum += Math.abs(t.amount);
    s.n += 1;
    sums.set(k, s);
  }
  const alias = aliasMap([...sums].map(([key, s]) => ({ key, amount: s.sum / s.n })));
  const keyOf = (t: SpendTxn) => {
    const k = rawKey(t);
    return alias.get(k) ?? k;
  };

  const groups = new Map<string, SpendGroup>();
  for (const t of inWindow) {
    const key = keyOf(t);
    const g =
      groups.get(key) ??
      ({
        key,
        label: displayPayee(t.merchant || t.description) || "Unknown",
        total: 0,
        count: 0,
        lastDate: t.date,
        txns: [],
      } satisfies SpendGroup);
    g.total += -t.amount; // outflow is negative, so this accumulates positive
    if (t.amount < 0) g.count += 1; // a refund is not a visit
    if (t.date > g.lastDate) g.lastDate = t.date;
    g.txns.push(t);
    groups.set(key, g);
  }

  /* What is left after netting:
     - positive: spending, possibly reduced by a refund. Keep it.
     - zero or negative: either a returned purchase that cancelled out, or
       money arriving — a paycheck, a reimbursement, a deposit. Neither is
       spending, and showing a negative row in a list of outgoings reads as a
       discount you did not get. */
  const kept = [...groups.values()]
    .filter((g) => g.total > 0.005)
    .map((g) => ({ ...g, txns: g.txns.sort((a, b) => (a.date < b.date ? 1 : -1)) }))
    .sort((a, b) => b.total - a.total);

  const fixed = kept.filter((g) => fixedKeys.has(g.key));
  const everyday = kept.filter((g) => !fixedKeys.has(g.key));
  const sum = (xs: SpendGroup[]) => xs.reduce((s, g) => s + g.total, 0);
  const fixedTotal = sum(fixed);
  const everydayTotal = sum(everyday);
  const total = fixedTotal + everydayTotal;

  return {
    from: addDays(from, 1),
    to: today,
    days,
    fixed,
    everyday,
    fixedTotal,
    everydayTotal,
    total,
    perMonth: days > 0 ? (total / days) * 30 : 0,
  };
}
