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

/* Money can move a day or two before the date it is "for": the bank releases
   Friday's pay on Thursday evening, and an autopay set for the 15th posts on
   the 14th. Matching only an exact date would miss all of those.

   The window has to stay well short of the series' own period, or the
   PREVIOUS occurrence starts satisfying this one — three days is harmless
   against a monthly bill and ruinous against a weekly one, where it would
   mark this week's child support paid because last week's went out. */
const GRACE = (s: Series) => Math.min(3, Math.floor(s.periodDays / 3));

/** Has this occurrence already moved through the account?
 *
 *  Only ever asked of a date that has ARRIVED, which is what stops a payment
 *  satisfying an occurrence still in the future and skipping a whole cycle.
 *
 *  For income: on payday morning the money is not there and the honest
 *  horizon is today, because what is left has to last until it clears. By
 *  the afternoon it has cleared, it is in the balance, and a horizon of
 *  "today" turns that balance into a figure you may spend before midnight.
 *
 *  For a bill: the balance already has the payment taken out of it, so
 *  subtracting it again on the day it posts charges you twice.
 *
 *  Either way the same calendar day means two different things on either
 *  side of the transaction, and the transaction is the only way to tell. */
function alreadySettled(s: Series, date: string, today: string): boolean {
  /* Paid in advance. Neither the schedule nor the posted payments can know
     about this: one Zelle for $462 on the 16th covering the 16th and the
     23rd leaves the 23rd looking unpaid, because on the 23rd nothing will
     post. Unlike the test below, this one reaches into the FUTURE — being
     covered until a date is exactly what it means. */
  if (s.paidThrough && date <= s.paidThrough) return true;
  return date <= today && s.lastSeen >= addDays(date, -GRACE(s));
}

/** The next payday: the soonest income occurrence not yet in the bank.
 *
 *  Not simply the soonest occurrence still to come, because on payday itself
 *  that is today, and a horizon of today means nothing is counted as due and
 *  the whole balance — paycheck included — reads as spendable. Once the
 *  deposit has actually landed, the question becomes the next fortnight. */
export function nextPayday(kept: Series[], today: string): string | null {
  const dates = kept
    .filter((s) => s.direction === "in")
    .map((s) => {
      /* 400 days covers an annual series; the occurrences come back in order,
         so the first one still owing is the first that has not been paid. */
      const upcoming = dueBetween(s, today, addDays(today, 400));
      return upcoming.find((d) => !alreadySettled(s, d, today));
    })
    .filter((d): d is string => !!d)
    .sort();
  return dates[0] ?? null;
}

function itemsBetween(
  kept: Series[],
  from: string,
  to: string,
  today: string,
): DueItem[] {
  const out: DueItem[] = [];
  for (const s of kept) {
    if (s.direction !== "out") continue;
    for (const date of dueBetween(s, from, to)) {
      /* Not what has already gone. On the day the mortgage posts, the
         balance is $583 lighter AND the mortgage is still "due today" — so
         it came off the number twice, for one day, every month. */
      if (alreadySettled(s, date, today)) continue;
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

  const due = itemsBetween(kept, today, end, today);
  const dueTotal = due.reduce((s, d) => s + d.amount, 0);

  /* What lands just after payday.
     "Safe until the 15th" invites spending it all on the 14th, and if the
     mortgage goes out on the 16th that was a trap rather than information.
     Showing the week beyond the horizon costs a line and prevents it. */
  const soonAfter = horizon
    ? itemsBetween(kept, addDays(horizon, 1), addDays(horizon, 7), today)
    : [];

  return {
    horizon,
    due,
    dueTotal,
    safe: balance - dueTotal - cardPayment - floor,
    soonAfter,
    soonAfterTotal: soonAfter.reduce((s, d) => s + d.amount, 0),
  };
}
