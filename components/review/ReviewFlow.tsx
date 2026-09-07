"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useTransactions,
  useCategories,
  useAccounts,
  useReviewTransaction,
  useResolveTransfer,
} from "@/hooks/useSupabaseData";
import { useUpsertSeries, useSeries } from "@/hooks/useSeries";
import { useCommitmentWindow, useLinkCommitment } from "@/hooks/useCommitments";
import { rankCommitments, suggestCommitment, orderForDisplay } from "@/lib/commitments/match";
import { periodWindow } from "@/lib/commitments/period";
import { selectionFor } from "@/lib/commitments/restore";
import { commitmentTransferTarget } from "@/lib/commitments/types";
import { reviewKind } from "@/lib/commitments/series";
import { monthKey } from "@/lib/aggregations";
import { mergeQueue, nextIndex } from "@/lib/reviewQueue";
import { CategoryGrid } from "@/components/transactions/CategoryGrid";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { BUCKETS } from "@/lib/buckets";
import { todayISO } from "@/lib/dates";
import { fmt, shortDate } from "@/lib/format";
import type { Transaction, TransactionType, BucketType, RecurringFrequency } from "@/lib/types";

const REVIEW_FREQ: Record<"monthly" | "biweekly" | "weekly", string> = {
  monthly: "Monthly",
  biweekly: "Every 2 weeks",
  weekly: "Weekly",
};

export function ReviewFlow({ onClose }: { onClose: () => void }) {
  const { data: transactions = [] } = useTransactions();
  const { data: categories = [] } = useCategories();
  const { data: accounts = [] } = useAccounts();
  const review = useReviewTransaction();
  const resolveTransfer = useResolveTransfer();
  const upsertSeries = useUpsertSeries();
  const { data: series = [] } = useSeries();
  const linkTxn = useLinkCommitment();

  // The queue is a snapshot so the order stays put as you review through it —
  // a live filter would delete the row under your finger. But it GROWS: rows
  // arrive in stages (a cached page, then the fetch; a widening date window; a
  // sync finishing mid-review), and a queue frozen at the first render hid
  // everything that came later until the screen was closed and reopened.
  const [queue, setQueue] = useState<Transaction[]>([]);
  const unreviewed = useMemo(() => transactions.filter((t) => !t.reviewed), [transactions]);
  useEffect(() => {
    setQueue((cur) => mergeQueue(cur, unreviewed));
  }, [unreviewed]);

  const [index, setIndex] = useState(0);

  // The queue is a snapshot; entries can become reviewed behind our back —
  // e.g. resolving one leg of a transfer auto-reviews the counterpart. Skip
  // those instead of asking the user to review them again.
  const liveById = useMemo(
    () => Object.fromEntries(transactions.map((t) => [t.id, t])),
    [transactions],
  );
  useEffect(() => {
    const i = nextIndex(index, queue, (id) => liveById[id]?.reviewed ?? false);
    if (i !== index) setIndex(i);
  }, [index, queue, liveById]);

  const txn = queue[index];
  const inflow = txn ? txn.amount > 0 : false;

  // per-transaction selections
  const [type, setType] = useState<TransactionType>("expense");
  const [categoryId, setCategoryId] = useState("");
  const [bucket, setBucket] = useState<BucketType>("needs");
  const [transferAccountId, setTransferAccountId] = useState("");
  const [makeRecurring, setMakeRecurring] = useState(false);
  const [recurFreq, setRecurFreq] = useState<RecurringFrequency>("monthly");
  // Ordered: the first is the primary that carries the amount; the rest are
  // covered by the same payment (one cheque, several weeks).
  const [commitmentIds, setCommitmentIds] = useState<string[]>([]);

  // Candidates come from a WINDOW of periods, not the transaction's calendar
  // month — a bill due the 31st that clears on the 1st must still find the
  // month that expected it.
  const txnMonth = txn ? monthKey(txn.date) : "";
  const { data: windowItems = [] } = useCommitmentWindow(txnMonth ? periodWindow(txnMonth) : []);
  // Scored for pre-selection, but shown in DATE order — the list doubles as a
  // run-down of what's still coming, and repeats tick off in sequence.
  const candidates = useMemo(
    () => (txn ? orderForDisplay(rankCommitments(txn, windowItems, { linked: transactions })) : []),
    [txn, windowItems, transactions],
  );
  const suggested = useMemo(
    () => (txn ? suggestCommitment(txn, windowItems, { linked: transactions }) : null),
    [txn, windowItems, transactions],
  );

  // Payee memory: if we've previously assigned this merchant as a transfer,
  // pre-suggest the same destination (extra debt payments, checks, etc.).
  const rememberedTransfer = useMemo(() => {
    if (!txn || txn.amount > 0) return null;
    const m = (txn.merchant || txn.description || "").toLowerCase().trim();
    if (!m) return null;
    const prior = transactions.find(
      (t) =>
        t.id !== txn.id &&
        t.reviewed &&
        t.type === "transfer" &&
        t.transfer_account_id &&
        t.account_id === txn.account_id &&
        (t.merchant || t.description || "").toLowerCase().trim() === m,
    );
    return prior?.transfer_account_id ?? null;
  }, [txn, transactions]);

  // reset selections whenever the current transaction changes
  useEffect(() => {
    if (!txn) return;
    if (rememberedTransfer) {
      setType("transfer");
      setTransferAccountId(rememberedTransfer);
    } else {
      setType(txn.amount > 0 ? "income" : "expense");
      setTransferAccountId("");
    }
    setCategoryId("");
    setBucket("needs");
    setMakeRecurring(false);
    setRecurFreq("monthly");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txn]);

  // Picking a debt / card / savings commitment IS saying this is a transfer —
  // the commitment already knows where the money goes. Reflect that in the
  // form straight away, so the type shown is the type that will be saved.
  useEffect(() => {
    if (commitmentIds.length === 0) return;
    const picked = windowItems.find((i) => i.id === commitmentIds[0]);
    const dest = commitmentTransferTarget(picked);
    if (dest) {
      setType("transfer");
      setTransferAccountId(dest);
    }
  }, [commitmentIds, windowItems]);

  // Reopening a linked transaction restores every occurrence it settles — the
  // primary plus anything it covers.
  useEffect(() => {
    if (!txn?.commitment_id) return;
    setCommitmentIds(selectionFor(txn, windowItems));
  }, [windowItems, txn?.commitment_id, txn?.id]);

  // Tapping adds to the selection rather than replacing it: one payment can
  // settle several occurrences. The first tapped stays the primary.
  const toggle = (id: string) =>
    setCommitmentIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  // Pre-select the suggestion — but it is only ever a suggestion. Nothing
  // links itself; saving is what commits it.
  useEffect(() => {
    setCommitmentIds(suggested ? [suggested.id] : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txn, suggested?.id]);

  // A live series already covering this merchant — show that instead of the
  // "repeat" checkbox. This check is the whole reason the Ooma bill existed
  // twice: without it, ticking "repeat" on a charge you already had a line for
  // silently minted a second one, each taking its day from its own spawning
  // transaction.
  const coveredBy = useMemo(() => {
    if (!txn) return undefined;
    const normed = (txn.merchant || txn.description || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!normed) return undefined;
    return series.find((c) => {
      if (c.series_ended || c.account_id !== txn.account_id) return false;
      const n = c.name.toLowerCase().replace(/\s+/g, " ").trim();
      return !!n && (n === normed || n.includes(normed) || normed.includes(n));
    });
  }, [txn, series]);

  function pickTransferAccount(id: string) {
    setTransferAccountId(id);
  }

  const typeOptions: TransactionType[] = inflow
    ? ["income", "refund", "transfer"]
    : ["expense", "transfer"];
  const needsCategory = type === "expense" || type === "refund";
  const otherAccounts = accounts.filter((a) => a.id !== txn?.account_id);

  function pickCategory(id: string, defaultBucket: BucketType) {
    setCategoryId(id);
    setBucket(defaultBucket);
  }

  const canSave =
    type === "income" ||
    (needsCategory && !!categoryId) ||
    (type === "transfer" && !!transferAccountId);

  async function save() {
    if (!txn || !canSave) return;
    if (type === "transfer") {
      await resolveTransfer.mutateAsync({
        id: txn.id,
        transfer_account_id: transferAccountId,
      });
    } else {
      await review.mutateAsync({
        id: txn.id,
        type,
        transfer_account_id: null,
        splits: needsCategory && categoryId
          ? [{ category_id: categoryId, bucket, amount: txn.amount }]
          : undefined,
      });
    }
    // Link to the commitment it fulfills (the ledger marks it paid).
    if (commitmentIds[0] !== (txn.commitment_id ?? null) || commitmentIds.length > 1) {
      await linkTxn.mutateAsync({ txnId: txn.id, commitmentId: commitmentIds });
    }
    // Optionally turn this into a recurring plan line.
    if (makeRecurring && type !== "refund" && !coveredBy) {
      const d = new Date(`${txn.date}T00:00:00Z`);
      await upsertSeries.mutateAsync({
        period: txn.date.slice(0, 7),
        input: {
          name: txn.merchant || txn.description || "Recurring",
          kind: reviewKind(type, transferAccountId, accounts),
          amount: Math.abs(txn.amount),
          account_id: txn.account_id,
          transfer_account_id: type === "transfer" ? transferAccountId || null : null,
          category_id: type === "expense" ? categoryId || null : null,
          bucket: type === "expense" ? bucket : null,
          frequency: recurFreq,
          day_of_month: recurFreq === "monthly" ? d.getUTCDate() : null,
          weekday: recurFreq === "weekly" || recurFreq === "biweekly" ? d.getUTCDay() : null,
          interval: 1,
        },
        // Link this transaction to the occurrence it represents (unless the
        // user already picked planned payments above).
        ...(commitmentIds.length === 0 ? { sourceTxn: { id: txn.id, date: txn.date } } : {}),
      });
    }
    setIndex((i) => i + 1);
  }

  const done = queue.length > 0 && index >= queue.length;
  const empty = queue.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-center scrim">
      <div
        className="w-full max-w-[430px] h-full flex flex-col"
        style={{ background: "var(--color-canvas)" }}
      >
      {/* header */}
      <div className="flex items-center justify-between px-4 py-4 border-b" style={{ borderColor: "var(--color-hairline)" }}>
        <button onClick={onClose} style={{ color: "var(--color-muted)" }}>
          <span className="material-symbols-outlined">close</span>
        </button>
        <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          Review
        </span>
        <span className="text-xs" style={{ color: "var(--color-faint)" }}>
          {!done && !empty ? `${index + 1} of ${queue.length}` : ""}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {empty || done ? (
          <div className="h-full flex flex-col items-center justify-center text-center px-6 gap-3">
            <span className="material-symbols-outlined" style={{ fontSize: 56, color: "var(--color-positive)" }}>
              task_alt
            </span>
            <p className="font-figure text-xl font-bold" style={{ color: "var(--color-text)" }}>
              All caught up
            </p>
            <p className="text-sm" style={{ color: "var(--color-muted)" }}>
              {empty ? "Nothing to review right now." : "You've reviewed every transaction."}
            </p>
            <Button onClick={onClose}>Done</Button>
          </div>
        ) : (
          <div className="p-5 space-y-5">
            {/* the transaction card */}
            <div
              className="rounded-[16px] border p-5"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-hairline)" }}
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-base font-semibold" style={{ color: "var(--color-text)" }}>
                    {txn.merchant || txn.description || "Transaction"}
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--color-faint)" }}>
                    {shortDate(txn.date)}
                  </p>
                </div>
                <p
                  className="font-figure text-2xl font-bold"
                  style={{ color: inflow ? "var(--color-positive)" : "var(--color-text)" }}
                >
                  {fmt(txn.amount)}
                </p>
              </div>
            </div>

            {/* type selector */}
            <div>
              <p className="text-xs font-medium mb-2" style={{ color: "var(--color-muted)" }}>
                Type
              </p>
              <div className="flex gap-2">
                {typeOptions.map((t) => (
                  <Chip
                    key={t}
                    active={type === t}
                    color={t === "transfer" ? "var(--color-transfer)" : t === "income" || t === "refund" ? "var(--color-positive)" : "var(--color-primary)"}
                    onClick={() => setType(t)}
                  >
                    {t[0].toUpperCase() + t.slice(1)}
                  </Chip>
                ))}
              </div>
            </div>

            {/* bucket (above) + category grid (inline) */}
            {needsCategory && (
              <>
                <div>
                  <p className="text-xs font-medium mb-2" style={{ color: "var(--color-muted)" }}>
                    Bucket
                  </p>
                  <div className="flex gap-2">
                    {(Object.keys(BUCKETS) as BucketType[]).map((b) => (
                      <Chip key={b} active={bucket === b} color={BUCKETS[b].color} onClick={() => setBucket(b)}>
                        {BUCKETS[b].label}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium mb-2" style={{ color: "var(--color-muted)" }}>
                    Category
                  </p>
                  <CategoryGrid
                    categories={categories}
                    selectedId={categoryId}
                    onPick={(c) => pickCategory(c.id, c.bucket)}
                  />
                </div>
              </>
            )}

            {/* transfer pairing */}
            {type === "transfer" && (
              <div>
                <p className="text-xs font-medium mb-2" style={{ color: "var(--color-muted)" }}>
                  {inflow ? "Transferred from" : "Transferred to"}
                </p>
                {otherAccounts.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--color-faint)" }}>
                    Add another account to pair transfers.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {otherAccounts.map((a) => (
                      <Chip key={a.id} active={transferAccountId === a.id} color="var(--color-transfer)" onClick={() => pickTransferAccount(a.id)}>
                        {a.name}
                      </Chip>
                    ))}
                  </div>
                )}
                <p className="text-xs mt-2" style={{ color: "var(--color-faint)" }}>
                  We'll link the matching transaction on the other account, so you
                  only review this once. Transfers into a savings account count
                  toward your Savings bucket automatically.
                </p>
              </div>
            )}

            {type === "income" && (
              <p className="text-sm" style={{ color: "var(--color-faint)" }}>
                Income needs no category — just save.
              </p>
            )}

            {/* Planned payment match. Plain chips: name, date, amount.
                Claimed lines drop to a "Claimed" group — dimmed, but still
                selectable, because the reason to tap one is that an earlier
                match was wrong. */}
            {candidates.length > 0 && (
              <div
                className="rounded-[10px] p-3 space-y-2.5"
                style={{
                  background: "var(--color-surface)",
                  border: commitmentIds.length > 0 ? "1px solid var(--color-primary)" : "1px solid transparent",
                }}
              >
                <p className="text-sm" style={{ color: "var(--color-text)" }}>
                  {suggested && commitmentIds.length === 1 && commitmentIds[0] === suggested.id ? (
                    <>Looks like: <span className="font-semibold">{suggested.name}</span></>
                  ) : (
                    "Fulfills a planned payment?"
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Chip active={commitmentIds.length === 0} onClick={() => setCommitmentIds([])}>
                    None
                  </Chip>
                  {candidates
                    .filter((x) => !x.claimedBy)
                    .map(({ commitment: i }) => (
                      <Chip
                        key={i.id}
                        active={commitmentIds.includes(i.id)}
                        onClick={() => toggle(i.id)}
                      >
                        {chipLabel(i)}
                      </Chip>
                    ))}
                </div>
                {commitmentIds.length > 1 && (
                  <p className="text-xs" style={{ color: "var(--color-faint)" }}>
                    Covers {commitmentIds.length} occurrences ·{" "}
                    {fmt(
                      windowItems
                        .filter((i) => commitmentIds.includes(i.id))
                        .reduce((s, i) => s + i.amount, 0),
                    )}{" "}
                    planned
                  </p>
                )}
                {candidates.some((x) => x.claimedBy) && (
                  <>
                    <p className="text-xs font-semibold" style={{ color: "var(--color-faint)" }}>
                      Claimed
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {candidates
                        .filter((x) => x.claimedBy)
                        .map(({ commitment: i }) => (
                          <Chip
                            key={i.id}
                            active={commitmentIds.includes(i.id)}
                            dim={!commitmentIds.includes(i.id)}
                            onClick={() => toggle(i.id)}
                          >
                            {chipLabel(i)}
                          </Chip>
                        ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Make recurring — hidden when a rule already covers this merchant */}
            {type !== "refund" && coveredBy && (
              <div
                className="rounded-[10px] p-3 flex items-center gap-2"
                style={{ background: "var(--color-surface)" }}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-primary)" }}>repeat</span>
                <p className="text-sm" style={{ color: "var(--color-text)" }}>
                  Recurring · covered by <span className="font-semibold">“{coveredBy.name}”</span>
                </p>
              </div>
            )}
            {type !== "refund" && !coveredBy && (
              <div className="rounded-[10px] p-3 space-y-2.5" style={{ background: "var(--color-surface)" }}>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-sm" style={{ color: "var(--color-text)" }}>Repeat this transaction</span>
                  <input
                    type="checkbox"
                    checked={makeRecurring}
                    onChange={(e) => setMakeRecurring(e.target.checked)}
                    style={{ accentColor: "var(--color-primary)" }}
                  />
                </label>
                {makeRecurring && (
                  <div className="flex flex-wrap gap-2">
                    {(["monthly", "biweekly", "weekly"] as const).map((fr) => (
                      <Chip key={fr} active={recurFreq === fr} onClick={() => setRecurFreq(fr)}>
                        {REVIEW_FREQ[fr]}
                      </Chip>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* controls */}
      {!done && !empty && (
        <div className="border-t px-4 py-3 flex items-center gap-3" style={{ borderColor: "var(--color-hairline)" }}>
          <button
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
            className="flex items-center gap-1 text-sm disabled:opacity-40"
            style={{ color: "var(--color-muted)" }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>undo</span>
            Undo
          </button>
          <button
            onClick={() => setIndex((i) => i + 1)}
            className="text-sm ml-2"
            style={{ color: "var(--color-muted)" }}
          >
            Skip
          </button>
          <div className="flex-1" />
          <Button onClick={save} disabled={!canSave || review.isPending || resolveTransfer.isPending}>
            {review.isPending || resolveTransfer.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
      </div>
    </div>
  );
}

/** Chip text: name, date, amount. Nothing about claim state — the dimming
 *  and the Claimed group already say that. */
function chipLabel(i: { name: string; due_hint?: string | null; amount: number }): string {
  const parts = [i.name];
  if (i.due_hint) parts.push(shortDate(i.due_hint));
  parts.push(fmt(i.amount));
  return parts.join(" \u00b7 ");
}
