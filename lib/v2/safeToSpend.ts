import { dueBetween, type Series } from "./recurring";

/* The number.
 *
 * "How much can I spend right now" — not for the month, and not against a
 * plan. The balance is what the bank says, the obligations are what the
 * detector found and you kept, and the horizon is your next paycheck.
 *
 * There are no months anywhere in this. v1 modelled a calendar month and
 * spent its life reconciling the plan against reality across period
 * boundaries: payments landing in the wrong month, lines materialising for
 * months nobody had opened, one payment charged to two months. A horizon of
 * "until the next deposit" has no boundary to get wrong, and when something
 * does go wrong it is wrong for days rather than for thirty.
 *
 * CASH ONLY. A card purchase does not move this number; the card payment
 * does, because that is when money leaves checking. That is a deliberate
 * choice rather than a simplification — it is what makes the figure equal to
 * money you can actually spend today.
 */

export interface SafeInput {
  /** what the bank says is in the spending account */
  balance: number;
  /** series the user has kept — obligations and income both */
  kept: Series[];
  today: string;
  /** never count the last of it; absorbs the lumpy bills nobody can predict */
  floor: number;
  /** what you intend to pay the card this cycle */
  cardPayment: number;
}

export interface DueItem {
  key: string;
  payee: string;
  date: string;
  amount: number;
}

export interface SafeResult {
  /** the next payday — what "safe until" means */
  horizon: string | null;
  /** obligations landing between now and then */
  due: DueItem[];
  dueTotal: number;
  /** balance − due − card − floor */
  safe: number;
  /** what lands in the week AFTER payday */
  soonAfter: DueItem[];
  soonAfterTotal: number;
}

const DAY = 86400000;
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** How far ahead to look when no income series has been kept yet. A fortnight
 *  is the common pay cycle and errs toward showing less. */
const FALLBACK_HORIZON = 14;

/** The next payday: the soonest income occurrence still to come. */
export function nextPayday(kept: Series[], today: string): string | null {
  const dates = kept
    .filter((s) => s.direction === "in")
    .map((s) => (s.nextDue >= today ? s.nextDue : dueBetween(s, today, addDays(today, 400))[0]))
    .filter((d): d is string => !!d)
    .sort();
  return dates[0] ?? null;
}

function itemsBetween(kept: Series[], from: string, to: string): DueItem[] {
  const out: DueItem[] = [];
  for (const s of kept) {
    if (s.direction !== "out") continue;
    for (const date of dueBetween(s, from, to)) {
      out.push({ key: `${s.key}|${date}`, payee: s.payee, date, amount: s.amount });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function safeToSpend(input: SafeInput): SafeResult {
  const { balance, kept, today, floor, cardPayment } = input;

  const horizon = nextPayday(kept, today);
  /* Bills due ON payday count against this side of it. The money has to be
     there in the morning, and a number that assumes the deposit arrives first
     is a number that overstates on exactly the day you are most likely to
     check it. */
  const end = horizon ?? addDays(today, FALLBACK_HORIZON);

  const due = itemsBetween(kept, today, end);
  const dueTotal = due.reduce((s, d) => s + d.amount, 0);

  /* What lands just after payday.
     "Safe until the 15th" invites spending it all on the 14th, and if the
     mortgage goes out on the 16th that was a trap rather than information.
     Showing the week beyond the horizon costs a line and prevents it. */
  const soonAfter = horizon ? itemsBetween(kept, addDays(horizon, 1), addDays(horizon, 7)) : [];

  return {
    horizon,
    due,
    dueTotal,
    safe: balance - dueTotal - cardPayment - floor,
    soonAfter,
    soonAfterTotal: soonAfter.reduce((s, d) => s + d.amount, 0),
  };
}
