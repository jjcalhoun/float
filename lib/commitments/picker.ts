import type { Candidate } from "./match";

/* What the plan-line picker actually shows.
 *
 * The picker scores every occurrence in a three-month window, and with weekly
 * series that is sixty-odd chips. Most of them are claimed — already settled
 * by some other payment — and they are shown because occasionally the reason
 * you are here is that an earlier match was wrong and you need to take it
 * back. That is real, and rare. Meanwhile the list you nearly always want,
 * the unclaimed lines, is pushed off the bottom of a phone screen.
 *
 * So the Claimed group collapses, and when open it is capped to lines near
 * the payment's own date. Two rules keep the cap from ever hiding something
 * that matters:
 *
 *   - a claimed line you have SELECTED is always visible, however far out it
 *     sits. Hiding an active selection is how you end up staring at a chip
 *     count that disagrees with the chips.
 *   - a line with no date at all is never filtered by date. There is nothing
 *     to measure it against, and silently dropping it would make a legitimate
 *     target unreachable.
 *
 * Note this trims DISPLAY only. Scoring, pre-selection and the claimed-versus-
 * open split all happen upstream in match.ts and are untouched — a chip that
 * would have won on score still wins, it just may be behind "Show all".
 */

export interface PickerGroups {
  /** unclaimed lines — always shown in full, this is the common case */
  open: Candidate[];
  /** claimed lines near the payment's date, plus any that are selected */
  claimedNear: Candidate[];
  /** claimed lines outside the window, behind "Show all" */
  claimedFar: Candidate[];
}

export interface PickerOptions {
  /** the payment's own date, as the centre of the window */
  date?: string | null;
  /** half-width of the window in days; ~1.5 months either side by default */
  days?: number;
  /** currently selected commitment ids — these are never trimmed away */
  selected?: string[];
}

const daysApart = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/** Split the ranked candidates into what the picker renders where.
 *
 *  Order within each group is preserved exactly as it arrives, because
 *  orderForDisplay has already decided it. */
export function splitCandidates(
  candidates: Candidate[],
  opts: PickerOptions = {},
): PickerGroups {
  const days = opts.days ?? 45;
  const anchor = opts.date;
  const selected = new Set(opts.selected ?? []);

  const open: Candidate[] = [];
  const claimedNear: Candidate[] = [];
  const claimedFar: Candidate[] = [];

  for (const c of candidates) {
    if (!c.claimedBy) {
      open.push(c);
      continue;
    }
    const due = c.commitment.due_hint;
    const near =
      selected.has(c.commitment.id) || // an active choice is never hidden
      !anchor ||
      !due || // nothing to measure — leave it reachable
      daysApart(anchor, due) <= days;
    (near ? claimedNear : claimedFar).push(c);
  }

  return { open, claimedNear, claimedFar };
}
