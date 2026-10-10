import { describe, it, expect } from "vitest";
import { summariseSpending, type SpendTxn } from "./spending";
import { normalisePayee } from "./payee";

const CHECKING = "acct-chase";
const CARD = "acct-card";
const OUTSIDE = "acct-iucu";

let n = 0;
const t = (
  date: string,
  amount: number,
  merchant: string,
  extra: Partial<SpendTxn> = {},
): SpendTxn => ({
  id: `t${n++}`,
  date,
  amount,
  merchant,
  account_id: CHECKING,
  type: amount < 0 ? "expense" : "income",
  ...extra,
});

const base = {
  accountIds: new Set([CHECKING, CARD]),
  fixedKeys: new Set<string>(),
  today: "2026-10-10",
  days: 30,
};

describe("the window", () => {
  const txns = [
    t("2026-10-09", -20, "Casey's"),
    t("2026-09-11", -30, "Casey's"), // inside 30 days
    t("2026-09-09", -99, "Casey's"), // outside
    t("2026-10-20", -50, "Casey's"), // the future; a pending row dated ahead
  ];

  it("takes the last N days and nothing else", () => {
    const r = summariseSpending({ ...base, txns });
    expect(r.total).toBe(50);
  });

  it("widens to 90 days when asked", () => {
    const r = summariseSpending({ ...base, txns, days: 90 });
    expect(r.total).toBe(149);
  });

  it("states a per-30-day rate so the two windows can be compared", () => {
    const r = summariseSpending({ ...base, txns, days: 90 });
    expect(r.perMonth).toBeCloseTo((149 / 90) * 30, 2);
  });
});

describe("what is not spending", () => {
  it("ignores accounts out of scope", () => {
    /* The IUCU accounts were dropped from v2 entirely. If they can still
       reach a total, the number stops being about the money v2 manages. */
    const r = summariseSpending({
      ...base,
      txns: [t("2026-10-01", -500, "Earnest Student Loan", { account_id: OUTSIDE })],
    });
    expect(r.total).toBe(0);
  });

  it("ignores transfers, including the card payment", () => {
    /* The groceries were counted when the card was swiped. Counting the
       payment too charges you twice for the same food. */
    const r = summariseSpending({
      ...base,
      txns: [
        t("2026-10-02", -400, "Walmart", { account_id: CARD }),
        t("2026-10-05", -658, "Chase Credit Card Payment", {
          type: "transfer",
          transfer_account_id: CARD,
        }),
      ],
    });
    expect(r.total).toBe(400);
  });

  it("ignores income", () => {
    const r = summariseSpending({
      ...base,
      txns: [t("2026-10-01", 2110.64, "ADP Totalsource"), t("2026-10-02", -40, "Casey's")],
    });
    expect(r.total).toBe(40);
    expect(r.everyday.map((g) => g.label)).toEqual(["Casey's"]);
  });
});

describe("cards", () => {
  it("count here, though they deliberately do not on screen 1", () => {
    /* The two screens disagree on purpose: screen 1 is what is spendable
       today, this is where the money went. Omitting the card would leave out
       most of the answer. */
    const r = summariseSpending({
      ...base,
      txns: [
        t("2026-10-02", -120, "Kroger", { account_id: CARD }),
        t("2026-10-03", -18, "Kroger", { account_id: CHECKING }),
      ],
    });
    expect(r.total).toBe(138);
    expect(r.everyday).toHaveLength(1); // one merchant, both cards
  });
});

describe("refunds", () => {
  it("net off the merchant that issued them", () => {
    const r = summariseSpending({
      ...base,
      txns: [t("2026-10-02", -200, "Target"), t("2026-10-06", 50, "Target")],
    });
    expect(r.everyday[0].total).toBe(150);
  });

  it("do not count as a visit", () => {
    const r = summariseSpending({
      ...base,
      txns: [t("2026-10-02", -200, "Target"), t("2026-10-06", 50, "Target")],
    });
    expect(r.everyday[0].count).toBe(1);
  });

  it("never produce a negative row", () => {
    /* A refund for something bought before the window begins would otherwise
       show as a merchant you "spent" minus $80 at, which reads as a discount
       rather than as nothing. */
    const r = summariseSpending({
      ...base,
      txns: [t("2026-10-06", 80, "Target"), t("2026-10-02", -40, "Casey's")],
    });
    expect(r.everyday.map((g) => g.label)).toEqual(["Casey's"]);
    expect(r.total).toBe(40);
  });
});

describe("fixed against everyday", () => {
  const txns = [
    t("2026-09-15", -583.57, "Citizens Bank Mortgage Payment"),
    t("2026-10-02", -74.99, "Smithville Tele Bill"),
    t("2026-10-03", -62, "Casey's"),
    t("2026-10-07", -38, "Casey's"),
    t("2026-10-08", -120, "Kroger"),
  ];
  const fixedKeys = new Set([
    normalisePayee("Citizens Bank Mortgage Payment"),
    normalisePayee("Smithville Tele Bill"),
  ]);

  it("splits on what you kept on the Recurring screen", () => {
    const r = summariseSpending({ ...base, txns, fixedKeys });
    expect(r.fixedTotal).toBeCloseTo(658.56, 2);
    expect(r.everydayTotal).toBeCloseTo(220, 2);
    expect(r.total).toBeCloseTo(878.56, 2);
  });

  it("keeps the mortgage out of the everyday list", () => {
    /* Sorted by size it would sit at the top for ever, and it is the one line
       you can do nothing about this month. */
    const r = summariseSpending({ ...base, txns, fixedKeys });
    expect(r.everyday.map((g) => g.label)).toEqual(["Kroger", "Casey's"]);
  });

  it("sorts each list largest first", () => {
    const r = summariseSpending({ ...base, txns, fixedKeys });
    expect(r.everyday[0].total).toBeGreaterThanOrEqual(r.everyday[1].total);
    expect(r.fixed[0].total).toBeGreaterThanOrEqual(r.fixed[1].total);
  });

  it("groups repeat visits and counts them", () => {
    const r = summariseSpending({ ...base, txns, fixedKeys });
    const caseys = r.everyday.find((g) => g.label === "Casey's")!;
    expect(caseys.total).toBe(100);
    expect(caseys.count).toBe(2);
    expect(caseys.lastDate).toBe("2026-10-07");
    expect(caseys.txns.map((x) => x.date)).toEqual(["2026-10-07", "2026-10-03"]);
  });
});

describe("one merchant, two bank descriptions", () => {
  it("lands in one row", () => {
    /* Chase posts the same Smithville bill both ways. Two rows of $74.99 in a
       list meant to tell you where the money went is a bug you cannot see,
       because both halves look plausible. */
    const r = summariseSpending({
      ...base,
      txns: [
        t("2026-09-15", -74.99, "Smithville Tele Bill"),
        t("2026-10-05", -74.99, "Certificate of Origin Smithville"),
      ],
    });
    expect(r.everyday).toHaveLength(1);
    expect(r.everyday[0].total).toBeCloseTo(149.98, 2);
  });

  it("does not merge different merchants that happen to share a word", () => {
    const r = summariseSpending({
      ...base,
      txns: [t("2026-10-02", -40, "Target"), t("2026-10-03", -310, "Target Optical")],
    });
    expect(r.everyday).toHaveLength(2);
  });
});

describe("the empty case", () => {
  it("is zero rather than a crash", () => {
    const r = summariseSpending({ ...base, txns: [] });
    expect(r.total).toBe(0);
    expect(r.perMonth).toBe(0);
    expect(r.everyday).toEqual([]);
  });
});
