import { describe, it, expect } from "vitest";
import { mergeQueue, nextIndex } from "./reviewQueue";
import type { Transaction } from "@/lib/types";

/* "Sometimes review stops, says I'm done, and there are more — I have to leave
   and go back in."
 *
 * The queue froze on the first render where anything was unreviewed and never
 * grew. Transactions arrive in stages — a cached page, then the fetch; a
 * widening date window; a background sync — so whatever had loaded at that
 * instant became the whole queue. Closing and reopening remounts, resets to
 * empty, and snapshots again, which is why the missing ones then appear.
 *
 * It still has to be a snapshot: reviewing an item makes it not-unreviewed, so
 * a live filter would delete the row under your finger and renumber the rest.
 * The fix is to seed once and APPEND, never reorder or remove. */

const t = (id: string, reviewed = false) =>
  ({ id, user_id: "u", account_id: "chk", date: "2026-08-10", amount: -10,
     type: "expense", source: "sync", reviewed, created_at: "", updated_at: "" }) as Transaction;

describe("mergeQueue", () => {
  it("seeds from an empty queue", () => {
    expect(mergeQueue([], [t("a"), t("b")]).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("appends transactions that arrive later", () => {
    // the reported bug: these used to be dropped forever
    const seeded = mergeQueue([], [t("a"), t("b")]);
    const grown = mergeQueue(seeded, [t("a"), t("b"), t("c"), t("d")]);
    expect(grown.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps existing entries in place, so nothing moves while you work", () => {
    const seeded = mergeQueue([], [t("a"), t("b")]);
    const grown = mergeQueue(seeded, [t("z"), t("a"), t("b")]);
    // z is new but goes to the END — inserting it first would renumber the
    // queue under the reviewer mid-flow
    expect(grown.map((x) => x.id)).toEqual(["a", "b", "z"]);
  });

  it("never duplicates one already queued", () => {
    const seeded = mergeQueue([], [t("a")]);
    expect(mergeQueue(seeded, [t("a"), t("a")]).map((x) => x.id)).toEqual(["a"]);
  });

  it("keeps an entry that has since been reviewed", () => {
    // it's mid-queue and the reviewer is walking past it; removing it would
    // shift everything after. nextIndex skips it instead.
    const seeded = mergeQueue([], [t("a"), t("b")]);
    expect(mergeQueue(seeded, [t("b")]).map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("returns the SAME array when nothing is new", () => {
    // stored in React state — a fresh array every render would loop forever
    const seeded = mergeQueue([], [t("a"), t("b")]);
    expect(mergeQueue(seeded, [t("a"), t("b")])).toBe(seeded);
    expect(mergeQueue(seeded, [])).toBe(seeded);
  });
});

describe("nextIndex", () => {
  const queue = [t("a"), t("b"), t("c")];

  it("stays put when the current item still needs review", () => {
    expect(nextIndex(0, queue, () => false)).toBe(0);
  });

  it("skips items reviewed behind our back", () => {
    // resolving one leg of a transfer auto-reviews its counterpart
    expect(nextIndex(0, queue, (id) => id === "a" || id === "b")).toBe(2);
  });

  it("runs off the end when everything left is done", () => {
    expect(nextIndex(0, queue, () => true)).toBe(3);
  });

  it("never walks backwards", () => {
    expect(nextIndex(2, queue, () => false)).toBe(2);
  });
});

describe("the round trip that was broken", () => {
  it("finishing a short queue then receiving more resumes instead of ending", () => {
    // open review while only two rows have loaded
    let queue = mergeQueue([], [t("a"), t("b")]);
    let index = 0;

    // review both
    const reviewed = new Set(["a", "b"]);
    index = nextIndex(index, queue, (id) => reviewed.has(id));
    expect(index).toBe(2);
    expect(index >= queue.length).toBe(true); // "you're done"

    // the rest of the fetch lands
    queue = mergeQueue(queue, [t("c"), t("d")]);

    // no longer done, and it picks up exactly where the new ones start
    expect(index >= queue.length).toBe(false);
    expect(queue[index].id).toBe("c");
  });
});
