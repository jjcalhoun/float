"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import {
  useAccounts,
  useCategories,
  useTransactions,
  useUpdateTransaction,
  useDeleteTransaction,
  useResolveTransfer,
} from "@/hooks/useSupabaseData";
import { CategoryGrid } from "@/components/transactions/CategoryGrid";
import { CommitmentPicker } from "@/components/commitments/CommitmentPicker";
import { useUpsertSeries, useSeries } from "@/hooks/useSeries";
import { reviewKind, seriesInputFrom } from "@/lib/commitments/series";
import { useCommitmentWindow, useLinkCommitment } from "@/hooks/useCommitments";
import { rankCommitments, suggestCommitment, orderForDisplay } from "@/lib/commitments/match";
import { periodWindow } from "@/lib/commitments/period";
import { commitmentTransferTarget } from "@/lib/commitments/types";
import { selectionFor } from "@/lib/commitments/restore";
import { monthKey } from "@/lib/aggregations";
import { SeriesEditor } from "@/components/plan/SeriesEditor";
import { isInterestPaid } from "@/lib/interestPaid";
import { todayISO } from "@/lib/dates";
import { BUCKETS } from "@/lib/buckets";
import type { Transaction, TransactionType, BucketType, RecurringFrequency } from "@/lib/types";
import type { Commitment } from "@/lib/commitments/types";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const FREQ_LABEL: Record<"monthly" | "biweekly" | "weekly", string> = {
  monthly: "Monthly",
  biweekly: "Every 2 weeks",
  weekly: "Weekly",
};

interface Props {
  txn: Transaction;
  onClose: () => void;
  inline?: boolean; // render the bare form (no Sheet) for the desktop side panel
}

const TYPE_LABEL: Record<TransactionType, string> = {
  expense: "Expense",
  income: "Income",
  transfer: "Transfer",
  refund: "Refund",
};

export function TransactionEditor({ txn, onClose, inline }: Props) {
  const { data: accounts = [] } = useAccounts();
  const { data: categories = [] } = useCategories();
  const { data: allTxns = [] } = useTransactions();
  const { data: series = [] } = useSeries();
  const update = useUpdateTransaction();
  const del = useDeleteTransaction();
  const resolveTransfer = useResolveTransfer();
  const upsertSeries = useUpsertSeries();
  const linkTxn = useLinkCommitment();

  const firstSplit = (txn.splits ?? [])[0];

  const [type, setType] = useState<TransactionType>(txn.type);
  const [amount, setAmount] = useState(String(Math.abs(txn.amount)));
  const [merchant, setMerchant] = useState(txn.merchant ?? "");
  const [date, setDate] = useState(txn.date);
  const [accountId, setAccountId] = useState(txn.account_id);
  const [categoryId, setCategoryId] = useState(firstSplit?.category_id ?? "");
  const [bucket, setBucket] = useState<BucketType>(firstSplit?.bucket ?? "needs");
  const [transferAccountId, setTransferAccountId] = useState(txn.transfer_account_id ?? "");
  const [notes, setNotes] = useState(txn.notes ?? "");
  const [makeRecurring, setMakeRecurring] = useState(false);
  const [recurFreq, setRecurFreq] = useState<RecurringFrequency>("monthly");
  // which series the editor is open on — the rule that GENERATED this row, or
  // the one that covers its merchant; they are not always the same.
  const [editingSeries, setEditingSeries] = useState<Commitment | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* ---- recurring status ---- */
  // Rows our old generator wrote still exist and still say `recurring`. Nothing
  // creates them any more, so this is a historical marker only.
  const genRuleId = /^recurring:([^:]+):/.exec(txn.external_id ?? "")?.[1] ?? null;
  const isGenerated = txn.source === "recurring" || !!genRuleId;
  const genSeries = genRuleId ? series.find((c) => c.series_id === genRuleId) : undefined;

  // A live series already covering this merchant on this account → the box
  // shows CHECKED; unchecking ends the series (keeps history, stops the future).
  const matchedSeries = useMemo(() => {
    if (isGenerated) return undefined;
    const m = norm(txn.merchant || txn.description || "");
    if (!m) return undefined;
    return series.find((c) => {
      if (c.series_ended || c.account_id !== txn.account_id) return false;
      const n = norm(c.name);
      return !!n && (n === m || n.includes(m) || m.includes(n));
    });
  }, [series, txn, isGenerated]);

  const touchedRecur = useRef(false);
  useEffect(() => {
    if (!touchedRecur.current) setMakeRecurring(!!matchedSeries);
  }, [matchedSeries]);

  /* ---- planned-payment link ---- */
  const txnMonth = monthKey(txn.date);
  // A window of periods, not just this transaction's month — the due date is a
  // hint, so a payment may fulfill a neighbouring month's commitment.
  const { data: windowItems = [] } = useCommitmentWindow(periodWindow(txnMonth));
  // Scored for pre-selection, shown in date order (see orderForDisplay).
  const candidates = useMemo(
    () => orderForDisplay(rankCommitments(txn, windowItems, { linked: allTxns })),
    [txn, windowItems, allTxns],
  );
  const suggested = useMemo(
    () => (txn.commitment_id ? null : suggestCommitment(txn, windowItems, { linked: allTxns })),
    [txn, windowItems, allTxns],
  );
  // Ordered: first is the primary; the rest are covered by this same payment.
  const [commitmentIds, setCommitmentIds] = useState<string[]>(
    txn.commitment_id ? [txn.commitment_id] : [],
  );
  const touchedPlan = useRef(false);
  useEffect(() => {
    if (!touchedPlan.current && !txn.commitment_id && suggested) setCommitmentIds([suggested.id]);
  }, [suggested, txn.commitment_id]);

  // Restore the WHOLE selection when reopening, not just the primary. The
  // extra occurrences live as covered_by on the commitment rows, so they only
  // become known once the window loads — without this they read as unselected
  // even though they are settled.
  useEffect(() => {
    if (touchedPlan.current || !txn.commitment_id) return;
    const full = selectionFor(txn, windowItems);
    if (full.length > 1) setCommitmentIds(full);
  }, [windowItems, txn.commitment_id, txn.id]);
  const pickCommitment = (id: string) => {
    touchedPlan.current = true;
    setCommitmentIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
    // A debt / card / savings commitment already knows its destination, so
    // choosing one is enough to say this payment is a transfer.
    const dest = commitmentTransferTarget(windowItems.find((i) => i.id === id));
    if (dest && !commitmentIds.includes(id)) {
      setType("transfer");
      setTransferAccountId(dest);
    }
  };

  const canRecur = type !== "refund" && !isGenerated; // a plan line covers expense / income / transfer

  // Interest charges affect the account balance only — they carry no category
  // split and are excluded from the budget, so we don't prompt for a category.
  const balanceOnly = isInterestPaid(txn);
  const needsCategory = (type === "expense" || type === "refund") && !balanceOnly;
  const inflow = txn.amount > 0;
  const otherAccounts = accounts.filter((a) => a.id !== accountId);

  function pickCategory(id: string, defaultBucket: BucketType) {
    setCategoryId(id);
    setBucket(defaultBucket);
  }

  function signedAmount(num: number): number {
    if (type === "expense") return -Math.abs(num);
    if (type === "transfer") return txn.amount < 0 ? -Math.abs(num) : Math.abs(num);
    return Math.abs(num); // income / refund
  }

  async function save() {
    setError(null);
    const num = parseFloat(amount);
    if (isNaN(num) || num <= 0) return setError("Enter an amount greater than 0.");
    if (!accountId) return setError("Choose an account.");
    if (needsCategory && !categoryId) return setError("Choose a category.");

    if (type === "transfer" && !transferAccountId) return setError("Choose the transfer account.");

    const signed = signedAmount(num);
    try {
      await update.mutateAsync({
        id: txn.id,
        account_id: accountId,
        date,
        amount: signed,
        merchant: merchant.trim() || null,
        type,
        transfer_account_id: type === "transfer" ? transferAccountId || null : null,
        notes: notes.trim() || null,
        splits: needsCategory && categoryId
          ? [{ category_id: categoryId, bucket, amount: signed }]
          : undefined,
      });
      // For transfers, link the counterpart. Savings-bucket impact is derived
      // from account types at read time, so there's nothing to designate here.
      if (type === "transfer" && transferAccountId) {
        await resolveTransfer.mutateAsync({ id: txn.id, transfer_account_id: transferAccountId });
      }
      if (canRecur) {
        if (matchedSeries && !makeRecurring) {
          // Unchecked an already-covered merchant → end the series. Its history
          // stays; only the future stops.
          await upsertSeries.mutateAsync({
            seriesId: matchedSeries.series_id,
            period: date.slice(0, 7),
            input: seriesInputFrom(matchedSeries, true),
          });
        } else if (!matchedSeries && makeRecurring) {
          // Turn this transaction into a plan line. It expects FUTURE
          // occurrences; this row links to the one it already represents rather
          // than being posted a second time.
          const d = new Date(`${date}T00:00:00Z`);
          await upsertSeries.mutateAsync({
            period: date.slice(0, 7),
            input: {
              name: merchant.trim() || "Recurring",
              kind: reviewKind(type, transferAccountId, accounts),
              amount: Math.abs(signed),
              account_id: accountId,
              transfer_account_id: type === "transfer" ? transferAccountId || null : null,
              category_id: type === "expense" ? categoryId || null : null,
              bucket: type === "expense" ? bucket : null,
              frequency: recurFreq,
              day_of_month: recurFreq === "monthly" ? d.getUTCDate() : null,
              weekday: recurFreq === "weekly" || recurFreq === "biweekly" ? d.getUTCDay() : null,
              interval: 1,
            },
            // Link this transaction to the occurrence it represents (unless a
            // planned payment was picked explicitly below).
            ...(commitmentIds.length === 0 ? { sourceTxn: { id: txn.id, date } } : {}),
          });
        }
        // matched + still checked → already covered, nothing to create.
      }
      // Planned-payment link changed → write it (None unlinks).
      if (commitmentIds[0] !== (txn.commitment_id ?? null) || commitmentIds.length > 1) {
        await linkTxn.mutateAsync({ txnId: txn.id, commitmentId: commitmentIds });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save transaction.");
    }
  }

  async function remove() {
    if (!confirm("Delete this transaction?")) return;
    try {
      await del.mutateAsync(txn.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete transaction.");
    }
  }

  const body = (
      <div className="px-5 py-4 space-y-4">
        {balanceOnly && (
          <div
            className="rounded-[10px] px-3 py-2.5 text-xs"
            style={{ background: "var(--color-chip-bg)", color: "var(--color-muted)" }}
          >
            Interest charge — this affects the account balance only. It’s excluded
            from your spending and Net available, so there’s no category to set.
          </div>
        )}
        {/* type — fully editable across all four types */}
        <div>
          <p className="text-xs font-medium mb-2" style={{ color: "var(--color-muted)" }}>
            Type
          </p>
          <div className="flex flex-wrap gap-2">
            {(["expense", "income", "transfer", "refund"] as TransactionType[]).map((t) => (
              <Chip
                key={t}
                active={type === t}
                color={
                  t === "transfer"
                    ? "var(--color-transfer)"
                    : t === "income" || t === "refund"
                      ? "var(--color-positive)"
                      : "var(--color-primary)"
                }
                onClick={() => setType(t)}
              >
                {TYPE_LABEL[t]}
              </Chip>
            ))}
          </div>
        </div>

        <Input
          label="Amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />

        <Input
          label={type === "income" ? "Source" : "Merchant"}
          value={merchant}
          onChange={(e) => setMerchant(e.target.value)}
        />

        <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />

        {/* account */}
        <div>
          <p className="text-xs font-medium mb-2" style={{ color: "var(--color-muted)" }}>
            Account
          </p>
          <div className="flex flex-wrap gap-2">
            {accounts.map((a) => (
              <Chip key={a.id} active={accountId === a.id} onClick={() => setAccountId(a.id)}>
                {a.name}
              </Chip>
            ))}
          </div>
        </div>

        {/* bucket (above) + category grid — expense/refund */}
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
              <CategoryGrid categories={categories} selectedId={categoryId} onPick={(c) => pickCategory(c.id, c.bucket)} />
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
                  <Chip
                    key={a.id}
                    active={transferAccountId === a.id}
                    color="var(--color-transfer)"
                    onClick={() => setTransferAccountId(a.id)}
                  >
                    {a.name}
                  </Chip>
                ))}
              </div>
            )}
            <p className="text-xs mt-2" style={{ color: "var(--color-faint)" }}>
              Transfers into a savings account automatically count toward your
              Savings bucket; transfers out subtract from it.
            </p>
          </div>
        )}

        <Input
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional"
        />

        {/* Recurring status — generated rows show where they came from */}
        {isGenerated && (
          <div
            className="rounded-[10px] p-3 flex items-center justify-between gap-3"
            style={{ background: "var(--color-elevated)" }}
          >
            <div className="min-w-0">
              <p className="text-sm flex items-center gap-1.5" style={{ color: "var(--color-text)" }}>
                <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-primary)" }}>repeat</span>
                Recurring
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--color-faint)" }}>
                Generated by {genSeries ? `“${genSeries.name}”` : "a recurring rule"}
              </p>
            </div>
            <Button size="sm" variant="secondary" onClick={() => genSeries && setEditingSeries(genSeries)}>
              Manage
            </Button>
          </div>
        )}

        {/* Make recurring — reflects rule state; unchecking pauses the rule */}
        {canRecur && (
          <div className="rounded-[10px] p-3 space-y-2.5" style={{ background: "var(--color-elevated)" }}>
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-sm" style={{ color: "var(--color-text)" }}>
                Repeat this transaction
              </span>
              <input
                type="checkbox"
                checked={makeRecurring}
                onChange={(e) => {
                  touchedRecur.current = true;
                  setMakeRecurring(e.target.checked);
                }}
                style={{ accentColor: "var(--color-primary)" }}
              />
            </label>
            {matchedSeries ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs" style={{ color: "var(--color-faint)" }}>
                  {makeRecurring
                    ? `Covered by “${matchedSeries.name}” — uncheck to end it.`
                    : `Saving will end “${matchedSeries.name}” (no future occurrences).`}
                </p>
                <Button size="sm" variant="secondary" onClick={() => matchedSeries && setEditingSeries(matchedSeries)}>
                  Manage
                </Button>
              </div>
            ) : makeRecurring ? (
              <>
                <div className="flex flex-wrap gap-2">
                  {(["monthly", "biweekly", "weekly"] as const).map((fr) => (
                    <Chip key={fr} active={recurFreq === fr} onClick={() => setRecurFreq(fr)}>
                      {FREQ_LABEL[fr]}
                    </Chip>
                  ))}
                </div>
                <p className="text-xs" style={{ color: "var(--color-faint)" }}>
                  Creates a recurring rule from this transaction. Future occurrences
                  post automatically — this one stays as it is.
                </p>
              </>
            ) : null}
          </div>
        )}

        {/* Planned payment link — shared with the review flow */}
        {(candidates.length > 0 || txn.commitment_id) && (
          <CommitmentPicker
            candidates={candidates}
            selected={commitmentIds}
            onToggle={pickCommitment}
            onClear={() => {
              touchedPlan.current = true;
              setCommitmentIds([]);
            }}
            suggested={suggested}
            date={date}
            background="var(--color-elevated)"
          />
        )}

        {error && (
          <p className="text-sm" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}

        <div className="flex gap-3 pt-1">
          <Button variant="ghost" onClick={remove} disabled={del.isPending}>
            Delete
          </Button>
          <Button fullWidth onClick={save} disabled={update.isPending}>
            {update.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
  );

  if (inline)
    return (
      <>
        {body}
        {editingSeries && <SeriesEditor series={editingSeries} period={date.slice(0, 7)} onClose={() => setEditingSeries(null)} />}
      </>
    );
  return (
    <Sheet title="Edit transaction" onClose={onClose}>
      {body}
      {editingSeries && <SeriesEditor series={editingSeries} period={date.slice(0, 7)} onClose={() => setEditingSeries(null)} />}
    </Sheet>
  );
}

