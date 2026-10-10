import { describe, it, expect } from "vitest";
import { cashAccounts, spendAccounts, isGenerated, GENERATED_SOURCES } from "./scope";

/* The real shape of it: Chase on the feed, IUCU not. */
const ACCOUNTS = [
  { id: "chase-checking", type: "checking", name: "Chase Checking" },
  { id: "chase-card", type: "credit", name: "Chase Credit Card" },
  { id: "iucu-checking", type: "checking", name: "IUCU Checking" },
  { id: "iucu-card", type: "credit", name: "IUCU Visa" },
  { id: "heloc", type: "loan", name: "HELOC" },
  { id: "savings", type: "savings", name: "Savings" },
];
const MAPPINGS = [{ account_id: "chase-checking" }, { account_id: "chase-card" }];

const ids = (xs: { id: string }[]) => xs.map((a) => a.id);

describe("what v2 may look at", () => {
  it("takes synced checking for the cash screens", () => {
    expect(ids(cashAccounts(ACCOUNTS, MAPPINGS))).toEqual(["chase-checking"]);
  });

  it("takes synced checking AND synced cards for the spending screen", () => {
    expect(ids(spendAccounts(ACCOUNTS, MAPPINGS))).toEqual(["chase-checking", "chase-card"]);
  });

  it("never lets an unsynced CARD in", () => {
    /* This is the bug. Screen 2 asked for "checking with a mapping, or any
       credit account", and the IUCU Visa walked in through the half of the
       condition with no mapping test on it. The rule has to apply to every
       type, not to whichever type I was thinking about. */
    expect(ids(spendAccounts(ACCOUNTS, MAPPINGS))).not.toContain("iucu-card");
  });

  it("never lets an unsynced checking account in", () => {
    expect(ids(spendAccounts(ACCOUNTS, MAPPINGS))).not.toContain("iucu-checking");
  });

  it("leaves out loans and savings even when they are synced", () => {
    /* A HELOC is a debt, not a place you spend from, and v2 does not do debt
       payoff. Savings is money moved, not money gone. */
    const synced = ACCOUNTS.map((a) => ({ account_id: a.id }));
    const got = ids(spendAccounts(ACCOUNTS, synced));
    expect(got).not.toContain("heloc");
    expect(got).not.toContain("savings");
  });

  it("is empty before the first sync rather than everything", () => {
    /* Failing open here would show IUCU totals as though they were yours to
       spend. Empty is visibly wrong; wrong-but-plausible is not. */
    expect(spendAccounts(ACCOUNTS, [])).toEqual([]);
    expect(cashAccounts(ACCOUNTS, [])).toEqual([]);
  });
});

describe("rows the app wrote for itself", () => {
  it("names all three", () => {
    expect(GENERATED_SOURCES).toEqual(["recurring", "escrow", "interest"]);
  });

  it("excludes interest, which screen 2 had forgotten", () => {
    expect(isGenerated("interest")).toBe(true);
  });

  it("keeps real money", () => {
    for (const s of ["sync", "manual", "csv"]) expect(isGenerated(s)).toBe(false);
  });
});
