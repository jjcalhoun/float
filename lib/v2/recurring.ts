import { normalisePayee, displayPayee } from "./payee";

/* Finding what repeats, from what already happened.
 *
 * v1 asked you to curate a plan and then spent its life reconciling that plan
 * against reality. Almost every bug it had lived on that seam. This infers the
 * plan from the transactions instead, so there is only one model of the month.
 *
 * THE TEST IS CADENCE, NOT COUNT. "Three or more times" is the obvious rule
 * and it is wrong: Sam's Club appears 57 times in four months and is not a
 * recurring payment, it is how the groceries get bought. What separates a
 * standing obligation from a habit is REGULARITY — $412 every fourteen days,
 * against Sam's Club's one-to-five-day scatter. So the gaps between
 * occurrences have to be consistent, and nothing faster than weekly counts.
 *
 * WHOLE PAYEE FIRST, AMOUNT CLUSTERS ONLY IF THAT FAILS. One payee is not
 * always one obligation — the same Zelle recipient gets $412 every fortnight
 * AND ad-hoc amounts of $20, $39, $74 — so a fallback splits a payee by
 * amount and looks for a regular subseries.
 *
 * But that fallback must not run first. Clustering Duke Energy's $142/$96/$88/
 * $114 by amount shatters an obviously monthly bill into three groups of one,
 * and it disappears. So: test the payee as a whole, and only reach for
 * clustering when the whole is irregular.
 *
 * AMOUNT VARIANCE DOES NOT DISQUALIFY. Duke Energy swings 31% month to month
 * and is obviously a monthly bill. Variance lowers confidence and widens the
 * range shown; it never rejects. The median is what gets predicted, so one
 * spike — or the two $406 payments that should have been $412 — moves nothing.
 */

export interface Txn {
  id: string;
  date: string; // ISO
  amount: number; // signed
  merchant?: string | null;
  description?: string | null;
}

export type Cadence = "weekly" | "biweekly" | "semimonthly" | "monthly" | "quarterly" | "annual";

export interface Series {
  key: string;
  payee: string; // display form
  direction: "in" | "out";
  cadence: Cadence;
  /** the rhythm, in days — what the prediction steps by. Not the median gap:
   *  a monthly series with a month missing has a median gap of 45 and a
   *  period of 30. */
  periodDays: number;
  /** share of gaps that were a single period — how reliably it arrives */
  onTime: number;
  /** median amount, unsigned */
  amount: number;
  /** how much the amount moves, as a fraction of the median */
  amountSpread: number;
  hits: number;
  lastSeen: string;
  nextDue: string;
  /** 0–1. Occurrences, gap consistency and amount stability. */
  confidence: number;
  txnIds: string[];
}

export interface DetectOptions {
  /** fewest occurrences before a series is believed */
  minHits?: number;
  /** share of gaps a cadence must explain to be believed */
  minFit?: number;
  /** amounts within this fraction of each other are the same obligation */
  amountTolerance?: number;
  /** how tight a fallback cluster's amounts must be. The fallback exists to
   *  find a FIXED amount hiding in a noisy payee; letting it accept variable
   *  amounts lets it carve imaginary series out of ordinary shopping. */
  maxClusterSpread?: number;
}

const DAY = 86400000;
const days = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const dayOfMonth = (iso: string) => Number(iso.slice(8, 10));
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Add whole months, clamping to the month's length: the 31st of a 30-day
 *  month is the 30th, not the 1st of the next. */
function addMonths(iso: string, n: number, keepDay?: number): string {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7)) - 1;
  const d = keepDay ?? dayOfMonth(iso);
  const total = m + n;
  const ty = y + Math.floor(total / 12);
  const tm = ((total % 12) + 12) % 12;
  const day = Math.min(d, lastDayOf(ty, tm));
  return `${ty}-${String(tm + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Nothing recurs faster than weekly. This single rule is what keeps Sam's
 *  Club — 57 hits at a median gap of two days — out of your fixed costs. */
const PERIODS: { cadence: Cadence; days: number }[] = [
  { cadence: "weekly", days: 7 },
  { cadence: "biweekly", days: 14 },
  { cadence: "semimonthly", days: 15.2 },
  { cadence: "monthly", days: 30.44 },
  { cadence: "quarterly", days: 91.3 },
  { cadence: "annual", days: 365.25 },
];

export interface Fit {
  cadence: Cadence;
  periodDays: number;
  /** share of gaps explained by the period */
  fit: number;
  /** share of gaps that are a SINGLE period — how often it actually arrived */
  onTime: number;
  /** mean days of slop in the gaps it did explain */
  residual: number;
}

/* Which rhythm these dates are keeping, if any.
 *
 * The first version measured variance in the raw gaps, and that was wrong in a
 * way that cost real obligations. A mortgage paid monthly but captured four
 * times across five months has one gap of sixty-one days, and raw variance
 * reads that as chaos — so the mortgage, Smithville and Philo were all thrown
 * out for the crime of a missing row.
 *
 * A missed occurrence is not irregularity. Sixty-one days is two months, not
 * noise. So each gap is explained as a WHOLE NUMBER of periods and judged on
 * the leftover: at 30.44 days, a 61-day gap is two periods with half a day
 * unaccounted for, which is an excellent fit.
 *
 * The danger in being this permissive is that every period explains every gap
 * if enough skips are allowed — a fortnightly series "fits" weekly with every
 * other one missing. Two rules stop that: the base period must have been
 * observed at least once, and the candidate that explains the most gaps as a
 * SINGLE period wins. */
function fitCadence(gaps: number[], minFit: number): Fit | null {
  let best: Fit | null = null;

  for (const { cadence, days: P } of PERIODS) {
    /* Generous enough for a weekend's slippage, tight enough that a period
       cannot absorb its neighbour.
       The width is load-bearing. At a quarter of the period, a week tolerates
       ±3 days, which means nearly any scatter of small gaps "fits weekly" —
       the Zelle payee, ad-hoc transfers and all, sailed through as a weekly
       obligation and buried the $412 series that was the point. At 22% a
       fortnight still absorbs its real ±3 jitter while a week stops swallowing
       everything near it.
       The absolute cap matters at the long end: 22% of a quarter is twenty
       days, which is loose enough to read three scattered payments months
       apart as a quarterly bill. Nothing real drifts more than about ten days
       from its rhythm. */
    const tol = Math.min(Math.max(2.5, P * 0.22), 10);
    const ratios = gaps.map((g) => {
      const r = Math.round(g / P);
      return r >= 1 && Math.abs(g - r * P) <= tol ? r : null;
    });

    const fitted = ratios.filter((r): r is number => r !== null);
    if (fitted.length === 0) continue;

    const fit = fitted.length / gaps.length;
    if (fit < minFit) continue;

    // You have to have actually seen the rhythm, not just a multiple of it.
    const onTimeCount = fitted.filter((r) => r === 1).length;
    if (onTimeCount === 0) continue;

    // Three skips in a row is not a cadence, it is a coincidence.
    if (median(fitted) > 3) continue;

    const onTime = onTimeCount / gaps.length;
    let slop = 0;
    ratios.forEach((r, i) => {
      if (r !== null) slop += Math.abs(gaps[i] - r * P);
    });
    const residual = slop / fitted.length;

    /* Ranked by how often it arrived on the period, then by how much it
       explains, then by how little slop is left over.
       The last of those is not a tidiness preference. Semimonthly pay is a
       15/16 alternation, which fits a 14-day period just as "often" as a
       15.2-day one — and the fortnightly reading put the next paycheck a day
       early, every time, on the date the entire horizon hangs from. The
       residual is what tells them apart. */
    const better =
      !best ||
      onTime > best.onTime ||
      (onTime === best.onTime && fit > best.fit) ||
      (onTime === best.onTime && fit === best.fit && residual < best.residual);
    if (better) best = { cadence, periodDays: P, fit, onTime, residual };
  }

  return best;
}

/** When the next one falls.
 *
 *  Not simply "last seen plus the median gap". A monthly bill lands on the
 *  same DAY each month, not every 30.5 days, and the difference compounds.
 *  Semimonthly is worse: ADP pays on the 15th and the last day, which is a
 *  15/16/15/16 alternation that no single gap describes — predicting by the
 *  median put the next paycheck a day late, and the paycheck is what the
 *  whole horizon is anchored to. */
function nextAfter(dates: string[], cadence: Cadence, periodDays: number): string {
  const last = dates[dates.length - 1];

  if (cadence === "weekly" || cadence === "biweekly") return addDays(last, Math.round(periodDays));
  if (cadence === "monthly") return addMonths(last, 1);
  if (cadence === "quarterly") return addMonths(last, 3);
  if (cadence === "annual") return addMonths(last, 12);

  // Semimonthly: find the two days of the month it actually lands on, and
  // alternate between them. "Late in the month" is treated as the month's
  // end, so February behaves.
  const dom = dates.map(dayOfMonth);
  const early = Math.round(median(dom.filter((d) => d <= 20)) || 15);
  const lateVals = dom.filter((d) => d > 20);
  const isEom = lateVals.length > 0 && Math.min(...lateVals) >= 28;

  if (dayOfMonth(last) <= 20) {
    const y = Number(last.slice(0, 4));
    const m = Number(last.slice(5, 7)) - 1;
    const day = isEom ? lastDayOf(y, m) : Math.round(median(lateVals) || 30);
    return `${last.slice(0, 7)}-${String(Math.min(day, lastDayOf(y, m))).padStart(2, "0")}`;
  }
  return addMonths(last, 1, early);
}

/** Split a payee's occurrences into amount clusters: the $412 fortnightly
 *  series and the ad-hoc $20s are not the same obligation. */
function clusterByAmount(txns: Txn[], tolerance: number): Txn[][] {
  const sorted = [...txns].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount));
  const out: Txn[][] = [];
  let group: Txn[] = [];

  for (const t of sorted) {
    if (group.length === 0) {
      group = [t];
      continue;
    }
    const ref = median(group.map((g) => Math.abs(g.amount)));
    if (Math.abs(Math.abs(t.amount) - ref) <= ref * tolerance) group.push(t);
    else {
      out.push(group);
      group = [t];
    }
  }
  if (group.length > 0) out.push(group);
  return out;
}

/* Suggesting is a different job from deciding, and wants different nerves.
 *
 * While the detector's output WAS the answer, every threshold had to be
 * defensive: a false positive told you your groceries were a fixed cost. Now
 * that nothing counts until it is ticked, a wrong suggestion costs one ignored
 * row — so suggestions can afford to be generous, and the misses that
 * conservatism bought us stop being worth it. Two occurrences instead of
 * three is what finally makes a quarterly bill visible before its third year.
 *
 * The strict defaults stay for anything that uses detection as an answer
 * rather than a proposal. */
export const SUGGEST: DetectOptions = {
  minHits: 2,
  minFit: 0.6,
};

/** Everything that repeats, most confident first. */
export function detectSeries(txns: Txn[], opts: DetectOptions = {}): Series[] {
  const minHits = opts.minHits ?? 3;
  const minFit = opts.minFit ?? 0.75;
  const amountTolerance = opts.amountTolerance ?? 0.15;
  const maxClusterSpread = opts.maxClusterSpread ?? 0.05;

  const byPayee = new Map<string, Txn[]>();
  for (const t of txns) {
    const key = normalisePayee(t.merchant || t.description);
    if (!key) continue;
    const arr = byPayee.get(key);
    if (arr) arr.push(t);
    else byPayee.set(key, [t]);
  }

  const out: Series[] = [];

  for (const [key, all] of byPayee) {
    // Inflows and outflows at one payee are different things — a refund is
    // not income, which is how "Sam's Club" turned up among the paychecks.
    for (const direction of ["in", "out"] as const) {
      const side = all.filter((t) => (direction === "in" ? t.amount > 0 : t.amount < 0));
      if (side.length < minHits) continue;

      // The payee read as one obligation, which is the common case...
      const whole = buildSeries(key, direction, side, minHits, minFit);

      /* ...and the same payee read as separate obligations at separate
         amounts. The amount has to be near-fixed for these: without that,
         random shopping gets carved into clusters that happen to be evenly
         spaced and Sam's Club acquires standing obligations it never had. */
      const clustered = clusterByAmount(side, amountTolerance)
        .map((c) => buildSeries(key, direction, c, minHits, minFit))
        .filter((s): s is Series => !!s && s.amountSpread <= maxClusterSpread);

      /* Whichever reading explains the payee better.
         Taking the whole whenever it merely passes was wrong. Philo bills $25
         monthly with one prorated $3.07 at the start: as a whole that is a
         0.64-confidence series with a bogus twelve-day gap, while the $25
         cluster alone is a flawless monthly at 0.85. Reading it whole also
         keeps the one-off inside the obligation, which is the opposite of
         true. Duke Energy goes the other way — its amounts vary so no cluster
         survives, and the whole is the only honest reading. */
      const bestCluster = clustered.reduce<Series | null>(
        (b, s) => (!b || s.confidence > b.confidence ? s : b),
        null,
      );

      if (whole && (!bestCluster || whole.confidence >= bestCluster.confidence)) out.push(whole);
      else out.push(...clustered);
    }
  }

  return out.sort((a, b) => b.confidence - a.confidence || b.amount - a.amount);
}

/** One candidate series, or null if these occurrences are not regular. */
function buildSeries(
  key: string,
  direction: "in" | "out",
  txns: Txn[],
  minHits: number,
  minFit: number,
): Series | null {
  if (txns.length < minHits) return null;

  const dates = [...new Set(txns.map((t) => t.date))].sort();
  if (dates.length < minHits) return null;

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(days(dates[i - 1], dates[i]));

  const f = fitCadence(gaps, minFit);
  if (!f) return null;

  const amounts = txns.map((t) => Math.abs(t.amount));
  const amt = median(amounts);
  const amountSpread =
    amt === 0 ? 0 : Math.sqrt(amounts.reduce((s, a) => s + (a - amt) ** 2, 0) / amounts.length) / amt;

  /* Two occurrences is one gap, and one gap always "fits" something — there
     is no regularity to measure, only a coincidence to rationalise. Sam's
     Club duly produced obligations out of pairs of unrelated shopping trips.
     So a pair has to earn it another way: the amounts must be identical, and
     the single gap must be exactly one period rather than a multiple, since
     you cannot infer a skip from one observation. */
  if (dates.length < 3 && (amountSpread > 0.001 || f.onTime < 1)) return null;

  return {
    key: `${key}|${direction}|${amt.toFixed(2)}`,
    payee: displayPayee(txns[0].merchant || txns[0].description || key),
    direction,
    cadence: f.cadence,
    periodDays: f.periodDays,
    onTime: f.onTime,
    amount: amt,
    amountSpread,
    hits: dates.length,
    lastSeen: dates[dates.length - 1],
    nextDue: nextAfter(dates, f.cadence, f.periodDays),
    confidence: confidenceOf(dates.length, f, amountSpread),
    txnIds: txns.map((t) => t.id),
  };
}

/** More occurrences, steadier gaps and steadier amounts all help; gaps matter
 *  most, because that is what a prediction is made of. */
function confidenceOf(hits: number, f: Fit, amountSpread: number): number {
  const byHits = Math.min(1, (hits - 2) / 4); // 3 hits → 0.25, 6+ → 1
  // Arriving on time matters more than merely being explainable: a series
  // that skips half its occurrences is a weak prediction even if every gap
  // is a clean multiple.
  const byRhythm = f.fit * 0.4 + f.onTime * 0.6;
  const byAmount = Math.max(0, 1 - Math.min(amountSpread, 0.5) / 0.5);
  return Math.round((byHits * 0.3 + byRhythm * 0.5 + byAmount * 0.2) * 100) / 100;
}

/** A series whose next occurrence is well past due has probably ended — a
 *  cancelled subscription, or a payment schedule that changed. Letting it fade
 *  is what stops a retired obligation haunting the forecast. */
export function isStale(s: Series, today: string, graceDays = 0): boolean {
  const grace = graceDays || Math.max(3, Math.round(s.periodDays * 0.5));
  return days(s.nextDue, today) > grace;
}

/** Occurrences expected between now and a horizon, inclusive of both ends.
 *  A weekly series can land more than once. */
export function dueBetween(s: Series, from: string, to: string): string[] {
  const out: string[] = [];
  let d = s.nextDue;
  // A stale series still owes its missed occurrence: catch up to `from` first.
  while (days(d, from) > 0) d = addDays(d, Math.round(s.periodDays));
  while (days(d, to) >= 0) {
    out.push(d);
    d = addDays(d, Math.round(s.periodDays));
    if (out.length > 60) break; // nothing sane recurs this often
  }
  return out;
}
