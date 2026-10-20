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
    // 2026-10-31 is a Saturday, so the deposit lands the Friday before
    expect(nextPayday(kept, "2026-10-16")).toBe("2026-10-30");
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
    expect(r.horizon).toBe("2026-10-30");
    expect(r.soonAfter.map((d) => d.payee)).toContain("Citizens Bank Mortgage Payment");
    expect(r.soonAfterTotal).toBeGreaterThan(0);
    expect(r.soonAfter.every((d) => d.date > "2026-10-30")).toBe(true);
  });

  it("never counts the same occurrence on both sides of payday", () => {
    const r = safeToSpend({ balance: 2000, kept, today: "2026-10-08", floor: 300, cardPayment: 0 });
    const overlap = r.due.filter((d) => r.soonAfter.some((a) => a.key === d.key));
    expect(overlap).toEqual([]);
  });
});

describe("a bill due ON payday", () => {
  /* This block used to assert the opposite, and it passed for two weeks
     without testing anything: the fixture had no bill landing on a payday,
     so both sides of the comparison were empty lists. A test that describes
     a rule it cannot observe is worse than no test, because it reads like
     cover. Hence the fixture below, which puts a bill on the 15th on
     purpose. */
  const PAYDAY_BILL = monthly("Citizens Bank Mortgage Payment", 583.57, "2026-05-15");
  const onPaydayKept = detectSeries([...ADP, ...PAYDAY_BILL]);
  const base = { balance: 3000, today: "2026-10-08", floor: 0, cardPayment: 0 };

  it("is paid out of that payday's money, not this fortnight's", () => {
    /* The autopay is drawn against the paycheck arriving the same morning,
       not against what survived the previous fortnight. */
    const r = safeToSpend({ ...base, kept: onPaydayKept });
    expect(r.horizon).toBe("2026-10-15");
    expect(r.due.some((d) => d.date === "2026-10-15")).toBe(false);
  });

  it("is shown in the week after, not silently dropped", () => {
    const r = safeToSpend({ ...base, kept: onPaydayKept });
    expect(r.soonAfter.some((d) => d.date === "2026-10-15")).toBe(true);
    expect(r.soonAfterTotal).toBeGreaterThan(0);
  });

  it("does not reduce the number at all", () => {
    const noBill = safeToSpend({ ...base, kept: detectSeries(ADP) });
    const withBill = safeToSpend({ ...base, kept: onPaydayKept });
    expect(withBill.safe).toBe(noBill.safe);
  });

  it("still falls on the far side when payday moves to the Friday", () => {
    /* 2026-10-31 is a Saturday, so pay lands on the 30th. A bill dated the
       31st is then simply after the horizon — the weekend rule needs no
       special case here, because the horizon is already the shifted date. */
    const endOfMonth = detectSeries([
      ...ADP,
      ...monthly("Department of Education", 221.33, "2026-05-31"),
    ]);
    const r = safeToSpend({ ...base, today: "2026-10-20", kept: endOfMonth });
    expect(r.horizon).toBe("2026-10-30");
    expect(r.due.some((d) => d.payee.startsWith("Department"))).toBe(false);
    expect(r.soonAfter.some((d) => d.payee.startsWith("Department"))).toBe(true);
  });

  it("is still counted on payday MORNING, before the deposit lands", () => {
    /* The horizon is today and there is no day before it to stop at. The
       bill leaves the account today whether or not the deposit beats it,
       and dropping it is the one error that shows more money than exists. */
    const r = safeToSpend({ ...base, today: "2026-10-15", kept: onPaydayKept });
    expect(r.horizon).toBe("2026-10-15");
    expect(r.due.some((d) => d.date === "2026-10-15")).toBe(true);
  });

  it("still counts a bill the day BEFORE payday", () => {
    const eve = detectSeries([...ADP, ...monthly("Verizon", 73.74, "2026-05-14")]);
    const r = safeToSpend({ ...base, kept: eve });
    expect(r.due.some((d) => d.date === "2026-10-14")).toBe(true);
  });

  it("never counts the same occurrence on both sides", () => {
    const r = safeToSpend({ ...base, kept: onPaydayKept });
    expect(r.due.filter((d) => r.soonAfter.some((a) => a.key === d.key))).toEqual([]);
  });

  it("excludes a bill dated ON the shifted payday, from the real screen", () => {
    /* Straight off the Float screen on 2026-10-20: pay is the 15th and the
       last day, 10-31 is a Saturday so the horizon is Friday 10-30, and two
       bills — the savings transfer and child support — are dated 10-30
       itself. They were appearing in "Coming up" for the 10-15 cycle.

       The weekend-shift test above puts its bill on the 31st, which lands
       after the horizon for the ordinary reason. This one is ON the horizon,
       which is the case that actually needs the window to stop a day short,
       and the one the screenshot showed. */
    const kept30 = detectSeries([
      ...ADP,
      ...monthly("Online Transfer to Savings", 100, "2026-05-30"),
      ...monthly("Zelle Transfer to Sarah Brinkman Jpm99cyjirem", 231, "2026-05-30"),
    ]);
    const r = safeToSpend({ balance: 1500, kept: kept30, today: "2026-10-20", floor: 0, cardPayment: 0 });
    expect(r.horizon).toBe("2026-10-30");
    expect(r.due.filter((d) => d.date === "2026-10-30")).toEqual([]);
    expect(r.soonAfter.filter((d) => d.date === "2026-10-30")).toHaveLength(2);
    expect(r.soonAfterTotal).toBeCloseTo(331, 2);
  });
});

describe("payday lands early at a weekend", () => {
  /* Pay on the 15th and the last day means Friday the 13th when the 15th is a
     Sunday. The detector had already seen this and I called it noise: the
     14th of August among a run of 15ths is not slippage, it is the rule —
     2026-08-15 was a Saturday.
     It matters because the horizon is the date everything is measured to, and
     2026-10-31 is a Saturday while 2026-11-15 is a Sunday. */
  it("Saturday pay dates move back to the Friday", () => {
    expect(nextPayday(kept, "2026-10-16")).toBe("2026-10-30"); // 31st is a Sat
  });

  it("Sunday pay dates move back two days", () => {
    expect(nextPayday(kept, "2026-11-01")).toBe("2026-11-13"); // 15th is a Sun
  });

  it("leaves a weekday pay date alone", () => {
    expect(nextPayday(kept, "2026-12-01")).toBe("2026-12-15"); // a Tuesday
  });

  it("does NOT shift bills, which post the next business day instead", () => {
    /* Moving a bill earlier is the one direction that makes the number look
       better than it is. */
    const r = safeToSpend({ balance: 5000, kept, today: "2026-10-25", floor: 0, cardPayment: 0 });
    const mortgage = [...r.due, ...r.soonAfter].find((d) => d.payee.startsWith("Citizens"));
    expect(mortgage?.date).toBe("2026-11-02"); // a Monday, unshifted
  });
});

describe("the horizon never stalls or goes backwards", () => {
  /* Shifting a payday back to Friday is not monotonic: from a payday already
     moved to Friday the 30th, "the late anchor this month" is still the 31st,
     which shifts back to the 30th — the same date, forever. The loop guard in
     dueBetween caught it, which is how it was found. */
  it("advances through a year of paydays without repeating", () => {
    const seen: string[] = [];
    let d = "2026-10-01";
    for (let i = 0; i < 24; i++) {
      const next = nextPayday(kept, d);
      if (!next) break;
      expect(next > d || next === d).toBe(true);
      expect(seen).not.toContain(next);
      seen.push(next);
      d = new Date(Date.parse(`${next}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    }
    expect(seen.length).toBe(24);
  });

  it("never names a payday in the past", () => {
    for (const today of ["2026-10-30", "2026-10-31", "2026-11-14", "2026-11-15", "2027-02-28"]) {
      const next = nextPayday(kept, today);
      expect(next! >= today).toBe(true);
    }
  });
});

describe("payday itself", () => {
  /* The report: "on paydays the upcoming bills and safe to spend weren't
     really updating." They were not meant to. The horizon was "the soonest
     payday still to come", which on payday is TODAY — so nothing counted as
     due, and the balance, freshly topped up by the deposit, read as entirely
     spendable until midnight.

     The same calendar day means two different things either side of the
     deposit, and the deposit is the only way to tell them apart. */

  const ADP_PAID_15TH: Txn[] = [
    t("2026-08-14", 2110.64, "ADP Totalsource"),
    t("2026-08-31", 2110.64, "ADP Totalsource"),
    t("2026-09-15", 2110.64, "ADP Totalsource"),
    t("2026-09-30", 2110.64, "ADP Totalsource"),
    t("2026-10-15", 2110.64, "ADP Totalsource"), // today's deposit, landed
  ];
  const ADP_NOT_YET: Txn[] = ADP_PAID_15TH.slice(0, -1);

  const bills = [
    ...monthly("Citizens Bank Mortgage Payment", 583.57, "2026-06-02"),
    ...monthly("Smithville Tele Bill", 74.99, "2026-06-05"),
    /* One INSIDE the second half of the month, or the window proves nothing.
       Starting in May, so the run ends at 09-20 and the next occurrence is
       10-20 — genuinely ahead of a 10-15 "today" rather than already seen. */
    ...monthly("Duke Energy", 142, "2026-05-20"),
  ];

  const paid = detectSeries([...ADP_PAID_15TH, ...bills]);
  const unpaid = detectSeries([...ADP_NOT_YET, ...bills]);

  it("moves to the NEXT payday once the deposit has landed", () => {
    expect(nextPayday(paid, "2026-10-15")).toBe("2026-10-30");
  });

  it("still says today while the deposit has not arrived", () => {
    /* Payday morning. The money is not there yet, and what is left has to
       last until it is. Rolling the horizon forward here would count a
       deposit that has not happened. */
    expect(nextPayday(unpaid, "2026-10-15")).toBe("2026-10-15");
  });

  it("counts the fortnight of bills again, rather than none", () => {
    const base = { balance: 2500, today: "2026-10-15", floor: 0, cardPayment: 0 };
    const after = safeToSpend({ ...base, kept: paid });
    const before = safeToSpend({ ...base, kept: unpaid });
    expect(after.due.length).toBeGreaterThan(before.due.length);
    expect(after.safe).toBeLessThan(before.safe);
    expect(after.due.some((d) => d.payee.startsWith("Duke"))).toBe(true);
  });

  it("accepts a deposit released a day or two early", () => {
    /* Banks release Friday's pay on Thursday evening. Matching only an exact
       date would leave the horizon stuck on payday all day. */
    const early = detectSeries([
      ...ADP_NOT_YET,
      t("2026-10-14", 2110.64, "ADP Totalsource"),
      ...bills,
    ]);
    expect(nextPayday(early, "2026-10-15")).toBe("2026-10-30");
  });

  it("rolls forward on the day the money actually lands, not on a date", () => {
    /* I expected the 15th here, on the reasoning that the 15th is payday and
       the 14th is the day before it. That reasoning is wrong, and the code
       was right: once a deposit has posted, the next deposit is a fortnight
       away whatever the calendar says the payday is. Holding the horizon at
       "tomorrow" while the money is already in the account is the same
       overstatement this whole change exists to remove — a balance that has
       to last 16 days, presented as if it had to last one.

       What protects against skipping a pay period is that an occurrence is
       only ever treated as paid once it has ARRIVED (payday <= today), so a
       deposit cannot satisfy a payday still in the future. */
    const early = detectSeries([
      ...ADP_NOT_YET,
      t("2026-10-14", 2110.64, "ADP Totalsource"),
      ...bills,
    ]);
    expect(nextPayday(early, "2026-10-14")).toBe("2026-10-30");
  });

  it("does not roll forward on a deposit from the PREVIOUS payday", () => {
    /* The grace window is three days, not a fortnight. A series last seen on
       09-30 must not satisfy the occurrence on 10-15. */
    expect(unpaid.find((s) => s.direction === "in")!.lastSeen).toBe("2026-09-30");
    expect(nextPayday(unpaid, "2026-10-15")).toBe("2026-10-15");
  });

  it("leaves every other day of the cycle alone", () => {
    for (const [today, want] of [
      ["2026-10-16", "2026-10-30"],
      ["2026-10-20", "2026-10-30"],
      ["2026-11-02", "2026-11-13"],
    ] as const) {
      expect(nextPayday(paid, today)).toBe(want);
    }
  });
});

describe("a bill that has already gone out", () => {
  /* The mirror of payday. On the day the mortgage posts, the balance is
     $583.57 lighter AND the mortgage still reads as "due today" — so it came
     off the number twice, for one day, every month. It errs toward showing
     less, which is the safe direction, but it is still wrong. */

  const PAID_TODAY: Txn[] = [
    ...monthly("Citizens Bank Mortgage Payment", 583.57, "2026-06-02"),
    t("2026-11-02", -583.57, "Citizens Bank Mortgage Payment"), // posted today
  ];
  const NOT_YET: Txn[] = monthly("Citizens Bank Mortgage Payment", 583.57, "2026-06-02");

  const withIncome = (bills: Txn[]) => detectSeries([...bills, ...ADP]);
  const base = { balance: 3000, today: "2026-11-02", floor: 0, cardPayment: 0 };

  it("is not subtracted again on the day it posts", () => {
    const r = safeToSpend({ ...base, kept: withIncome(PAID_TODAY) });
    expect(r.due.some((d) => d.payee.startsWith("Citizens"))).toBe(false);
  });

  it("IS subtracted while it is still only expected", () => {
    const r = safeToSpend({ ...base, kept: withIncome(NOT_YET) });
    expect(r.due.some((d) => d.payee.startsWith("Citizens"))).toBe(true);
  });

  it("is worth exactly the bill, not a penny more", () => {
    const paid = safeToSpend({ ...base, kept: withIncome(PAID_TODAY) });
    const unpaid = safeToSpend({ ...base, kept: withIncome(NOT_YET) });
    expect(paid.safe - unpaid.safe).toBeCloseTo(583.57, 2);
  });

  it("does not suppress the NEXT occurrence as well", () => {
    /* Marking the series paid rather than the occurrence would hide
       December's mortgage too, and overstate the number for a month. */
    const r = safeToSpend({
      ...base,
      today: "2026-11-20",
      kept: withIncome(PAID_TODAY),
    });
    const all = [...r.due, ...r.soonAfter].filter((d) => d.payee.startsWith("Citizens"));
    expect(all.map((d) => d.date)).toContain("2026-12-02");
  });

  it("never suppresses something still in the future", () => {
    /* A payment cannot settle an occurrence that has not arrived. On 11-01
       the mortgage is due tomorrow and must still be counted. */
    const r = safeToSpend({ ...base, today: "2026-11-01", kept: withIncome(NOT_YET) });
    expect(r.due.some((d) => d.payee.startsWith("Citizens"))).toBe(true);
  });
});

describe("the grace window against a WEEKLY series", () => {
  /* This is where a fixed three-day grace would be dangerous. Child support
     is weekly now. With a flat ±3 days, last Friday's payment sits three
     days before this Monday's occurrence and would mark it paid — hiding a
     $231 obligation and OVERSTATING what is safe to spend, which is the one
     direction that costs money. The window scales with the period. */

  const weekly = (payee: string, amount: number, from: string, n: number) => {
    const out: Txn[] = [];
    let d = from;
    for (let i = 0; i < n; i++) {
      out.push(t(d, -amount, payee));
      d = new Date(Date.parse(`${d}T00:00:00Z`) + 7 * 86400000).toISOString().slice(0, 10);
    }
    return out;
  };

  // Fridays through 2026-10-09, so the next occurrence is Friday 2026-10-16
  const CS = weekly("Zelle Transfer to Sarah Brinkman Jpmw", 231, "2026-08-14", 9);
  const kept = detectSeries([...CS, ...ADP]);

  it("still counts this week's payment three days after last week's", () => {
    const r = safeToSpend({
      balance: 1200,
      kept,
      today: "2026-10-16",
      floor: 0,
      cardPayment: 0,
    });
    const cs = r.due.filter((d) => d.payee.startsWith("Zelle"));
    expect(cs.length).toBeGreaterThanOrEqual(1);
    expect(cs[0].date).toBe("2026-10-16");
  });

  it("drops it once this week's payment has actually gone", () => {
    const paid = detectSeries([
      ...CS,
      /* Same merchant string as the rest. "Jpmx" is four characters, which
         is too short to read as a bank reference, so varying it here made a
         second payee and left the original series predicting 10-16 with
         nothing paid against it. */
      t("2026-10-16", -231, "Zelle Transfer to Sarah Brinkman Jpmw"),
      ...ADP,
    ]);
    const r = safeToSpend({
      balance: 1200,
      kept: paid,
      today: "2026-10-16",
      floor: 0,
      cardPayment: 0,
    });
    expect(r.due.some((d) => d.payee.startsWith("Zelle") && d.date === "2026-10-16")).toBe(false);
  });
});

describe("a bill that was due and has not gone out", () => {
  /* The overdraft. Safe-to-spend read about $400 across the weekend and the
     account overdrew on Monday morning when "several recurring payments"
     landed. They had been counted on Friday, vanished on Saturday, and were
     still coming.

     A due date passing is not a payment. The window started at today, so an
     occurrence dated yesterday dropped out of the maths whether or not the
     money had left — and weekends make that systematic, because a bill
     dated Saturday posts on Monday. */

  const CS: Txn[] = [
    "2026-08-14","2026-08-21","2026-08-28","2026-09-04","2026-09-11",
    "2026-09-18","2026-09-25","2026-10-02","2026-10-09",
  ].map((d) => t(d, -231, "Zelle Transfer to Sarah Brinkman Jpm99cyjirem"));

  const kept = detectSeries([...CS, ...ADP]);
  const base = { balance: 400, floor: 0, cardPayment: 0 };

  it("is still counted the day after it was due", () => {
    const fri = safeToSpend({ ...base, kept, today: "2026-10-16" });
    const sat = safeToSpend({ ...base, kept, today: "2026-10-17" });
    expect(fri.due.some((d) => d.date === "2026-10-16")).toBe(true);
    expect(sat.due.some((d) => d.date === "2026-10-16")).toBe(true);
  });

  it("does not let the number jump overnight for no reason", () => {
    /* This is the whole bug in one assertion: the balance did not change
       and no payment was made, so the figure must not improve. */
    const fri = safeToSpend({ ...base, kept, today: "2026-10-16" });
    const sat = safeToSpend({ ...base, kept, today: "2026-10-17" });
    const sun = safeToSpend({ ...base, kept, today: "2026-10-18" });
    expect(sat.safe).toBe(fri.safe);
    expect(sun.safe).toBe(fri.safe);
  });

  it("is marked overdue rather than quietly listed", () => {
    const sat = safeToSpend({ ...base, kept, today: "2026-10-17" });
    const late = sat.due.find((d) => d.date === "2026-10-16")!;
    expect(late.overdue).toBe(true);
    expect(sat.due.find((d) => d.date === "2026-10-23")?.overdue).toBe(false);
  });

  it("stops counting it the moment it posts", () => {
    const paid = detectSeries([
      ...CS,
      t("2026-10-19", -231, "Zelle Transfer to Sarah Brinkman Jpm99cyjirem"),
      ...ADP,
    ]);
    const r = safeToSpend({ ...base, kept: paid, today: "2026-10-19" });
    expect(r.due.some((d) => d.date === "2026-10-16")).toBe(false);
  });

  it("gives up after a bounded time rather than subtracting for ever", () => {
    /* A bill you have genuinely stopped paying must not haunt the number.
       The lookback is one period for a weekly series. */
    const r = safeToSpend({ ...base, kept, today: "2026-10-26" });
    expect(r.due.some((d) => d.date === "2026-10-16")).toBe(false);
  });

  it("never counts the same occurrence twice across the two lists", () => {
    const r = safeToSpend({ ...base, kept, today: "2026-10-17" });
    const keys = [...r.due, ...r.soonAfter].map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
