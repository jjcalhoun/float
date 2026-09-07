"use client";

import { useEffect, useMemo, useState } from "react";
import {
  useAccounts,
  useCategories,
  useTransactions,
  useBudget,
  useCategoryBudgets,
  useAccountBalances,
  useSettings,
  useUpdateSettings,
} from "@/hooks/useSupabaseData";
import { useCommitments, useConfirmCommitment } from "@/hooks/useCommitments";
import { useSimplefinMappings } from "@/hooks/useSimplefin";
import { isAwaitingConfirmation, daysOverdue } from "@/lib/commitments/due";
import { settlementFor } from "@/lib/commitments/restore";
import { findUnmatchedIncome, overstatedBy } from "@/lib/commitments/unmatched";
import { findMisdatedLinks } from "@/lib/commitments/misdated";
import { useCommitmentWindow } from "@/hooks/useCommitments";
import { periodWindow } from "@/lib/commitments/period";
import { todayISO } from "@/lib/dates";
import { useTxnWindow } from "@/components/providers";
import { rollup, loanPaydown, monthKey } from "@/lib/aggregations";
import { debtPayment } from "@/lib/debt";
import { ledger as buildLedger } from "@/lib/commitments/ledger";
import { fmt, fmt0, shortDate, currentMonthKey, monthLabel, addMonth } from "@/lib/format";
import { BUCKETS } from "@/lib/buckets";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Gauge, type GaugePetal } from "@/components/insights/Gauge";
import { CategoryDetail } from "@/components/insights/CategoryDetail";
import { SegmentDetail, type DetailSegment } from "@/components/insights/SegmentDetail";
import { GaugeLoader } from "@/components/ui/GaugeLoader";
import { AccountEditor } from "@/components/settings/AccountEditor";
import { NewTransaction } from "@/components/transactions/NewTransaction";
import { TransactionEditor } from "@/components/transactions/TransactionEditor";
import { ReviewFlow } from "@/components/review/ReviewFlow";
import { LedgerSheet } from "@/components/plan/LedgerSheet";
import { MonthPlanSheet } from "@/components/plan/MonthPlanSheet";
import type { BucketType, Category, Transaction } from "@/lib/types";
import type { CommitmentKind } from "@/lib/commitments/types";

const DEBT_PETAL = { color: "#F97316", icon: "account_balance", label: "Debt payments" };

/* Dimmed petals for committed-but-unpaid plan items, grouped by kind. */
const PENDING_STYLE: Record<Exclude<CommitmentKind, "income">, { color: string; icon: string; label: string }> = {
  bill: { color: "#64748B", icon: "receipt_long", label: "Upcoming bills" },
  debt: { color: DEBT_PETAL.color, icon: DEBT_PETAL.icon, label: "Upcoming debt payments" },
  cc_payment: { color: "#8B5CF6", icon: "credit_card", label: "Upcoming card payments" },
  savings: { color: BUCKETS.savings.color, icon: "savings", label: "Upcoming savings" },
};

export function HomeScreen() {
  const { data: accounts = [], isLoading: la } = useAccounts();
  const { data: categories = [] } = useCategories();
  const { data: transactions = [], isLoading: lt } = useTransactions();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { data: budget } = useBudget();
  const { data: categoryBudgets = {} } = useCategoryBudgets();
  const { data: balances = {} } = useAccountBalances();
  const { ensureSince } = useTxnWindow();

  const thisMonth = currentMonthKey();
  const [month, setMonth] = useState(thisMonth);
  const isCurrent = month === thisMonth;
  const canGoForward = month < thisMonth;

  const [sheet, setSheet] = useState<"account" | "txn" | "ledger" | "plan" | null>(null);
  const [detail, setDetail] = useState<Category | null>(null);
  // A specific transaction to open for matching — the review queue only holds
  // UNREVIEWED rows, so an already-reviewed deposit can only be reached here.
  const [editTxn, setEditTxn] = useState<Transaction | null>(null);
  const [debtOpen, setDebtOpen] = useState(false);
  const [showReview, setShowReview] = useState(false);

  // category detail shows a 7-month history, so load 6 months before too
  useEffect(() => {
    ensureSince(`${addMonth(month, -6)}-01`);
  }, [month, ensureSince]);

  const savingsIds = useMemo(
    () => new Set(accounts.filter((a) => a.type === "savings").map((a) => a.id)),
    [accounts],
  );
  const loanIds = useMemo(
    () => new Set(accounts.filter((a) => a.type === "loan").map((a) => a.id)),
    [accounts],
  );
  const creditIds = useMemo(
    () => new Set(accounts.filter((a) => a.type === "credit").map((a) => a.id)),
    [accounts],
  );

  const roll = useMemo(
    () => rollup(transactions, month, undefined, savingsIds, loanIds),
    [transactions, month, savingsIds, loanIds],
  );
  const categoryById = useMemo(
    () => Object.fromEntries(categories.map((c) => [c.id, c])),
    [categories],
  );
  const accountNameById = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );

  /* ---- the free-to-spend ledger ---- */
  const { data: commitments = [] } = useCommitments(month);
  // Cards: count the purchases, or count the payment that settles them —
  // never both. See lib/commitments/ledger.ts.
  const countCards = settings?.count_card_purchases ?? true;
  const led = useMemo(
    () =>
      buildLedger(
        commitments,
        transactions,
        month,
        {
          creditAccountIds: creditIds,
          loanAccountIds: loanIds,
          savingsAccountIds: savingsIds,
        },
        { countCardPurchases: countCards },
      ),
    [commitments, transactions, month, creditIds, loanIds, savingsIds, countCards],
  );

  // Only worth offering when there is a card in play at all.
  const hasCards = creditIds.size > 0;

  /* ---- income that arrived but was never matched ----
     The costliest silent failure available here: the plan line counts from the
     1st and the unlinked deposit counts again as income beyond the plan, so
     the month reads high by a whole paycheck with nothing saying why. */
  const unmatchedIncome = useMemo(
    () => (isCurrent ? findUnmatchedIncome(commitments, transactions, month) : []),
    [commitments, transactions, month, isCurrent],
  );

  /* ---- a payment settling the wrong occurrence of its own series ----
     A linked payment counts toward its COMMITMENT's month, so one mis-tap
     between two chips reading alike moves a whole paycheck between months.
     Needs neighbouring periods to see the sibling it should have matched. */
  const { data: windowCommitments = [] } = useCommitmentWindow(periodWindow(month));
  const misdated = useMemo(
    () => (isCurrent ? findMisdatedLinks(windowCommitments, transactions) : []),
    [windowCommitments, transactions, isCurrent],
  );

  /* ---- payments waiting on you ----
     On a manual account nothing will ever match a payment automatically: there
     is no feed to bring it. The plan sheet has said so since it learned to ask,
     but the plan sheet is two taps into Profile, so in practice a paid bill sat
     unconfirmed and dragged free-to-spend down for weeks. It belongs here. */
  const { data: mappings = [] } = useSimplefinMappings();
  const confirmPaid = useConfirmCommitment(month);
  const today = todayISO();
  const awaiting = useMemo(() => {
    if (!isCurrent) return [];
    const syncedIds = new Set(mappings.map((m) => m.account_id));
    const accountById = new Map(accounts.map((a) => [a.id, a]));
    return commitments
      .filter((c) =>
        isAwaitingConfirmation(
          c,
          c.account_id ? accountById.get(c.account_id) : undefined,
          !!c.account_id && syncedIds.has(c.account_id),
          settlementFor(c, transactions),
          today,
        ),
      )
      .sort((a, b) => daysOverdue(b.due_hint, today) - daysOverdue(a.due_hint, today));
  }, [commitments, transactions, accounts, mappings, today, isCurrent]);

  // Gauge scale: expected income from the ledger; sensible fallbacks while a
  // plan doesn't exist yet (fresh month, or months before plans existed).
  const expectedIncome = Math.max(
    led.incomeEffective + led.extraIncome,
    roll.income,
    isCurrent ? (budget?.income ?? 0) : 0,
  );

  /* ---- 3-month category averages ---- */
  const avg3ByCat = useMemo(() => {
    const acc: Record<string, number> = {};
    for (let i = 1; i <= 3; i++) {
      const r = rollup(transactions, addMonth(month, -i), undefined, savingsIds, loanIds);
      for (const [id, v] of Object.entries(r.byCat)) if (v > 0) acc[id] = (acc[id] ?? 0) + v;
    }
    const out: Record<string, number> = {};
    for (const id in acc) out[id] = acc[id] / 3;
    return out;
  }, [transactions, month, savingsIds, loanIds]);

  /* ---- debt payments ---- */
  const debt = useMemo(() => {
    const loans = accounts.filter((a) => a.type === "loan");
    const byAccount: Record<string, number> = {};
    const txns = [];
    for (const t of transactions) {
      if (monthKey(t.date) !== month) continue;
      if (t.type === "transfer" && t.amount > 0 && loanIds.has(t.account_id)) {
        byAccount[t.account_id] = (byAccount[t.account_id] ?? 0) + t.amount;
        txns.push(t);
      }
    }
    const actual = Object.values(byAccount).reduce((s, v) => s + v, 0);
    // escrow leaves checking but never pays down a loan, so the target is the
    // debt-only portion of each payment
    const budgetAmt = loans.reduce(
      (s, a) => s + debtPayment(a, Math.max(0, -(balances[a.id] ?? 0))),
      0,
    );
    let avg = 0;
    for (let i = 1; i <= 3; i++) avg += loanPaydown(transactions, loanIds, addMonth(month, -i));
    const breakdown = loans
      .filter((a) => (byAccount[a.id] ?? 0) > 0)
      .map((a) => ({ label: a.name, value: byAccount[a.id] }))
      .sort((x, y) => y.value - x.value);
    return { actual, budget: budgetAmt, avg3: avg / 3, breakdown, txns };
  }, [transactions, accounts, loanIds, month, balances]);

  /* ---- petals: actual spend + dimmed upcoming commitments ---- */
  const petals: GaugePetal[] = useMemo(() => {
    const keys = new Set(Object.keys(roll.byCat).filter((id) => roll.byCat[id] > 0));
    const out: GaugePetal[] = [...keys].flatMap((id) => {
      const c = categoryById[id];
      if (!c) return [];
      return [{
        key: `cat:${id}`,
        label: c.name,
        color: c.color,
        icon: c.icon,
        actual: Math.max(0, roll.byCat[id] ?? 0),
        budget: categoryBudgets[id] ?? 0,
        avg3: avg3ByCat[id] ?? 0,
      }];
    });
    if (debt.actual > 0) {
      out.push({
        key: "debt",
        ...DEBT_PETAL,
        actual: debt.actual,
        budget: debt.budget,
        avg3: debt.avg3,
        breakdown: debt.breakdown,
      });
    }
    // Current month: committed-but-unpaid plan items as dimmed segments that
    // solidify (become real petals) as they're paid.
    if (isCurrent) {
      const pendingByKind = new Map<Exclude<CommitmentKind, "income">, { total: number; breakdown: { label: string; value: number }[] }>();
      for (const i of led.items) {
        if (i.kind === "income" || i.excluded || i.status === "paid") continue;
        const kind = i.kind as Exclude<CommitmentKind, "income">;
        const entry = pendingByKind.get(kind) ?? { total: 0, breakdown: [] };
        entry.total += -i.amount;
        entry.breakdown.push({ label: i.name, value: -i.amount });
        pendingByKind.set(kind, entry);
      }
      for (const [kind, v] of pendingByKind) {
        if (v.total <= 0) continue;
        out.push({
          key: `pending:${kind}`,
          label: PENDING_STYLE[kind].label,
          color: PENDING_STYLE[kind].color,
          icon: PENDING_STYLE[kind].icon,
          actual: v.total,
          budget: 0,
          avg3: 0,
          breakdown: v.breakdown.sort((a, b) => b.value - a.value),
          dim: true,
        });
      }
    }
    return out;
  }, [categoryBudgets, roll.byCat, categoryById, avg3ByCat, debt, isCurrent, led.items]);

  const ranked = useMemo(() => {
    return Object.entries(roll.byCat)
      .map(([id, spend]) => ({ cat: categoryById[id], spend }))
      .filter((r) => r.cat && r.spend > 0)
      .sort((a, b) => b.spend - a.spend);
  }, [roll.byCat, categoryById]);

  function onPetalClick(key: string) {
    if (key === "debt") return setDebtOpen(true);
    if (key.startsWith("pending:")) return setSheet("ledger");
    const c = categoryById[key.slice(4)];
    if (c) setDetail(c);
  }

  const netCash = accounts.reduce((s, a) => s + (balances[a.id] ?? 0), 0);
  const unreviewedList = transactions.filter((t) => !t.reviewed);
  const unreviewed = unreviewedList.length;
  const unreviewedTotal = unreviewedList.reduce((s, t) => s + Math.abs(t.amount), 0);

  const center = isCurrent
    ? {
        label: "Free to spend",
        value: fmt0(led.freeToSpend),
        sub: `of ${fmt0(expectedIncome)} expected`,
      }
    : {
        label: "Net",
        value: fmt0(roll.income - roll.spend),
        sub: `${fmt0(roll.spend)} spent of ${fmt0(roll.income)}`,
      };

  if (la || lt) return <GaugeLoader />;

  return (
    <main className="p-4 space-y-5">
      {/* Month navigator */}
      <div className="flex items-center justify-between">
        <button onClick={() => setMonth(addMonth(month, -1))} style={{ color: "var(--color-muted)" }}>
          <span className="material-symbols-outlined">chevron_left</span>
        </button>
        <h1 className="font-figure text-lg font-bold" style={{ color: "var(--color-text)" }}>
          {monthLabel(month)}
        </h1>
        <button
          onClick={() => canGoForward && setMonth(addMonth(month, 1))}
          disabled={!canGoForward}
          style={{ color: canGoForward ? "var(--color-muted)" : "var(--color-hairline)" }}
        >
          <span className="material-symbols-outlined">chevron_right</span>
        </button>
      </div>

      {/* Two-column dashboard on desktop */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start space-y-5 lg:space-y-0">
        <div className="space-y-5">

      {/* Gauge hero — tap the center for the ledger breakdown */}
      <Card className="px-3 pt-3 pb-2">
        {/* the donut is square, so it needs a cap — left to fill a wide
            desktop column it would be taller than the viewport */}
        <div className="mx-auto w-full max-w-[380px]">
          <Gauge
            petals={petals}
            income={expectedIncome || roll.spend}
            center={center}
            onPetalClick={onPetalClick}
            onCenterClick={isCurrent ? () => setSheet("ledger") : undefined}
          />
        </div>
        {isCurrent && hasCards && (
          <CardSpendToggle
            on={countCards}
            onChange={(v) => updateSettings.mutate({ count_card_purchases: v })}
          />
        )}
      </Card>

      {/* A payment on the wrong month's line — see the note above */}
      {misdated.length > 0 && (
        <Card className="p-4 space-y-2.5" style={{ borderColor: "var(--color-danger)" }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
              {misdated.length === 1 ? "A payment is" : `${misdated.length} payments are`} on the
              wrong month&apos;s line
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
              Money counts toward the month of the line it&apos;s matched to, so this moves it
              out of the month it actually belongs to
            </p>
          </div>
          {misdated.map((m) => (
            <button
              key={m.txn.id}
              onClick={() => setEditTxn(m.txn)}
              className="w-full flex items-center gap-3 text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate" style={{ color: "var(--color-text)" }}>
                  {m.txn.merchant || m.txn.description}
                </p>
                <p className="text-xs" style={{ color: "var(--color-faint)" }}>
                  {shortDate(m.txn.date)} · matched to {monthLabel(m.linkedTo.period)}, belongs to{" "}
                  {monthLabel(m.better.period)}
                </p>
              </div>
              <span className="font-figure text-sm shrink-0" style={{ color: "var(--color-text)" }}>
                {fmt(m.txn.amount)}
              </span>
              <span
                className="text-xs font-semibold px-2.5 py-1.5 rounded-md shrink-0 text-white"
                style={{ background: "var(--color-primary)" }}
              >
                Fix
              </span>
            </button>
          ))}
        </Card>
      )}

      {/* Income counted twice — see the note above.

          Each row opens its OWN deposit. Sending this to the review queue was
          a dead end: that queue holds unreviewed rows only, and these deposits
          were reviewed long ago — they passed through without being matched,
          which is the whole problem. */}
      {unmatchedIncome.length > 0 && (
        <Card className="p-4 space-y-2.5" style={{ borderColor: "var(--color-danger)" }}>
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
              {unmatchedIncome.length === 1 ? "A deposit isn't" : `${unmatchedIncome.length} deposits aren't`}{" "}
              matched to the plan
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
              Income above counts {fmt0(overstatedBy(unmatchedIncome))} twice until they are —
              once as the plan line, once as the deposit
            </p>
          </div>
          {unmatchedIncome.map((u) => (
            <button
              key={u.txn.id}
              onClick={() => setEditTxn(u.txn)}
              className="w-full flex items-center gap-3 text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate" style={{ color: "var(--color-text)" }}>
                  {u.txn.merchant || u.txn.description}
                </p>
                <p className="text-xs" style={{ color: "var(--color-faint)" }}>
                  {shortDate(u.txn.date)} · expected as {u.expected.name}
                </p>
              </div>
              <span className="font-figure text-sm shrink-0" style={{ color: "var(--color-positive)" }}>
                {fmt(u.txn.amount)}
              </span>
              <span
                className="text-xs font-semibold px-2.5 py-1.5 rounded-md shrink-0 text-white"
                style={{ background: "var(--color-primary)" }}
              >
                Match
              </span>
            </button>
          ))}
        </Card>
      )}

      {/* Payments waiting on you — manual accounts only; see the note above */}
      {awaiting.length > 0 && (
        <Card className="p-4 space-y-2.5">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
              Did these go through?
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
              No bank feed on these accounts, so nothing can match them for you
            </p>
          </div>
          {awaiting.slice(0, 4).map((c) => (
            <div key={c.id} className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate" style={{ color: "var(--color-text)" }}>
                  {c.name}
                </p>
                <p className="text-xs" style={{ color: "var(--color-faint)" }}>
                  {overdueLabel(daysOverdue(c.due_hint, today))}
                </p>
              </div>
              <span className="font-figure text-sm shrink-0" style={{ color: "var(--color-text)" }}>
                {fmt(c.amount)}
              </span>
              <button
                onClick={() =>
                  // A variable line can't be confirmed at its estimate — the
                  // reason to ask is that the real figure differs — so it goes
                  // to the plan, where the amount can be typed.
                  c.variable
                    ? setSheet("plan")
                    : confirmPaid.mutate({ commitment: c, amount: Math.abs(c.amount), date: today })
                }
                className="text-xs font-semibold px-2.5 py-1.5 rounded-md shrink-0 text-white"
                style={{ background: "var(--color-primary)" }}
              >
                {c.variable ? "Confirm…" : "Mark paid"}
              </button>
            </div>
          ))}
          {awaiting.length > 4 && (
            <button
              onClick={() => setSheet("plan")}
              className="text-xs font-semibold"
              style={{ color: "var(--color-primary)" }}
            >
              {awaiting.length - 4} more in the plan
            </button>
          )}
        </Card>
      )}

      {/* Review queue */}
      {unreviewed > 0 && (
        <button
          onClick={() => setShowReview(true)}
          className="w-full rounded-[16px] border p-4 flex items-center justify-between text-left"
          style={{ background: "var(--color-surface)", borderColor: "var(--color-primary)" }}
        >
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
              {unreviewed} to review
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
              {fmt0(unreviewedTotal)} across new transactions
            </p>
          </div>
          <span
            className="inline-flex items-center gap-1 text-sm font-semibold px-3 py-1.5 rounded-full text-white"
            style={{ background: "var(--color-primary)" }}
          >
            Review
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>arrow_forward</span>
          </span>
        </button>
      )}

      {/* Empty state */}
      {accounts.length === 0 && (
        <Card className="p-5 text-center space-y-3">
          <p className="text-sm" style={{ color: "var(--color-muted)" }}>
            Add your first account to start tracking balances and spending.
          </p>
          <Button onClick={() => setSheet("account")}>+ Add account</Button>
        </Card>
      )}

      {/* Spending categories */}
      {(ranked.length > 0 || debt.actual > 0) && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
            Spending categories
          </h2>
          <Card className="p-2">
            {debt.actual > 0 && (
              <button onClick={() => setDebtOpen(true)} className="w-full text-left px-2 py-2.5">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="flex items-center gap-2 text-sm">
                    <span
                      className="inline-flex items-center justify-center w-6 h-6 rounded-full"
                      style={{ background: `${DEBT_PETAL.color}22` }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: 14, color: DEBT_PETAL.color }}>
                        {DEBT_PETAL.icon}
                      </span>
                    </span>
                    <span style={{ color: "var(--color-text)" }}>{DEBT_PETAL.label}</span>
                  </span>
                  <span className="text-sm font-figure" style={{ color: debt.budget > 0 && debt.actual > debt.budget ? "var(--color-danger)" : "var(--color-text)" }}>
                    {fmt0(debt.actual)}
                    {debt.budget > 0 && <span style={{ color: "var(--color-faint)" }}> / {fmt0(debt.budget)}</span>}
                  </span>
                </div>
                {debt.budget > 0 && (
                  <ProgressBar value={(debt.actual / debt.budget) * 100} color={DEBT_PETAL.color} overBudget={debt.actual > debt.budget} />
                )}
              </button>
            )}
            {ranked.map(({ cat, spend }) => {
              const target = categoryBudgets[cat.id] ?? 0;
              const pct = target > 0 ? (spend / target) * 100 : 0;
              const over = target > 0 && spend > target;
              return (
                <button key={cat.id} onClick={() => setDetail(cat)} className="w-full text-left px-2 py-2.5">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="flex items-center gap-2 text-sm">
                      <span
                        className="inline-flex items-center justify-center w-6 h-6 rounded-full"
                        style={{ background: `${cat.color}22` }}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: 14, color: cat.color }}>
                          {cat.icon}
                        </span>
                      </span>
                      <span style={{ color: "var(--color-text)" }}>{cat.name}</span>
                    </span>
                    <span className="text-sm font-figure" style={{ color: over ? "var(--color-danger)" : "var(--color-text)" }}>
                      {fmt0(spend)}
                      {target > 0 && <span style={{ color: "var(--color-faint)" }}> / {fmt0(target)}</span>}
                    </span>
                  </div>
                  {target > 0 && <ProgressBar value={pct} color={cat.color} overBudget={over} />}
                </button>
              );
            })}
          </Card>
        </section>
      )}

        </div>{/* left column */}

        <div className="space-y-5">

      {/* Cash flow */}
      {accounts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
            Cash flow
          </h2>
          <Card className="p-4 space-y-3">
            <FlowBar label="Income" value={expectedIncome} max={Math.max(expectedIncome, roll.spend, 1)} color="var(--color-positive)" />
            {(Object.keys(BUCKETS) as BucketType[]).map((b) => (
              <FlowBar
                key={b}
                label={BUCKETS[b].label}
                value={roll.byBucket[b]}
                max={Math.max(expectedIncome, roll.spend, 1)}
                color={BUCKETS[b].color}
              />
            ))}
          </Card>
        </section>
      )}

      {/* Spending by bucket — plan vs actual */}
      {accounts.length > 0 && budget && (
        <Card className="p-4 space-y-3">
          <p className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
            Spending by bucket
          </p>
          {(Object.keys(BUCKETS) as BucketType[]).map((b) => {
            const planPct =
              b === "needs" ? budget.plan_needs : b === "wants" ? budget.plan_wants : budget.plan_savings;
            const actual = roll.byBucket[b];
            const actualPct = roll.spend > 0 ? Math.round((actual / roll.spend) * 100) : 0;
            return (
              <div key={b} className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: BUCKETS[b].color }} />
                  <span style={{ color: "var(--color-text)" }}>{BUCKETS[b].label}</span>
                </span>
                <span style={{ color: "var(--color-muted)" }}>
                  {fmt0(actual)}{" "}
                  <span style={{ color: "var(--color-text)", fontWeight: 600 }}>{actualPct}%</span>
                  <span style={{ color: "var(--color-faint)" }}> / plan {planPct}%</span>
                </span>
              </div>
            );
          })}
        </Card>
      )}

      {/* Accounts */}
      {accounts.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
              Accounts
            </h2>
            <button
              className="text-xs font-semibold"
              style={{ color: "var(--color-primary)" }}
              onClick={() => setSheet("account")}
            >
              + Add
            </button>
          </div>
          <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
                    {a.name}
                  </p>
                  <p className="text-xs capitalize" style={{ color: "var(--color-faint)" }}>
                    {a.type}{a.last4 ? ` ••${a.last4}` : ""}
                  </p>
                </div>
                <p
                  className="font-figure text-sm font-semibold"
                  style={{ color: (balances[a.id] ?? 0) < 0 ? "var(--color-danger)" : "var(--color-text)" }}
                >
                  {fmt(balances[a.id] ?? 0)}
                </p>
              </div>
            ))}
            <div className="flex items-center justify-between px-4 py-3">
              <p className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
                Net cash
              </p>
              <p
                className="font-figure text-sm font-bold"
                style={{ color: netCash < 0 ? "var(--color-danger)" : "var(--color-positive)" }}
              >
                {fmt(netCash)}
              </p>
            </div>
          </Card>
        </section>
      )}

      {/* Quick add */}
      {accounts.length > 0 && (
        <Button fullWidth variant="secondary" onClick={() => setSheet("txn")}>
          + New transaction
        </Button>
      )}

        </div>{/* right column */}
      </div>{/* dashboard grid */}

      {sheet === "account" && <AccountEditor onClose={() => setSheet(null)} />}
      {sheet === "txn" && <NewTransaction onClose={() => setSheet(null)} />}
      {sheet === "ledger" && (
        <LedgerSheet
          month={month}
          ledger={led}
          onEditPlan={() => setSheet("plan")}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "plan" && <MonthPlanSheet month={month} onClose={() => setSheet(null)} />}
      {editTxn && <TransactionEditor txn={editTxn} onClose={() => setEditTxn(null)} />}
      {showReview && <ReviewFlow onClose={() => setShowReview(false)} />}
      {detail && (
        <CategoryDetail
          category={detail}
          transactions={transactions}
          month={month}
          monthlyTarget={categoryBudgets[detail.id] ?? 0}
          onClose={() => setDetail(null)}
        />
      )}
      {debtOpen && (
        <SegmentDetail
          segment={{ ...DEBT_PETAL, value: debt.actual } as DetailSegment}
          transactions={debt.txns}
          month={month}
          accountNameById={accountNameById}
          breakdown={debt.breakdown}
          onClose={() => setDebtOpen(false)}
        />
      )}
    </main>
  );
}

function FlowBar({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-xs w-16" style={{ color: "var(--color-muted)" }}>
        {label}
      </span>
      <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "var(--color-hairline)" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, (Math.max(0, value) / max) * 100)}%`, background: color }}
        />
      </div>
      <span className="text-xs font-figure w-16 text-right" style={{ color: "var(--color-text)" }}>
        {fmt0(value)}
      </span>
    </div>
  );
}

/* Whether card purchases count as you make them, on top of the card payment
 * that always counts. See lib/commitments/ledger.ts for why both belong while
 * a balance is carried.
 *
 * It sits under the gauge because it changes the number directly above it, and
 * the caption says which reading you're getting rather than making you
 * remember what the switch means. */
function CardSpendToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="w-full flex items-center justify-between gap-3 px-2 pt-2 pb-1 text-left"
      style={{ borderTop: "1px solid var(--color-hairline)" }}
      aria-pressed={on}
    >
      <span className="min-w-0">
        <span className="block text-xs font-medium" style={{ color: "var(--color-text)" }}>
          Count card spending
        </span>
        <span className="block text-xs" style={{ color: "var(--color-faint)" }}>
          {on
            ? "Purchases count as you make them"
            : "Only the card payment counts, not purchases"}
        </span>
      </span>
      <span
        className="shrink-0 rounded-full transition-colors"
        style={{
          width: 40,
          height: 24,
          padding: 3,
          background: on ? "var(--color-primary)" : "var(--color-elevated)",
          border: on ? "none" : "1px solid var(--color-hairline)",
        }}
      >
        <span
          className="block rounded-full transition-transform"
          style={{
            width: 18,
            height: 18,
            background: on ? "#fff" : "var(--color-muted)",
            transform: on ? "translateX(16px)" : "translateX(0)",
          }}
        />
      </span>
    </button>
  );
}

/* How late a waiting payment is. "Due today" reads better than "0 days late",
   and a payment one day out doesn't deserve alarm. */
function overdueLabel(days: number): string {
  if (days <= 0) return "due today";
  if (days === 1) return "due yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 14) return "over a week ago";
  return `${Math.floor(days / 7)} weeks ago`;
}
