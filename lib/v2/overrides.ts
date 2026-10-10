import type { Series } from "./recurring";

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
}

export function applyOverrides(
  series: Series[],
  byKey: Record<string, Override | undefined>,
  keyOf: (s: Series) => string,
): Series[] {
  return series.map((s) => {
    const o = byKey[keyOf(s)]?.override_amount;
    return o == null ? s : { ...s, amount: o, amountSpread: 0 };
  });
}
