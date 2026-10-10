"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTheme } from "@/components/providers";
import { useAccounts, useAccountBalances } from "@/hooks/useSupabaseData";
import { fmt, shortDate } from "@/lib/format";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { AccountEditor } from "@/components/settings/AccountEditor";
import { BudgetEditor } from "@/components/settings/BudgetEditor";
import { CategoryManager } from "@/components/settings/CategoryManager";
import { ImportWizard } from "@/components/import/ImportWizard";
import { ImportStartDateEditor } from "@/components/settings/ImportStartDateEditor";
import { ConnectionsManager } from "@/components/settings/ConnectionsManager";
import { DeleteAllTransactions } from "@/components/settings/DeleteAllTransactions";
import { MonthPlanSheet } from "@/components/plan/MonthPlanSheet";
import { currentMonthKey } from "@/lib/format";
import { InstallButton } from "@/components/pwa/InstallButton";
import type { Account, ThemeMode } from "@/lib/types";

type Sheet = "budget" | "categories" | "import" | "importDate" | "connections" | "monthPlan" | "deleteAll" | null;

export function ProfileScreen() {
  const router = useRouter();
  const { themeMode, setThemeMode } = useTheme();
  const { data: accounts = [] } = useAccounts();
  const { data: balances = {} } = useAccountBalances();

  const [editingAccount, setEditingAccount] = useState<Account | "new" | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);

  async function signOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="p-4 space-y-5">
      <h1 className="font-figure text-xl font-bold" style={{ color: "var(--color-text)" }}>
        Profile
      </h1>

      {/* Order: Theme → Settings → Accounts → Sign out.
          Two-column on desktop: accounts on the right, theme + settings left. */}
      <div className="lg:grid lg:grid-cols-2 lg:gap-5 lg:items-start space-y-5 lg:space-y-0">

      {/* Left column on desktop: theme, then settings */}
      <div className="lg:order-1 space-y-5">
      {/* Theme */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          Theme
        </h2>
        <div className="flex gap-2">
          {(["system", "light", "dark"] as ThemeMode[]).map((m) => (
            <Chip key={m} active={themeMode === m} onClick={() => setThemeMode(m)}>
              {m === "system" ? "Device" : m === "light" ? "Light" : "Dark"}
            </Chip>
          ))}
        </div>
      </section>

      {/* Settings */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          Settings
        </h2>
        <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
          <SettingRow icon="tune" label="Budget plan" onClick={() => setSheet("budget")} />
          <SettingRow icon="category" label="Manage categories" onClick={() => setSheet("categories")} />
          <SettingRow icon="account_balance" label="Bank connections" onClick={() => setSheet("connections")} />
          <SettingRow icon="event_note" label="Month plan" onClick={() => setSheet("monthPlan")} />
          <SettingRow icon="upload_file" label="Import CSV" onClick={() => setSheet("import")} />
          <SettingRow icon="event" label="Import start date" onClick={() => setSheet("importDate")} />
          <SettingRow icon="delete_sweep" label="Delete all transactions" onClick={() => setSheet("deleteAll")} />
        </Card>
      </section>

      {/* The v1 screens, still here.
          They came off the nav when the home screen became the number, but
          the donut, the ledger, the month plan and the debt payoff plan all
          still work and still know things about this account that v2 does
          not model. Hidden is not the same as deleted. */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
          Original screens
        </h2>
        <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
          <LinkRow icon="donut_small" label="Home (donut and ledger)" href="/classic" />
          <LinkRow icon="payments" label="Debt payoff" href="/debt" />
          <LinkRow icon="insights" label="Insights" href="/insights" />
        </Card>
      </section>
      </div>{/* left column */}

      {/* Accounts (right column on desktop) */}
      <section className="space-y-3 lg:order-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
            Accounts
          </h2>
          <button
            className="text-xs font-semibold"
            style={{ color: "var(--color-primary)" }}
            onClick={() => setEditingAccount("new")}
          >
            + Add
          </button>
        </div>
        {accounts.length === 0 ? (
          <Card className="p-4 text-center">
            <p className="text-sm" style={{ color: "var(--color-muted)" }}>
              No accounts yet.
            </p>
          </Card>
        ) : (
          <Card className="divide-y" style={{ borderColor: "var(--color-hairline)" }}>
            {accounts.map((a) => (
              <button
                key={a.id}
                onClick={() => setEditingAccount(a)}
                className="w-full flex items-center justify-between px-4 py-3 text-left"
              >
                <div>
                  <p className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
                    {a.name}
                  </p>
                  <p className="text-xs capitalize" style={{ color: "var(--color-faint)" }}>
                    {a.type}{a.last4 ? ` ••${a.last4}` : ""}
                    {a.live_balance_at ? ` · as of ${shortDate(a.live_balance_at.slice(0, 10))}` : ""}
                  </p>
                </div>
                <span
                  className="font-figure text-sm font-semibold"
                  style={{ color: (balances[a.id] ?? 0) < 0 ? "var(--color-danger)" : "var(--color-text)" }}
                >
                  {fmt(balances[a.id] ?? 0)}
                </span>
              </button>
            ))}
          </Card>
        )}
      </section>
      </div>{/* dashboard grid */}

      {/* Install + sign out (full width, below) */}
      <InstallButton />

      <Button variant="secondary" fullWidth onClick={signOut}>
        Sign out
      </Button>

      {editingAccount && (
        <AccountEditor
          account={editingAccount === "new" ? undefined : editingAccount}
          onClose={() => setEditingAccount(null)}
        />
      )}
      {sheet === "budget" && <BudgetEditor onClose={() => setSheet(null)} />}
      {sheet === "categories" && <CategoryManager onClose={() => setSheet(null)} />}
      {sheet === "connections" && <ConnectionsManager onClose={() => setSheet(null)} />}
      {sheet === "monthPlan" && <MonthPlanSheet month={currentMonthKey()} onClose={() => setSheet(null)} />}
      {sheet === "import" && <ImportWizard onClose={() => setSheet(null)} />}
      {sheet === "importDate" && <ImportStartDateEditor onClose={() => setSheet(null)} />}
      {sheet === "deleteAll" && <DeleteAllTransactions onClose={() => setSheet(null)} />}
    </main>
  );
}

function SettingRow({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button onClick={onClick} className="w-full flex items-center justify-between px-4 py-3 text-left">
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
    </button>
  );
}

function LinkRow({ icon, label, href }: { icon: string; label: string; href: string }) {
  return (
    <Link href={href} className="w-full flex items-center justify-between px-4 py-3 text-left">
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
    </Link>
  );
}
