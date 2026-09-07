import { describe, it, expect, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createDemoClient } from "@/lib/demo/client";
import { postEscrow } from "./escrow";

/* Escrow is the last thing the recurring generator was kept alive for, so
   these mostly pin that it took the job over intact — and that it is an
   ACCOUNT charge, not a payment: it posts whether or not you paid this month,
   and it never becomes spend, because the mortgage payment already was. */

const db = createDemoClient() as unknown as SupabaseClient;
const U = "escrow-user";

const account = (over: Record<string, unknown>) => ({
  user_id: U,
  type: "loan",
  starting_balance: -120000,
  as_of_date: "2026-05-31",
  apr: 0,
  statement_day: 1,
  escrow_amount: 230.91,
  ...over,
});

async function reset() {
  await db.from("transactions").delete().eq("user_id", U);
  await db.from("accounts").delete().eq("user_id", U);
  await db.from("simplefin_account_map").delete().eq("user_id", U);
  await db.from("transaction_splits").delete().eq("user_id", U);
}

const splitsFor = async (txns: { id: string }[]) => {
  const { data } = await db
    .from("transaction_splits")
    .select("*")
    .in("transaction_id", txns.map((t) => t.id));
  return data ?? [];
};

const rows = async () => {
  const { data } = await db.from("transactions").select("*").eq("user_id", U);
  return data ?? [];
};

describe("postEscrow", () => {
  beforeEach(reset);

  it("posts one charge per missed statement, oldest first", async () => {
    await db.from("accounts").insert(account({ id: "mortgage", name: "Mortgage" }));
    const r = await postEscrow(db, U);
    // as_of 5/31, statement on the 1st: June, July and August have all passed
    expect(r.errors).toEqual([]);
    expect(r.inserted).toBeGreaterThanOrEqual(2);
    const posted = await rows();
    expect(posted.every((t) => t.amount === -230.91)).toBe(true);
    expect(posted.every((t) => t.account_id === "mortgage")).toBe(true);
  });

  it("increases what's owed, offsetting the payment's over-credit", async () => {
    // the payment transfers the FULL $583.57 into the loan; without this the
    // balance would fall three times faster than the real one
    await db.from("accounts").insert(account({ id: "m2", name: "Mortgage" }));
    await postEscrow(db, U);
    const posted = await rows();
    expect(posted[0].amount).toBeLessThan(0);
  });

  it("is idempotent — running twice posts nothing new", async () => {
    await db.from("accounts").insert(account({ id: "m3", name: "Mortgage" }));
    const first = await postEscrow(db, U);
    const second = await postEscrow(db, U);
    expect(second.inserted).toBe(0);
    expect((await rows()).length).toBe(first.inserted);
  });

  it("posts no split when the account names no category", async () => {
    await db.from("accounts").insert(account({ id: "m4", name: "Mortgage" }));
    await postEscrow(db, U);
    expect(await splitsFor(await rows())).toEqual([]);
  });

  it("attaches the account's category when it has one", async () => {
    /* "Not spending" had been implemented as "no split", which also meant "not
       in any category" — so several hundred dollars a month of plainly
       housing-shaped money appeared nowhere in the breakdown. It is still not
       spending: the ledger skips loan accounts outright, so free-to-spend
       cannot see this row however it is categorised. */
    await db
      .from("accounts")
      .insert(account({ id: "m5", name: "Mortgage", escrow_category_id: "housing" }));
    await postEscrow(db, U);

    const posted = await rows();
    const splits = await splitsFor(posted);
    expect(splits.length).toBe(posted.length);
    for (const s of splits) {
      expect(s.category_id).toBe("housing");
      expect(s.bucket).toBe("needs"); // a mortgage is not discretionary
    }
  });

  it("splits for the whole charge, matching the transaction's sign", async () => {
    await db
      .from("accounts")
      .insert(account({ id: "m6", name: "Mortgage", escrow_category_id: "housing" }));
    await postEscrow(db, U);

    const posted = await rows();
    const splits = await splitsFor(posted);
    const byTxn = new Map(splits.map((s) => [s.transaction_id, s.amount]));
    for (const t of posted) expect(byTxn.get(t.id)).toBe(t.amount);
  });

  it("skips statements already inside the entered balance", async () => {
    // a balance entered as of today has every past statement in it already
    await db.from("accounts").insert(
      account({ id: "m5", name: "Mortgage", as_of_date: "2099-01-01" }),
    );
    expect((await postEscrow(db, U)).inserted).toBe(0);
  });

  it("leaves a synced loan alone — the bank sends the real split", async () => {
    await db.from("accounts").insert(account({ id: "m6", name: "Mortgage" }));
    await db
      .from("simplefin_account_map")
      .insert({ user_id: U, account_id: "m6", connection_id: "c", simplefin_account_id: "x" });
    expect((await postEscrow(db, U)).inserted).toBe(0);
  });

  it("ignores an account with no escrow set", async () => {
    await db.from("accounts").insert(account({ id: "m7", name: "Car loan", escrow_amount: 0 }));
    expect((await postEscrow(db, U)).inserted).toBe(0);
  });

  it("ignores non-loan accounts even if a figure is set", async () => {
    // escrow is a mortgage idea; a card with a stray value shouldn't accrue one
    await db
      .from("accounts")
      .insert(account({ id: "m8", name: "Visa", type: "credit", escrow_amount: 50 }));
    expect((await postEscrow(db, U)).inserted).toBe(0);
  });
});
