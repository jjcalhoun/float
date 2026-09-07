import { describe, it, expect } from "vitest";
import { ledger, type LedgerContext } from "./ledger";
import type { Commitment } from "./types";
import type { Transaction } from "@/lib/types";

const ctx = {
  creditAccountIds: new Set(["acc-cc"]),
  loanAccountIds: new Set(["acc-loan"]),
  savingsAccountIds: new Set(["acc-sav"]),
};

const c = (over: Partial<Commitment> & { id: string }): Commitment => ({
  user_id: "u",
  series_id: `s-${over.id}`,
  period: "2026-07",
  seq: 0,
  name: "Rent",
  kind: "bill",
  amount: -1450,
  account_id: "acc-chk",
  interval: 1,
  frequency: "monthly",
  series_ended: false,
  skipped: false,
  variable: false,
  auto_confirm: false,
  created_at: "",
  updated_at: "",
  ...over,
});

const t = (over: Partial<Transaction> & { id: string; amount: number; date: string }): Transaction =>
  ({
    user_id: "u",
    account_id: "acc-chk",
    type: "expense",
    reviewed: true,
    source: "sync",
    ...over,
  }) as Transaction;

describe("commitments ledger", () => {
  it("counts planned amounts until something links, then the actual", () => {
    const items = [c({ id: "i1", kind: "income", amount: 4000 }), c({ id: "i2", amount: -1450 })];
    const before = ledger(items, [], "2026-07", ctx);
    expect(before.freeToSpend).toBe(2550);
    expect(before.items[1].status).toBe("expected");

    const after = ledger(
      items,
      [t({ id: "t1", amount: -1475, date: "2026-07-01", commitment_id: "i2" })],
      "2026-07",
      ctx,
    );
    expect(after.items[1].status).toBe("paid");
    expect(after.items[1].actual).toBe(-1475);
    expect(after.freeToSpend).toBe(2525); // the real figure, not the estimate
  });

  it("a bill due the 31st that clears on the 1st lands in the month that expected it", () => {
    const items = [c({ id: "i1", amount: -200, due_hint: "2026-07-31" })];
    const led = ledger(
      items,
      [t({ id: "t1", amount: -200, date: "2026-08-01", commitment_id: "i1" })],
      "2026-07",
      ctx,
    );
    // linked -> counted against July, and NOT double-counted as August spend
    expect(led.items[0].status).toBe("paid");
    expect(led.commitmentsEffective).toBe(200);
    expect(led.discretionary).toBe(0);
  });

  it("ignores links belonging to another period's commitments", () => {
    const led = ledger(
      [c({ id: "i1", amount: -200 })],
      [t({ id: "t1", amount: -99, date: "2026-07-05", commitment_id: "other-period" })],
      "2026-07",
      ctx,
    );
    expect(led.items[0].status).toBe("expected");
    // unlinked as far as July is concerned, but it has no splits, so no spend
    expect(led.discretionary).toBe(0);
  });

  it("skipped commitments count for nothing", () => {
    const led = ledger(
      [c({ id: "i1", kind: "income", amount: 4000 }), c({ id: "i2", amount: -1450, skipped: true })],
      [],
      "2026-07",
      ctx,
    );
    expect(led.commitmentsPlanned).toBe(0);
    expect(led.freeToSpend).toBe(4000);
    expect(led.items[1].effective).toBe(0);
  });

  it("counts a linked transfer pair once, preferring the outflow leg", () => {
    const led = ledger(
      [c({ id: "i1", kind: "cc_payment", amount: -600 })],
      [
        t({ id: "out", amount: -600, date: "2026-07-20", type: "transfer", commitment_id: "i1" }),
        t({ id: "in", amount: 600, date: "2026-07-20", type: "transfer", account_id: "acc-cc", commitment_id: "i1" }),
      ],
      "2026-07",
      ctx,
    );
    expect(led.items[0].actual).toBe(-600);
    expect(led.commitmentsEffective).toBe(600);
  });

  it("cash view: card purchases don't reduce free-to-spend", () => {
    const led = ledger(
      [],
      [
        t({
          id: "t1", amount: -80, date: "2026-07-04", account_id: "acc-cc",
          splits: [{ id: "s", user_id: "u", transaction_id: "t1", category_id: "c", bucket: "wants", amount: -80, created_at: "" }],
        }),
      ],
      "2026-07",
      ctx,
    );
    expect(led.discretionary).toBe(0);
  });

  it("checking spend is discretionary; unplanned income is extra", () => {
    const led = ledger(
      [],
      [
        t({
          id: "t1", amount: -60, date: "2026-07-04",
          splits: [{ id: "s", user_id: "u", transaction_id: "t1", category_id: "c", bucket: "needs", amount: -60, created_at: "" }],
        }),
        t({ id: "t2", amount: 250, date: "2026-07-09", type: "income" }),
      ],
      "2026-07",
      ctx,
    );
    expect(led.discretionary).toBe(60);
    expect(led.extraIncome).toBe(250);
    expect(led.freeToSpend).toBe(190);
  });

  it("an unlinked transfer into savings is committed cash", () => {
    const led = ledger(
      [],
      [
        t({ id: "out", amount: -300, date: "2026-07-02", type: "transfer" }),
        t({ id: "in", amount: 300, date: "2026-07-02", type: "transfer", account_id: "acc-sav" }),
      ],
      "2026-07",
      ctx,
    );
    expect(led.discretionary).toBe(300); // counted once, at the destination
  });

  it("baseline is the 1st-of-month picture, independent of what has posted", () => {
    const items = [c({ id: "i1", kind: "income", amount: 4000 }), c({ id: "i2", amount: -1450 })];
    const led = ledger(
      items,
      [t({ id: "t1", amount: -1450, date: "2026-07-01", commitment_id: "i2" })],
      "2026-07",
      ctx,
    );
    expect(led.baseline).toBe(2550);
    expect(led.expectedIncome).toBe(4000);
    expect(led.commitmentsPlanned).toBe(1450);
  });

  it("escrow charged to a loan account reaches categories but not free-to-spend", () => {
    // the mortgage: one transfer out of checking, plus an escrow line posted on
    // the loan. The cash already left via the transfer, so counting the escrow
    // split again would double-charge the budget.
    const led = ledger(
      [c({ id: "m", kind: "debt", amount: -583.57, transfer_account_id: "acc-loan" })],
      [
        t({ id: "out", amount: -583.57, date: "2026-07-01", type: "transfer", commitment_id: "m" }),
        t({ id: "in", amount: 583.57, date: "2026-07-01", type: "transfer", account_id: "acc-loan", commitment_id: "m" }),
        t({
          id: "escrow", amount: -230.91, date: "2026-07-01", account_id: "acc-loan",
          splits: [{ id: "s", user_id: "u", transaction_id: "escrow", category_id: "cat-housing", bucket: "needs", amount: -230.91, created_at: "" }],
        }),
        t({ id: "int", amount: -180.64, date: "2026-07-01", account_id: "acc-loan", source: "interest" }),
      ],
      "2026-07",
      ctx,
    );
    expect(led.discretionary).toBe(0); // not double-charged
    expect(led.commitmentsEffective).toBeCloseTo(583.57, 2); // the real outflow, once
  });

  it("a lump payment across four weeks counts the cash exactly once", () => {
    // four weekly child-support lines, one payment of 824 settling all of them
    const items = [
      c({ id: "w1", name: "Child support", amount: -206, due_hint: "2026-07-07" }),
      c({ id: "w2", name: "Child support", amount: -206, due_hint: "2026-07-14", covered_by: "lump" }),
      c({ id: "w3", name: "Child support", amount: -206, due_hint: "2026-07-21", covered_by: "lump" }),
      c({ id: "w4", name: "Child support", amount: -206, due_hint: "2026-07-28", covered_by: "lump" }),
    ];
    const led = ledger(
      items,
      [t({ id: "lump", amount: -824, date: "2026-07-07", commitment_id: "w1" })],
      "2026-07",
      ctx,
    );
    // the real outflow, not 824 + three planned 206s
    expect(led.commitmentsEffective).toBe(824);
    expect(led.discretionary).toBe(0);
    // every week reads as settled
    expect(led.items.every((i) => i.status === "paid")).toBe(true);
    expect(led.items.filter((i) => i.coveredBy === "lump")).toHaveLength(3);
  });

  it("before the lump is matched, all four weeks are still expected", () => {
    const items = [
      c({ id: "w1", name: "Child support", amount: -206 }),
      c({ id: "w2", name: "Child support", amount: -206 }),
      c({ id: "w3", name: "Child support", amount: -206 }),
      c({ id: "w4", name: "Child support", amount: -206 }),
    ];
    const led = ledger(items, [], "2026-07", ctx);
    expect(led.commitmentsPlanned).toBe(824); // the month still expects all four
    expect(led.items.every((i) => i.status === "expected")).toBe(true);
  });
});

/* A transfer pair settling one commitment, counted twice.
 *
 * Real data, September 2026:
 *
 *   Chase Checking      -583.57  commitment_id: <mortgage>
 *   Citizens Mortgage   +583.57  commitment_id: null
 *
 * The first leg is the mortgage's actual. The second is unlinked money
 * landing in a loan account, which the ledger counts as cash committed — so
 * one payment was charged to the month twice. Across the mortgage and a
 * HELOC that understated free-to-spend by $883.57, with nothing on any screen
 * saying so. */
describe("a transfer pair settling a commitment", () => {
  const pairCtx: LedgerContext = {
    creditAccountIds: new Set(["card"]),
    loanAccountIds: new Set(["mortgage"]),
    savingsAccountIds: new Set(["save"]),
  };

  const pair = (over: Partial<Transaction> = {}) => [
    {
      id: "out", user_id: "u", account_id: "chk", transfer_account_id: "mortgage",
      date: "2026-09-02", amount: -583.57, type: "transfer", source: "sync",
      reviewed: true, commitment_id: "m1", created_at: "", updated_at: "", ...over,
    },
    {
      id: "in", user_id: "u", account_id: "mortgage", transfer_account_id: "chk",
      date: "2026-09-02", amount: 583.57, type: "transfer", source: "sync",
      reviewed: true, created_at: "", updated_at: "",
    },
  ] as Transaction[];

  const mortgage = {
    id: "m1", user_id: "u", series_id: "mortgage", period: "2026-09", seq: 0,
    name: "Mortgage Payment", kind: "debt", amount: -583.57, interval: 1,
    frequency: "monthly", series_ended: false, skipped: false, variable: false,
    auto_confirm: false, covered_by: null, account_id: "chk",
    created_at: "", updated_at: "",
  } as Commitment;

  it("charges the month once, not twice", () => {
    const led = ledger([mortgage], pair(), "2026-09", pairCtx);
    expect(led.commitmentsEffective).toBeCloseTo(583.57);
    expect(led.discretionary).toBe(0);
  });

  it("still counts an unlinked loan payment nothing promised", () => {
    // no commitment, so nothing else counts it — this must stay
    const [, arriving] = pair();
    const led = ledger([], [arriving], "2026-09", pairCtx);
    expect(led.discretionary).toBeCloseTo(583.57);
  });

  it("counts a savings transfer that settles no plan line", () => {
    const led = ledger(
      [],
      [
        { id: "a", user_id: "u", account_id: "chk", transfer_account_id: "save", date: "2026-09-01", amount: -100, type: "transfer", source: "sync", reviewed: true, created_at: "", updated_at: "" },
        { id: "b", user_id: "u", account_id: "save", transfer_account_id: "chk", date: "2026-09-01", amount: 100, type: "transfer", source: "sync", reviewed: true, created_at: "", updated_at: "" },
      ] as Transaction[],
      "2026-09",
      pairCtx,
    );
    expect(led.discretionary).toBe(100);
  });

  it("leaves free-to-spend $583.57 higher than it was", () => {
    const income = {
      ...mortgage, id: "i1", series_id: "pay", name: "ADP", kind: "income", amount: 4000,
    } as Commitment;
    const led = ledger([income, mortgage], pair(), "2026-09", pairCtx);
    // 4000 planned income, one 583.57 payment: 3416.43, not 2832.86
    expect(led.freeToSpend).toBeCloseTo(3416.43);
  });
});
