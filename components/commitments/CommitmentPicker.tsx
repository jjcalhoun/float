"use client";

import { useState } from "react";
import { Chip } from "@/components/ui/Chip";
import { fmt, shortDate } from "@/lib/format";
import { splitCandidates } from "@/lib/commitments/picker";
import type { Candidate } from "@/lib/commitments/match";
import type { Commitment } from "@/lib/commitments/types";

/* "Fulfills a planned payment?" — the plan-line picker.
 *
 * This markup lived twice, in ReviewFlow and in TransactionEditor, and had
 * already drifted: different backgrounds, different click handlers, and one
 * of them quietly missing changes made to the other. It is one control and it
 * is now one component.
 *
 * Claimed lines — occurrences some other payment has already settled — are
 * kept selectable rather than hidden, because the reason you are looking at
 * one is usually that an earlier match was wrong. But they outnumber the
 * useful chips badly (a three-month window of a weekly series is a dozen-plus
 * on its own), so they collapse behind a count and, once open, show only the
 * ones near this payment's date. See lib/commitments/picker.ts for what that
 * cap will and will not hide.
 */

export interface CommitmentPickerProps {
  candidates: Candidate[];
  /** currently chosen occurrences — more than one means a lump payment */
  selected: string[];
  onToggle: (id: string) => void;
  onClear: () => void;
  /** the pre-selected line, if the matcher was confident enough to offer one */
  suggested?: Commitment | null;
  /** the payment's date — the centre of the claimed-line window */
  date?: string | null;
  /** picker sits on --color-surface in review, --color-elevated in the editor */
  background?: string;
}

export function CommitmentPicker({
  candidates,
  selected,
  onToggle,
  onClear,
  suggested,
  date,
  background = "var(--color-surface)",
}: CommitmentPickerProps) {
  const [showClaimed, setShowClaimed] = useState(false);
  const [showFar, setShowFar] = useState(false);

  const { open, claimedNear, claimedFar } = splitCandidates(candidates, { date, selected });
  const claimedCount = claimedNear.length + claimedFar.length;

  // A claimed line you have already picked has to be visible from the start —
  // otherwise the "covers N occurrences" line below counts a chip you cannot
  // see, which is precisely the confusion this picker used to cause.
  const hasPickedClaimed = claimedNear.some((c) => selected.includes(c.commitment.id));
  const claimedOpen = showClaimed || hasPickedClaimed;

  const plannedTotal = candidates
    .filter((c) => selected.includes(c.commitment.id))
    .reduce((s, c) => s + c.commitment.amount, 0);

  const chip = (c: Candidate, dim = false) => (
    <Chip
      key={c.commitment.id}
      active={selected.includes(c.commitment.id)}
      dim={dim && !selected.includes(c.commitment.id)}
      onClick={() => onToggle(c.commitment.id)}
    >
      {chipLabel(c.commitment)}
    </Chip>
  );

  return (
    <div
      className="rounded-[10px] p-3 space-y-2.5"
      style={{
        background,
        border: selected.length > 0 ? "1px solid var(--color-primary)" : "1px solid transparent",
      }}
    >
      <p className="text-sm" style={{ color: "var(--color-text)" }}>
        {suggested && selected.length === 1 && selected[0] === suggested.id ? (
          <>
            Looks like: <span className="font-semibold">{suggested.name}</span>
          </>
        ) : (
          "Fulfills a planned payment?"
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        <Chip active={selected.length === 0} onClick={onClear}>
          None
        </Chip>
        {open.map((c) => chip(c))}
      </div>

      {selected.length > 1 && (
        <p className="text-xs" style={{ color: "var(--color-faint)" }}>
          Covers {selected.length} occurrences · {fmt(plannedTotal)} planned
        </p>
      )}

      {claimedCount > 0 && (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowClaimed((v) => !v)}
            className="flex items-center gap-1 text-xs font-semibold"
            style={{ color: "var(--color-faint)" }}
          >
            {/* aria-hidden: the ligature name is real text, and without this a
                screen reader announces "expand_more Claimed (2)" */}
            <span className="material-symbols-outlined" aria-hidden style={{ fontSize: 16 }}>
              {claimedOpen ? "expand_less" : "expand_more"}
            </span>
            Claimed ({claimedCount})
          </button>

          {claimedOpen && (
            <>
              <div className="flex flex-wrap gap-2">
                {claimedNear.map((c) => chip(c, true))}
                {showFar && claimedFar.map((c) => chip(c, true))}
              </div>
              {claimedFar.length > 0 && !showFar && (
                <button
                  type="button"
                  onClick={() => setShowFar(true)}
                  className="text-xs underline"
                  style={{ color: "var(--color-faint)" }}
                >
                  Show {claimedFar.length} further from this date
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Chip text: name, date, amount. Claim state is conveyed by dimming and the
 *  Claimed group, not by words. */
function chipLabel(i: { name: string; due_hint?: string | null; amount: number }): string {
  const parts = [i.name];
  if (i.due_hint) parts.push(shortDate(i.due_hint));
  parts.push(fmt(i.amount));
  return parts.join(" · ");
}
