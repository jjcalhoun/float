"use client";

/* Screen 1. The number.
 *
 * "How much can I spend right now." Not for the month, not against a plan:
 * what the bank says is there, less what must leave before the next paycheck,
 * less the floor and whatever you mean to pay the card.
 *
 * There are no months in it. The arithmetic lives in lib/v2/safeToSpend.ts.
 */

import { useEffect, useMemo, useState } from "react";
import {
  useAccounts,
  useTransactions,
  useSettings,
  useUpdateSettings,
  useAccountBalances,
} from "@/hooks/useSupabaseData";
import { useRecurringPayees, useSetRecurringPayee } from "@/hooks/useRecurringPayees";
import { useSimplefinMappings, useSyncSimplefin } from "@/hooks/useSimplefin";
import { cashAccounts, isGenerated } from "@/lib/v2/scope";
import { useTxnWindow } from "@/components/providers";
import { detectSeries, SUGGEST, type Series, type Txn } from "@/lib/v2/recurring";
import { normalisePayee } from "@/lib/v2/payee";
import { manualSeries } from "@/lib/v2/manual";
import { usePayeeAliases } from "@/hooks/usePayeeAliases";
import { memoByTxns } from "@/lib/v2/cache";
import { safeToSpend, type DueItem } from "@/lib/v2/safeToSpend";
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
  const { data: aliases = {} } = usePayeeAliases();
  const setPayee = useSetRecurringPayee();
  const { data: mappings = [] } = useSimplefinMappings();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const { ensureSince } = useTxnWindow();
  const today = todayISO();

  /* Widening the loaded window is a state update, so it belongs in an
     effect — doing it inside useMemo set state during render, which React
     has to unpick with an extra pass on every mount of this screen. */
  useEffect(() => {
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
  const { total: balance, source, pending, posted, clamped } = spendableBalance(
    spendingAccounts,
    computed,
  );
  const balanceAt = spendingAccounts
    .map((a) => a.live_balance_at)
    .filter(Boolean)
    .sort()[0];

  const cards = useMemo(() => accounts.filter((a) => a.type === "credit"), [accounts]);
  const cardOwed = cards.reduce((s, a) => s + Math.max(0, -Number(a.live_balance ?? 0)), 0);

  const scopeKey = spendingAccounts.map((a) => a.id).sort().join(",");

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
  const kept = useMemo(() => {
    /* Shared with the Recurring screen through the transactions array, so
       switching between the two does not re-run detection. */
    /* The alias set is part of the cache key: asserting "same as" changes
       what detection returns, and a memo that ignored it would serve the
       answer from before the link. */
    const aliasKey = Object.entries(aliases).sort().flat().join(",");
    const detected = memoByTxns(transactions, `detect|float|${scopeKey}|${aliasKey}`, () =>
      detectSeries(scoped, { ...SUGGEST, aliases }),
    );
    return applyOverrides(
      [
        ...detected.filter((s) => decisions[normalisePayee(s.payee)]?.decision === "fixed"),
        // bills declared from Spending, which history cannot show yet
        ...manualSeries({ decisions, txns: scoped, detected }),
      ],
      decisions,
      (s) => normalisePayee(s.payee),
    );
  }, [scoped, decisions, transactions, scopeKey, aliases]);

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
          {/* On payday morning the horizon IS today, which "until 10/15"
              states uselessly. It is the one day the label has to explain
              itself: what is left has to last until the deposit clears. */}
          {!r.horizon
            ? "for the next two weeks"
            : r.horizon === today
              ? "until today's paycheck lands"
              : `until ${shortDate(r.horizon)}`}
        </p>
      </section>

      <Card className="p-4 space-y-2">
        <Line label={spendingAccounts.map((a) => a.name).join(" + ") || "No synced checking"} value={balance} />
        <Line label="due before then" value={-r.dueTotal} />
        {cardPayment > 0 && <Line label="card payment" value={-cardPayment} />}
        {floor > 0 && <Line label="floor" value={-floor} dim />}
        {/* Both figures, when they differ.
            Showing only "available: $0" against a bank app reading $1,268
            looks like the app has lost track of the money. The gap is the
            whole story — what has posted, and how much of it the bank has
            not released — so it is said outright rather than left to be
            inferred from a single number that disagrees with Chase. */}
        <p className="text-xs pt-1" style={{ color: "var(--color-faint)" }}>
          {source === "computed" ? (
            "computed from transactions — no live figure from the bank yet"
          ) : source === "posted" ? (
            `posted balance${asOf} — this bank publishes no available balance, so pending charges are not deducted`
          ) : (
            <>
              available to spend{asOf}
              {Math.abs(posted - balance) > 0.005 && (
                <>
                  {" "}· {fmt0(posted)} posted,{" "}
                  {pending > 0 ? (
                    <>
                      {/* "at least", because a bank clamps available at zero:
                          once pending exceeds the balance the subtraction can
                          only see as much of it as there was money to
                          cover. */}
                      {clamped ? "at least " : ""}
                      {fmt0(pending)} not yet cleared
                    </>
                  ) : (
                    /* Available EXCEEDS posted: the bank has released money
                       before it settles, which is what early direct deposit
                       does — on payday the paycheck is spendable while the
                       posted figure still shows yesterday. Subtracting one
                       from the other and calling the result "pending" turned
                       that into "−$2,074 not yet cleared", which describes
                       the opposite of what happened. */
                    <>{fmt0(-pending)} released before it posts</>
                  )}
                </>
              )}
            </>
          )}
        </p>
        <StaleNotice at={balanceAt} />
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
              <DueRow
                key={d.key}
                item={d}
                onPaid={() =>
                  setPayee.mutate({
                    payee_key: normalisePayee(d.payee),
                    decision: "fixed",
                    paid_through: d.date,
                  })
                }
              />
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

/* A bill you have already paid, early.
 *
 * The detector cannot work this out: a single Zelle for $462 on the 16th
 * covering both the 16th and the 23rd leaves the 23rd looking unpaid,
 * because on the 23rd nothing will post. So it is simply asked — one tap,
 * recorded as "paid through this date", undone on the Recurring screen.
 *
 * The amount is NOT read as two payments of $231. v1 did that, and the
 * script to repair its guesses is still in the repo. */
function DueRow({ item, onPaid }: { item: DueItem; onPaid: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="px-3 py-2.5 flex items-center justify-between gap-3">
      <span className="text-sm truncate" style={{ color: "var(--color-text)" }}>
        {item.payee}
      </span>
      {/* An overdue row is the one thing here you might act on, so it says
          so. It is still subtracted — a due date passing is not a payment —
          but silently subtracting it would leave you wondering why the
          number is lower than the dates suggest. */}
      <span
        className="text-xs shrink-0"
        style={{ color: item.overdue ? "var(--color-danger)" : "var(--color-faint)" }}
      >
        {item.overdue ? `${shortDate(item.date)} · late` : shortDate(item.date)}
      </span>
      <span className="font-figure text-sm shrink-0" style={{ color: "var(--color-text)" }}>
        {fmt(item.amount)}
      </span>
      {confirming ? (
        <button
          onClick={onPaid}
          className="text-xs font-semibold px-2 py-1 rounded-md shrink-0"
          style={{ background: "var(--color-primary)", color: "#fff" }}
        >
          Paid
        </button>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          aria-label={`Mark ${item.payee} paid`}
          className="shrink-0 material-symbols-outlined"
          style={{ fontSize: 18, color: "var(--color-faint)" }}
        >
          check_circle
        </button>
      )}
    </div>
  );
}

/* How old this is, and a way to fix it.
 *
 * The sync runs once a day at six in the morning. A transfer made on Monday
 * evening is therefore invisible until Tuesday, and the screen said nothing
 * about that — it showed a confident figure from sixteen hours ago while the
 * bank app two taps away showed another. The age is the missing context, and
 * a refresh is the missing verb. */
function StaleNotice({ at }: { at?: string | null }) {
  const sync = useSyncSimplefin();
  if (!at) return null;
  const hours = (Date.now() - Date.parse(at)) / 3_600_000;
  if (hours < 6 && !sync.isPending) return null;

  const age =
    hours < 48 ? `${Math.round(hours)} hours ago` : `${Math.round(hours / 24)} days ago`;

  /* What the bank said back, including when it said no.
     The sync collects per-connection errors and hands them to the caller;
     this button threw them away, so a connection that needs reauthorising
     looked exactly like a successful check that found nothing. A refresh
     you cannot tell has failed is worse than no refresh button. */
  const failed = sync.isError
    ? sync.error instanceof Error
      ? sync.error.message
      : "could not reach the bank"
    : sync.data?.errors?.length
      ? sync.data.errors[0]
      : null;

  return (
    <div className="text-xs space-y-1">
      <p className="flex items-center gap-2" style={{ color: "var(--color-muted)" }}>
        <span>last checked {age}</span>
        <button
          onClick={() => sync.mutate(undefined)}
          disabled={sync.isPending}
          className="underline font-semibold"
          style={{ color: "var(--color-primary)" }}
        >
          {sync.isPending ? "checking…" : "check now"}
        </button>
      </p>
      {failed && (
        <p style={{ color: "var(--color-danger)" }}>
          {failed} — reconnect under Profile → Bank connections.
        </p>
      )}
      {!failed && sync.isSuccess && (
        <p style={{ color: "var(--color-muted)" }}>
          {sync.data.balancesUpdated > 0 || sync.data.inserted > 0
            ? `updated · ${sync.data.inserted} new`
            : "the bank reported nothing new"}
        </p>
      )}
    </div>
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
