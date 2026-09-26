import { describe, it, expect } from "vitest";
import { findUnmatchedIncome, overstatedBy } from "./unmatched";
import { suggestCommitment } from "./match";
import { ledger } from "./ledger";
import type { Commitment } from "./types";
import type { Transaction } from "@/lib/types";

/* Income counted twice.
 *
 * August read $6,979 of income against a real $4,631. Two deposits — a $420
 * payday allocation and an $1,845.67 ADP paycheck — had arrived and were never
 * matched to the plan lines expecting them. The lines counted from the 1st;
 * the deposits counted again as income beyond the plan. Same money, twice,
 * with nothing on any screen saying so.
 *
 * It slipped through review because the matcher refused to pre-select: two
 * paydays a month are identical apart from their date, so neither was ever
 * "clearly better than the runner-up". Both halves are covered here — spotting
 * it after the fact, and not creating it in the first place.
 */

const c = (o: Partial<Commitment> & { id: string }) =>
  ({
    user_id: "u", series_id: o.id, period: "2026-08", seq: 0, name: "ADP Totalsource",
    kind: "income", amount: 1845.66, interval: 1, frequency: "semimonthly",
    series_ended: false, skipped: false, variable: false, auto_confirm: false,
    covered_by: null, account_id: "chk", created_at: "", updated_at: "", ...o,
  }) as Commitment;

const t = (o: Partial<Transaction> & { id: string }) =>
  ({
    user_id: "u", account_id: "chk", date: "2026-08-29", amount: 0,
    type: "income", source: "sync", reviewed: true,
    created_at: "", updated_at: "", ...o,
  }) as Transaction;

/* The real August, simplified: two ADP paydays and two payday allocations. */
const adp15 = c({ id: "adp15", series_id: "adp", due_hint: "2026-08-15" });
const adp31 = c({ id: "adp31", series_id: "adp", seq: 1, due_hint: "2026-08-31" });
const alloc15 = c({ id: "al15", series_id: "alloc", name: "payday allocation", amount: 420, due_hint: "2026-08-15" });
const alloc31 = c({ id: "al31", series_id: "alloc", seq: 1, name: "payday allocation", amount: 420, due_hint: "2026-08-31" });
const plan = [adp15, adp31, alloc15, alloc31];

describe("finding income the plan already expected", () => {
  it("spots the paycheck that arrived unmatched", () => {
    const pay = t({ id: "p", amount: 1845.67, merchant: "ADP Totalsource" });
    const found = findUnmatchedIncome(plan, [pay], "2026-08");
    expect(found).toHaveLength(1);
    expect(found[0].expected.id).toBe("adp31"); // nearest date, not the 15th
  });

  it("reports what the month is overstated by", () => {
    const rows = [
      t({ id: "a", amount: 1845.67, date: "2026-08-29", merchant: "ADP Totalsource" }),
      t({ id: "b", amount: 420, date: "2026-08-06", merchant: "Online Deposit Check #1" }),
    ];
    const found = findUnmatchedIncome(plan, rows, "2026-08");
    expect(found).toHaveLength(2);
    expect(overstatedBy(found)).toBeCloseTo(2265.67, 2);
  });

  it("leaves a genuine windfall alone", () => {
    // $100 that nothing planned is real extra income and belongs in the number
    const gift = t({ id: "g", amount: 100, date: "2026-08-04", merchant: "Online Deposit Check #1" });
    expect(findUnmatchedIncome(plan, [gift], "2026-08")).toEqual([]);
  });

  it("never points two deposits at the same line", () => {
    const rows = [
      t({ id: "a", amount: 1845.66, date: "2026-08-15", merchant: "ADP Totalsource" }),
      t({ id: "b", amount: 1845.66, date: "2026-08-31", merchant: "ADP Totalsource" }),
    ];
    const found = findUnmatchedIncome(plan, rows, "2026-08");
    expect(new Set(found.map((f) => f.expected.id)).size).toBe(found.length);
  });

  it("ignores a line that is already settled", () => {
    const paid = t({ id: "paid", amount: 1845.66, date: "2026-08-15", commitment_id: "adp15" });
    const late = t({ id: "late", amount: 1845.67, date: "2026-08-29", merchant: "ADP Totalsource" });
    const found = findUnmatchedIncome(plan, [paid, late], "2026-08");
    expect(found.map((f) => f.expected.id)).toEqual(["adp31"]);
  });

  it("ignores a covered or skipped line", () => {
    const pay = t({ id: "p", amount: 1845.67, merchant: "ADP Totalsource" });
    const skipped = [c({ ...adp31, skipped: true }), c({ ...adp15, skipped: true })];
    expect(findUnmatchedIncome(skipped, [pay], "2026-08")).toEqual([]);
  });

  it("ignores other months and outgoing money", () => {
    const july = t({ id: "j", amount: 1845.66, date: "2026-07-31", merchant: "ADP Totalsource" });
    const spend = t({ id: "s", amount: -1845.66, type: "expense" });
    expect(findUnmatchedIncome(plan, [july, spend], "2026-08")).toEqual([]);
  });

  it("won't claim a deposit that is nothing like the plan", () => {
    // a $900 deposit against an $1,845 line is not that paycheck
    const odd = t({ id: "o", amount: 900, merchant: "ADP Totalsource" });
    expect(findUnmatchedIncome(plan, [odd], "2026-08")).toEqual([]);
  });

  it("matches by name even when the deposit is early", () => {
    const early = t({ id: "e", amount: 1845.66, date: "2026-08-02", merchant: "ADP Totalsource" });
    expect(findUnmatchedIncome(plan, [early], "2026-08")).toHaveLength(1);
  });
});

describe("not creating the problem: twin paydays get a suggestion", () => {
  it("suggests the NEARER of two identical occurrences", () => {
    // the rule that blocked this exists so an ambiguous pair is left alone.
    // Two occurrences of one series at one amount are not ambiguous that way:
    // the date is the only discriminator, so it should decide.
    const pay = t({ id: "p", amount: 1845.66, date: "2026-08-29", merchant: "ADP TOTALSOURCE" });
    const s = suggestCommitment(pay, [adp15, adp31]);
    expect(s?.id).toBe("adp31");
  });

  it("still refuses when the twins are DIFFERENT series", () => {
    // Two separate bills that happen to look alike stay ambiguous, as before —
    // picking one would be a guess about WHICH BILL, not which occurrence.
    // (This is also what a duplicate series looks like, and quietly choosing
    // between duplicates is how the Ooma double-charge went unnoticed.)
    const a = c({ id: "x", series_id: "one", name: "Rent", kind: "bill", amount: -500, due_hint: "2026-08-10" });
    const b = c({ id: "y", series_id: "two", name: "Rent", kind: "bill", amount: -500, due_hint: "2026-08-10" });
    const pay = t({ id: "p", amount: -500, type: "expense", date: "2026-08-10", merchant: "Rent" });
    expect(suggestCommitment(pay, [a, b])).toBeNull();
  });
});

describe("what matching actually fixes", () => {
  const ctx = {
    creditAccountIds: new Set<string>(),
    loanAccountIds: new Set<string>(),
    savingsAccountIds: new Set<string>(),
  };

  it("unmatched: the paycheck counts twice", () => {
    const pay = t({ id: "p", amount: 1845.66, merchant: "ADP Totalsource" });
    const led = ledger([adp31], [pay], "2026-08", ctx);
    expect(led.incomeEffective).toBe(1845.66); // the plan line
    expect(led.extraIncome).toBe(1845.66); // and the deposit again
    expect(led.freeToSpend).toBeCloseTo(3691.32, 2);
  });

  it("matched: it counts once", () => {
    const pay = t({ id: "p", amount: 1845.66, merchant: "ADP Totalsource", commitment_id: "adp31" });
    const led = ledger([adp31], [pay], "2026-08", ctx);
    expect(led.incomeEffective).toBe(1845.66);
    expect(led.extraIncome).toBe(0);
    expect(led.freeToSpend).toBeCloseTo(1845.66, 2);
  });
});

describe("a deposit the user says is not from the plan", () => {
  /* A $500 deposit can look exactly like a $500 payday allocation and be
     something else entirely. Match was the card's only action, so the prompt
     came back every time the screen opened, forever, about money that was
     never wrong. */
  it("is not reported once marked exempt", () => {
    const line = c({ id: "pay", name: "payday allocation", amount: 500, due_hint: "2026-08-24" });
    const dep = t({ id: "d", amount: 500, date: "2026-08-24", merchant: "payday allocation" });

    expect(findUnmatchedIncome([line], [dep], "2026-08")).toHaveLength(1);
    expect(findUnmatchedIncome([line], [{ ...dep, plan_exempt: true }], "2026-08")).toEqual([]);
  });

  it("still counts as extra income — the flag changes no total", () => {
    // it was always extra while unlinked; this only silences the prompt
    const dep = t({ id: "d", amount: 500, plan_exempt: true });
    expect(dep.commitment_id).toBeUndefined();
  });
});
