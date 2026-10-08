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
  /** days between occurrences, median — what the prediction actually uses */
  medianGap: number;
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
  /** how much the gaps may wobble, as a fraction of the median gap */
  maxGapVariation?: number;
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
const MIN_GAP = 6;

function cadenceOf(gap: number): Cadence | null {
  if (gap >= 6 && gap <= 8) return "weekly";
  // Biweekly and semimonthly overlap and are hard to tell apart from gaps
  // alone; both are predicted from the median gap, so the label is cosmetic.
  if (gap >= 12 && gap <= 17) return gap <= 15 ? "biweekly" : "semimonthly";
  if (gap >= 26 && gap <= 35) return "monthly";
  if (gap >= 84 && gap <= 98) return "quarterly";
  if (gap >= 355 && gap <= 375) return "annual";
  return null;
}

/** When the next one falls.
 *
 *  Not simply "last seen plus the median gap". A monthly bill lands on the
 *  same DAY each month, not every 30.5 days, and the difference compounds.
 *  Semimonthly is worse: ADP pays on the 15th and the last day, which is a
 *  15/16/15/16 alternation that no single gap describes — predicting by the
 *  median put the next paycheck a day late, and the paycheck is what the
 *  whole horizon is anchored to. */
function nextAfter(dates: string[], cadence: Cadence, medianGap: number): string {
  const last = dates[dates.length - 1];

  if (cadence === "weekly" || cadence === "biweekly") return addDays(last, Math.round(medianGap));
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

/** Everything that repeats, most confident first. */
export function detectSeries(txns: Txn[], opts: DetectOptions = {}): Series[] {
  const minHits = opts.minHits ?? 3;
  const maxGapVariation = opts.maxGapVariation ?? 0.4;
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

      // The payee as one obligation, which is the common case...
      const whole = buildSeries(key, direction, side, minHits, maxGapVariation);
      if (whole) {
        out.push(whole);
        continue;
      }
      /* ...and only if that is irregular, look for a regular series hiding
         inside it at ONE amount.
         The amount has to be near-fixed. Without that, random shopping gets
         carved into clusters that happen to be evenly spaced, and Sam's Club
         acquires two standing obligations it never had. A genuinely variable
         bill does not need this path — the whole-payee test above found it. */
      for (const cluster of clusterByAmount(side, amountTolerance)) {
        const s = buildSeries(key, direction, cluster, minHits, maxGapVariation);
        if (s && s.amountSpread <= maxClusterSpread) out.push(s);
      }
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
  maxGapVariation: number,
): Series | null {
  if (txns.length < minHits) return null;

  const dates = [...new Set(txns.map((t) => t.date))].sort();
  if (dates.length < minHits) return null;

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(days(dates[i - 1], dates[i]));

  const mg = median(gaps);
  if (mg < MIN_GAP) return null; // a habit, not an obligation

  const cadence = cadenceOf(mg);
  if (!cadence) return null;

  // Consistency, not just typical: a median of 14 built from 2s and 30s is
  // noise wearing a fortnight's clothes.
  const spread = Math.sqrt(gaps.reduce((s, g) => s + (g - mg) ** 2, 0) / gaps.length);
  const variation = spread / mg;
  if (variation > maxGapVariation) return null;

  const amounts = txns.map((t) => Math.abs(t.amount));
  const amt = median(amounts);
  const amountSpread =
    amt === 0 ? 0 : Math.sqrt(amounts.reduce((s, a) => s + (a - amt) ** 2, 0) / amounts.length) / amt;

  return {
    key: `${key}|${direction}|${amt.toFixed(2)}`,
    payee: displayPayee(txns[0].merchant || txns[0].description || key),
    direction,
    cadence,
    medianGap: mg,
    amount: amt,
    amountSpread,
    hits: dates.length,
    lastSeen: dates[dates.length - 1],
    nextDue: nextAfter(dates, cadence, mg),
    confidence: confidenceOf(dates.length, variation, amountSpread),
    txnIds: txns.map((t) => t.id),
  };
}

/** More occurrences, steadier gaps and steadier amounts all help; gaps matter
 *  most, because that is what a prediction is made of. */
function confidenceOf(hits: number, gapVariation: number, amountSpread: number): number {
  const byHits = Math.min(1, (hits - 2) / 4); // 3 hits → 0.25, 6+ → 1
  const byGaps = Math.max(0, 1 - gapVariation / 0.4);
  const byAmount = Math.max(0, 1 - Math.min(amountSpread, 0.5) / 0.5);
  return Math.round((byHits * 0.3 + byGaps * 0.5 + byAmount * 0.2) * 100) / 100;
}

/** A series whose next occurrence is well past due has probably ended — a
 *  cancelled subscription, or a payment schedule that changed. Letting it fade
 *  is what stops a retired obligation haunting the forecast. */
export function isStale(s: Series, today: string, graceDays = 0): boolean {
  const grace = graceDays || Math.max(3, Math.round(s.medianGap * 0.5));
  return days(s.nextDue, today) > grace;
}

/** Occurrences expected between now and a horizon, inclusive of both ends.
 *  A weekly series can land more than once. */
export function dueBetween(s: Series, from: string, to: string): string[] {
  const out: string[] = [];
  let d = s.nextDue;
  // A stale series still owes its missed occurrence: catch up to `from` first.
  while (days(d, from) > 0) d = addDays(d, Math.round(s.medianGap));
  while (days(d, to) >= 0) {
    out.push(d);
    d = addDays(d, Math.round(s.medianGap));
    if (out.length > 60) break; // nothing sane recurs this often
  }
  return out;
}
