"use client";

import { useMemo, useState, useEffect } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { rollup, monthKey } from "@/lib/aggregations";
import { fmt, fmt0, shortDate, monthLabel } from "@/lib/format";
import { useSetCategoryBudget } from "@/hooks/useSupabaseData";
import { TransactionEditor } from "@/components/transactions/TransactionEditor";
import type { Category, Transaction } from "@/lib/types";

interface Props {
  category: Category;
  transactions: Transaction[];
  month: string; // "YYYY-MM"
  monthlyTarget: number;
  /* The home screen can show a loan's whole payment under a category; the
     7-month history has to agree with the ring it was opened from. */
  paymentCategoryByAccount?: Record<string, string>;
  savingsAccountIds?: Set<string>;
  loanAccountIds?: Set<string>;
  onClose: () => void;
}

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function CategoryDetail({
  category,
  transactions,
  month,
  monthlyTarget,
  paymentCategoryByAccount,
  savingsAccountIds,
  loanAccountIds,
  onClose,
}: Props) {
  const setBudget = useSetCategoryBudget();
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  const [budget, setBudgetInput] = useState(monthlyTarget ? String(monthlyTarget) : "");
  useEffect(() => {
    setBudgetInput(monthlyTarget ? String(monthlyTarget) : "");
  }, [monthlyTarget]);

  // 7-month history ending at the selected month
  const history = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const out: { key: string; label: string; spend: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(y, m - 1 - i, 1);
      const mk = monthKey(d);
      const { byCat } = rollup(transactions, mk, undefined, savingsAccountIds, loanAccountIds, {
        paymentCategoryByAccount,
      });
      out.push({ key: mk, label: MONTH_ABBR[d.getMonth()], spend: byCat[category.id] ?? 0 });
    }
    return out;
  }, [transactions, month, category.id]);

  const maxSpend = Math.max(...history.map((h) => h.spend), 1);
  const averageMonthly =
    history.reduce((s, h) => s + h.spend, 0) / history.length;
  const spentThisMonth = history[history.length - 1]?.spend ?? 0;

  const budgetNum = parseFloat(budget) || 0;
  const left = budgetNum - spentThisMonth;
  const pct = budgetNum > 0 ? (spentThisMonth / budgetNum) * 100 : 100;
  const over = budgetNum > 0 && spentThisMonth > budgetNum;

  function saveBudget() {
    const num = parseFloat(budget);
    if (isNaN(num) || num === monthlyTarget) return;
    setBudget.mutate({ category_id: category.id, monthly_target: num });
  }

  const monthTxns = useMemo(
    () =>
      transactions.filter(
        (t) =>
          monthKey(t.date) === month &&
          (t.splits ?? []).some((s) => s.category_id === category.id),
      ),
    [transactions, month, category.id],
  );

  return (
    <Sheet onClose={onClose}>
      <div className="px-5 pb-4 space-y-5">
        {/* title */}
        <div className="flex items-center gap-3">
          <span
            className="inline-flex items-center justify-center w-9 h-9 rounded-xl"
            style={{ background: `${category.color}22` }}
          >
            <span className="material-symbols-outlined" style={{ color: category.color }}>
              {category.icon}
            </span>
          </span>
          <p className="font-figure text-2xl font-bold" style={{ color: "var(--color-text)" }}>
            {fmt(spentThisMonth)}
          </p>
          <span className="text-sm" style={{ color: "var(--color-muted)" }}>
            {monthLabel(month)}
          </span>
        </div>

        {/* history bars */}
        <div className="flex items-end justify-between gap-1.5 h-32">
          {history.map((h) => (
            <div key={h.key} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
              <span className="text-[9px]" style={{ color: "var(--color-faint)" }}>
                {fmt0(h.spend)}
              </span>
              <div
                className="w-full rounded-t"
                style={{
                  height: `${Math.max(2, (h.spend / maxSpend) * 100)}%`,
                  background: h.key === month ? category.color : "var(--color-hairline)",
                }}
              />
              <span className="text-[9px]" style={{ color: "var(--color-faint)" }}>
                {h.label}
              </span>
            </div>
          ))}
        </div>

        {/* average / budget / left */}
        <div
          className="rounded-[16px] border p-4 space-y-3"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-hairline)" }}
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-faint)" }}>
                Average monthly
              </p>
              <p className="font-figure text-lg font-bold" style={{ color: "var(--color-text)" }}>
                {fmt(averageMonthly)}
              </p>
            </div>
            <div className="text-center">
              <p className="text-[10px] uppercase tracking-wide mb-1" style={{ color: "var(--color-faint)" }}>
                Monthly budget
              </p>
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={budget}
                onChange={(e) => setBudgetInput(e.target.value)}
                onBlur={saveBudget}
                className="w-24 text-center px-2 py-1.5 rounded-lg text-sm font-figure outline-none border"
                style={{
                  background: "var(--color-elevated)",
                  color: "var(--color-text)",
                  borderColor: "var(--color-hairline)",
                }}
              />
            </div>
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-faint)" }}>
                Left this month
              </p>
              <p
                className="font-figure text-lg font-bold"
                style={{ color: left < 0 ? "var(--color-danger)" : "var(--color-positive)" }}
              >
                {fmt(left)}
              </p>
            </div>
          </div>

          <p className="text-xs" style={{ color: "var(--color-muted)" }}>
            <span style={{ color: category.color }}>●</span> {fmt(spentThisMonth)} spent of{" "}
            {fmt(budgetNum)} budget · {Math.round(pct)}% of budget
          </p>
          <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "var(--color-hairline)" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, pct)}%`,
                background: over ? "var(--color-danger)" : category.color,
              }}
            />
          </div>
        </div>

        {/* this month's transactions */}
        <div>
          <p className="text-sm font-semibold mb-2" style={{ color: "var(--color-text)" }}>
            {monthLabel(month)}
          </p>
          {monthTxns.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--color-faint)" }}>
              None this month.
            </p>
          ) : (
            <div className="space-y-1">
              {monthTxns.map((t) => {
                const split = (t.splits ?? []).find((s) => s.category_id === category.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => setEditTxn(t)}
                    className="w-full flex items-center justify-between py-1.5 text-sm text-left active:opacity-70"
                  >
                    <span style={{ color: "var(--color-text)" }}>{t.merchant ?? "Transaction"}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-figure" style={{ color: "var(--color-text)" }}>
                        {fmt(-(split?.amount ?? 0))}
                      </span>
                      <span className="text-xs" style={{ color: "var(--color-faint)" }}>
                        {shortDate(t.date)}
                      </span>
                      <span className="material-symbols-outlined" style={{ fontSize: 16, color: "var(--color-faint)" }}>
                        chevron_right
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {editTxn && (
        <TransactionEditor txn={editTxn} onClose={() => setEditTxn(null)} />
      )}
    </Sheet>
  );
}
