import {
  advance,
  periodDaysFor,
  type Cadence,
  type Series,
  type Txn,
} from "./recurring";
import { normalisePayee, displayPayee } from "./payee";

/* A bill you know about and history cannot show yet.
 *
 * The detector needs three payments, or two identical ones exactly a period
 * apart. That strictness is deliberate — it is what stopped two unrelated
 * Sam's Club trips becoming an obligation — but it means a NEW bill is
 * invisible for one to three cycles, which is exactly when being wrong
 * about it costs the most.
 *
 * So a merchant you have paid at least ONCE can be declared recurring:
 * you supply the rhythm, the app supplies the rest from the payment that
 * already happened. The anchor is that payment's date, so the schedule
 * starts from real money rather than from the day you happened to tap the
 * button.
 *
 * Still backed by a real transaction, deliberately. Every fixed cost in
 * this app traces to money that actually moved, which is what makes the
 * list auditable: there is no row whose origin is "somebody typed it".
 */

export interface ManualInput {
  /** the user's rows, keyed by normalised payee */
  decisions: Record<
    string,
    { decision: string; override_amount?: number | null; override_cadence?: Cadence | null } | undefined
  >;
  /** the same transactions the detector was given */
  txns: Txn[];
  /** what the detector already found, so this only fills the gaps */
  detected: Series[];
}

const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** Series for payees kept as fixed that the detector did not find.
 *
 *  Returns nothing for a payee the detector DID find: declaring a rhythm is
 *  a correction there, handled by the cadence override, and producing a
 *  second series for the same payee would count the bill twice. */
export function manualSeries(input: ManualInput): Series[] {
  const { decisions, txns, detected } = input;
  const found = new Set(detected.map((s) => normalisePayee(s.payee)));

  const byKey = new Map<string, Txn[]>();
  for (const t of txns) {
    const k = normalisePayee(t.merchant || t.description);
    if (!k) continue;
    const row = decisions[k];
    if (row?.decision !== "fixed" || found.has(k)) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), t]);
  }

  const out: Series[] = [];
  for (const [key, group] of byKey) {
    const row = decisions[key]!;
    const sorted = [...group].sort((a, b) => (a.date < b.date ? -1 : 1));
    const latest = sorted[sorted.length - 1];
    const direction: "in" | "out" = latest.amount > 0 ? "in" : "out";
    const cadence: Cadence = row.override_cadence ?? "monthly";
    const amount = row.override_amount ?? median(sorted.map((t) => Math.abs(t.amount)));

    const base: Series = {
      key: `${key}|${direction}|manual`,
      payee: displayPayee(latest.merchant || latest.description),
      direction,
      cadence,
      periodDays: periodDaysFor(cadence),
      /* Declared, not observed. onTime describes how reliably a rhythm has
         ARRIVED, and nothing has been observed arriving on this one yet —
         claiming 1 would dress a guess up as a track record. */
      onTime: 0,
      anchors: [Number(latest.date.slice(8, 10))],
      amount,
      amountSpread: 0,
      hits: sorted.length,
      lastSeen: latest.date,
      nextDue: latest.date, // replaced below, once periodDays is in place
      confidence: 0,
      txnIds: sorted.map((t) => t.id),
    };
    out.push({ ...base, nextDue: advance(base, latest.date) });
  }
  return out;
}
