"use client";

/* The original app, behind one door.
 *
 * v1 still works and still knows things about this account that v2 does not
 * model — the donut, the ledger, the month plan, the debt payoff. None of it
 * is deleted and none of it runs on its own: commitments are materialised
 * only when the Month plan sheet below is opened.
 *
 * But it was showing through. Half of Profile's settings list existed to
 * serve screens v2 never looks at, and a rewrite you can still see the old
 * app inside is a rewrite that has not finished. So everything v1-only lives
 * here, reached by a single row in Settings, and Profile is about the app
 * you actually use.
 */

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { BudgetEditor } from "@/components/settings/BudgetEditor";
import { CategoryManager } from "@/components/settings/CategoryManager";
import { ImportWizard } from "@/components/import/ImportWizard";
import { MonthPlanSheet } from "@/components/plan/MonthPlanSheet";
import { currentMonthKey } from "@/lib/format";

type Sheet = "budget" | "categories" | "import" | "monthPlan" | null;

export function V1Screen() {
  const [sheet, setSheet] = useState<Sheet>(null);

  return (
    <main className="p-4 space-y-5 pb-24">
      <div>
        <h1 className="font-figure text-xl font-bold" style={{ color: "var(--color-text)" }}>
          Original app
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--color-muted)" }}>
          Everything the app did before Float. Still working, still reading the
          same data — nothing here runs on its own.
        </p>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          Screens
        </h2>
        <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
          <Row icon="donut_small" label="Home — donut and ledger" href="/classic" />
          <Row icon="payments" label="Debt payoff" href="/debt" />
          <Row icon="insights" label="Insights" href="/insights" />
        </Card>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          Settings for those screens
        </h2>
        <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
          <Row icon="tune" label="Budget plan" onClick={() => setSheet("budget")} />
          <Row icon="category" label="Manage categories" onClick={() => setSheet("categories")} />
          <Row icon="event_note" label="Month plan" onClick={() => setSheet("monthPlan")} />
          <Row icon="upload_file" label="Import CSV" onClick={() => setSheet("import")} />
        </Card>
        <p className="text-xs" style={{ color: "var(--color-faint)" }}>
          Float works out its own fixed costs from the bank feed, so none of
          these affect it.
        </p>
      </section>

      {sheet === "budget" && <BudgetEditor onClose={() => setSheet(null)} />}
      {sheet === "categories" && <CategoryManager onClose={() => setSheet(null)} />}
      {sheet === "monthPlan" && (
        <MonthPlanSheet month={currentMonthKey()} onClose={() => setSheet(null)} />
      )}
      {sheet === "import" && <ImportWizard onClose={() => setSheet(null)} />}
    </main>
  );
}

function Row({
  icon,
  label,
  href,
  onClick,
}: {
  icon: string;
  label: string;
  href?: string;
  onClick?: () => void;
}) {
  const inner = (
    <>
      <span className="flex items-center gap-3">
        <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--color-muted)" }}>
          {icon}
        </span>
        <span className="text-sm" style={{ color: "var(--color-text)" }}>
          {label}
        </span>
      </span>
      <span className="material-symbols-outlined" style={{ fontSize: 18, color: "var(--color-faint)" }}>
        chevron_right
      </span>
    </>
  );
  const cls = "w-full flex items-center justify-between px-4 py-3 text-left";
  return href ? (
    <Link href={href} className={cls}>
      {inner}
    </Link>
  ) : (
    <button onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}
