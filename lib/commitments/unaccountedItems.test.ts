import { describe, it, expect } from "vitest";
import { unaccountedItems, unaccountedTotal } from "./unaccountedItems";
import type { LedgerContext } from "./ledger";
import type { Transaction } from "@/lib/types";

/* The "not in a category" wedge used to be a subtraction, which made it the
   one slice you couldn't open — a residual has nothing in it. These pin what
   actually belongs there, and the rule is narrow: a row appears only when the
   ledger counted money leaving and no category (or the debt petal) could hold
   it. */

const ctx: LedgerContext = {
  creditAccountIds: new Set(["card"]),
  loanAccountIds: new Set(["loan"]),
  savingsAccountIds: new Set(["save"]),
};

const t = (o: Partial<Transaction> & { id: string }): Transaction =>
  ({
    user_id: "u", account_id: "chk", date: "2026-09-10", amount: -100,
    type: "expense", source: "sync", reviewed: true,
    created_at: "", updated_at: "", ...o,
  }) as Transaction;

const split = (amount: number, category_id = "groceries") =>
  [{ id: "s", user_id: "u", transaction_id: "t", category_id, bucket: "needs", amount, created_at: "" }] as Transaction["splits"];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("what belongs in the wedge", () => {
  it("a savings transfer — real money, no category can hold it", () => {
    const rows = unaccountedItems([t({ id: "sv", account_id: "save", type: "transfer", amount: 250 })], "2026-09", ctx);
    expect(ids(rows)).toEqual(["sv"]);
    expect(rows[0].gap).toBe(250);
  });

  it("a card payment — likewise", () => {
    const rows = unaccountedItems([t({ id: "cc", account_id: "card", type: "transfer", amount: 300 })], "2026-09", ctx);
    expect(rows[0].gap).toBe(300);
  });

  it("a settled plan payment whose transaction was never categorised", () => {
    // the common one: marking a bill paid records the payment, not a category
    const rows = unaccountedItems([t({ id: "bill", amount: -74.99, commitment_id: "c1" })], "2026-09", ctx);
    expect(rows[0].gap).toBe(74.99);
  });

  it("only the UNCATEGORISED part of a partly-categorised payment", () => {
    const rows = unaccountedItems(
      [t({ id: "part", amount: -100, commitment_id: "c1", splits: split(-40) })],
      "2026-09",
      ctx,
    );
    expect(rows[0].ledger).toBe(100);
    expect(rows[0].ring).toBe(40);
    expect(rows[0].gap).toBe(60);
  });
});

describe("what must never appear", () => {
  it("an ordinary categorised purchase", () => {
    expect(unaccountedItems([t({ id: "g", amount: -50, splits: split(-50) })], "2026-09", ctx)).toEqual([]);
  });

  it("a loan payment — the debt petal already shows it", () => {
    expect(
      unaccountedItems([t({ id: "ln", account_id: "loan", type: "transfer", amount: 583.57 })], "2026-09", ctx),
    ).toEqual([]);
  });

  it("the PAYING leg of a loan payment, seen from checking", () => {
    /* The reported double count. A mortgage payment is a pair: money leaves
       checking and arrives at the loan. The debt petal counts the arriving
       leg, so reporting the departing one here put one payment in two wedges
       at once — $583.57 under Debt payments AND under "not in a category". */
    const rows = unaccountedItems(
      [
        t({
          id: "pay",
          account_id: "chk",
          type: "transfer",
          amount: -583.57,
          transfer_account_id: "loan",
          commitment_id: "mortgage",
        }),
      ],
      "2026-09",
      ctx,
    );
    expect(rows).toEqual([]);
  });

  it("both legs of a loan payment, when the feed sends both", () => {
    const rows = unaccountedItems(
      [
        t({ id: "out", account_id: "chk", type: "transfer", amount: -300, transfer_account_id: "loan", commitment_id: "heloc" }),
        t({ id: "in", account_id: "loan", type: "transfer", amount: 300 }),
      ],
      "2026-09",
      ctx,
    );
    expect(rows).toEqual([]);
  });

  it("income", () => {
    expect(unaccountedItems([t({ id: "pay", type: "income", amount: 1845.66 })], "2026-09", ctx)).toEqual([]);
  });

  it("interest or escrow on a loan — the ledger never counted them", () => {
    // consequences of a payment that already counted; counting them here would
    // charge the month twice
    const rows = unaccountedItems(
      [t({ id: "int", account_id: "loan", amount: -412.1 }), t({ id: "esc", account_id: "loan", amount: -230.91 })],
      "2026-09",
      ctx,
    );
    expect(rows).toEqual([]);
  });

  it("the outbound leg of a transfer, so a pair counts once", () => {
    const rows = unaccountedItems(
      [
        t({ id: "out", account_id: "chk", type: "transfer", amount: -250 }),
        t({ id: "in", account_id: "save", type: "transfer", amount: 250 }),
      ],
      "2026-09",
      ctx,
    );
    expect(ids(rows)).toEqual(["in"]);
  });

  it("another month", () => {
    expect(unaccountedItems([t({ id: "x", date: "2026-08-10", commitment_id: "c" })], "2026-09", ctx)).toEqual([]);
  });
});

describe("the card view moves one thing, deliberately", () => {
  const purchase = t({ id: "buy", account_id: "card", amount: -80, splits: split(-80) });

  it("a categorised card purchase is accounted for in the spend view", () => {
    expect(unaccountedItems([purchase], "2026-09", ctx, { countCardPurchases: true })).toEqual([]);
  });

  it("and invisible to the ledger in the cash view, so still no row", () => {
    expect(unaccountedItems([purchase], "2026-09", ctx, { countCardPurchases: false })).toEqual([]);
  });
});

describe("totals", () => {
  it("sums the gaps, not the transactions", () => {
    const rows = unaccountedItems(
      [
        t({ id: "sv", account_id: "save", type: "transfer", amount: 250 }),
        t({ id: "part", amount: -100, commitment_id: "c1", splits: split(-40) }),
        t({ id: "fine", amount: -50, splits: split(-50) }),
      ],
      "2026-09",
      ctx,
    );
    expect(unaccountedTotal(rows)).toBe(310); // 250 + 60, not 400
  });

  it("orders by the size of the hole", () => {
    const rows = unaccountedItems(
      [
        t({ id: "small", amount: -10, commitment_id: "a" }),
        t({ id: "big", amount: -900, commitment_id: "b" }),
      ],
      "2026-09",
      ctx,
    );
    expect(ids(rows)).toEqual(["big", "small"]);
  });
});
