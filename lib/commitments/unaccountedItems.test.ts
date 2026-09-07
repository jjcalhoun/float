import { describe, it, expect } from "vitest";
import { unaccountedItems, unaccountedTotal } from "./unaccountedItems";
import type { LedgerContext } from "./ledger";
import type { Transaction } from "@/lib/types";
import type { Commitment } from "./types";

// Every commitment the tests link to, all live and in-period.
const C = ["c1", "mortgage", "heloc", "a", "b", "c"].map(
  (id) => ({ id, period: "2026-09", skipped: false, covered_by: null }) as Commitment,
);

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
  it("a card payment — nothing else in the ring shows it", () => {
    const rows = unaccountedItems(C, [t({ id: "cc", account_id: "card", type: "transfer", amount: 300 })], "2026-09", ctx);
    expect(rows[0].gap).toBe(300);
  });

  it("a settled plan payment whose transaction was never categorised", () => {
    // the common one: marking a bill paid records the payment, not a category
    const rows = unaccountedItems(C, [t({ id: "bill", amount: -74.99, commitment_id: "c1" })], "2026-09", ctx);
    expect(rows[0].gap).toBe(74.99);
  });

  it("only the UNCATEGORISED part of a partly-categorised payment", () => {
    const rows = unaccountedItems(
      C,
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
    expect(unaccountedItems(C, [t({ id: "g", amount: -50, splits: split(-50) })], "2026-09", ctx)).toEqual([]);
  });

  it("a loan payment — the debt petal already shows it", () => {
    expect(
      unaccountedItems(C, [t({ id: "ln", account_id: "loan", type: "transfer", amount: 583.57 })], "2026-09", ctx),
    ).toEqual([]);
  });

  it("the PAYING leg of a loan payment, seen from checking", () => {
    /* The reported double count. A mortgage payment is a pair: money leaves
       checking and arrives at the loan. The debt petal counts the arriving
       leg, so reporting the departing one here put one payment in two wedges
       at once — $583.57 under Debt payments AND under "not in a category". */
    const rows = unaccountedItems(
      C,
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
      C,
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
    expect(unaccountedItems(C, [t({ id: "pay", type: "income", amount: 1845.66 })], "2026-09", ctx)).toEqual([]);
  });

  it("interest or escrow on a loan — the ledger never counted them", () => {
    // consequences of a payment that already counted; counting them here would
    // charge the month twice
    const rows = unaccountedItems(
      C,
      [t({ id: "int", account_id: "loan", amount: -412.1 }), t({ id: "esc", account_id: "loan", amount: -230.91 })],
      "2026-09",
      ctx,
    );
    expect(rows).toEqual([]);
  });

  it("a savings transfer — the Savings petal shows it now", () => {
    /* This used to be the wedge's one legitimate resident, because saving had
       no slice of its own: rollup files it under a bucket, never a category.
       It has a petal now, so it is accounted for. */
    const rows = unaccountedItems(
      C,
      [
        t({ id: "out", account_id: "chk", type: "transfer", amount: -250, transfer_account_id: "save" }),
        t({ id: "in", account_id: "save", type: "transfer", amount: 250 }),
      ],
      "2026-09",
      ctx,
    );
    expect(rows).toEqual([]);
  });

  it("a transaction in another month, linked to another month's line", () => {
    const august = [{ id: "aug", period: "2026-08", skipped: false, covered_by: null }] as Commitment[];
    expect(
      unaccountedItems(august, [t({ id: "x", date: "2026-08-10", commitment_id: "aug" })], "2026-09", ctx),
    ).toEqual([]);
  });

  it("a payment settling a SKIPPED or covered line — the ledger counts it zero", () => {
    const odd = [
      { id: "skip", period: "2026-09", skipped: true, covered_by: null },
      { id: "cov", period: "2026-09", skipped: false, covered_by: "other" },
    ] as Commitment[];
    const rows = unaccountedItems(
      odd,
      [t({ id: "a", amount: -50, commitment_id: "skip" }), t({ id: "b", amount: -50, commitment_id: "cov" })],
      "2026-09",
      ctx,
    );
    expect(rows).toEqual([]);
  });
});

describe("the card view moves one thing, deliberately", () => {
  const purchase = t({ id: "buy", account_id: "card", amount: -80, splits: split(-80) });

  it("a categorised card purchase is accounted for in the spend view", () => {
    expect(unaccountedItems(C, [purchase], "2026-09", ctx, { countCardPurchases: true })).toEqual([]);
  });

  it("and invisible to the ledger in the cash view, so still no row", () => {
    expect(unaccountedItems(C, [purchase], "2026-09", ctx, { countCardPurchases: false })).toEqual([]);
  });
});

describe("a linked payment belongs to its LINE's month, not its own", () => {
  it("counts a bill that cleared next month against this month", () => {
    /* The ledger buckets a linked row by its commitment's period whatever day
       it cleared. Filtering by transaction date alone missed those, so they
       were counted by the ledger, absent from this list, and the wedge and the
       sheet disagreed by exactly that much. */
    const rows = unaccountedItems(
      C,
      [t({ id: "late", date: "2026-10-02", amount: -120, commitment_id: "c1" })],
      "2026-09",
      ctx,
    );
    expect(ids(rows)).toEqual(["late"]);
    expect(rows[0].gap).toBe(120);
  });
});

describe("totals", () => {
  it("sums the gaps, not the transactions", () => {
    const rows = unaccountedItems(
      C,
      [
        t({ id: "cc", account_id: "card", type: "transfer", amount: 250 }),
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
      C,
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

describe("a transfer pair the plan already counted", () => {
  it("shows ONE leg, not both — one payment, one hole", () => {
    /* A paid card payment really does have nowhere to show: the debt petal
       counts loan accounts only, and "upcoming card payments" stops being
       upcoming once it is paid. So the paying leg belongs here. Its arriving
       twin does not — that is the same money, and counting both was how the
       ledger came to charge a mortgage to the month twice. */
    const rows = unaccountedItems(
      [{ id: "cc1", period: "2026-09", skipped: false, covered_by: null }] as Commitment[],
      [
        t({ id: "out", account_id: "chk", type: "transfer", amount: -300, transfer_account_id: "card", commitment_id: "cc1", date: "2026-09-20" }),
        t({ id: "in", account_id: "card", type: "transfer", amount: 300, transfer_account_id: "chk", date: "2026-09-20" }),
      ],
      "2026-09",
      ctx,
    );
    expect(ids(rows)).toEqual(["out"]);
    expect(rows[0].gap).toBe(300);
  });
});
