import { reschedule, type Cadence, type Series } from "./recurring";

/* What you told the app, over what it worked out.
 *
 * Inference is right almost always and wrong exactly when something has just
 * changed. A raise, or child support moving from $412 a fortnight to $231 a
 * week, takes three occurrences to shift the median — and until then the app
 * predicts the old figure with complete confidence, which is the worst
 * combination available. You already know the new number.
 *
 * Clearing the override resumes inference, so this stays a correction rather
 * than a second set of figures to keep up to date.
 */

export interface Override {
  override_amount?: number | null;
  /** replaces the detected rhythm, and with it the predicted dates */
  override_cadence?: Cadence | null;
  /** "I'm paid up through here" — see 0024_paid_through.sql */
  paid_through?: string | null;
}

export function applyOverrides(
  series: Series[],
  byKey: Record<string, Override | undefined>,
  keyOf: (s: Series) => string,
): Series[] {
  return series.map((s) => {
    const row = byKey[keyOf(s)];
    if (!row) return s;
    const {
      override_amount: amount,
      override_cadence: cadence,
      paid_through: paidThrough,
    } = row;
    if (amount == null && cadence == null && paidThrough == null) return s;
    /* Cadence first: it recomputes the next due date from the last payment
       actually seen, and the other two only decorate what comes out. */
    const base = cadence == null ? s : reschedule(s, cadence);
    return {
      ...base,
      ...(amount == null ? {} : { amount, amountSpread: 0 }),
      ...(paidThrough == null ? {} : { paidThrough }),
    };
  });
}
