"use client";

import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { Commitment } from "@/lib/commitments/types";
import { cloneForward, latestPerSeries } from "@/lib/commitments/clone";
import { linkTransactionToCommitment } from "@/lib/commitments/link";
import { confirmCommitment, unconfirmCommitment } from "@/lib/commitments/confirm";

const supabase = createClient();

async function currentUserId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");
  return user.id;
}

/** Commitments for one period. */
export function useCommitments(period: string) {
  return useQuery({
    queryKey: ["commitments", period],
    queryFn: async (): Promise<Commitment[]> => {
      const { data, error } = await supabase
        .from("commitments")
        .select("*")
        .eq("period", period)
        .order("due_hint", { nullsFirst: false })
        .order("seq");
      if (error) throw error;
      return (data ?? []) as Commitment[];
    },
    enabled: !!period,
  });
}

/** Every commitment in a window of periods — what the matcher draws from, so a
 *  payment can fill a neighbouring month's commitment. */
export function useCommitmentWindow(periods: string[]) {
  const key = [...periods].sort().join(",");
  return useQuery({
    queryKey: ["commitments_window", key],
    queryFn: async (): Promise<Commitment[]> => {
      if (periods.length === 0) return [];
      const { data, error } = await supabase
        .from("commitments")
        .select("*")
        .in("period", periods);
      if (error) throw error;
      return (data ?? []) as Commitment[];
    },
    enabled: periods.length > 0,
  });
}

/** Materialize a period from the live series, once. Safe to call repeatedly:
 *  series already present in the period are skipped, and the unique constraint
 *  on (series, period, seq) is the backstop if two callers race. */
export function useEnsurePeriod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (period: string) => {
      const user_id = await currentUserId();

      // Everything up to and including the target period: the newest row per
      // series carries the schedule forward.
      const { data: rows, error } = await supabase
        .from("commitments")
        .select("*")
        .lte("period", period);
      if (error) throw error;
      const all = (rows ?? []) as Commitment[];

      const already = new Set(all.filter((c) => c.period === period).map((c) => c.series_id));
      const live = latestPerSeries(all).filter(
        (c) => !c.series_ended && !already.has(c.series_id),
      );
      if (live.length === 0) return 0;

      const drafts = cloneForward(live, period).map((d) => ({ ...d, user_id }));
      const { error: insErr } = await supabase.from("commitments").insert(drafts);
      if (insErr) throw insErr;
      return drafts.length;
    },
    onSuccess: (_n, period) => {
      qc.invalidateQueries({ queryKey: ["commitments", period] });
      qc.invalidateQueries({ queryKey: ["commitments_window"] });
    },
  });
}

/** Draft any period in the window that has no lines yet, so the picker can
 *  offer them.
 *
 *  A month's lines were only ever created by opening the Month plan sheet for
 *  that month (MonthPlanSheet calls useEnsurePeriod on mount). The picker asks
 *  for a three-month window, so the month either side was routinely empty —
 *  and a fortnightly payment that lands on the 1st, settling a week that falls
 *  in the next month, had nothing to select. There was no error; the chip
 *  simply wasn't there.
 *
 *  Only the current period and later are drafted. Cloning a series into a PAST
 *  month would invent history that never happened. */
export function useEnsureWindow(periods: string[], currentPeriod: string) {
  const ensure = useEnsurePeriod();
  const { data: existing } = useCommitmentWindow(periods);
  // One attempt per period per mount: the mutation is idempotent, but a retry
  // loop on a period whose series are all ended would be pointless traffic.
  const tried = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!existing) return;
    const has = new Set(existing.map((c) => c.period));
    for (const p of periods) {
      if (p < currentPeriod || has.has(p) || tried.current.has(p)) continue;
      tried.current.add(p);
      ensure.mutate(p);
    }
  }, [existing, periods, currentPeriod, ensure]);
}

/** Link (or unlink) a transaction to the commitment it fulfills. */
export function useLinkCommitment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      txnId,
      commitmentId,
    }: {
      txnId: string;
      /** first id is the primary; the rest are covered by the same payment */
      commitmentId: string | string[] | null;
    }) => {
      await linkTransactionToCommitment(supabase, txnId, commitmentId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["commitments"] });
      qc.invalidateQueries({ queryKey: ["commitments_window"] });
    },
  });
}

export function useUpdateCommitment(period: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...patch
    }: { id: string } & Partial<
      Pick<Commitment, "amount" | "name" | "skipped" | "variable" | "due_hint" | "series_ended">
    >) => {
      const { error } = await supabase
        .from("commitments")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commitments", period] });
      qc.invalidateQueries({ queryKey: ["commitments_window"] });
    },
  });
}

/** A one-off line for this period only — its own series, ended on arrival so
 *  it never clones forward. */
export function useAddOneOffCommitment(period: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      name,
      kind,
      amount,
    }: {
      name: string;
      kind: Commitment["kind"];
      amount: number;
    }) => {
      const user_id = await currentUserId();
      const { error } = await supabase.from("commitments").insert({
        user_id,
        series_id: crypto.randomUUID(),
        period,
        seq: 0,
        name,
        kind,
        amount,
        frequency: "monthly",
        series_ended: true,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commitments", period] });
      qc.invalidateQueries({ queryKey: ["commitments_window"] });
    },
  });
}

export function useDeleteCommitment(period: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("commitments").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commitments", period] });
      qc.invalidateQueries({ queryKey: ["commitments_window"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
    },
  });
}

/** End a whole series — no future occurrences. Distinct from skipping one
 *  period, which is a `skipped` flag on the single row. */
export function useEndSeries(period: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (seriesId: string) => {
      const { error } = await supabase
        .from("commitments")
        .update({ series_ended: true, updated_at: new Date().toISOString() })
        .eq("series_id", seriesId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commitments", period] });
      qc.invalidateQueries({ queryKey: ["commitments_window"] });
    },
  });
}

/** Say a manual-account commitment actually happened, which is what creates
 *  the transaction. The amount is passed in rather than assumed: the reason to
 *  ask at all is that the app can't know what landed. */
export function useConfirmCommitment(period: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      commitment,
      amount,
      date,
    }: {
      commitment: Commitment;
      amount: number;
      date: string;
    }) => confirmCommitment(supabase, commitment, amount, date),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commitments", period] });
      qc.invalidateQueries({ queryKey: ["commitments_window"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}

/** Undo a confirmation — removes only what this app posted. */
export function useUnconfirmCommitment(period: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (commitmentId: string) => unconfirmCommitment(supabase, commitmentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commitments", period] });
      qc.invalidateQueries({ queryKey: ["commitments_window"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["account_balances"] });
    },
  });
}
