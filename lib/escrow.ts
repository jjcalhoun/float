import type { SupabaseClient } from "@supabase/supabase-js";
import type { Account } from "@/lib/types";
import { statementsSince } from "@/lib/interest";
import { todayISO } from "@/lib/dates";

/* Escrow on a mortgage, posted as an account-level charge.
 *
 * A mortgage payment is not all principal. Ours is $583.57, of which $172.02
 * actually reduces the loan; the rest is interest and escrow (taxes and
 * insurance the servicer holds for you). The payment transfer moves the whole
 * $583.57 into the loan account, so without a counter-charge the balance falls
 * three times faster than the real one and every payoff projection is fiction.
 *
 * Interest already posts this way, monthly on the statement day, computed from
 * what was owed at the time. Escrow is the other half and belongs beside it:
 * it is a property of the ACCOUNT (`accounts.escrow_amount`), not of any
 * payment, so it posts whether or not you paid that month.
 *
 * This is what the recurring generator was still being kept alive for — an
 * escrow expense rule that existed only to post one row a month against a loan.
 * A schedule-driven writer of transactions is exactly what the commitments
 * model removed, so the last one moves here and the generator goes.
 *
 * It does NOT count as spending — same as interest. The money left your pocket
 * once already, in the mortgage payment; the spend is counted there. The
 * ledger enforces that by skipping loan accounts outright, so free-to-spend
 * cannot see this row however it is categorised.
 *
 * It does, however, get a CATEGORY when the account names one
 * (`accounts.escrow_category_id`). The category rollup reads splits, so
 * without one several hundred dollars a month of plainly housing-shaped money
 * appears in no category at all — while still, correctly, not being spending.
 * Those two things were conflated: "not spending" was implemented as "no
 * split", which also meant "not anything".
 */

export interface EscrowResult {
  inserted: number;
  errors: string[];
}

export async function postEscrow(
  supabase: SupabaseClient,
  userId: string,
): Promise<EscrowResult> {
  const today = todayISO();

  const [{ data: accounts }, { data: maps }] = await Promise.all([
    supabase.from("accounts").select("*").eq("user_id", userId),
    supabase.from("simplefin_account_map").select("account_id").eq("user_id", userId),
  ]);

  // A synced loan gets its real escrow split from the bank feed.
  const linked = new Set((maps ?? []).map((m) => m.account_id as string));

  let inserted = 0;
  const errors: string[] = [];

  for (const a of (accounts ?? []) as Account[]) {
    const escrow = Number(a.escrow_amount ?? 0);
    if (a.type !== "loan" || escrow <= 0 || linked.has(a.id)) continue;

    // Statements on or before as_of_date are already inside the entered
    // balance; posting them again would double-count.
    const due = statementsSince(today, a.statement_day, a.as_of_date);
    if (due.length === 0) continue;

    const { data: existing } = await supabase
      .from("transactions")
      .select("external_id")
      .eq("account_id", a.id)
      .like("external_id", "escrow:%");
    const posted = new Set((existing ?? []).map((t) => t.external_id as string));

    for (const { monthKey, postDate } of due) {
      const externalId = `escrow:${a.id}:${monthKey}`;
      if (posted.has(externalId)) continue;

      const { data: row, error } = await supabase
        .from("transactions")
        .insert({
          user_id: userId,
          account_id: a.id,
          date: postDate,
          amount: -escrow, // increases what's owed, offsetting the payment
          description: "Escrow",
          merchant: "Escrow",
          type: "expense",
          source: "escrow",
          external_id: externalId,
          reviewed: true,
        })
        .select("id")
        .single();
      if (error) {
        errors.push(error.message);
        continue;
      }
      inserted++;

      // The category, when the account names one. A failure here is not worth
      // losing the transaction over — the row is what keeps the loan balance
      // honest, and an uncategorised escrow is exactly what we had before.
      if (a.escrow_category_id && row) {
        const { error: splitError } = await supabase.from("transaction_splits").insert({
          user_id: userId,
          transaction_id: row.id,
          category_id: a.escrow_category_id,
          bucket: "needs", // a mortgage is not discretionary
          amount: -escrow,
        });
        if (splitError) errors.push(splitError.message);
      }
    }
  }

  return { inserted, errors };
}
