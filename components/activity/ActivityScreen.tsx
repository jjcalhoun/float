"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  useTransactions,
  useCategories,
  useAccounts,
  useDeleteTransactions,
} from "@/hooks/useSupabaseData";
import { useTxnWindow } from "@/components/providers";
import { useIsDesktop } from "@/hooks/useMediaQuery";
import { TxnTile } from "@/components/transactions/TxnTile";
import { NewTransaction } from "@/components/transactions/NewTransaction";
import { TransactionEditor } from "@/components/transactions/TransactionEditor";
import { ReviewFlow } from "@/components/review/ReviewFlow";
import { FilterSheet, EMPTY_FILTERS, activeFilterCount, type ActivityFilters } from "@/components/activity/FilterSheet";
import { GaugeLoader } from "@/components/ui/GaugeLoader";
import { Chip } from "@/components/ui/Chip";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { BUCKETS } from "@/lib/buckets";
import { monthKey } from "@/lib/aggregations";
import { monthLabel } from "@/lib/format";
import type { BucketType, Transaction } from "@/lib/types";

export function ActivityScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const { data: transactions = [], isLoading } = useTransactions();
  const { data: categories = [] } = useCategories();
  const { data: accounts = [] } = useAccounts();
  const { ensureSince } = useTxnWindow();
  const isDesktop = useIsDesktop();
  const [query, setQuery] = useState("");
  const [bucket, setBucket] = useState<BucketType | null>(null);
  const [filters, setFilters] = useState<ActivityFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  /* How many tiles to actually render.
     This screen drew EVERY matching transaction, and v2 made that much
     worse: the Float screen widens the loaded window to two years so the
     detector can see annual bills, and Activity then rendered all of it.
     Thousands of tiles took 25 seconds to paint on a throttled phone and
     pushed the nav bar off the bottom of the page.
     Filtering, searching and counting still run over everything — only the
     drawing is capped. */
  const PAGE = 60;
  const [shown, setShown] = useState(PAGE);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const deleteTxns = useDeleteTransactions();

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }
  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} transaction${selected.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    await deleteTxns.mutateAsync([...selected]);
    exitSelect();
  }

  const years = useMemo(() => {
    const cur = new Date().getFullYear();
    const set = new Set<number>();
    for (let y = cur; y >= cur - 7; y--) set.add(y); // selectable even if not yet loaded
    for (const t of transactions) set.add(Number(t.date.slice(0, 4)));
    return [...set].sort((a, b) => b - a);
  }, [transactions]);
  const filterCount = activeFilterCount(filters);

  // deep-link filters from the Home Income/Spent tiles
  const typeParam = params.get("type"); // "income" | "spending"
  const monthParam = params.get("month"); // "YYYY-MM"
  const hasDeepFilter = typeParam === "income" || typeParam === "spending";

  // expand the loaded window when filters reach older than the default window
  useEffect(() => {
    if (monthParam) ensureSince(`${monthParam}-01`);
    if (filters.from) ensureSince(filters.from);
    if (filters.year) ensureSince(`${filters.year}-01-01`);
    if (filters.month && !filters.year && !filters.from) ensureSince("1970-01-01");
  }, [filters, monthParam, ensureSince]);

  const deepLabel =
    typeParam === "income"
      ? `Income${monthParam ? ` · ${monthLabel(monthParam)}` : ""}`
      : `Spending${monthParam ? ` · ${monthLabel(monthParam)}` : ""}`;

  const unreviewedCount = transactions.filter((t) => !t.reviewed).length;

  const categoryById = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c])),
    [categories],
  );
  const accountNameById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );
  const savingsAccountIds = useMemo(
    () => new Set(accounts.filter((a) => a.type === "savings").map((a) => a.id)),
    [accounts],
  );

  // a narrowed search should start from the top, not 300 tiles down
  useEffect(() => setShown(PAGE), [query, bucket, filters, typeParam, monthParam]);

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      // deep-link filters (from Home)
      if (monthParam && monthKey(t.date) !== monthParam) return false;
      if (typeParam === "income" && t.type !== "income") return false;
      if (typeParam === "spending" && t.type !== "expense" && t.type !== "refund") return false;
      // search + bucket
      if (query) {
        const hay = `${t.merchant ?? ""} ${t.description ?? ""}`.toLowerCase();
        if (!hay.includes(query.toLowerCase())) return false;
      }
      if (bucket && !(t.splits ?? []).some((s) => s.bucket === bucket)) return false;
      // filter sheet
      if (filters.type !== "all" && t.type !== filters.type) return false;
      if (filters.recurring !== "all") {
        // "recurring" = generated by a rule, or a real transaction that
        // fulfilled a planned recurring payment.
        const isRecurring = !!t.commitment_id;
        if (filters.recurring === "recurring" ? !isRecurring : isRecurring) return false;
      }
      if (filters.categoryId && !(t.splits ?? []).some((s) => s.category_id === filters.categoryId)) return false;
      if (filters.year && Number(t.date.slice(0, 4)) !== filters.year) return false;
      if (filters.month && Number(t.date.slice(5, 7)) !== filters.month) return false;
      if (filters.from && t.date < filters.from) return false;
      if (filters.to && t.date > filters.to) return false;
      return true;
    });
  }, [transactions, query, bucket, typeParam, monthParam, filters]);

  // A transfer is stored as two linked rows (one per account). Collapse each
  // transfer_group_id to a single Activity entry — prefer the outflow (debit)
  // side so the "from → to" reads in the natural direction. Both DB rows remain
  // for per-account balances; this is display-only.
  const visible = useMemo(() => {
    // Choose one representative row per transfer group: the outflow (debit) side
    // when present, so the "from → to" label reads in the natural direction.
    const repForGroup = new Map<string, Transaction>();
    for (const t of filtered) {
      const g = t.transfer_group_id;
      if (!g) continue;
      const cur = repForGroup.get(g);
      if (!cur || (cur.amount >= 0 && t.amount < 0)) repForGroup.set(g, t);
    }
    // Keep source order; drop the non-representative side of each group.
    return filtered.filter((t) => {
      const g = t.transfer_group_id;
      return !g || repForGroup.get(g)?.id === t.id;
    });
  }, [filtered]);

  return (
    <main className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="font-figure text-xl font-bold" style={{ color: "var(--color-text)" }}>
          Activity
        </h1>
        <div className="flex items-center gap-2">
          {unreviewedCount > 0 && (
            <Button size="sm" onClick={() => setShowReview(true)} className="relative">
              Review
              <span
                className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold"
                style={{ background: "#fff", color: "var(--color-primary)" }}
              >
                {unreviewedCount}
              </span>
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => setShowNew(true)}>
            + New
          </Button>
          {selectMode ? (
            <Button size="sm" variant="secondary" onClick={exitSelect}>
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setSelectMode(true)}>
              Select
            </Button>
          )}
        </div>
      </div>

      {/* List + detail pane on desktop */}
      <div className="lg:grid lg:grid-cols-[1fr_360px] lg:gap-5 lg:items-start">
        <div className="space-y-4 min-w-0">
      <Input
        placeholder="Search transactions…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {hasDeepFilter && (
        <button
          onClick={() => router.push("/activity")}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold"
          style={{ background: "var(--color-primary)", color: "#fff" }}
        >
          {deepLabel}
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
        </button>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setShowFilters(true)}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-[9999px] text-xs font-semibold"
          style={{
            background: filterCount > 0 ? "var(--color-primary)" : "var(--color-chip-bg)",
            color: filterCount > 0 ? "#fff" : "var(--color-muted)",
          }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 15 }}>tune</span>
          Filters{filterCount > 0 ? ` · ${filterCount}` : ""}
        </button>
        {(Object.keys(BUCKETS) as BucketType[]).map((b) => (
          <Chip
            key={b}
            active={bucket === b}
            color={BUCKETS[b].color}
            onClick={() => setBucket(bucket === b ? null : b)}
          >
            {BUCKETS[b].label}
          </Chip>
        ))}
        {filterCount > 0 && (
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="text-xs font-semibold"
            style={{ color: "var(--color-muted)" }}
          >
            Clear
          </button>
        )}
      </div>

      {isLoading ? (
        <GaugeLoader />
      ) : visible.length === 0 ? (
        <p className="text-sm text-center py-8" style={{ color: "var(--color-muted)" }}>
          {transactions.length === 0
            ? "No transactions yet. Tap + New to add one."
            : "No transactions match your filters."}
        </p>
      ) : (
        <div className="grid grid-cols-3 xl:grid-cols-4 gap-3">
          {visible.slice(0, shown).map((t) => {
            const isSel = selected.has(t.id);
            const isOpen = !selectMode && editTxn?.id === t.id;
            return (
              <div key={t.id} className="relative">
                <TxnTile
                  txn={t}
                  categoryById={categoryById}
                  accountNameById={accountNameById}
                  savingsAccountIds={savingsAccountIds}
                  onClick={() => (selectMode ? toggleSelected(t.id) : setEditTxn(t))}
                />
                {isOpen && (
                  <span
                    className="absolute inset-0 rounded-[12px] pointer-events-none"
                    style={{ boxShadow: "0 0 0 2px var(--color-primary)" }}
                  />
                )}
                {selectMode && (
                  <span
                    className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center pointer-events-none"
                    style={{
                      background: isSel ? "var(--color-primary)" : "rgba(0,0,0,0.35)",
                      border: isSel ? "none" : "1.5px solid #fff",
                    }}
                  >
                    {isSel && (
                      <span className="material-symbols-outlined" style={{ fontSize: 14, color: "#fff" }}>
                        check
                      </span>
                    )}
                  </span>
                )}
                {selectMode && isSel && (
                  <span
                    className="absolute inset-0 rounded-[12px] pointer-events-none"
                    style={{ boxShadow: "0 0 0 2px var(--color-primary)" }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {visible.length > shown && (
        <div className="flex flex-col items-center gap-1 pt-1">
          <Button size="sm" variant="secondary" onClick={() => setShown((n) => n + PAGE * 4)}>
            Show more
          </Button>
          <p className="text-xs" style={{ color: "var(--color-faint)" }}>
            {shown} of {visible.length}
          </p>
        </div>
      )}
        </div>{/* list column */}

        {/* Detail pane — desktop only */}
        <aside className="hidden lg:block sticky top-6">
          {editTxn ? (
            <div
              className="rounded-[16px] border overflow-hidden"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-hairline)" }}
            >
              <div
                className="flex items-center justify-between px-5 py-3 border-b"
                style={{ borderColor: "var(--color-hairline)" }}
              >
                <span className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                  Edit transaction
                </span>
                <button onClick={() => setEditTxn(null)} style={{ color: "var(--color-muted)" }}>
                  <span className="material-symbols-outlined" style={{ fontSize: 20 }}>close</span>
                </button>
              </div>
              <div className="max-h-[calc(100vh-150px)] overflow-y-auto">
                <TransactionEditor txn={editTxn} inline onClose={() => setEditTxn(null)} />
              </div>
            </div>
          ) : (
            <div
              className="rounded-[16px] border p-10 text-center"
              style={{ background: "var(--color-surface)", borderColor: "var(--color-hairline)" }}
            >
              <p className="text-sm" style={{ color: "var(--color-faint)" }}>
                Select a transaction to view or edit it here.
              </p>
            </div>
          )}
        </aside>
      </div>{/* list + detail */}

      {selectMode && (
        <div
          className="fixed bottom-20 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2.5 rounded-full shadow-lg"
          style={{ background: "var(--color-elevated)", border: "1px solid var(--color-hairline)" }}
        >
          <span className="text-sm" style={{ color: "var(--color-muted)" }}>
            {selected.size} selected
          </span>
          <Button
            size="sm"
            onClick={deleteSelected}
            disabled={selected.size === 0 || deleteTxns.isPending}
            style={{ background: "var(--color-danger)", color: "#fff" }}
          >
            {deleteTxns.isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      )}

      {showFilters && (
        <FilterSheet
          filters={filters}
          categories={categories}
          years={years}
          onApply={setFilters}
          onClose={() => setShowFilters(false)}
        />
      )}
      {showNew && <NewTransaction onClose={() => setShowNew(false)} />}
      {showReview && <ReviewFlow onClose={() => setShowReview(false)} />}
      {/* Mobile: modal editor. Desktop uses the side panel above. */}
      {editTxn && !isDesktop && (
        <TransactionEditor txn={editTxn} onClose={() => setEditTxn(null)} />
      )}
    </main>
  );
}
