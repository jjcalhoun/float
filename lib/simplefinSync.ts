import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { decrypt } from "@/lib/crypto";
import { fetchAccounts } from "@/lib/simplefin";
import { guessCategory } from "@/lib/autocategorize";
import { classifyTxn } from "@/lib/classifyTxn";
import { pairTransfers, type PairItem } from "@/lib/pairTransfers";
import type { Account, Category, TransactionType } from "@/lib/types";

// SimpleFIN caps the requested range and warns when it's exceeded; in practice
// the limit observed on this connection is 45 days (89 still tripped it).
// 44 days stays safely inside the cap, and routine syncs only need recent days
// anyway — dedupe on external_id handles the overlap.
const SYNC_WINDOW_SECONDS = 44 * 24 * 60 * 60;
const PAIR_WINDOW_DAYS = 5;

export interface SyncResult {
  inserted: number;
  balancesUpdated: number;
  errors: string[];
}

interface Candidate {
  externalId: string;
  accountId: string;
  date: string;
  amount: number;
  description: string;
  type: TransactionType;
  interest: boolean;
  splitCategoryId: string | null;
  splitBucket: string | null;
  autoReview: boolean;
}

/* Core SimpleFIN sync for one user. Works with any Supabase client whose queries
   resolve to this user's rows — the session client (RLS scopes automatically) or
   the service-role admin client used by the cron (we scope by userId here).
   Pulls ~44 days, updates live balances, classifies new transactions, pairs the
   two sides of transfers (so card payments don't double-count), and inserts. */
export async function syncUser(
  supabase: SupabaseClient,
  userId: string,
  opts: { connectionId?: string } = {},
): Promise<SyncResult> {
  const [{ data: settings }, { data: categories }, { data: maps }, { data: accounts }] =
    await Promise.all([
      supabase.from("settings").select("autocategorize_imports").eq("user_id", userId).single(),
      supabase.from("categories").select("*").eq("user_id", userId).eq("is_archived", false),
      supabase.from("simplefin_account_map").select("*").eq("user_id", userId),
      supabase.from("accounts").select("id, type, live_balance").eq("user_id", userId),
    ]);
  const autocategorize = settings?.autocategorize_imports ?? true;
  const cats = (categories ?? []) as Category[];
  const typeFor = new Map(
    (accounts ?? []).map((a) => [a.id as string, a.type as Account["type"]]),
  );
  const balanceFor = new Map(
    (accounts ?? []).map((a) => [a.id as string, a.live_balance as number | null]),
  );
  const accountFor = new Map(
    (maps ?? []).map((m) => [m.simplefin_account_id as string, m.account_id as string]),
  );

  let connQuery = supabase
    .from("simplefin_connections")
    .select("id, access_url_enc")
    .eq("user_id", userId);
  if (opts.connectionId) connQuery = connQuery.eq("id", opts.connectionId);
  const { data: connections, error: connErr } = await connQuery;
  if (connErr) throw new Error(connErr.message);

  const startDate = Math.floor(Date.now() / 1000) - SYNC_WINDOW_SECONDS;
  let balancesUpdated = 0;
  const errors: string[] = [];

  // ---- Phase 1: fetch + classify into candidates (no inserts yet) ----
  const candidates: Candidate[] = [];

  for (const conn of connections ?? []) {
    let accessUrl: string;
    try {
      accessUrl = decrypt(conn.access_url_enc as string);
    } catch {
      errors.push("Could not decrypt a connection");
      continue;
    }

    let set;
    try {
      set = await fetchAccounts(accessUrl, { startDate, pending: true });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : "Fetch failed");
      continue;
    }
    errors.push(...set.errors);

    for (const acct of set.accounts) {
      const ourAccountId = accountFor.get(acct.id);
      if (!ourAccountId) continue; // unmapped — skip until the user maps it

      // Live balance (decision 1: trust SimpleFIN's balance for linked accts).
      // Always record the value + the bank's as-of date (so freshness is
      // visible), but only *count* it as updated when the number actually
      // changed — so "N balances updated" reflects real movement, not writes.
      const newBalance = Number(acct.balance);
      const prevBalance = balanceFor.get(ourAccountId);
      /* Both figures. `balance` is what has posted; `available-balance` is
         that less pending authorisations and holds, and is what the bank's
         own app shows you. Screen 1 wants available — a pending charge is
         money that is gone — while reconciling against a list of
         transactions wants posted, so neither can be dropped. Not every
         institution sends available. */
      const avail = acct["available-balance"];
      const { error: balErr } = await supabase
        .from("accounts")
        .update({
          live_balance: newBalance,
          live_available_balance: avail == null ? null : Number(avail),
          live_balance_at: new Date(acct["balance-date"] * 1000).toISOString(),
        })
        .eq("id", ourAccountId)
        .eq("user_id", userId);
      if (!balErr && prevBalance !== newBalance) balancesUpdated++;

      const incoming = acct.transactions ?? [];
      if (incoming.length === 0) continue;

      const externalIds = incoming.map((t) => `simplefin:${t.id}`);
      const { data: existing } = await supabase
        .from("transactions")
        .select("external_id")
        .eq("account_id", ourAccountId)
        .in("external_id", externalIds);
      const seen = new Set((existing ?? []).map((r) => r.external_id as string));

      for (const t of incoming) {
        const externalId = `simplefin:${t.id}`;
        if (seen.has(externalId)) continue;
        seen.add(externalId);

        const description = t.payee || t.description || "Transaction";
        const c = classifyTxn({
          amount: Number(t.amount),
          description,
          accountType: typeFor.get(ourAccountId) ?? "checking",
          accountBalance: Number(acct.balance),
        });

        // Interest gets no split → it adds to the balance but is excluded from
        // spend/leftover (spend is computed only from splits). Real purchases
        // get a best-guess category.
        const splitCat =
          c.type === "expense" && !c.interest && autocategorize
            ? guessCategory(description, cats)
            : null;

        // Pending transactions can report posted:0; fall back to transacted_at
        // (or now) so they aren't dated to 1970 and hidden from the recent view.
        const tsSeconds = t.posted || t.transacted_at || Math.floor(Date.now() / 1000);

        candidates.push({
          externalId,
          accountId: ourAccountId,
          date: new Date(tsSeconds * 1000).toISOString().slice(0, 10),
          amount: c.normalizedAmount,
          description,
          type: c.type,
          interest: c.interest,
          splitCategoryId: splitCat?.id ?? null,
          splitBucket: splitCat?.bucket ?? null,
          autoReview: c.autoReview,
        });
      }
    }

    await supabase
      .from("simplefin_connections")
      .update({ last_synced_at: new Date().toISOString() })
      .eq("id", conn.id)
      .eq("user_id", userId);
  }

  // ---- Phase 2: pair the two sides of transfers ----
  // Include recently-synced existing rows so a counterpart that posted in an
  // earlier sync can still be matched and converted.
  const mappedIds = [...new Set(accountFor.values())];
  const windowStart = candidates.reduce(
    (min, c) => (c.date < min ? c.date : min),
    new Date(Date.now() - (PAIR_WINDOW_DAYS + 1) * 86400000).toISOString().slice(0, 10),
  );
  const { data: recent } =
    mappedIds.length > 0
      ? await supabase
          .from("transactions")
          .select("id, account_id, date, amount, type")
          .in("account_id", mappedIds)
          .gte("date", windowStart)
      : { data: [] };

  const items: PairItem[] = [
    ...candidates.map((c) => ({
      id: c.externalId,
      accountId: c.accountId,
      date: c.date,
      amount: c.amount,
      type: c.type,
    })),
    ...((recent ?? []) as { id: string; account_id: string; date: string; amount: number; type: PairItem["type"] }[]).map(
      (r) => ({ id: r.id, accountId: r.account_id, date: r.date, amount: Number(r.amount), type: r.type }),
    ),
  ];
  const candidateKeys = new Set(candidates.map((c) => c.externalId));

  // For each pair, record the counterpart + a shared group id keyed by item id.
  const link = new Map<string, { counterAccount: string; group: string }>();
  for (const { a, b } of pairTransfers(items, PAIR_WINDOW_DAYS)) {
    const group = randomUUID();
    link.set(a.id, { counterAccount: b.accountId, group });
    link.set(b.id, { counterAccount: a.accountId, group });
  }

  // Convert any matched EXISTING rows into linked transfers (drop their splits).
  for (const [id, l] of link) {
    if (candidateKeys.has(id)) continue; // it's a new candidate, handled below
    await supabase.from("transaction_splits").delete().eq("transaction_id", id);
    await supabase
      .from("transactions")
      .update({
        type: "transfer",
        transfer_account_id: l.counterAccount,
        transfer_group_id: l.group,
        reviewed: true,
      })
      .eq("id", id)
      .eq("user_id", userId);
  }

  // ---- Phase 3: insert new candidates ----
  let inserted = 0;
  for (const c of candidates) {
    const l = link.get(c.externalId);
    const isTransfer = !!l || c.type === "transfer";

    const { data: txn, error: txnErr } = await supabase
      .from("transactions")
      .insert({
        user_id: userId,
        account_id: c.accountId,
        date: c.date,
        amount: c.amount,
        description: c.description,
        merchant: c.description,
        type: isTransfer ? "transfer" : c.type,
        transfer_account_id: l?.counterAccount ?? null,
        transfer_group_id: l?.group ?? null,
        source: c.interest && !isTransfer ? "interest" : "sync",
        external_id: c.externalId,
        reviewed: l ? true : c.autoReview,
      })
      .select("id")
      .single();
    if (txnErr || !txn) {
      errors.push(txnErr?.message ?? "Insert failed");
      continue;
    }
    inserted++;

    // Split only for non-transfer expenses (paired rows become transfers).
    if (!isTransfer && c.splitCategoryId && c.splitBucket) {
      await supabase.from("transaction_splits").insert({
        user_id: userId,
        transaction_id: txn.id,
        category_id: c.splitCategoryId,
        bucket: c.splitBucket,
        amount: c.amount,
      });
    }
  }

  return { inserted, balancesUpdated, errors };
}
