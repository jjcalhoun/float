import { describe, it, expect } from "vitest";
import { manualSeries } from "./manual";
import { detectSeries, type Txn } from "./recurring";
import { safeToSpend } from "./safeToSpend";
import { normalisePayee } from "./payee";

let n = 0;
const t = (date: string, amount: number, merchant: string): Txn => ({
  id: `t${n++}`, date, amount, merchant,
});

const fixed = (over: Record<string, unknown> = {}) => ({ decision: "fixed", ...over });

describe("declaring a bill the detector cannot see", () => {
  /* One payment is never enough for detection — and must not be, or two
     grocery runs become an obligation. But a bill you have paid once and
     know is monthly should not be invisible for three more cycles. */
  const txns = [t("2026-10-05", -80, "Hometown Lawn Care")];
  const key = normalisePayee("Hometown Lawn Care");

  it("produces nothing until it is kept", () => {
    expect(detectSeries(txns)).toEqual([]);
    expect(manualSeries({ decisions: {}, txns, detected: [] })).toEqual([]);
  });

  it("produces a series once it is", () => {
    const [s] = manualSeries({ decisions: { [key]: fixed() }, txns, detected: [] });
    expect(s.payee).toBe("Hometown Lawn Care");
    expect(s.direction).toBe("out");
    expect(s.amount).toBe(80);
    expect(s.cadence).toBe("monthly");
  });

  it("anchors on the payment, not on today", () => {
    /* The schedule has to start from money that actually moved, or a bill
       paid on the 5th lands on whatever day you happened to tap the
       button. */
    const [s] = manualSeries({ decisions: { [key]: fixed() }, txns, detected: [] });
    expect(s.lastSeen).toBe("2026-10-05");
    expect(s.nextDue).toBe("2026-11-05");
  });

  it("takes the cadence you chose", () => {
    const [s] = manualSeries({
      decisions: { [key]: fixed({ override_cadence: "weekly" }) },
      txns,
      detected: [],
    });
    expect(s.cadence).toBe("weekly");
    expect(s.nextDue).toBe("2026-10-12");
  });

  it("takes the amount you typed over the one observed", () => {
    const [s] = manualSeries({
      decisions: { [key]: fixed({ override_amount: 95 }) },
      txns,
      detected: [],
    });
    expect(s.amount).toBe(95);
  });

  it("does not claim a track record it has not got", () => {
    /* onTime says how reliably a rhythm has ARRIVED. Nothing has been
       observed arriving on this one, so claiming 1 would dress a guess up
       as history. */
    const [s] = manualSeries({ decisions: { [key]: fixed() }, txns, detected: [] });
    expect(s.onTime).toBe(0);
    expect(s.confidence).toBe(0);
    expect(s.hits).toBe(1);
  });

  it("reaches the number", () => {
    const kept = manualSeries({ decisions: { [key]: fixed() }, txns, detected: [] });
    const r = safeToSpend({
      balance: 1000, kept, today: "2026-11-01", floor: 0, cardPayment: 0,
    });
    expect(r.safe).toBe(920);
  });
});

describe("what it refuses to do", () => {
  const monthly = (payee: string, amount: number, start: string) => {
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

  it("never duplicates a payee the detector already found", () => {
    /* The dangerous case: a second series for the same bill would subtract
       it twice, and the two would disagree about the date. */
    const txns = monthly("Smithville Tele Bill", 74.99, "2026-05-05");
    const detected = detectSeries(txns);
    expect(detected).toHaveLength(1);
    const key = normalisePayee("Smithville Tele Bill");
    expect(manualSeries({ decisions: { [key]: fixed() }, txns, detected })).toEqual([]);
  });

  it("ignores a payee that was dismissed rather than kept", () => {
    const txns = [t("2026-10-05", -80, "Hometown Lawn Care")];
    const key = normalisePayee("Hometown Lawn Care");
    const out = manualSeries({ decisions: { [key]: { decision: "dismissed" } }, txns, detected: [] });
    expect(out).toEqual([]);
  });

  it("ignores a payee with no transactions at all", () => {
    /* Every fixed cost traces to money that actually moved. A decision row
       with nothing behind it is not a bill. */
    const out = manualSeries({ decisions: { "ghost bill": fixed() }, txns: [], detected: [] });
    expect(out).toEqual([]);
  });

  it("reads an inflow as income", () => {
    const txns = [t("2026-10-05", 300, "Water Inc")];
    const key = normalisePayee("Water Inc");
    const [s] = manualSeries({ decisions: { [key]: fixed() }, txns, detected: [] });
    expect(s.direction).toBe("in");
    expect(s.amount).toBe(300);
  });

  it("uses the median of several payments, not the latest", () => {
    /* I first asserted the detector found nothing in these three dates. It
       found a semimonthly series — 47 and 14 days apart is three periods
       then one, which fits. The scenario stands on `detected` being empty,
       which is what manualSeries actually keys off. */
    const txns = [
      t("2026-07-03", -40, "Odd Jobs"),
      t("2026-08-19", -90, "Odd Jobs"),
      t("2026-09-02", -50, "Odd Jobs"),
    ];
    const key = normalisePayee("Odd Jobs");
    const [s] = manualSeries({ decisions: { [key]: fixed() }, txns, detected: [] });
    expect(s.amount).toBe(50);
    expect(s.hits).toBe(3);
    expect(s.lastSeen).toBe("2026-09-02");
  });
});
