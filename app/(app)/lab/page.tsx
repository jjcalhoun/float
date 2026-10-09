"use client";

/* A dry run of the v2 detector against real data. Reads only.
 *
 * Not a feature, and not linked from anywhere. The point of v2 is that the
 * recurrence detector replaces the hand-curated plan, so the only question
 * worth answering before building any of it is whether the detector actually
 * describes this account. This page answers that and nothing else: everything
 * it found, what it rejected, and why.
 *
 * Delete it once the question is settled.
 */

import { useMemo, useState } from "react";
import { useTransactions, useAccounts } from "@/hooks/useSupabaseData";
import { useTxnWindow } from "@/components/providers";
import { detectSeries, isStale, type Txn } from "@/lib/v2/recurring";
import { normalisePayee, displayPayee } from "@/lib/v2/payee";
import { fmt, fmt0, shortDate } from "@/lib/format";
import { todayISO } from "@/lib/dates";
import { Card } from "@/components/ui/Card";

const CADENCE_LABEL: Record<string, string> = {
  weekly: "weekly",
  biweekly: "every 2 weeks",
  semimonthly: "twice a month",
  monthly: "monthly",
  quarterly: "quarterly",
  annual: "yearly",
};

export default function DetectorLab() {
  const { data: transactions = [], isLoading } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const { ensureSince } = useTxnWindow();
  const [months, setMonths] = useState(12);
  const today = todayISO();

  // The detector wants as much history as it can get.
  useMemo(() => {
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    ensureSince(since.toISOString().slice(0, 10));
  }, [months, ensureSince]);

  /* Checking only, which is what screen 1 will look at.
   *
   * Scope is not cosmetic here. Run the detector across every account and a
   * transfer shows up twice — once leaving checking, once arriving at savings
   * or the card — so "Savings auto-transfer" appears as both a $250 outflow
   * and a $250 income. Nothing is wrong with the detection; both legs are
   * real. Looking at one account is what makes a transfer one event. */
  const spending = useMemo(
    () => new Set(accounts.filter((a) => a.type === "checking").map((a) => a.id)),
    [accounts],
  );

  const scoped: Txn[] = useMemo(
    () =>
      transactions
        /* Only what the bank actually sent.
           "payday allocation to IUCU checking" turned up as detected income,
           and it is not a deposit at all — it is a row v1 wrote for itself.
           ADP splits the pay at source, so the money never passes through
           this account. v2 is built on what SimpleFIN sees, and anything the
           old app invented has to stay out of it or the detector learns from
           its predecessor's bookkeeping instead of from the bank. */
        .filter((t) => t.source === "sync")
        // Transfers are kept deliberately: the card payment and the standing
        // transfer to savings both leave checking every month, so they are
        // exactly the kind of recurring outflow the horizon needs to know.
        .filter((t) => spending.size === 0 || spending.has(t.account_id))
        .map((t) => ({
          id: t.id,
          date: t.date,
          amount: t.amount,
          merchant: t.merchant,
          description: t.description,
        })),
    [transactions, spending],
  );

  const series = useMemo(() => detectSeries(scoped), [scoped]);
  const live = series.filter((s) => !isStale(s, today));
  const stale = series.filter((s) => isStale(s, today));

  /* What it did NOT claim: payees with enough hits to look recurring that the
     cadence test threw out. This is where false negatives hide.
     Payees that DID yield a series are marked, because otherwise the list
     lies: the ad-hoc $20 and $74 Zelles to the same person legitimately go
     unclaimed even when the $412 fortnightly series was found perfectly, and
     seeing the payee here reads as a miss when nothing was missed. */
  const rejected = useMemo(() => {
    const claimed = new Set(series.flatMap((s) => s.txnIds));
    const payeesWithSeries = new Set(
      series.map((s) => normalisePayee(s.payee)),
    );
    const by = new Map<string, { hits: number; total: number; label: string; partial: boolean }>();
    for (const t of scoped) {
      if (claimed.has(t.id) || t.amount >= 0) continue;
      const k = normalisePayee(t.merchant || t.description);
      if (!k) continue;
      const e =
        by.get(k) ??
        { hits: 0, total: 0, label: displayPayee(t.merchant || t.description), partial: payeesWithSeries.has(k) };
      e.hits++;
      e.total += Math.abs(t.amount);
      by.set(k, e);
    }
    return [...by.values()].filter((e) => e.hits >= 3).sort((a, b) => b.total - a.total);
  }, [scoped, series]);

  const monthlyFixed = live
    .filter((s) => s.direction === "out")
    .reduce((sum, s) => sum + (s.amount * 365.25) / 12 / s.periodDays, 0);

  return (
    <main className="p-4 space-y-5 pb-24">
      <div>
        <h1 className="font-figure text-xl font-bold" style={{ color: "var(--color-text)" }}>
          Detector dry run
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--color-muted)" }}>
          Checking accounts only — the scope screen 1 will use. Reads only;
          nothing is saved and v1 is untouched.
        </p>
        <div className="flex gap-2 mt-3">
          {[6, 12, 24].map((m) => (
            <button
              key={m}
              onClick={() => setMonths(m)}
              className="text-xs px-3 py-1.5 rounded-lg border"
              style={{
                borderColor: months === m ? "var(--color-primary)" : "var(--color-hairline)",
                color: months === m ? "var(--color-primary)" : "var(--color-muted)",
              }}
            >
              {m} months
            </button>
          ))}
        </div>
      </div>

      {isLoading && (
        <p className="text-sm" style={{ color: "var(--color-faint)" }}>
          Loading {scoped.length} transactions…
        </p>
      )}

      <Card className="p-4">
        <p className="text-sm" style={{ color: "var(--color-muted)" }}>
          From {scoped.length} transactions it found{" "}
          <span style={{ color: "var(--color-text)" }}>{live.length} live series</span>
          {stale.length > 0 && <> and {stale.length} that look retired</>}.
        </p>
        <p className="font-figure text-2xl font-bold mt-2" style={{ color: "var(--color-text)" }}>
          {fmt0(monthlyFixed)}
          <span className="text-sm font-normal" style={{ color: "var(--color-muted)" }}>
            {" "}/ month in fixed costs
          </span>
        </p>
      </Card>

      <Section title="Found" subtitle="what the detector would treat as recurring">
        {live.map((s) => (
          <Row key={s.key} s={s} />
        ))}
      </Section>

      {stale.length > 0 && (
        <Section title="Looks retired" subtitle="overdue by more than a cycle — these fade out on their own">
          {stale.map((s) => (
            <Row key={s.key} s={s} stale />
          ))}
        </Section>
      )}

      <Section
        title="Not claimed"
        subtitle="3+ outflows at one payee with no series. &quot;leftovers&quot; means a series WAS found at that payee and these are the one-offs around it"
      >
        {rejected.map((r) => (
          <div key={r.label} className="flex items-center justify-between px-3 py-2">
            <span className="text-sm truncate" style={{ color: "var(--color-text)" }}>
              {r.label}
            </span>
            <span className="text-xs shrink-0" style={{ color: "var(--color-faint)" }}>
              {r.partial && <span style={{ color: "var(--color-primary)" }}>leftovers · </span>}
              {r.hits}× · {fmt0(r.total)}
            </span>
          </div>
        ))}
      </Section>
    </main>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          {title}
        </h2>
        <p className="text-xs" style={{ color: "var(--color-muted)" }}>
          {subtitle}
        </p>
      </div>
      <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
        {children}
      </Card>
    </section>
  );
}

function Row({ s, stale }: { s: ReturnType<typeof detectSeries>[number]; stale?: boolean }) {
  return (
    <div className="px-3 py-2.5" style={{ opacity: stale ? 0.5 : 1 }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm truncate" style={{ color: "var(--color-text)" }}>
          {s.payee}
        </span>
        <span
          className="font-figure text-sm shrink-0"
          style={{ color: s.direction === "in" ? "var(--color-positive)" : "var(--color-text)" }}
        >
          {s.direction === "in" ? "+" : ""}
          {fmt(s.amount)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3 mt-0.5">
        <span className="text-xs" style={{ color: "var(--color-faint)" }}>
          {CADENCE_LABEL[s.cadence]} · {s.hits}× · next {shortDate(s.nextDue)}
          {s.amountSpread > 0.08 && <> · varies ±{Math.round(s.amountSpread * 100)}%</>}
        </span>
        <span className="text-xs shrink-0" style={{ color: "var(--color-faint)" }}>
          {Math.round(s.confidence * 100)}%
        </span>
      </div>
    </div>
  );
}
