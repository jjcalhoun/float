"use client";

import { useMemo, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { projectDebt, type ProjDebt } from "@/lib/debtProjection";
import type { DebtStrategy } from "@/lib/debt";
import type { Account, Settings } from "@/lib/types";
import { fmt0 } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { useSetAccountMinPayment, useUpdateSettings, useCategories } from "@/hooks/useSupabaseData";
import { minPayment as estMinPayment, debtPayment } from "@/lib/debt";

// Recharts is heavy — load the charts only after the rest of the tab paints.
const DebtCharts = dynamic(() => import("@/components/debt/DebtCharts"), {
  ssr: false,
  loading: () => (
    <Card className="p-3 flex items-center justify-center" style={{ height: 240 }}>
      <span className="text-xs" style={{ color: "var(--color-faint)" }}>Loading charts…</span>
    </Card>
  ),
});

const DEBT_COLORS = ["#EF4444", "#3B82F6", "#EAB308", "#8B5CF6", "#14B8A6", "#F97316", "#EC4899"];

function monthsLabel(m: number): string {
  const y = Math.floor(m / 12);
  const r = m % 12;
  return y === 0 ? `${r}m` : r === 0 ? `${y}y` : `${y}y ${r}m`;
}

interface Props {
  liabilityAccounts: Account[]; // credit/loan with balance owed
  debtBalances: Record<string, number>; // account_id → owed (positive)
  strategy: DebtStrategy;
  avgNet3: number; // 3-month average net available (default surplus)
  startChecking: number;
  startSavings: number;
  settings: Settings | null | undefined;
}

export function DebtPlanner({
  liabilityAccounts,
  debtBalances,
  strategy,
  avgNet3,
  startChecking,
  startSavings,
  settings,
}: Props) {
  const setMin = useSetAccountMinPayment();
  const updateSettings = useUpdateSettings();

  // planner inputs (hydrated from settings)
  const [surplus, setSurplus] = useState("");
  const [extra, setExtra] = useState("");
  const [invBal, setInvBal] = useState("0");
  const [invRet, setInvRet] = useState("0");
  const [savingsPct, setSavingsPct] = useState(20);
  const [investPct, setInvestPct] = useState(0);
  useEffect(() => {
    if (!settings) return;
    setSurplus(settings.debt_surplus != null ? String(settings.debt_surplus) : String(Math.round(avgNet3)));
    setExtra(settings.debt_extra ? String(settings.debt_extra) : "");
    setInvBal(String(settings.investments_balance ?? 0));
    setInvRet(String(settings.investments_return ?? 0));
    setSavingsPct(settings.surplus_savings_pct ?? 20);
    setInvestPct(settings.surplus_investments_pct ?? 0);
  }, [settings, avgNet3]);
  const extraDebtPct = Math.max(0, 100 - savingsPct - investPct);

  const monthlySurplus = (parseFloat(surplus) || 0) + (parseFloat(extra) || 0);

  const debts: ProjDebt[] = useMemo(
    () =>
      liabilityAccounts.map((a) => ({
        id: a.id,
        name: a.name,
        balance: debtBalances[a.id] ?? 0,
        apr: a.apr,
        minPayment: debtPayment(a, debtBalances[a.id] ?? 0),
      })),
    [liabilityAccounts, debtBalances],
  );

  const projection = useMemo(
    () =>
      projectDebt({
        debts,
        strategy,
        monthlySurplus,
        savingsPct,
        investmentsPct: investPct,
        startChecking,
        startSavings,
        startInvestments: parseFloat(invBal) || 0,
        investReturnPct: parseFloat(invRet) || 0,
      }),
    [debts, strategy, monthlySurplus, savingsPct, investPct, startChecking, startSavings, invBal, invRet],
  );

  const debtChartData = useMemo(
    () =>
      projection.points.map((p) => {
        const row: Record<string, number> = { month: p.month };
        for (const d of debts) row[d.name] = p.debt[d.id] ?? 0;
        return row;
      }),
    [projection, debts],
  );

  const netWorthData = useMemo(
    () =>
      projection.points.map((p) => ({
        month: p.month,
        Checking: p.checking,
        Savings: p.savings,
        Investments: p.investments,
        "Total debt": p.totalDebt,
        "Net worth": p.netWorth,
      })),
    [projection],
  );

  const persistSplit = (s: number, i: number) =>
    updateSettings.mutate({ surplus_savings_pct: s, surplus_investments_pct: i });

  return (
    <div className="space-y-5">
      {/* Surplus allocation + payoff timeline, side by side on desktop */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start space-y-5 lg:space-y-0">
      {/* Surplus + allocation */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>Surplus allocation</h2>
        <Card className="p-4 space-y-3">
          <div className="flex gap-3">
            <div className="flex-1">
              <Input
                label="Monthly surplus"
                inputMode="decimal"
                value={surplus}
                onChange={(e) => setSurplus(e.target.value)}
                onBlur={() => updateSettings.mutate({ debt_surplus: parseFloat(surplus) || 0 })}
              />
            </div>
            <div className="flex-1">
              <Input
                label="Extra payment / mo"
                inputMode="decimal"
                placeholder="0"
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                onBlur={() => updateSettings.mutate({ debt_extra: parseFloat(extra) || 0 })}
              />
            </div>
          </div>
          <p className="text-xs" style={{ color: "var(--color-faint)" }}>
            Allocating {fmt0(monthlySurplus)}/mo — your surplus (defaults to the
            3-month average net above) plus any extra payment.
          </p>

          <SplitSlider
            label="To savings"
            value={savingsPct}
            color="#16A34A"
            onChange={(v) => setSavingsPct(Math.min(v, 100 - investPct))}
            onCommit={() => persistSplit(savingsPct, investPct)}
          />
          <SplitSlider
            label="To investments"
            value={investPct}
            color="#8B5CF6"
            onChange={(v) => setInvestPct(Math.min(v, 100 - savingsPct))}
            onCommit={() => persistSplit(savingsPct, investPct)}
          />
          <div className="flex items-center justify-between">
            <span className="text-sm" style={{ color: "var(--color-text)" }}>To extra debt</span>
            <span className="text-sm font-figure font-bold" style={{ color: "var(--color-text)" }}>{extraDebtPct}%</span>
          </div>
          <div className="flex h-7 rounded-lg overflow-hidden text-[11px] font-semibold text-white">
            {savingsPct > 0 && <div className="flex items-center justify-center" style={{ width: `${savingsPct}%`, background: "#16A34A" }}>{savingsPct}%</div>}
            {investPct > 0 && <div className="flex items-center justify-center" style={{ width: `${investPct}%`, background: "#8B5CF6" }}>{investPct}%</div>}
            {extraDebtPct > 0 && <div className="flex items-center justify-center" style={{ width: `${extraDebtPct}%`, background: "#EF4444" }}>{extraDebtPct}%</div>}
          </div>
          <p className="text-xs leading-relaxed" style={{ color: "var(--color-faint)" }}>
            Freed-up minimums roll into the next-highest-APR debt. Your savings &amp;
            investing percentages keep flowing, and once debt-free the freed money
            redirects to savings.
          </p>
        </Card>
      </section>

      {/* Payoff timeline */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
            Payoff timeline
          </h2>
          <span className="text-xs" style={{ color: "var(--color-faint)" }}>
            debt-free in {monthsLabel(projection.debtFreeMonth)}
          </span>
        </div>
        <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
          {projection.order.map((d, i) => (
            <div key={d.id} className="flex items-center justify-between px-4 py-3">
              <div className="flex items-center gap-3">
                <span
                  className="flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold"
                  style={{ background: `${DEBT_COLORS[i % DEBT_COLORS.length]}22`, color: DEBT_COLORS[i % DEBT_COLORS.length] }}
                >
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium" style={{ color: "var(--color-text)" }}>{d.name}</p>
                  <p className="text-xs" style={{ color: "var(--color-faint)" }}>
                    {d.apr}% APR · {fmt0(d.balance)}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-figure" style={{ color: "var(--color-text)" }}>Month {d.monthsToClear}</p>
                <p className="text-xs" style={{ color: "var(--color-muted)" }}>{monthsLabel(d.monthsToClear)}</p>
              </div>
            </div>
          ))}
        </Card>
      </section>
      </div>{/* surplus + timeline grid */}

      {/* Projection charts (Recharts, lazy-loaded) */}
      <DebtCharts
        debtChartData={debtChartData}
        netWorthData={netWorthData}
        debts={debts.map((d) => ({ id: d.id, name: d.name }))}
        colors={DEBT_COLORS}
      />

      {/* Debts — editable minimum payment */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>Debts</h2>
        <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
          {liabilityAccounts.map((a) => (
            <MinPaymentRow
              key={a.id}
              account={a}
              owed={debtBalances[a.id] ?? 0}
              onSave={(terms) => setMin.mutate({ id: a.id, ...terms })}
            />
          ))}
        </Card>
        <p className="text-xs" style={{ color: "var(--color-faint)" }}>
          Edit balances &amp; APR in account settings. Blank min uses a 2% estimate;{" "}
          “I pay” overrides it in the payoff math. Escrow leaves your account but
          never touches the balance.
        </p>
      </section>
    </div>
  );
}

function MinPaymentRow({
  account,
  owed,
  onSave,
}: {
  account: Account;
  owed: number;
  onSave: (terms: {
    min_payment?: number | null;
    monthly_payment?: number | null;
    escrow_amount?: number | null;
    escrow_category_id?: string | null;
  }) => void;
}) {
  const { data: categories = [] } = useCategories();
  // Escrow is really a mortgage thing — a HELOC, student loan or card doesn't
  // have one, and the app has no way to tell a mortgage from any other loan.
  // So the field appears only where it's already in use, with a way to add it
  // on the loans that need it. Cards never offer it.
  const [addingEscrow, setAddingEscrow] = useState(false);
  const hasEscrow = (account.escrow_amount ?? 0) > 0;
  const canEscrow = account.type === "loan";
  const showEscrow = canEscrow && (hasEscrow || addingEscrow);
  const paydown = debtPayment(account, owed);
  const gross = account.monthly_payment ?? account.min_payment ?? estMinPayment(owed);

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium truncate" style={{ color: "var(--color-text)" }}>
          {account.name}
        </p>
        <p className="text-xs shrink-0" style={{ color: "var(--color-faint)" }}>
          {account.apr}% APR · {fmt0(owed)}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <TermField
          label="min"
          value={account.min_payment}
          placeholder={fmt0(estMinPayment(owed)).replace("$", "")}
          onSave={(v) => onSave({ min_payment: v })}
        />
        <TermField
          label="I pay"
          value={account.monthly_payment}
          placeholder={account.min_payment != null ? String(account.min_payment) : "—"}
          onSave={(v) => onSave({ monthly_payment: v })}
        />
        {showEscrow && (
          <TermField
            label="escrow"
            value={account.escrow_amount || null}
            placeholder="0"
            autoFocus={addingEscrow && !hasEscrow}
            onSave={(v) => onSave({ escrow_amount: v ?? 0 })}
          />
        )}
        {canEscrow && !showEscrow && (
          <button
            onClick={() => setAddingEscrow(true)}
            className="text-xs font-semibold pb-2"
            style={{ color: "var(--color-primary)" }}
          >
            + escrow
          </button>
        )}
      </div>

      {hasEscrow && (
        <>
          <p className="text-xs" style={{ color: "var(--color-faint)" }}>
            {fmt0(gross)} paid, {fmt0(account.escrow_amount ?? 0)} to escrow —{" "}
            <span style={{ color: "var(--color-text)" }}>{fmt0(paydown)}</span> against the balance
          </p>
          {/* Escrow posts monthly on its own and never counts as spending, so
              this only decides which category it SHOWS under. Left unset it
              posts uncategorised, as it always did. */}
          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-faint)" }}>
            <span className="shrink-0">shows under</span>
            <select
              value={account.escrow_category_id ?? ""}
              onChange={(e) => onSave({ escrow_category_id: e.target.value || null })}
              className="flex-1 min-w-0 rounded-lg px-2 py-1 text-xs outline-none border"
              style={{
                background: "var(--color-elevated)",
                color: "var(--color-text)",
                borderColor: "var(--color-hairline)",
              }}
            >
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

function TermField({
  label,
  value,
  placeholder,
  autoFocus,
  onSave,
}: {
  label: string;
  value?: number | null;
  placeholder: string;
  autoFocus?: boolean;
  onSave: (v: number | null) => void;
}) {
  const [val, setVal] = useState(value != null ? String(value) : "");
  useEffect(() => {
    setVal(value != null ? String(value) : "");
  }, [value]);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-faint)" }}>
        {label}
      </span>
      <input
        inputMode="decimal"
        autoFocus={autoFocus}
        aria-label={label}
        placeholder={placeholder}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => onSave(val === "" ? null : parseFloat(val) || null)}
        className="w-20 text-right px-2 py-1.5 rounded-lg text-sm font-figure outline-none border"
        style={{
          background: "var(--color-elevated)",
          color: "var(--color-text)",
          borderColor: "var(--color-hairline)",
        }}
      />
    </label>
  );
}

function SplitSlider({
  label,
  value,
  color,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  color: string;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm w-28" style={{ color: "var(--color-text)" }}>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="flex-1"
        style={{ accentColor: color }}
      />
      <span className="text-sm font-figure font-bold w-10 text-right" style={{ color: "var(--color-text)" }}>{value}%</span>
    </div>
  );
}
