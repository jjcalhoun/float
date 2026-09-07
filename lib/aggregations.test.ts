import { describe, it, expect } from "vitest";
import { rollup, loanPaydown, accountBalance, monthKey } from "./aggregations";
import type { Transaction, Account } from "./types";

/* ---- helpers ---- */
const makeTxn = (overrides: Partial<Transaction>): Transaction => ({
  id: "t1",
  user_id: "u1",
  account_id: "a1",
  date: "2026-06-15",
  amount: -50,
  type: "expense",
  source: "manual",
  reviewed: true,
  created_at: "",
  updated_at: "",
  splits: [],
  ...overrides,
});

const makeAccount = (overrides: Partial<Account>): Account => ({
  id: "a1",
  user_id: "u1",
  name: "Checking",
  type: "checking",
  starting_balance: 1000,
  as_of_date: "2026-01-01",
  apr: 0,
  sort_order: 0,
  created_at: "",
  updated_at: "",
  ...overrides,
});

/* ---- monthKey ---- */
describe("monthKey", () => {
  it("returns YYYY-MM from string", () => {
    expect(monthKey("2026-06-15")).toBe("2026-06");
  });
  it("returns YYYY-MM from Date", () => {
    expect(monthKey(new Date(2026, 5, 24))).toBe("2026-06");
  });
});

/* ---- rollup ---- */
describe("rollup — refund nets against category", () => {
  it("refund claws back from the same category", () => {
    const catId = "groceries";
    const txns: Transaction[] = [
      makeTxn({
        id: "t1",
        type: "expense",
        amount: -100,
        date: "2026-06-10",
        splits: [{ id: "s1", user_id: "u1", transaction_id: "t1", category_id: catId, bucket: "needs", amount: -100, created_at: "" }],
      }),
      makeTxn({
        id: "t2",
        type: "refund",
        amount: 30,
        date: "2026-06-12",
        splits: [{ id: "s2", user_id: "u1", transaction_id: "t2", category_id: catId, bucket: "needs", amount: 30, created_at: "" }],
      }),
    ];
    const { byCat, byBucket, spend } = rollup(txns, "2026-06");
    expect(byCat[catId]).toBe(70);    // 100 expense - 30 refund
    expect(byBucket.needs).toBe(70);
    expect(spend).toBe(70);
  });

  it("refund does not inflate income", () => {
    const txns: Transaction[] = [
      makeTxn({ id: "t1", type: "refund", amount: 20, splits: [{ id: "s1", user_id: "u1", transaction_id: "t1", category_id: "other", bucket: "wants", amount: 20, created_at: "" }] }),
    ];
    const { income, spend } = rollup(txns, "2026-06");
    expect(income).toBe(0);
    expect(spend).toBe(-20); // negative = net gain on spending
  });
});

describe("rollup — transfers excluded from spend/income", () => {
  it("transfer does not appear in spend or income", () => {
    const txns: Transaction[] = [
      makeTxn({ id: "t1", type: "transfer", amount: -500, splits: [] }),
      makeTxn({ id: "t2", type: "transfer", amount: 500, splits: [] }),
    ];
    const { income, spend } = rollup(txns, "2026-06");
    expect(income).toBe(0);
    expect(spend).toBe(0);
  });

  it("a transfer INTO savings adds to the savings bucket + spend, counted once", () => {
    const savings = new Set(["sav"]);
    const txns: Transaction[] = [
      // checking outflow (non-savings leg) + savings inflow (the counted leg)
      makeTxn({ id: "t1", account_id: "chk", type: "transfer", amount: -100, splits: [] }),
      makeTxn({ id: "t2", account_id: "sav", type: "transfer", amount: 100, splits: [] }),
    ];
    const { spend, income, byBucket } = rollup(txns, "2026-06", undefined, savings);
    expect(byBucket.savings).toBe(100);
    expect(spend).toBe(100);
    expect(income).toBe(0);
  });

  it("a transfer OUT of savings subtracts from the savings bucket + spend", () => {
    const savings = new Set(["sav"]);
    const txns: Transaction[] = [
      // savings outflow (counted leg) + checking inflow (non-savings leg)
      makeTxn({ id: "t1", account_id: "sav", type: "transfer", amount: -100, splits: [] }),
      makeTxn({ id: "t2", account_id: "chk", type: "transfer", amount: 100, splits: [] }),
    ];
    const { spend, byBucket } = rollup(txns, "2026-06", undefined, savings);
    expect(byBucket.savings).toBe(-100);
    expect(spend).toBe(-100);
  });

  it("a paydown into a loan account counts as spend (needs), reducing net available", () => {
    const savings = new Set<string>();
    const loans = new Set(["loan"]);
    const txns: Transaction[] = [
      // checking outflow (non-loan leg) + loan paydown (the counted leg)
      makeTxn({ id: "t1", account_id: "chk", type: "transfer", amount: -250, splits: [] }),
      makeTxn({ id: "t2", account_id: "loan", type: "transfer", amount: 250, splits: [] }),
    ];
    const { spend, byBucket } = rollup(txns, "2026-06", undefined, savings, loans);
    expect(spend).toBe(250);
    expect(byBucket.needs).toBe(250);
  });

  it("a credit-card payment stays budget-neutral (purchases already counted)", () => {
    const txns: Transaction[] = [
      makeTxn({ id: "t1", account_id: "chk", type: "transfer", amount: -250, splits: [] }),
      makeTxn({ id: "t2", account_id: "card", type: "transfer", amount: 250, splits: [] }),
    ];
    // card is neither in savings nor loan sets
    const { spend, byBucket } = rollup(txns, "2026-06", undefined, new Set(), new Set());
    expect(spend).toBe(0);
    expect(byBucket.needs).toBe(0);
  });

  it("a transfer between non-savings accounts is budget-neutral", () => {
    const savings = new Set(["sav"]);
    const txns: Transaction[] = [
      makeTxn({ id: "t1", account_id: "chk", type: "transfer", amount: -100, splits: [] }),
      makeTxn({ id: "t2", account_id: "cash", type: "transfer", amount: 100, splits: [] }),
    ];
    const { spend, byBucket } = rollup(txns, "2026-06", undefined, savings);
    expect(byBucket.savings).toBe(0);
    expect(spend).toBe(0);
  });

  it("income type accumulates to income, not spend", () => {
    const txns: Transaction[] = [
      makeTxn({ id: "t1", type: "income", amount: 2000, splits: [] }),
    ];
    const { income, spend } = rollup(txns, "2026-06");
    expect(income).toBe(2000);
    expect(spend).toBe(0);
  });
});

describe("rollup — month filter", () => {
  it("only counts transactions in the target month", () => {
    const catId = "dining";
    const txns: Transaction[] = [
      makeTxn({ id: "t1", date: "2026-05-10", amount: -40, splits: [{ id: "s1", user_id: "u1", transaction_id: "t1", category_id: catId, bucket: "wants", amount: -40, created_at: "" }] }),
      makeTxn({ id: "t2", date: "2026-06-10", amount: -60, splits: [{ id: "s2", user_id: "u1", transaction_id: "t2", category_id: catId, bucket: "wants", amount: -60, created_at: "" }] }),
    ];
    const { byCat } = rollup(txns, "2026-06");
    expect(byCat[catId]).toBe(60);
    expect(byCat[catId + "_may"]).toBeUndefined();
  });
});

/* ---- loanPaydown ---- */
describe("loanPaydown — money paid into loan accounts", () => {
  const loans = new Set(["loan"]);

  it("sums paydown legs (transfer into a loan account, amount > 0)", () => {
    const txns = [
      makeTxn({ id: "t1", account_id: "loan", type: "transfer", amount: 250, transfer_account_id: "chk", splits: [] }),
      makeTxn({ id: "t2", account_id: "loan", type: "transfer", amount: 100, transfer_account_id: "chk", splits: [] }),
      // the checking-side outflow leg is NOT counted (different account)
      makeTxn({ id: "t3", account_id: "chk", type: "transfer", amount: -250, transfer_account_id: "loan", splits: [] }),
    ];
    expect(loanPaydown(txns, loans, "2026-06")).toBe(350);
  });

  it("ignores non-loan accounts and non-transfers", () => {
    const txns = [
      makeTxn({ id: "t1", account_id: "chk", type: "income", amount: 500, splits: [] }),
      makeTxn({ id: "t2", account_id: "sav", type: "transfer", amount: 200, splits: [] }),
    ];
    expect(loanPaydown(txns, loans, "2026-06")).toBe(0);
  });
});

/* ---- accountBalance ---- */
describe("accountBalance — strictly after as_of_date", () => {
  const account = makeAccount({ starting_balance: 1000, as_of_date: "2026-01-15" });

  it("excludes transactions ON the as_of_date", () => {
    const txns = [makeTxn({ date: "2026-01-15", amount: -200 })];
    expect(accountBalance(account, txns)).toBe(1000); // not counted
  });

  it("includes transactions strictly after as_of_date", () => {
    const txns = [makeTxn({ date: "2026-01-16", amount: -200 })];
    expect(accountBalance(account, txns)).toBe(800);
  });

  it("includes multiple transactions after cutoff", () => {
    const txns = [
      makeTxn({ id: "t1", date: "2026-02-01", amount: -200 }),
      makeTxn({ id: "t2", date: "2026-03-05", amount: 500 }),
      makeTxn({ id: "t3", date: "2026-01-15", amount: -9999 }), // on cutoff, excluded
      makeTxn({ id: "t4", date: "2026-01-01", amount: -9999, account_id: "other" }), // wrong acct
    ];
    expect(accountBalance(account, txns)).toBe(1300);
  });

  it("only counts transactions for that specific account", () => {
    const txns = [
      makeTxn({ id: "t1", date: "2026-02-01", amount: -100, account_id: "a1" }),
      makeTxn({ id: "t2", date: "2026-02-01", amount: -500, account_id: "other" }),
    ];
    expect(accountBalance(account, txns)).toBe(900);
  });
});

/* A mortgage payment shown as one line under Housing.
 *
 * One payment was appearing in three places: the transfer under "Debt
 * payments", the escrow counter-charge under Housing, and interest nowhere at
 * all — $814 of chart for a $583.57 payment. The Debt tab wants that split;
 * the home screen wants the payment. */
describe("paymentCategoryByAccount", () => {
  const loans = new Set(["mortgage"]);
  const payTo = { paymentCategoryByAccount: { mortgage: "housing" } };

  const payment = {
    id: "p", user_id: "u", account_id: "mortgage", transfer_account_id: "chk",
    date: "2026-09-02", amount: 583.57, type: "transfer", source: "sync",
    reviewed: true, created_at: "", updated_at: "",
  } as Transaction;

  const escrow = {
    id: "e", user_id: "u", account_id: "mortgage", date: "2026-09-01",
    amount: -230.91, type: "expense", source: "escrow", reviewed: true,
    created_at: "", updated_at: "",
    splits: [{ id: "s", user_id: "u", transaction_id: "e", category_id: "housing", bucket: "needs", amount: -230.91, created_at: "" }],
  } as unknown as Transaction;

  it("puts the whole payment under the named category", () => {
    const { byCat } = rollup([payment], "2026-09", undefined, new Set(), loans, payTo);
    expect(byCat.housing).toBeCloseTo(583.57);
  });

  it("drops the escrow split, which is inside that payment", () => {
    // both would show $814.48 for a $583.57 payment
    const { byCat } = rollup([payment, escrow], "2026-09", undefined, new Set(), loans, payTo);
    expect(byCat.housing).toBeCloseTo(583.57);
  });

  it("changes nothing about what the month cost", () => {
    const withCat = rollup([payment, escrow], "2026-09", undefined, new Set(), loans, payTo);
    const without = rollup([payment], "2026-09", undefined, new Set(), loans);
    expect(withCat.spend).toBeCloseTo(without.spend);
    expect(withCat.byBucket.needs).toBeCloseTo(without.byBucket.needs);
  });

  it("leaves an unnamed loan exactly as it was", () => {
    const heloc = { ...payment, id: "h", account_id: "heloc", amount: 300 } as Transaction;
    const { byCat, byBucket } = rollup(
      [heloc], "2026-09", undefined, new Set(), new Set(["heloc"]), payTo,
    );
    expect(byCat.housing).toBeUndefined();
    expect(byBucket.needs).toBe(300);
  });

  it("still keeps escrow under its own category when no payment category is set", () => {
    const { byCat } = rollup([payment, escrow], "2026-09", undefined, new Set(), loans);
    expect(byCat.housing).toBeCloseTo(230.91);
  });
});
