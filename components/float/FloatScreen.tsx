"use client";

/* Screen 1. The number.
 *
 * "How much can I spend right now." Not for the month, not against a plan:
 * what the bank says is there, less what must leave before the next paycheck,
 * less the floor and whatever you mean to pay the card.
 *
 * There are no months in it. The arithmetic lives in lib/v2/safeToSpend.ts.
 */

import { useMemo, useState } from "react";
import {
  useAccounts,
  useTransactions,
  useSettings,
  useUpdateSettings,
  useAccountBalances,
} from "@/hooks/useSupabaseData";
import { useRecurringPayees } from "@/hooks/useRecurringPayees";
import { useSimplefinMappings } from "@/hooks/useSimplefin";
import { cashAccounts, isGenerated } from "@/lib/v2/scope";
import { useTxnWindow } from "@/components/providers";
import { detectSeries, SUGGEST, type Series, type Txn } from "@/lib/v2/recurring";
import { normalisePayee } from "@/lib/v2/payee";
import { safeToSpend } from "@/lib/v2/safeToSpend";
import { applyOverrides } from "@/lib/v2/overrides";
import { spendableBalance } from "@/lib/v2/balance";
import { fmt, fmt0, shortDate } from "@/lib/format";
import { todayISO } from "@/lib/dates";
import { Card } from "@/components/ui/Card";
import Link from "next/link";

export function FloatScreen() {
  const { data: accounts = [], isLoading: la } = useAccounts();
  const { data: transactions = [], isLoading: lt } = useTransactions();
  const { data: decisions = {} } = useRecurringPayees();
  const { data: mappings = [] } = useSimplefinMappings();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { ensureSince } = useTxnWindow();
  const today = todayISO();

  useMemo(() => {
    const since = new Date();
    since.setMonth(since.getMonth() - 24);
    ensureSince(since.toISOString().slice(0, 10));
  }, [ensureSince]);

  const spendingAccounts = useMemo(() => cashAccounts(accounts, mappings), [accounts, mappings]);

  /* Which balance to believe, and what to call it: lib/v2/balance.ts.
     Short version — available, not posted, because Chase's app shows
     available and a number that disagrees with the bank app is worth
     nothing however it was derived. */
  const { data: computed = {} } = useAccountBalances();
  const { total: balance, source, pending } = spendableBalance(spendingAccounts, computed);
  const balanceAt = spendingAccounts
    .map((a) => a.live_balance_at)
    .filter(Boolean)
    .sort()[0];

  const cards = useMemo(() => accounts.filter((a) => a.type === "credit"), [accounts]);
  const cardOwed = cards.reduce((s, a) => s + Math.max(0, -Number(a.live_balance ?? 0)), 0);

  const scoped: Txn[] = useMemo(() => {
    const ids = new Set(spendingAccounts.map((a) => a.id));
    return transactions
      .filter((t) => !isGenerated(t.source))
      .filter((t) => ids.has(t.account_id))
      .map((t) => ({
        id: t.id,
        date: t.date,
        amount: t.amount,
        merchant: t.merchant,
        description: t.description,
      }));
  }, [transactions, spendingAccounts]);

  // Only what you kept. A suggestion nobody acted on is not an obligation.
  const kept = useMemo(
    () =>
      applyOverrides(
        detectSeries(scoped, SUGGEST).filter(
          (s) => decisions[normalisePayee(s.payee)]?.decision === "fixed",
        ),
        decisions,
        (s) => normalisePayee(s.payee),
      ),
    [scoped, decisions],
  );

  const floor = Number(settings?.v2_floor ?? 0);
  const cardPayment = Number(settings?.v2_card_payment ?? 0);
  const r = safeToSpend({ balance, kept, today, floor, cardPayment });

  const asOf = balanceAt ? ` as of ${shortDate(balanceAt.slice(0, 10))}` : "";
  const loading = la || lt;

  return (
    <main className="p-4 space-y-5 pb-24">
      <section className="text-center py-6">
        <p className="text-sm" style={{ color: "var(--color-muted)" }}>
          safe to spend
        </p>
        <p
          className="font-figure text-[52px] font-bold leading-none my-1"
          style={{ color: r.safe < 0 ? "var(--color-danger)" : "var(--color-text)" }}
        >
          {loading ? "—" : fmt0(r.safe)}
        </p>
        <p className="text-sm" style={{ color: "var(--color-muted)" }}>
          {r.horizon ? `until ${shortDate(r.horizon)}` : "for the next two weeks"}
        </p>
      </section>

      <Card className="p-4 space-y-2">
        <Line label={spendingAccounts.map((a) => a.name).join(" + ") || "No synced checking"} value={balance} />
        <Line label="due before then" value={-r.dueTotal} />
        {cardPayment > 0 && <Line label="card payment" value={-cardPayment} />}
        {floor > 0 && <Line label="floor" value={-floor} dim />}
        <p className="text-xs pt-1" style={{ color: "var(--color-faint)" }}>
          {source === "computed"
            ? "computed from transactions — no live figure from the bank yet"
            : source === "posted"
              ? `posted balance${asOf} — this bank publishes no available balance, so pending charges are not deducted`
              : `available balance${asOf}${pending > 0.005 ? ` · ${fmt0(pending)} pending` : ""}`}
        </p>
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <p className="text-sm" style={{ color: "var(--color-text)" }}>
            Credit cards
          </p>
          <p className="font-figure text-sm" style={{ color: "var(--color-text)" }}>
            {fmt(cardOwed)} owed
          </p>
        </div>
        {/* The detector cannot help here — 11 payments averaging $659 with a
            $370 spread is a decision, not a rhythm — so it is simply asked. */}
        <Field
          label="paying this cycle"
          value={cardPayment}
          onSave={(v) => updateSettings.mutate({ v2_card_payment: v })}
        />
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          Coming up
        </h2>
        <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
          {r.due.length === 0 ? (
            <p className="px-3 py-4 text-sm" style={{ color: "var(--color-faint)" }}>
              {kept.length === 0 ? (
                <>
                  Nothing kept yet — <Link href="/lab" style={{ color: "var(--color-primary)" }}>pick your bills</Link>.
                </>
              ) : (
                "Nothing due before then."
              )}
            </p>
          ) : (
            r.due.map((d) => (
              <div key={d.key} className="px-3 py-2.5 flex items-center justify-between gap-3">
                <span className="text-sm truncate" style={{ color: "var(--color-text)" }}>
                  {d.payee}
                </span>
                <span className="text-xs shrink-0" style={{ color: "var(--color-faint)" }}>
                  {shortDate(d.date)}
                </span>
                <span className="font-figure text-sm shrink-0" style={{ color: "var(--color-text)" }}>
                  {fmt(d.amount)}
                </span>
              </div>
            ))
          )}
        </Card>
        {/* "Safe until the 31st" invites spending it all on the 30th. */}
        {r.soonAfterTotal > 0 && (
          <p className="text-xs" style={{ color: "var(--color-muted)" }}>
            then {fmt0(r.soonAfterTotal)} in the week after
          </p>
        )}
      </section>

      <Card className="p-4">
        <Field
          label="never go below"
          value={floor}
          onSave={(v) => updateSettings.mutate({ v2_floor: v })}
        />
      </Card>

      <div className="flex justify-center gap-4 text-xs">
        <Link href="/spending" style={{ color: "var(--color-primary)" }}>
          Where it went
        </Link>
        <Link href="/lab" style={{ color: "var(--color-primary)" }}>
          Edit recurring
        </Link>
      </div>
    </main>
  );
}

function Line({ label, value, dim }: { label: string; value: number; dim?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3" style={{ opacity: dim ? 0.7 : 1 }}>
      <span className="text-sm truncate" style={{ color: "var(--color-muted)" }}>
        {label}
      </span>
      <span className="font-figure text-sm shrink-0" style={{ color: "var(--color-text)" }}>
        {value < 0 ? `− ${fmt0(-value)}` : fmt0(value)}
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  onSave,
}: {
  label: string;
  value: number;
  onSave: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);

  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-sm" style={{ color: "var(--color-muted)" }}>
        {label}
      </span>
      <span className="flex items-baseline gap-1">
        <span style={{ color: "var(--color-muted)" }}>$</span>
        <input
          inputMode="decimal"
          value={editing ? draft : String(value)}
          onFocus={() => {
            setDraft(String(value));
            setEditing(true);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            setEditing(false);
            const n = Number(draft);
            if (Number.isFinite(n) && n >= 0 && n !== value) onSave(n);
          }}
          className="w-24 text-right rounded-lg px-2 py-1 text-sm outline-none border font-figure"
          style={{
            background: "var(--color-elevated)",
            color: "var(--color-text)",
            borderColor: "var(--color-hairline)",
          }}
        />
      </span>
    </label>
  );
}
