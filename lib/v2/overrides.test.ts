import { describe, it, expect } from "vitest";
import { applyOverrides } from "./overrides";
import { detectSeries, type Txn } from "./recurring";
import { safeToSpend } from "./safeToSpend";
import { normalisePayee } from "./payee";

let n = 0;
const t = (date: string, amount: number, merchant: string): Txn => ({
  id: `t${n++}`, date, amount, merchant,
});

/* Child support: $412 a fortnight, which is what the history says and what
   the detector will go on saying for three more occurrences after it changes
   to $231 a week. */
const CS: Txn[] = [
  t("2026-07-17", -412, "Zelle Transfer to Sarah Brinkman Jpm99a"),
  t("2026-07-31", -412, "Zelle Transfer to Sarah Brinkman Jpm99b"),
  t("2026-08-14", -412, "Zelle Transfer to Sarah Brinkman Jpm99c"),
  t("2026-08-28", -412, "Zelle Transfer to Sarah Brinkman Jpm99d"),
  t("2026-09-11", -412, "Zelle Transfer to Sarah Brinkman Jpm99e"),
  t("2026-09-25", -412, "Zelle Transfer to Sarah Brinkman Jpm99f"),
];

const ADP: Txn[] = [
  t("2026-07-15", 2110.64, "ADP Totalsource"),
  t("2026-07-31", 2110.64, "ADP Totalsource"),
  t("2026-08-14", 2110.64, "ADP Totalsource"),
  t("2026-08-31", 2110.64, "ADP Totalsource"),
  t("2026-09-15", 2110.64, "ADP Totalsource"),
  t("2026-09-30", 2110.64, "ADP Totalsource"),
];

const keyOf = (s: { payee: string }) => normalisePayee(s.payee);
const series = detectSeries([...CS, ...ADP]);
const cs = series.find((s) => s.payee.startsWith("Zelle"))!;

describe("a typed amount", () => {
  it("replaces the inferred one", () => {
    const [out] = applyOverrides([cs], { [keyOf(cs)]: { override_amount: 231 } }, keyOf);
    expect(cs.amount).toBeCloseTo(412, 2); // the input is left alone
    expect(out.amount).toBe(231);
  });

  it("stops the row claiming to vary, since it no longer does", () => {
    const [out] = applyOverrides([cs], { [keyOf(cs)]: { override_amount: 231 } }, keyOf);
    expect(out.amountSpread).toBe(0);
  });

  it("leaves the cadence and the schedule alone", () => {
    /* An override is a correction to one figure, not a second schedule to
       maintain. Changing what is owed must not change when. */
    const [out] = applyOverrides([cs], { [keyOf(cs)]: { override_amount: 231 } }, keyOf);
    expect(out.cadence).toBe(cs.cadence);
    expect(out.nextDue).toBe(cs.nextDue);
    expect(out.periodDays).toBe(cs.periodDays);
  });

  it("is ignored when cleared, resuming inference", () => {
    for (const o of [{}, { override_amount: null }, undefined]) {
      const [out] = applyOverrides([cs], { [keyOf(cs)]: o }, keyOf);
      expect(out.amount).toBeCloseTo(412, 2);
    }
  });

  it("passes through a series nobody has edited", () => {
    const out = applyOverrides(series, {}, keyOf);
    expect(out.map((s) => s.amount)).toEqual(series.map((s) => s.amount));
  });

  it("reaches the number", () => {
    const before = safeToSpend({ balance: 2000, kept: series, today: "2026-10-05", floor: 0, cardPayment: 0 });
    const after = safeToSpend({
      balance: 2000,
      kept: applyOverrides(series, { [keyOf(cs)]: { override_amount: 231 } }, keyOf),
      today: "2026-10-05",
      floor: 0,
      cardPayment: 0,
    });
    expect(before.due.length).toBe(after.due.length);
    expect(after.safe).toBeGreaterThan(before.safe);
    expect(after.safe - before.safe).toBeCloseTo((412 - 231) * after.due.length, 2);
  });
});

describe("overriding income", () => {
  it("does not move the number, because income is only ever the horizon", () => {
    /* The paycheck sets the date everything is measured to and never enters
       the arithmetic. Raising it from $1,845 to $2,110.64 must therefore be
       visible on the recurring screen and invisible here — if it ever starts
       adding to safe-to-spend, this test is the one that should fail. */
    const adp = series.find((s) => s.direction === "in")!;
    const base = { balance: 2000, today: "2026-10-05", floor: 0, cardPayment: 0 };
    const before = safeToSpend({ ...base, kept: series });
    const after = safeToSpend({
      ...base,
      kept: applyOverrides(series, { [keyOf(adp)]: { override_amount: 9999 } }, keyOf),
    });
    expect(after.safe).toBe(before.safe);
    expect(after.horizon).toBe(before.horizon);
  });
});
