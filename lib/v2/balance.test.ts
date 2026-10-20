import { describe, it, expect } from "vitest";
import { spendableBalance } from "./balance";

describe("which balance wins", () => {
  it("prefers available over posted", () => {
    /* The real case: Chase showed $159.87 available, Float showed $225.00
       posted, and the $65.13 difference was pending card authorisations. */
    const r = spendableBalance([
      { id: "chk", live_balance: 225, live_available_balance: 159.87 },
    ]);
    expect(r.total).toBeCloseTo(159.87, 2);
    expect(r.source).toBe("available");
    expect(r.pending).toBeCloseTo(65.13, 2);
  });

  it("falls back to posted when the bank publishes no available figure", () => {
    const r = spendableBalance([{ id: "chk", live_balance: 225 }]);
    expect(r.total).toBe(225);
    expect(r.source).toBe("posted");
    expect(r.pending).toBe(0);
  });

  it("falls back to the computed balance before the first sync", () => {
    const r = spendableBalance([{ id: "chk" }], { chk: 412.5 });
    expect(r.total).toBe(412.5);
    expect(r.source).toBe("computed");
  });

  it("does not treat a missing balance as zero", () => {
    /* Zero is a number people act on. A confident $0 is worse than an
       obviously-derived figure. */
    const r = spendableBalance([{ id: "chk", live_balance: null }], { chk: 300 });
    expect(r.total).toBe(300);
  });

  it("reports the weakest source across accounts, not the best", () => {
    /* One account on live data does not make the total live. Saying
       "available as of today" over a sum that is half guesswork is the kind
       of confident label that stops anyone checking. */
    const r = spendableBalance(
      [
        { id: "a", live_balance: 100, live_available_balance: 90 },
        { id: "b" },
      ],
      { b: 10 },
    );
    expect(r.total).toBe(100);
    expect(r.source).toBe("computed");
  });

  it("sums pending across accounts, ignoring ones that cannot report it", () => {
    const r = spendableBalance([
      { id: "a", live_balance: 100, live_available_balance: 90 },
      { id: "b", live_balance: 50, live_available_balance: 45 },
      { id: "c", live_balance: 20 },
    ]);
    expect(r.total).toBeCloseTo(155, 2);
    expect(r.pending).toBeCloseTo(15, 2);
  });

  it("handles no accounts without claiming to know anything", () => {
    const r = spendableBalance([]);
    expect(r.total).toBe(0);
    expect(r.source).toBe("computed");
  });

  it("copes with a negative available balance", () => {
    const r = spendableBalance([{ id: "chk", live_balance: 10, live_available_balance: -45 }]);
    expect(r.total).toBe(-45);
    expect(r.pending).toBe(55);
  });
});

describe("showing both figures", () => {
  /* Straight from the account on Monday: Chase reported $1,268.42 posted
     and $0.00 available, and the screen said "available balance · $1,268
     pending" — which reads as though the app has lost the money. */
  const CHECKING = [{ id: "chk", live_balance: 1268.42, live_available_balance: 0 }];

  it("keeps the posted figure so the two can be shown side by side", () => {
    const r = spendableBalance(CHECKING);
    expect(r.total).toBe(0);
    expect(r.posted).toBeCloseTo(1268.42, 2);
  });

  it("says when pending is clamped and therefore a lower bound", () => {
    /* A bank floors available at zero. Once pending exceeds the balance,
       posted minus available can only see as much of it as there was money
       to cover — so the true figure is unknown and larger. */
    expect(spendableBalance(CHECKING).clamped).toBe(true);
  });

  it("is not clamped when available is simply lower", () => {
    const r = spendableBalance([{ id: "sav", live_balance: 560, live_available_balance: 538.49 }]);
    expect(r.clamped).toBe(false);
    expect(r.pending).toBeCloseTo(21.51, 2);
    expect(r.posted).toBe(560);
  });

  it("is not clamped when the account is genuinely empty", () => {
    expect(spendableBalance([{ id: "chk", live_balance: 0, live_available_balance: 0 }]).clamped).toBe(false);
  });

  it("reports posted alongside the other two sources too", () => {
    expect(spendableBalance([{ id: "a", live_balance: 100 }]).posted).toBe(100);
    expect(spendableBalance([{ id: "a" }], { a: 70 }).posted).toBe(70);
  });

  it("still never prefers posted when available is available", () => {
    /* The tempting fix for "my bank says $138 and the app says $0" is to
       fall back to posted. That is the direction that hides an overdraft,
       and this account has just had one. */
    expect(spendableBalance(CHECKING).total).toBe(0);
  });
});
