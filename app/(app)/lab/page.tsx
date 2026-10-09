"use client";

/* Which merchants are fixed costs — the list screen 1 will draw its outflows
 * from.
 *
 * The detector proposes and you decide. Nothing here is a fixed cost until
 * you tick it, which is what keeps three tidy grocery runs out of your
 * obligations and lets the suggestions be generous: an untouched row costs
 * nothing, so it can afford to be only half sure.
 *
 * Amounts and cadences stay inferred. You are classifying merchants, never
 * typing figures — so when child support moves from $412 fortnightly to $231
 * weekly, the tick stays put and the numbers follow on their own.
 */

import { useMemo, useState } from "react";
import { useTransactions, useAccounts } from "@/hooks/useSupabaseData";
import { useRecurringPayees, useSetRecurringPayee } from "@/hooks/useRecurringPayees";
import { useSimplefinMappings } from "@/hooks/useSimplefin";
import { useTxnWindow } from "@/components/providers";
import { detectSeries, isStale, SUGGEST, type Series, type Txn } from "@/lib/v2/recurring";
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

export default function RecurringLab() {
  const { data: transactions = [], isLoading } = useTransactions();
  const { data: accounts = [] } = useAccounts();
  const { data: decisions = {} } = useRecurringPayees();
  const setDecision = useSetRecurringPayee();
  const { ensureSince } = useTxnWindow();
  const [showDismissed, setShowDismissed] = useState(false);
  const today = todayISO();

  useMemo(() => {
    const since = new Date();
    since.setMonth(since.getMonth() - 24);
    ensureSince(since.toISOString().slice(0, 10));
  }, [ensureSince]);

  /* Checking accounts the bank feed actually covers.
   *
   * "Every checking account" was wrong, and it showed: the HELOC payment and
   * the Earnest student loan are paid from IUCU, which is out of scope
   * entirely — v2 is about what SimpleFIN sees at Chase. Scoping by account
   * TYPE quietly dragged a whole second bank back in, and the suggestions
   * list filled with obligations that have nothing to do with the number
   * screen 1 is meant to produce.
   *
   * Requiring a SimpleFIN mapping says the same thing in the app's own terms:
   * if the feed does not cover it, this cannot reason about it. */
  const { data: mappings = [] } = useSimplefinMappings();
  const syncedIds = useMemo(() => new Set(mappings.map((m) => m.account_id)), [mappings]);
  const spendingAccounts = useMemo(
    () => accounts.filter((a) => a.type === "checking" && syncedIds.has(a.id)),
    [accounts, syncedIds],
  );
  const spending = useMemo(
    () => new Set(spendingAccounts.map((a) => a.id)),
    [spendingAccounts],
  );
  const creditIds = useMemo(
    () => new Set(accounts.filter((a) => a.type === "credit").map((a) => a.id)),
    [accounts],
  );

  const scoped: Txn[] = useMemo(
    () =>
      transactions
        /* Not what the app wrote for itself.
           The IUCU payday allocation showed up as detected income, and it is
           not a deposit — ADP splits the pay at source, so that money never
           touches this account. It is a row v1 generated.
           A blacklist of generated sources rather than a whitelist of 'sync':
           manual and imported rows are real money the user put in, and
           excluding them would quietly blind the detector to anything not on
           the feed. If something generated still slips through, it is one
           "Not a bill" tap away — which is rather the point of the list. */
        .filter((t) => !["recurring", "escrow", "interest"].includes(t.source))
        .filter((t) => spending.size === 0 || spending.has(t.account_id))
        /* A card payment is regular money that is already answered: screen 1
           shows the balance and takes the payment you intend to make. Offering
           "Chase Credit Card, monthly, $658" as a fixed cost would be a second
           and worse answer to a settled question, so it is never suggested. */
        .filter((t) => !(t.transfer_account_id && creditIds.has(t.transfer_account_id)))
        .map((t) => ({
          id: t.id,
          date: t.date,
          amount: t.amount,
          merchant: t.merchant,
          description: t.description,
        })),
    [transactions, spending, creditIds],
  );

  const series = useMemo(() => detectSeries(scoped, SUGGEST), [scoped]);

  /* Income is kept apart from bills throughout.
     They do different jobs: bills are subtracted from the balance, while
     income sets the HORIZON — "safe to spend until the next ADP deposit" —
     so mixing them in one list invites exactly the confusion of treating a
     paycheck as a fixed cost. */
  const { fixed, suggested, dismissed } = useMemo(() => {
    const fixed: Series[] = [];
    const suggested: Series[] = [];
    const dismissed: Series[] = [];
    for (const s of series) {
      const d = decisions[normalisePayee(s.payee)]?.decision;
      if (d === "fixed") fixed.push(s);
      else if (d === "dismissed") dismissed.push(s);
      else if (!isStale(s, today)) suggested.push(s);
    }
    return { fixed, suggested, dismissed };
  }, [series, decisions, today]);

  const out = (xs: Series[]) => xs.filter((s) => s.direction === "out");
  const inc = (xs: Series[]) => xs.filter((s) => s.direction === "in");

  const monthly = fixed
    .filter((s) => s.direction === "out")
    .reduce((sum, s) => sum + (s.amount * 365.25) / 12 / s.periodDays, 0);
  const monthlyIn = fixed
    .filter((s) => s.direction === "in")
    .reduce((sum, s) => sum + (s.amount * 365.25) / 12 / s.periodDays, 0);

  const decide = (s: Series, decision: "fixed" | "dismissed" | null) =>
    setDecision.mutate({
      payee_key: normalisePayee(s.payee),
      decision,
      noted_amount: s.amount,
      noted_cadence: s.cadence,
    });

  return (
    <main className="p-4 space-y-5 pb-24">
      <div>
        <h1 className="font-figure text-xl font-bold" style={{ color: "var(--color-text)" }}>
          Recurring
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--color-muted)" }}>
          Nothing counts as a fixed cost until you keep it. Reading{" "}
          {spendingAccounts.length === 0
            ? "no synced checking accounts"
            : spendingAccounts.map((a) => a.name).join(", ")}
          .
        </p>
      </div>

      {isLoading && (
        <p className="text-sm" style={{ color: "var(--color-faint)" }}>
          Reading history…
        </p>
      )}

      <Card className="p-4">
        <p className="font-figure text-2xl font-bold" style={{ color: "var(--color-text)" }}>
          {fmt0(monthly)}
          <span className="text-sm font-normal" style={{ color: "var(--color-muted)" }}>
            {" "}/ month in fixed costs
          </span>
        </p>
        <p className="text-xs mt-1" style={{ color: "var(--color-faint)" }}>
          from {out(fixed).length} kept
          {monthlyIn > 0 && <> · {fmt0(monthlyIn)} / month in</>}
        </p>
      </Card>

      {out(fixed).length > 0 && (
        <Group title="Fixed costs" subtitle="these are what screen 1 will subtract">
          {out(fixed).map((s) => (
            <Row key={s.key} s={s} action="remove" onAct={() => decide(s, null)} />
          ))}
        </Group>
      )}

      {inc(fixed).length > 0 && (
        <Group title="Income" subtitle="these set the horizon — safe to spend until the next one">
          {inc(fixed).map((s) => (
            <Row key={s.key} s={s} action="remove" onAct={() => decide(s, null)} />
          ))}
        </Group>
      )}

      <Group
        title={`Suggested bills${out(suggested).length ? ` (${out(suggested).length})` : ""}`}
        subtitle="found in your history — keep the real obligations, dismiss the rest"
      >
        {out(suggested).length === 0 ? (
          <p className="px-3 py-4 text-sm" style={{ color: "var(--color-faint)" }}>
            Nothing new.
          </p>
        ) : (
          out(suggested).map((s) => (
            <Row
              key={s.key}
              s={s}
              action="keep"
              onAct={() => decide(s, "fixed")}
              onDismiss={() => decide(s, "dismissed")}
            />
          ))
        )}
      </Group>

      {inc(suggested).length > 0 && (
        <Group title={`Suggested income (${inc(suggested).length})`} subtitle="money arriving on a rhythm">
          {inc(suggested).map((s) => (
            <Row
              key={s.key}
              s={s}
              action="keep"
              onAct={() => decide(s, "fixed")}
              onDismiss={() => decide(s, "dismissed")}
            />
          ))}
        </Group>
      )}

      {dismissed.length > 0 && (
        <div>
          <button
            onClick={() => setShowDismissed((v) => !v)}
            className="text-xs font-semibold"
            style={{ color: "var(--color-muted)" }}
          >
            {showDismissed ? "Hide" : "Show"} {dismissed.length} dismissed
          </button>
          {showDismissed && (
            <Card className="divide-y mt-2" style={{ borderColor: "var(--color-hairline)" }}>
              {dismissed.map((s) => (
                <Row key={s.key} s={s} action="undo" onAct={() => decide(s, null)} dim />
              ))}
            </Card>
          )}
        </div>
      )}
    </main>
  );
}

function Group({
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

function Row({
  s,
  action,
  onAct,
  onDismiss,
  dim,
}: {
  s: Series;
  action: "keep" | "remove" | "undo";
  onAct: () => void;
  onDismiss?: () => void;
  dim?: boolean;
}) {
  const label = action === "keep" ? "Keep" : action === "remove" ? "Remove" : "Undo";
  return (
    <div className="px-3 py-2.5 flex items-center gap-3" style={{ opacity: dim ? 0.5 : 1 }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
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
        <p className="text-xs" style={{ color: "var(--color-faint)" }}>
          {CADENCE_LABEL[s.cadence]} · {s.hits}× · next {shortDate(s.nextDue)}
          {s.amountSpread > 0.08 && <> · varies ±{Math.round(s.amountSpread * 100)}%</>}
        </p>
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="text-xs shrink-0 underline"
          style={{ color: "var(--color-muted)" }}
        >
          Not a bill
        </button>
      )}
      <button
        onClick={onAct}
        className="text-xs font-semibold px-2.5 py-1.5 rounded-md shrink-0"
        style={
          action === "keep"
            ? { background: "var(--color-primary)", color: "#fff" }
            : { color: "var(--color-muted)" }
        }
      >
        {label}
      </button>
    </div>
  );
}
