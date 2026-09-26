import type { Transaction } from "@/lib/types";
import type { Commitment } from "./types";

/* Income that arrived and was never matched to the plan line expecting it.
 *
 * This one is expensive, because it counts the same money twice. The plan line
 * counts from the 1st whether or not the deposit shows up; the deposit, if
 * nothing links it, counts again as income beyond the plan. A paycheck that
 * slipped through review therefore INFLATES the month by its whole value, and
 * nothing on any screen says so — August read $6,979 of income against a real
 * $4,631.
 *
 * Why it slips: two paydays a month are identical apart from their date, so
 * the matcher refuses to pre-select either (see suggestCommitment — a
 * suggestion has to be clearly better than the runner-up). You review the
 * deposit, nothing is offered, you move on. Every month.
 *
 * A deposit is only reported here when the plan is genuinely still expecting
 * money of that size. Real windfalls — a refund, a gift, a side job — are
 * extra income and belong in the number, so they are left alone.
 */

export interface UnmatchedIncome {
  txn: Transaction;
  /** the plan line it most likely belongs to */
  expected: Commitment;
  /** how far apart the amounts are, as a fraction of the planned figure */
  drift: number;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const days = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000;

/** Unlinked income that looks like it belongs to an unfilled income line.
 *
 *  Deliberately narrow: same period, amount within 5%, and either the names
 *  agree or the deposit lands within a fortnight of the line's date. Being
 *  wrong here means telling someone their income is overstated when it isn't,
 *  so the bar is "this is plainly the paycheck", not "this might be". */
export function findUnmatchedIncome(
  commitments: Commitment[],
  transactions: Transaction[],
  period: string,
  opts: { amountTolPct?: number; dayTol?: number } = {},
): UnmatchedIncome[] {
  const tol = (opts.amountTolPct ?? 5) / 100;
  const dayTol = opts.dayTol ?? 14;

  // Income lines in this period that nothing has settled yet.
  const settled = new Set(
    transactions.map((t) => t.commitment_id).filter((id): id is string => !!id),
  );
  const open = commitments.filter(
    (c) =>
      c.kind === "income" &&
      c.period === period &&
      !c.skipped &&
      !c.covered_by &&
      !settled.has(c.id),
  );
  if (open.length === 0) return [];

  const taken = new Set<string>();
  const out: UnmatchedIncome[] = [];

  for (const t of transactions) {
    if (t.commitment_id) continue;
    // Already answered: the user said this one is not from the plan. It still
    // counts as extra income — that was always true — it just stops asking.
    if (t.plan_exempt) continue;
    if (t.type !== "income") continue;
    if (t.date.slice(0, 7) !== period) continue;

    const mTxn = norm(t.merchant || t.description || "");
    let best: { c: Commitment; drift: number; gap: number } | null = null;

    for (const c of open) {
      if (taken.has(c.id)) continue;
      const planned = Math.abs(c.amount);
      if (planned <= 0) continue;
      const drift = Math.abs(Math.abs(t.amount) - planned) / planned;
      if (drift > tol) continue;

      const mC = norm(c.name);
      const nameHit = !!mTxn && !!mC && (mTxn === mC || mTxn.includes(mC) || mC.includes(mTxn));
      const gap = c.due_hint ? days(t.date, c.due_hint) : Infinity;
      if (!nameHit && gap > dayTol) continue;

      // nearest date wins among equally plausible lines — with two paydays a
      // month that is the only thing distinguishing them
      if (!best || gap < best.gap) best = { c, drift, gap };
    }

    if (best) {
      taken.add(best.c.id);
      out.push({ txn: t, expected: best.c, drift: best.drift });
    }
  }

  return out.sort((a, b) => Math.abs(b.txn.amount) - Math.abs(a.txn.amount));
}

/** What the month is overstated by while these stay unmatched. */
export const overstatedBy = (rows: UnmatchedIncome[]): number =>
  rows.reduce((s, r) => s + Math.abs(r.txn.amount), 0);
