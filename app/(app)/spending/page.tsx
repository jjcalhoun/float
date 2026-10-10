"use client";

/* Screen 2. Where it went.
 *
 * Screen 1 says what you can spend. This answers the question you ask about
 * two seconds later — why is that lower than I thought — and it answers it
 * with a list of merchants rather than a budget. No targets, no categories to
 * keep up to date, no months: a rolling window, largest first.
 *
 * The arithmetic is in lib/v2/spending.ts, including why cards count here and
 * deliberately do not on screen 1.
 */

import { useMemo, useState } from "react";
import { useAccounts, useTransactions } from "@/hooks/useSupabaseData";
import { useRecurringPayees } from "@/hooks/useRecurringPayees";
import { useSimplefinMappings } from "@/hooks/useSimplefin";
import { useTxnWindow } from "@/components/providers";
import { summariseSpending, type SpendGroup, type SpendTxn } from "@/lib/v2/spending";
import { spendAccounts, isGenerated } from "@/lib/v2/scope";
import { fmt, fmt0, shortDate } from "@/lib/format";
import { todayISO } from "@/lib/dates";
import { Card } from "@/components/ui/Card";
import Link from "next/link";

const WINDOWS = [30, 90] as const;

export default function SpendingScreen() {
  const { data: accounts = [], isLoading: la } = useAccounts();
  const { data: transactions = [], isLoading: lt } = useTransactions();
  const { data: decisions = {} } = useRecurringPayees();
  const { data: mappings = [] } = useSimplefinMappings();
  const { ensureSince } = useTxnWindow();
  const [days, setDays] = useState<number>(30);
  const today = todayISO();

  useMemo(() => {
    const since = new Date();
    since.setMonth(since.getMonth() - 6);
    ensureSince(since.toISOString().slice(0, 10));
  }, [ensureSince]);

  // Synced checking and synced cards. The rule lives in lib/v2/scope.ts.
  const scopeAccounts = useMemo(() => spendAccounts(accounts, mappings), [accounts, mappings]);
  const accountIds = useMemo(
    () => new Set(scopeAccounts.map((a) => a.id)),
    [scopeAccounts],
  );

  const fixedKeys = useMemo(
    () =>
      new Set(
        Object.values(decisions)
          .filter((d) => d?.decision === "fixed")
          .map((d) => d!.payee_key),
      ),
    [decisions],
  );

  const txns: SpendTxn[] = useMemo(
    () =>
      transactions
        /* Rows the app generated for itself are not purchases. Interest is
           one of them and I left it out of this list: it is a charge the app
           posted against a loan, not money you spent at a merchant, and the
           other two v2 screens have excluded it from the start. */
        .filter((t) => !isGenerated(t.source))
        .map((t) => ({
          id: t.id,
          date: t.date,
          amount: t.amount,
          merchant: t.merchant,
          description: t.description,
          account_id: t.account_id,
          type: t.type,
          transfer_account_id: t.transfer_account_id,
        })),
    [transactions],
  );

  const r = useMemo(
    () => summariseSpending({ txns, accountIds, fixedKeys, today, days }),
    [txns, accountIds, fixedKeys, today, days],
  );

  const loading = la || lt;

  return (
    <main className="p-4 space-y-5 pb-24">
      <section className="text-center py-5">
        <p className="text-sm" style={{ color: "var(--color-muted)" }}>
          spent in the last {days} days
        </p>
        <p
          className="font-figure text-[44px] font-bold leading-none my-1"
          style={{ color: "var(--color-text)" }}
        >
          {loading ? "—" : fmt0(r.total)}
        </p>
        {/* 30 and 90 are not comparable until one of them is rescaled. */}
        {days !== 30 && (
          <p className="text-sm" style={{ color: "var(--color-muted)" }}>
            {fmt0(r.perMonth)} a month
          </p>
        )}
        <div className="inline-flex mt-3 rounded-lg overflow-hidden border" style={{ borderColor: "var(--color-hairline)" }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              onClick={() => setDays(w)}
              className="px-3 py-1.5 text-xs font-semibold"
              style={
                days === w
                  ? { background: "var(--color-primary)", color: "#fff" }
                  : { color: "var(--color-muted)" }
              }
            >
              {w} days
            </button>
          ))}
        </div>
      </section>

      <Card className="p-4 space-y-2">
        <Split label="Fixed" value={r.fixedTotal} total={r.total} />
        <Split label="Everyday" value={r.everydayTotal} total={r.total} />
        <p className="text-xs pt-1" style={{ color: "var(--color-faint)" }}>
          {scopeAccounts.length === 0
            ? "No accounts in scope yet."
            : `Includes card purchases. Reading ${scopeAccounts.map((a) => a.name).join(", ")}.`}
        </p>
      </Card>

      <Section
        title="Everyday"
        subtitle="the part you can change"
        groups={r.everyday}
        empty="Nothing in this window."
      />

      <Section
        title="Fixed"
        subtitle={
          r.fixed.length === 0
            ? "merchants you keep on the Recurring screen show up here"
            : "the bills you kept — same every month, listed apart"
        }
        groups={r.fixed}
        empty="Nothing kept yet."
      />

      <div className="flex justify-center gap-4 text-xs">
        <Link href="/float" style={{ color: "var(--color-primary)" }}>
          Safe to spend
        </Link>
        <Link href="/lab" style={{ color: "var(--color-primary)" }}>
          Edit recurring
        </Link>
      </div>
    </main>
  );
}

function Split({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm" style={{ color: "var(--color-muted)" }}>
        {label}
        <span className="text-xs" style={{ color: "var(--color-faint)" }}>
          {" "}· {pct}%
        </span>
      </span>
      <span className="font-figure text-sm" style={{ color: "var(--color-text)" }}>
        {fmt0(value)}
      </span>
    </div>
  );
}

function Section({
  title,
  subtitle,
  groups,
  empty,
}: {
  title: string;
  subtitle: string;
  groups: SpendGroup[];
  empty: string;
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
        {groups.length === 0 ? (
          <p className="px-3 py-4 text-sm" style={{ color: "var(--color-faint)" }}>
            {empty}
          </p>
        ) : (
          groups.map((g) => <MerchantRow key={g.key} g={g} />)
        )}
      </Card>
    </section>
  );
}

/* Tap to see the individual charges.
   A merchant total is the useful unit nine times in ten, but the tenth time
   the question is "$340 at Amazon in HOW many orders" — and an answer that
   cannot be opened is one you have to go and verify somewhere else. */
function MerchantRow({ g }: { g: SpendGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-3 py-2.5 flex items-center gap-3 text-left"
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm truncate" style={{ color: "var(--color-text)" }}>
            {g.label}
          </p>
          <p className="text-xs" style={{ color: "var(--color-faint)" }}>
            {g.count}× · last {shortDate(g.lastDate)}
          </p>
        </div>
        <span className="font-figure text-sm shrink-0" style={{ color: "var(--color-text)" }}>
          {fmt0(g.total)}
        </span>
        <span
          className="material-symbols-outlined shrink-0"
          style={{ fontSize: 18, color: "var(--color-faint)" }}
        >
          {open ? "expand_less" : "expand_more"}
        </span>
      </button>
      {open && (
        <div className="pb-2">
          {g.txns.map((t) => (
            <div key={t.id} className="px-3 py-1 flex items-baseline justify-between gap-3">
              <span className="text-xs truncate" style={{ color: "var(--color-muted)" }}>
                {shortDate(t.date)} · {t.merchant || t.description}
              </span>
              <span
                className="font-figure text-xs shrink-0"
                style={{
                  color: t.amount > 0 ? "var(--color-positive)" : "var(--color-muted)",
                }}
              >
                {t.amount > 0 ? `+${fmt(t.amount)}` : fmt(-t.amount)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
