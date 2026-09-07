"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { resolveTransfer } from "@/lib/transfers";
import { useTxnWindow } from "@/components/providers";
import type {
  Account,
  Category,
  Transaction,
  BudgetPlan,
  Settings,
  BucketType,
  TransactionType,
} from "@/lib/types";

/**
 * All read/write data hooks for the app, backed by Supabase + TanStack Query.
 * Row Level Security scopes every query to the signed-in user automatically,
 * but inserts still need an explicit user_id (the RLS WITH CHECK requires it).
 */

const supabase = createClient();

async function currentUserId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  return user.id;
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */
export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: async (): Promise<Category[]> => {
      const { data, error } = await supabase
        .from("categories")
        .select("*")
        .eq("is_archived", false)
        .order("sort_order");
      if (error) throw error;
      return data as Category[];
    },
  });
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */
export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: async (): Promise<Account[]> => {
      const { data, error } = await supabase
        .from("accounts")
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return data as Account[];
    },
  });
}

/** Account balances computed server-side by the account_balances view
 *  (starting balance + everything after the as-of date). Independent of the
 *  transaction window, so it stays correct no matter how far back we load. */
export function useAccountBalances() {
  return useQuery({
    queryKey: ["account_balances"],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .from("account_balances")
        .select("account_id, balance");
      if (error) throw error;
      const out: Record<string, number> = {};
      for (const r of data ?? []) out[r.account_id as string] = Number(r.balance);
      return out;
    },
  });
}

export interface AccountInput {
  name: string;
  type: Account["type"];
  last4?: string | null;
  starting_balance: number;
  as_of_date: string;
  apr?: number;
  statement_day?: number | null;
  color?: string | null;
}

export function useUpsertAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AccountInput & { id?: string }) => {
      const user_id = await currentUserId();
      if (input.id) {
        const { id, ...rest } = input;
        const { error } = await supabase
          .from("accounts")
          .update(rest)
          .eq("id", id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("accounts")
          .insert({ ...input, user_id });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

export function useDeleteAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("accounts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Transactions (with splits embedded)                                 */
/* ------------------------------------------------------------------ */
/** Transactions within the current window (date >= since), splits embedded.
 *  The window expands backwards on demand via useTxnWindow().ensureSince(). */
export function useTransactions() {
  const { since } = useTxnWindow();
  return useQuery({
    queryKey: ["transactions", since],
    queryFn: async (): Promise<Transaction[]> => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*, splits:transaction_splits(*)")
        .gte("date", since)
        .order("date", { ascending: false });
      if (error) throw error;
      return data as Transaction[];
    },
  });
}

export interface SplitInput {
  category_id: string;
  bucket: BucketType;
  amount: number;
}

export interface TransactionInput {
  account_id: string;
  date: string;
  amount: number; // signed
  merchant?: string | null;
  type: TransactionType;
  notes?: string | null;
  reviewed?: boolean;
  splits?: SplitInput[]; // expense/refund only
}

export function useAddTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TransactionInput) => {
      const user_id = await currentUserId();
      const { splits, ...txn } = input;
      const { data: created, error } = await supabase
        .from("transactions")
        .insert({ ...txn, user_id, source: "manual" })
        .select()
        .single();
      if (error) throw error;

      if (splits && splits.length > 0) {
        const rows = splits.map((s) => ({
          ...s,
          transaction_id: created.id,
          user_id,
        }));
        const { error: splitErr } = await supabase
          .from("transaction_splits")
          .insert(rows);
        if (splitErr) throw splitErr;
      }
      return created as Transaction;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

export interface TransactionUpdate {
  id: string;
  account_id: string;
  date: string;
  amount: number; // signed
  merchant?: string | null;
  type: TransactionType;
  transfer_account_id?: string | null; // transfer only
  notes?: string | null;
  splits?: SplitInput[]; // replaces the existing splits
}

export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: TransactionUpdate) => {
      const user_id = await currentUserId();
      const { id, splits, ...fields } = input;

      const { error } = await supabase
        .from("transactions")
        .update(fields)
        .eq("id", id);
      if (error) throw error;

      // Replace splits wholesale: delete the old, insert the new.
      const { error: delErr } = await supabase
        .from("transaction_splits")
        .delete()
        .eq("transaction_id", id);
      if (delErr) throw delErr;

      if (splits && splits.length > 0) {
        const rows = splits.map((s) => ({ ...s, transaction_id: id, user_id }));
        const { error: insErr } = await supabase
          .from("transaction_splits")
          .insert(rows);
        if (insErr) throw insErr;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

/** Expand a set of transaction ids to also include the other side of any
 *  transfer (rows sharing a transfer_group_id), so deleting a transfer removes
 *  both the debit and credit rows — done at the DB level so it holds even when
 *  the counterpart isn't loaded in the client. */
async function withTransferCounterparts(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return ids;
  const { data: rows } = await supabase
    .from("transactions")
    .select("transfer_group_id")
    .in("id", ids);
  const groups = [
    ...new Set(
      (rows ?? []).map((r) => r.transfer_group_id as string | null).filter((g): g is string => !!g),
    ),
  ];
  if (groups.length === 0) return ids;
  const { data: sides } = await supabase
    .from("transactions")
    .select("id")
    .in("transfer_group_id", groups);
  const all = new Set(ids);
  for (const r of sides ?? []) all.add(r.id as string);
  return [...all];
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const ids = await withTransferCounterparts([id]);
      const { error } = await supabase
        .from("transactions")
        .delete()
        .in("id", ids);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

/** Delete several transactions at once (splits cascade). */
export function useDeleteTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return;
      const all = await withTransferCounterparts(ids);
      const { error } = await supabase.from("transactions").delete().in("id", all);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

/** Delete every transaction for the signed-in user (splits cascade). */
export function useDeleteAllTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const user_id = await currentUserId();
      const { error } = await supabase
        .from("transactions")
        .delete()
        .eq("user_id", user_id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

export interface ReviewInput {
  id: string;
  type: TransactionType;
  transfer_account_id?: string | null;
  splits?: SplitInput[]; // expense/refund only
}

/** Mark a transaction reviewed with its chosen type, splits, transfer pairing. */
export function useReviewTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ReviewInput) => {
      const user_id = await currentUserId();
      const { error } = await supabase
        .from("transactions")
        .update({
          type: input.type,
          reviewed: true,
          transfer_account_id:
            input.type === "transfer" ? input.transfer_account_id ?? null : null,
        })
        .eq("id", input.id);
      if (error) throw error;

      const { error: delErr } = await supabase
        .from("transaction_splits")
        .delete()
        .eq("transaction_id", input.id);
      if (delErr) throw delErr;

      if (input.splits && input.splits.length > 0) {
        const rows = input.splits.map((s) => ({ ...s, transaction_id: input.id, user_id }));
        const { error: insErr } = await supabase.from("transaction_splits").insert(rows);
        if (insErr) throw insErr;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

/** Patch a liability account's payment terms (Debt planner). */
export function useSetAccountMinPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...terms
    }: {
      id: string;
      min_payment?: number | null;
      monthly_payment?: number | null;
      escrow_amount?: number | null;
      escrow_category_id?: string | null;
    }) => {
      const { error } = await supabase.from("accounts").update(terms).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["accounts"] }),
  });
}

export interface ResolveTransferInput {
  id: string;
  transfer_account_id: string;
}

const addDays = (iso: string, n: number) =>
  new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

/** Resolve a transfer in one action: mark it reviewed, find the matching
 *  opposite-amount transaction on the counterpart account (within 5 days) and
 *  link both via transfer_group_id. Savings-bucket impact is derived from the
 *  account types at read time (see rollup), so no per-row tagging is needed. */
export function useResolveTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, transfer_account_id }: ResolveTransferInput) =>
      resolveTransfer(supabase, id, transfer_account_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

export interface ImportInput {
  account_id: string;
  rows: { date: string; amount: number; description: string; external_id: string }[];
}

/** Bulk-import CSV rows as unreviewed transactions, deduped on external_id. */
export function useImportTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ account_id, rows }: ImportInput) => {
      const user_id = await currentUserId();
      const import_batch_id =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `${Date.now()}`;
      // Dedupe in the app: the DB's unique index on external_id is partial
      // (WHERE external_id IS NOT NULL), which Postgres can't use as an
      // ON CONFLICT target. So we fetch existing ids and filter, then insert.
      const { data: existing, error: exErr } = await supabase
        .from("transactions")
        .select("external_id")
        .eq("account_id", account_id)
        .not("external_id", "is", null);
      if (exErr) throw exErr;

      const seen = new Set((existing ?? []).map((r) => r.external_id as string));
      const insertRows = [];
      for (const r of rows) {
        if (seen.has(r.external_id)) continue; // skip existing + within-batch dupes
        seen.add(r.external_id);
        insertRows.push({
          user_id,
          account_id,
          date: r.date,
          amount: r.amount,
          description: r.description,
          merchant: r.description,
          type: "expense" as const, // placeholder; the Review flow sets the real type
          source: "csv" as const,
          external_id: r.external_id,
          import_batch_id,
          reviewed: false,
        });
      }

      if (insertRows.length > 0) {
        const { error } = await supabase.from("transactions").insert(insertRows);
        if (error) throw error;
      }
      return { inserted: insertRows.length, total: rows.length };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

/* ------------------------------------------------------------------ */
/* Budget plan                                                         */
/* ------------------------------------------------------------------ */
export function useBudget() {
  return useQuery({
    queryKey: ["budget"],
    queryFn: async (): Promise<BudgetPlan | null> => {
      const { data, error } = await supabase
        .from("budget_plan")
        .select("*")
        .maybeSingle();
      if (error) throw error;
      return data as BudgetPlan | null;
    },
  });
}

export function useUpdateBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<BudgetPlan>) => {
      const user_id = await currentUserId();
      const { error } = await supabase
        .from("budget_plan")
        .update(input)
        .eq("user_id", user_id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["budget"] });
    },
  });
}

export interface CategoryInput {
  id?: string;
  name: string;
  icon: string;
  color: string;
  bucket: BucketType;
  sort_order?: number;
}

export function useUpsertCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CategoryInput) => {
      const user_id = await currentUserId();
      if (input.id) {
        const { id, ...rest } = input;
        const { error } = await supabase
          .from("categories")
          .update(rest)
          .eq("id", id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("categories")
          .insert({ ...input, user_id });
        if (error) throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });
}

/** Archive instead of delete — splits reference categories, so we keep history. */
export function useArchiveCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("categories")
        .update({ is_archived: true })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["categories"] }),
  });
}

/* ------------------------------------------------------------------ */
/* Category budgets (per-category monthly targets)                     */
/* ------------------------------------------------------------------ */
export function useCategoryBudgets() {
  return useQuery({
    queryKey: ["category_budgets"],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase
        .from("category_budgets")
        .select("category_id, monthly_target");
      if (error) throw error;
      const out: Record<string, number> = {};
      for (const row of data ?? []) {
        out[row.category_id as string] = Number(row.monthly_target);
      }
      return out;
    },
  });
}

export function useSetCategoryBudget() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { category_id: string; monthly_target: number }) => {
      const user_id = await currentUserId();
      const { error } = await supabase
        .from("category_budgets")
        .upsert(
          { user_id, category_id: input.category_id, monthly_target: input.monthly_target },
          { onConflict: "user_id,category_id" },
        );
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["category_budgets"] }),
  });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */
export function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async (): Promise<Settings | null> => {
      const { data, error } = await supabase
        .from("settings")
        .select("*")
        .maybeSingle();
      if (error) throw error;
      return data as Settings | null;
    },
  });
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Partial<Settings>) => {
      const user_id = await currentUserId();
      const { error } = await supabase
        .from("settings")
        .update(input)
        .eq("user_id", user_id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}
