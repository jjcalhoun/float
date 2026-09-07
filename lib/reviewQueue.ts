import type { Transaction } from "@/lib/types";

/* The review queue.
 *
 * It is a SNAPSHOT rather than a live filter, and that part is right: as you
 * review, each item stops being unreviewed, so a live list would delete the
 * row under your finger and shuffle everything after it. Freezing the order
 * keeps "next" meaning next.
 *
 * What was wrong is that it froze ONCE — on the first render where anything
 * was unreviewed — and then refused to grow:
 *
 *     if (queue.length === 0 && unreviewed.length > 0) setQueue(unreviewed);
 *
 * Transactions arrive in stages: React Query serves a cached page first and
 * the fresh fetch a moment later, the date window widens, a background sync
 * finishes. Whatever had loaded at that instant became the whole queue, and
 * everything after it was invisible until the screen was closed and reopened —
 * which remounts, resets to empty, and snapshots again. Hence "it says I'm
 * done, but there are more, and leaving and coming back finds them".
 *
 * So: seed once, then APPEND anything new at the end. Existing entries keep
 * their positions, so nothing moves while you work, and late arrivals are
 * picked up without losing your place.
 */

/** Merge newly-seen unreviewed transactions into the queue, preserving order.
 *
 *  Returns the SAME array when there is nothing to add — the caller stores
 *  this in state, and a fresh array every render would loop forever. */
export function mergeQueue(current: Transaction[], unreviewed: Transaction[]): Transaction[] {
  if (unreviewed.length === 0) return current;
  const seen = new Set(current.map((t) => t.id));
  const extra = unreviewed.filter((t) => !seen.has(t.id));
  return extra.length === 0 ? current : [...current, ...extra];
}

/** Where to move next, skipping anything already reviewed behind our back.
 *
 *  Reviewing one leg of a transfer auto-reviews its counterpart, so the queue
 *  can contain entries that no longer need you. Returns the current index when
 *  nothing needs skipping, so the caller can avoid a pointless state update. */
export function nextIndex(
  index: number,
  queue: Transaction[],
  isReviewed: (id: string) => boolean,
): number {
  let i = index;
  while (i < queue.length && isReviewed(queue[i].id)) i++;
  return i;
}
