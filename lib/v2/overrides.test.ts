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

describe("paid through", () => {
  /* The real case: one Zelle for $462 on the 16th covering both the 16th and
     the 23rd. The 16th drops out on its own once the payment posts, but
     nothing will ever post on the 23rd, so without this it stays "due" and
     $231 is subtracted twice. */
  const base = { balance: 2000, today: "2026-10-18", floor: 0, cardPayment: 0 };
  const key = keyOf(cs);

  it("settles an occurrence that nothing will ever post against", () => {
    // the control, or "every remaining date is later" passes on an empty list
    const before = safeToSpend({ ...base, kept: series }).due.filter((d) =>
      d.payee.startsWith("Zelle"),
    );
    expect(before.some((d) => d.date <= "2026-10-23")).toBe(true);

    const covered = applyOverrides(series, { [key]: { paid_through: "2026-10-23" } }, keyOf);
    const owed = safeToSpend({ ...base, kept: covered }).due.filter((d) =>
      d.payee.startsWith("Zelle"),
    );
    expect(owed.every((d) => d.date > "2026-10-23")).toBe(true);
  });

  it("reaches into the future, unlike every other settled test", () => {
    const plain = safeToSpend({ ...base, kept: series });
    const covered = safeToSpend({
      ...base,
      kept: applyOverrides(series, { [key]: { paid_through: "2026-10-23" } }, keyOf),
    });
    expect(covered.safe).toBeGreaterThan(plain.safe);
  });

  it("does not touch occurrences after the watermark", () => {
    const covered = applyOverrides(series, { [key]: { paid_through: "2026-10-23" } }, keyOf);
    const s = covered.find((x) => keyOf(x) === key)!;
    const later = safeToSpend({ ...base, today: "2026-11-01", kept: covered });
    expect(later.due.concat(later.soonAfter).some((d) => d.payee === s.payee)).toBe(true);
  });

  it("does not touch any other payee", () => {
    const covered = applyOverrides(series, { [key]: { paid_through: "2099-01-01" } }, keyOf);
    const others = covered.filter((s) => keyOf(s) !== key);
    expect(others.every((s) => s.paidThrough == null)).toBe(true);
  });

  it("is cleared by null, restoring the schedule", () => {
    const cleared = applyOverrides(series, { [key]: { paid_through: null } }, keyOf);
    expect(cleared.find((x) => keyOf(x) === key)!.paidThrough).toBeUndefined();
    const r = safeToSpend({ ...base, kept: cleared });
    const plain = safeToSpend({ ...base, kept: series });
    expect(r.safe).toBe(plain.safe);
  });

  it("coexists with an amount override", () => {
    const both = applyOverrides(
      series,
      { [key]: { override_amount: 231, paid_through: "2026-10-23" } },
      keyOf,
    );
    const s = both.find((x) => keyOf(x) === key)!;
    expect(s.amount).toBe(231);
    expect(s.paidThrough).toBe("2026-10-23");
  });
});

describe("a rhythm that has changed", () => {
  /* The real row: "Zelle Transfer to Sarah Bri… $412.00 · every 2 weeks ·
     10× · next 10/30", when it is now $231 weekly. Ten fortnightly payments
     outvote two weekly ones for months, so detection stays confidently
     wrong about both the amount AND the dates. */
  const key = keyOf(cs);

  it("puts the series on the new rhythm", () => {
    const [out] = applyOverrides([cs], { [key]: { override_cadence: "weekly" } }, keyOf);
    expect(cs.cadence).toBe("biweekly"); // the input is left alone
    expect(out.cadence).toBe("weekly");
    expect(out.periodDays).toBe(7);
  });

  it("moves the next due date with it, counted from the last real payment", () => {
    const [out] = applyOverrides([cs], { [key]: { override_cadence: "weekly" } }, keyOf);
    expect(cs.lastSeen).toBe("2026-09-25");
    expect(out.nextDue).toBe("2026-10-02"); // a week on, not a fortnight
  });

  it("produces twice as many occurrences over the same stretch", () => {
    const fortnightly = safeToSpend({
      balance: 5000, kept: [cs], today: "2026-10-05", floor: 0, cardPayment: 0,
    });
    const weekly = safeToSpend({
      balance: 5000,
      kept: applyOverrides([cs], { [key]: { override_cadence: "weekly" } }, keyOf),
      today: "2026-10-05",
      floor: 0,
      cardPayment: 0,
    });
    expect(weekly.due.length).toBeGreaterThan(fortnightly.due.length);
  });

  it("combines with an amount override, which is the actual situation", () => {
    const [out] = applyOverrides(
      [cs],
      { [key]: { override_cadence: "weekly", override_amount: 231 } },
      keyOf,
    );
    expect(out.cadence).toBe("weekly");
    expect(out.amount).toBe(231);
    expect(out.amountSpread).toBe(0);
  });

  it("is ignored when cleared, and when it matches what was detected", () => {
    for (const o of [{}, { override_cadence: null }, { override_cadence: "biweekly" as const }]) {
      const [out] = applyOverrides([cs], { [key]: o }, keyOf);
      expect(out.cadence).toBe("biweekly");
      expect(out.nextDue).toBe(cs.nextDue);
    }
  });

  it("leaves the payee, history and confidence alone", () => {
    /* An override says the rhythm changed, not that the past did not
       happen. "10×" must still read 10×. */
    const [out] = applyOverrides([cs], { [key]: { override_cadence: "weekly" } }, keyOf);
    expect(out.hits).toBe(cs.hits);
    expect(out.lastSeen).toBe(cs.lastSeen);
    expect(out.payee).toBe(cs.payee);
  });
});
