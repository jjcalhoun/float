import { describe, it, expect } from "vitest";
import { safeToSpend, nextPayday } from "./safeToSpend";
import { detectSeries, type Txn } from "./recurring";

/* Built from the real account: ADP semimonthly, child support fortnightly,
   the mortgage monthly, Smithville monthly. */

let n = 0;
const t = (date: string, amount: number, merchant: string): Txn => ({
  id: `t${n++}`, date, amount, merchant,
});

const monthly = (payee: string, amount: number, day: string) => {
  const out: Txn[] = [];
  let d = day;
  for (let i = 0; i < 5; i++) {
    out.push(t(d, -amount, payee));
    const dt = new Date(Date.parse(`${d}T00:00:00Z`));
    dt.setUTCMonth(dt.getUTCMonth() + 1);
    d = dt.toISOString().slice(0, 10);
  }
  return out;
};

const ADP: Txn[] = [
  t("2026-07-15", 1845, "ADP Totalsource"),
  t("2026-07-31", 1845, "ADP Totalsource"),
  t("2026-08-14", 1845, "ADP Totalsource"),
  t("2026-08-31", 1845, "ADP Totalsource"),
  t("2026-09-15", 1845, "ADP Totalsource"),
  t("2026-09-30", 1845, "ADP Totalsource"),
];

const CHILD_SUPPORT: Txn[] = [
  t("2026-07-17", -412, "Zelle Transfer to Sarah Brinkman Jpm99a"),
  t("2026-07-31", -412, "Zelle Transfer to Sarah Brinkman Jpm99b"),
  t("2026-08-14", -412, "Zelle Transfer to Sarah Brinkman Jpm99c"),
  t("2026-08-31", -412, "Zelle Transfer to Sarah Brinkman Jpm99d"),
  t("2026-09-11", -412, "Zelle Transfer to Sarah Brinkman Jpm99e"),
  t("2026-09-25", -412, "Zelle Transfer to Sarah Brinkman Jpm99f"),
];

const kept = detectSeries([
  ...ADP,
  ...CHILD_SUPPORT,
  ...monthly("Citizens Bank Mortgage Payment", 583.57, "2026-06-02"),
  ...monthly("Smithville Tele Bill", 74.99, "2026-06-05"),
]);

describe("the horizon", () => {
  it("is the next paycheck", () => {
    // ADP pays the 15th and the last day; on the 8th the next is the 15th
    expect(nextPayday(kept, "2026-10-08")).toBe("2026-10-15");
  });

  it("moves to the end of the month once payday has passed", () => {
    expect(nextPayday(kept, "2026-10-16")).toBe("2026-10-31");
  });

  it("is null when no income has been kept, and the maths still works", () => {
    const noIncome = kept.filter((s) => s.direction === "out");
    const r = safeToSpend({ balance: 2000, kept: noIncome, today: "2026-10-08", floor: 300, cardPayment: 0 });
    expect(r.horizon).toBeNull();
    expect(r.safe).toBeLessThan(2000); // still subtracts a fortnight of bills
  });
});

describe("the number", () => {
  const base = { balance: 2000, kept, today: "2026-10-08", floor: 300, cardPayment: 0 };

  it("is balance minus what is due minus the floor", () => {
    const r = safeToSpend(base);
    expect(r.safe).toBeCloseTo(2000 - r.dueTotal - 300, 2);
  });

  it("counts every occurrence before payday, not just the next one", () => {
    // child support lands fortnightly; a week-long horizon must not miss one
    const r = safeToSpend({ ...base, today: "2026-10-01" });
    const cs = r.due.filter((d) => d.payee.startsWith("Zelle"));
    expect(cs.length).toBeGreaterThanOrEqual(1);
  });

  it("subtracts the card payment you intend to make", () => {
    const without = safeToSpend(base);
    const with600 = safeToSpend({ ...base, cardPayment: 600 });
    expect(without.safe - with600.safe).toBe(600);
  });

  it("respects the floor", () => {
    const a = safeToSpend({ ...base, floor: 0 });
    const b = safeToSpend({ ...base, floor: 300 });
    expect(a.safe - b.safe).toBe(300);
  });

  it("can go negative, and says so rather than clamping", () => {
    // a number that refuses to show a deficit is not worth trusting
    const r = safeToSpend({ ...base, balance: 100 });
    expect(r.safe).toBeLessThan(0);
  });
});

describe("the day after payday", () => {
  it("shows what lands in the week beyond the horizon", () => {
    /* "Safe until the 31st" invites spending it all on the 30th. The mortgage
       goes out on the 2nd, so that would be a trap rather than information. */
    const r = safeToSpend({ balance: 2000, kept, today: "2026-10-20", floor: 300, cardPayment: 0 });
    expect(r.horizon).toBe("2026-10-31");
    expect(r.soonAfter.map((d) => d.payee)).toContain("Citizens Bank Mortgage Payment");
    expect(r.soonAfterTotal).toBeGreaterThan(0);
    expect(r.soonAfter.every((d) => d.date > "2026-10-31")).toBe(true);
  });

  it("never counts the same occurrence on both sides of payday", () => {
    const r = safeToSpend({ balance: 2000, kept, today: "2026-10-08", floor: 300, cardPayment: 0 });
    const overlap = r.due.filter((d) => r.soonAfter.some((a) => a.key === d.key));
    expect(overlap).toEqual([]);
  });
});

describe("a bill due ON payday", () => {
  it("counts against this side of it", () => {
    /* The money has to be in the account that morning. A number that assumes
       the deposit clears first overstates on exactly the day you are most
       likely to look at it. */
    const r = safeToSpend({ balance: 2000, kept, today: "2026-10-08", floor: 300, cardPayment: 0 });
    const onPayday = r.due.filter((d) => d.date === r.horizon);
    const after = r.soonAfter.filter((d) => d.date === r.horizon);
    expect(after).toEqual([]);
    expect(onPayday.every((d) => r.due.includes(d))).toBe(true);
  });
});
