import { describe, it, expect } from "vitest";
import { detectSeries, isStale, dueBetween, type Txn } from "./recurring";

/* These fixtures are real: dates and amounts lifted from the Chase feed. The
   detector is the whole bet of v2, so the cases that decide it are the ones
   from an actual account rather than ones invented to pass. */

let n = 0;
const t = (date: string, amount: number, merchant: string): Txn => ({
  id: `t${n++}`, date, amount, merchant,
});

/* The real child support: nine payments, biweekly, with two at $406 that
   should have been $412, and ±3 days of jitter around a 14-day cadence. */
const CHILD_SUPPORT: Txn[] = [
  t("2026-06-05", -412, "Zelle Transfer to Sarah Brinkman Jpm99cjp3q8c"),
  t("2026-06-22", -406, "Zelle Transfer to Sarah Brinkman Jpm99cljll22"),
  t("2026-07-03", -406, "Zelle Transfer to Sarah Brinkman Jpm99co7zz5x"),
  t("2026-07-17", -412, "Zelle Transfer to Sarah Brinkman Jpm99cppeoev"),
  t("2026-07-31", -412, "Zelle Transfer to Sarah Brinkman Jpm99cr5ffa0"),
  t("2026-08-14", -412, "Zelle Transfer to Sarah Brinkman Jpm99ct0xra0"),
  t("2026-08-31", -412, "Zelle Transfer to Sarah Brinkman Jpm99cuwyxzc"),
  t("2026-09-11", -412, "Zelle Transfer to Sarah Brinkman Jpm99cw5x8du"),
  t("2026-09-25", -412, "Zelle Transfer to Sarah Brinkman Jpm99cxnhaep"),
];

/* Ad-hoc transfers to the SAME person, interleaved with the above. */
const ADHOC: Txn[] = [
  t("2026-05-29", -50, "Zelle Transfer to Sarah Brinkman Jpm99ciswoiu"),
  t("2026-06-15", -100, "Zelle Transfer to Sarah Brinkman Jpm99ckvilpp"),
  t("2026-07-07", -140, "Zelle Transfer to Sarah Brinkman Jpm99coo02j9"),
  t("2026-08-05", -85, "Zelle Transfer to Sarah Brinkman Jpm99crwhai2"),
  t("2026-09-10", -39, "Zelle Transfer to Sarah Brinkman Jpm99cw1z3x0"),
  t("2026-09-14", -20, "Zelle Transfer to Sarah Brinkman Jpm99cwje5di"),
  t("2026-09-22", -45, "Zelle Transfer to Sarah Brinkman Jpm99cxdhdv0"),
  t("2026-10-02", -54, "Zelle Transfer to Sarah Brinkman Jpm99cygnuai"),
  t("2026-10-02", -74, "Zelle Transfer to Sarah Brinkman Jpm99cyjirem"),
];

describe("the case the whole design rests on", () => {
  it("finds $412 every fortnight inside a payee full of noise", () => {
    const found = detectSeries([...CHILD_SUPPORT, ...ADHOC]);
    const cs = found.find((s) => s.amount === 412);

    expect(cs).toBeDefined();
    expect(cs!.cadence).toBe("biweekly");
    expect(cs!.medianGap).toBe(14);
    expect(cs!.hits).toBe(9);
    expect(cs!.lastSeen).toBe("2026-09-25");
    expect(cs!.nextDue).toBe("2026-10-09");
  });

  it("ignores the two $406 payments when predicting", () => {
    // the median is immune to them; a mean would have said $410.67
    const cs = detectSeries(CHILD_SUPPORT).find((s) => s.cadence === "biweekly");
    expect(cs!.amount).toBe(412);
  });

  it("does not mistake the ad-hoc transfers for an obligation", () => {
    // same payee, 9 occurrences, amounts $20–$140 at irregular intervals
    const found = detectSeries(ADHOC);
    expect(found).toEqual([]);
  });
});

describe("the trap that count-based rules fall into", () => {
  it("rejects Sam's Club, 57 hits of groceries", () => {
    /* "Three or more times" would call this a recurring payment. It is how
       the shopping gets done: a median gap of two days, wildly irregular. */
    const sams: Txn[] = [];
    const gaps = [1, 3, 2, 5, 1, 2, 4, 2, 1, 7, 2, 3, 1, 2, 6, 2, 1, 3];
    // fixed, not random: a flaky detector test is worse than none
    const amts = [31, 184, 62, 27, 155, 44, 98, 71, 22, 140, 56, 203, 38, 88, 117, 49, 24, 166];
    let d = "2026-06-01";
    gaps.forEach((g, i) => {
      sams.push(t(d, -amts[i], "Sam's Club"));
      d = new Date(Date.parse(`${d}T00:00:00Z`) + g * 86400000).toISOString().slice(0, 10);
    });
    expect(detectSeries(sams)).toEqual([]);
  });

  it("still finds a genuine monthly bill with a wobbly amount", () => {
    // Duke Energy swings 31% and is obviously monthly; variance must lower
    // confidence, never reject
    const duke = [
      t("2026-06-18", -142, "Duke Energy"),
      t("2026-07-18", -96, "Duke Energy"),
      t("2026-08-19", -88, "Duke Energy"),
      t("2026-09-18", -114, "Duke Energy"),
    ];
    const found = detectSeries(duke);
    expect(found).toHaveLength(1);
    expect(found[0].cadence).toBe("monthly");
    expect(found[0].amount).toBe(105);
    expect(found[0].amountSpread).toBeGreaterThan(0.1);
  });
});

describe("the clean ones", () => {
  const monthly = (payee: string, amount: number, start = "2026-06-05") => {
    const out: Txn[] = [];
    let d = start;
    for (let i = 0; i < 5; i++) {
      out.push(t(d, -amount, payee));
      const dt = new Date(Date.parse(`${d}T00:00:00Z`));
      dt.setUTCMonth(dt.getUTCMonth() + 1);
      d = dt.toISOString().slice(0, 10);
    }
    return out;
  };

  it("Ooma at $6.81, zero spread, full confidence", () => {
    const found = detectSeries(monthly("Ooma", 6.81));
    expect(found[0].amount).toBe(6.81);
    expect(found[0].amountSpread).toBe(0);
    expect(found[0].confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("separates income from spend at the same payee", () => {
    // Sam's Club refunds turned up among the paychecks in the real data
    const mixed = [...monthly("Sam's Club", 60), t("2026-06-22", 34, "Sam's Club"), t("2026-08-02", 20, "Sam's Club")];
    const found = detectSeries(mixed);
    expect(found.every((s) => s.direction === "out")).toBe(true);
  });

  it("finds a semimonthly paycheck", () => {
    const adp = [
      t("2026-05-29", 1845, "ADP Totalsource"),
      t("2026-06-15", 1845, "ADP Totalsource"),
      t("2026-06-30", 1845, "ADP Totalsource"),
      t("2026-07-15", 1845, "ADP Totalsource"),
      t("2026-07-31", 1845, "ADP Totalsource"),
    ];
    const found = detectSeries(adp);
    expect(found[0].direction).toBe("in");
    expect(found[0].medianGap).toBeGreaterThanOrEqual(15);
    expect(found[0].nextDue).toBe("2026-08-15");
  });
});

describe("letting a dead series go", () => {
  const cs = detectSeries(CHILD_SUPPORT)[0];

  it("is not stale the day its next payment is due", () => {
    expect(isStale(cs, "2026-10-09")).toBe(false);
  });

  it("is not stale a few days late — payments slip", () => {
    expect(isStale(cs, "2026-10-13")).toBe(false);
  });

  it("IS stale once a whole cycle has passed", () => {
    /* The real reason this matters: child support moved to $231 weekly. The
       old $412 fortnightly series must stop being predicted on its own,
       without anyone telling the app. */
    expect(isStale(cs, "2026-10-25")).toBe(true);
  });
});

describe("what falls inside the horizon", () => {
  const cs = detectSeries(CHILD_SUPPORT)[0];

  it("lists each occurrence before the next payday", () => {
    expect(dueBetween(cs, "2026-10-08", "2026-10-31")).toEqual(["2026-10-09", "2026-10-23"]);
  });

  it("is empty when the next one falls past the horizon", () => {
    expect(dueBetween(cs, "2026-10-10", "2026-10-20")).toEqual([]);
  });

  it("catches a missed occurrence up to today rather than forgetting it", () => {
    const due = dueBetween(cs, "2026-10-20", "2026-10-31");
    expect(due[0]).toBe("2026-10-23");
  });
});
