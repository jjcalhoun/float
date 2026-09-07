import { describe, it, expect } from "vitest";
import { splitCandidates } from "./picker";
import type { Candidate } from "./match";
import type { Commitment } from "./types";
import type { Transaction } from "@/lib/types";

/* The Claimed list got long. A three-month window of weekly series is sixty-odd
   chips, nearly all of them claimed, and they push the handful of unclaimed
   lines — the ones you almost always want — off the bottom of the screen.

   The cap is display-only. It must never make a line unreachable that the
   reviewer is actually using, which is what the pinning and dateless rules
   below are for. */

const c = (id: string, due: string | null, claimed = false): Candidate => ({
  commitment: { id, name: "Child support", due_hint: due, amount: -412 } as Commitment,
  score: 0.5,
  claimedBy: claimed ? ({ id: `t-${id}` } as Transaction) : undefined,
});

const ids = (xs: Candidate[]) => xs.map((x) => x.commitment.id);

describe("splitCandidates", () => {
  it("never trims the unclaimed lines", () => {
    // these are the point of the picker; however far out they sit, they show
    const far = [c("a", "2026-01-01"), c("b", "2026-12-01")];
    const g = splitCandidates(far, { date: "2026-06-15" });
    expect(ids(g.open)).toEqual(["a", "b"]);
    expect(g.claimedFar).toEqual([]);
  });

  it("keeps claimed lines within the window", () => {
    const g = splitCandidates([c("near", "2026-07-01", true)], { date: "2026-06-15", days: 45 });
    expect(ids(g.claimedNear)).toEqual(["near"]);
    expect(g.claimedFar).toEqual([]);
  });

  it("sets aside claimed lines outside it", () => {
    const g = splitCandidates([c("far", "2026-09-30", true)], { date: "2026-06-15", days: 45 });
    expect(g.claimedNear).toEqual([]);
    expect(ids(g.claimedFar)).toEqual(["far"]);
  });

  it("counts either direction from the payment", () => {
    const g = splitCandidates(
      [c("before", "2026-05-10", true), c("after", "2026-07-20", true)],
      { date: "2026-06-15", days: 45 },
    );
    expect(ids(g.claimedNear)).toEqual(["before", "after"]);
  });

  it("keeps a SELECTED claimed line visible however far out it is", () => {
    // hiding an active selection is how you get a chip count that disagrees
    // with the chips — exactly the failure this picker had before
    const g = splitCandidates([c("old", "2025-01-01", true)], {
      date: "2026-06-15",
      selected: ["old"],
    });
    expect(ids(g.claimedNear)).toEqual(["old"]);
    expect(g.claimedFar).toEqual([]);
  });

  it("keeps a dateless claimed line, since there is nothing to measure", () => {
    const g = splitCandidates([c("nodate", null, true)], { date: "2026-06-15" });
    expect(ids(g.claimedNear)).toEqual(["nodate"]);
  });

  it("caps nothing when the payment itself has no date", () => {
    const g = splitCandidates([c("x", "2020-01-01", true)], { date: null });
    expect(ids(g.claimedNear)).toEqual(["x"]);
  });

  it("preserves the order it was given", () => {
    // orderForDisplay already decided this; re-sorting here would fight it
    const g = splitCandidates(
      [c("c3", "2026-06-20", true), c("c1", "2026-06-01", true), c("c2", "2026-06-10", true)],
      { date: "2026-06-15" },
    );
    expect(ids(g.claimedNear)).toEqual(["c3", "c1", "c2"]);
  });

  it("loses nothing — every candidate lands in exactly one group", () => {
    const all = [
      c("open1", "2026-06-01"),
      c("open2", null),
      c("near", "2026-06-20", true),
      c("far", "2027-01-01", true),
      c("pinned", "2020-01-01", true),
      c("nodate", null, true),
    ];
    const g = splitCandidates(all, { date: "2026-06-15", selected: ["pinned"] });
    const out = [...ids(g.open), ...ids(g.claimedNear), ...ids(g.claimedFar)].sort();
    expect(out).toEqual(ids(all).sort());
  });

  it("the reported shape: a long claimed list collapses to a handful", () => {
    // ~13 weeks of a weekly series across the three-month window
    const weekly = Array.from({ length: 13 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 4, 1 + i * 7));
      return c(`w${i}`, d.toISOString().slice(0, 10), true);
    });
    const g = splitCandidates([c("this-one", "2026-06-18"), ...weekly], { date: "2026-06-18" });
    expect(ids(g.open)).toEqual(["this-one"]);
    expect(g.claimedNear.length).toBeLessThan(weekly.length);
    expect(g.claimedNear.length + g.claimedFar.length).toBe(weekly.length);
  });
});
