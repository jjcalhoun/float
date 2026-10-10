import { DEMO_USER_ID as U } from "./isDemo";

/* Deterministic demo dataset for a fictional user ("Alex").
 *
 * Everything is generated relative to `today`, so the last ~3 months are
 * always populated and "new" transactions arrive each day. The PRNG is
 * seeded from the calendar date, so a given day always produces the same
 * data (refreshing doesn't reshuffle history).
 */

export interface DemoTables {
  [table: string]: Record<string, unknown>[];
}

/* mulberry32 — tiny deterministic PRNG */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (base: Date, n: number) => new Date(base.getTime() + n * 86400000);
const dayNum = (s: string) => Math.floor(Date.parse(`${s}T00:00:00Z`) / 86400000);

let idCounter = 0;
const nid = () => `d${String(++idCounter).padStart(5, "0")}`;

/* ---- static shape ---- */

const ACCOUNTS = [
  { id: "acc-chk", name: "Everyday Checking", type: "checking", starting_balance: 2350, last4: "4821" },
  { id: "acc-sav", name: "High-Yield Savings", type: "savings", starting_balance: 6200, last4: "9034" },
  { id: "acc-cc", name: "Rewards Card", type: "credit", starting_balance: -640, last4: "7716", apr: 24.99, min_payment: 35, statement_day: 20 },
  // Deliberately has NO payment rule below: this is the card-gap prompt's case,
  // a card being spent on with nothing planned to pay it down.
  { id: "acc-cc2", name: "Travel Card", type: "credit", starting_balance: -415, last4: "3390", apr: 21.99, min_payment: 25, statement_day: 12 },
  { id: "acc-loan", name: "Car Loan", type: "loan", starting_balance: -11890, last4: "0042", apr: 6.4, min_payment: 320, statement_day: 5 },
];

const CATEGORIES = [
  { id: "cat-housing", name: "Housing", icon: "home", color: "#14B8A6", bucket: "needs" },
  { id: "cat-groceries", name: "Groceries", icon: "shopping_cart", color: "#84CC16", bucket: "needs" },
  { id: "cat-utilities", name: "Utilities", icon: "bolt", color: "#F59E0B", bucket: "needs" },
  { id: "cat-transport", name: "Transportation", icon: "directions_car", color: "#8B5CF6", bucket: "needs" },
  { id: "cat-dining", name: "Dining Out", icon: "restaurant", color: "#06B6D4", bucket: "wants" },
  { id: "cat-subs", name: "Subscriptions", icon: "subscriptions", color: "#EC4899", bucket: "wants" },
  { id: "cat-fun", name: "Fun & Hobbies", icon: "sports_esports", color: "#F97316", bucket: "wants" },
  { id: "cat-health", name: "Health", icon: "favorite", color: "#EF4444", bucket: "needs" },
];

interface RuleSpec {
  id: string;
  name: string;
  account_id: string;
  type: "income" | "expense" | "transfer";
  amount: number;
  transfer_account_id?: string;
  category_id?: string;
  bucket?: string;
  frequency: "monthly" | "biweekly" | "weekly" | "semimonthly";
  day_of_month?: number;
  weekday?: number;
  variable?: boolean;
}

const RULES: RuleSpec[] = [
  { id: "rule-pay", name: "Acme Payroll", account_id: "acc-chk", type: "income", amount: 2180, frequency: "biweekly", weekday: 5 },
  { id: "rule-rent", name: "Rent — Maple St Apartments", account_id: "acc-chk", type: "expense", amount: -1450, category_id: "cat-housing", bucket: "needs", frequency: "monthly", day_of_month: 1 },
  { id: "rule-electric", name: "City Power & Light", account_id: "acc-chk", type: "expense", amount: -112, category_id: "cat-utilities", bucket: "needs", frequency: "monthly", day_of_month: 17, variable: true },
  { id: "rule-internet", name: "Fiberly Internet", account_id: "acc-chk", type: "expense", amount: -75, category_id: "cat-utilities", bucket: "needs", frequency: "monthly", day_of_month: 9 },
  { id: "rule-netflix", name: "Netflix", account_id: "acc-chk", type: "expense", amount: -15.99, category_id: "cat-subs", bucket: "wants", frequency: "monthly", day_of_month: 12 },
  { id: "rule-gym", name: "Iron Temple Gym", account_id: "acc-chk", type: "expense", amount: -45, category_id: "cat-health", bucket: "needs", frequency: "monthly", day_of_month: 3 },
  { id: "rule-carpay", name: "Car loan payment", account_id: "acc-chk", type: "transfer", amount: -320, transfer_account_id: "acc-loan", frequency: "monthly", day_of_month: 5 },
  { id: "rule-ccpay", name: "Rewards Card payment", account_id: "acc-chk", type: "transfer", amount: -600, transfer_account_id: "acc-cc", frequency: "monthly", day_of_month: 20 },
  { id: "rule-save", name: "Savings auto-transfer", account_id: "acc-chk", type: "transfer", amount: -250, transfer_account_id: "acc-sav", frequency: "monthly", day_of_month: 2 },
];

/* Series whose CURRENT-MONTH payment is deliberately left unposted.
 *
 * Every account here is manual — the demo has no bank connected — so a due
 * occurrence with nothing against it is exactly the case the home screen now
 * asks about: "did this go through?". Without these the demo would show a
 * month where everything settles itself, which is the assumption the app
 * spent this whole redesign removing. */
const AWAITING = new Set(["rule-gym", "rule-carpay"]);

const MERCHANTS = {
  groceries: ["Kroger", "Aldi", "Fresh Market", "Costco"],
  dining: ["Chipotle", "Thai Garden", "Milano's Pizza", "Sunrise Diner", "Bean & Barrel Coffee"],
  gas: ["Shell", "Speedway", "Casey's"],
  fun: ["Steam Games", "AMC Theatres", "Bowl-a-Rama", "City Bookstore"],
};

function pick<T>(rnd: () => number, arr: T[]): T {
  return arr[Math.floor(rnd() * arr.length)];
}
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ---- occurrence dates for a rule within [from, to] ---- */
function ruleDates(rule: RuleSpec, from: Date, to: Date): string[] {
  const out: string[] = [];
  if (rule.frequency === "monthly") {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    while (d <= to) {
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      const occ = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(rule.day_of_month ?? 1, last)));
      if (occ >= from && occ <= to) out.push(iso(occ));
      d.setUTCMonth(d.getUTCMonth() + 1);
    }
  } else if (rule.frequency === "biweekly") {
    // anchor: the first `weekday` on/after a fixed epoch so paydays are stable
    const anchor = new Date(Date.UTC(2026, 0, 2)); // a Friday
    let t = anchor.getTime();
    while (t < from.getTime()) t += 14 * 86400000;
    for (; t <= to.getTime(); t += 14 * 86400000) {
      const d = new Date(t);
      if (d >= from) out.push(iso(d));
    }
  }
  return out;
}

/* ---- main ---- */

export function buildSeed(todayIso: string): DemoTables {
  idCounter = 0;
  const today = new Date(`${todayIso}T00:00:00Z`);
  const historyStart = addDays(today, -100);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const month = todayIso.slice(0, 7);

  const t: DemoTables = {
    accounts: [],
    categories: [],
    transactions: [],
    transaction_splits: [],
    commitments: [],
    plan_periods: [],
    budget_plan: [],
    category_budgets: [],
    settings: [],
    recurring_suggestion_dismissals: [],
    simplefin_connections: [],
    simplefin_account_map: [],
  };

  /* The demo's accounts are "on the feed".
     v2 scopes itself to accounts a SimpleFIN mapping covers and fails closed
     when there are none, so without this the demo shows $0 everywhere — a
     correct answer to the question "what does the feed cover" and a useless
     showcase. The car loan and savings are left off, as they would be. */
  t.simplefin_connections = [
    { id: "demo-conn", user_id: U, last_synced_at: `${todayIso}T06:00:00Z`, created_at: `${todayIso}T00:00:00Z`, updated_at: `${todayIso}T00:00:00Z` },
  ];
  t.simplefin_account_map = ["acc-chk", "acc-cc", "acc-cc2"].map((account_id, i) => ({
    id: `demo-map-${i}`,
    user_id: U,
    connection_id: "demo-conn",
    simplefin_account_id: `demo-sf-${account_id}`,
    account_id,
    org_name: "Demo Bank",
    created_at: `${todayIso}T00:00:00Z`,
  }));

  const stamp = { created_at: `${todayIso}T00:00:00Z`, updated_at: `${todayIso}T00:00:00Z` };

  t.accounts = ACCOUNTS.map((a, i) => ({
    user_id: U,
    as_of_date: iso(addDays(historyStart, -1)),
    apr: 0,
    sort_order: i,
    color: null,
    min_payment: null,
    statement_day: null,
    live_balance: null,
    live_balance_at: null,
    ...stamp,
    ...a,
  }));

  t.categories = CATEGORIES.map((c, i) => ({
    user_id: U, is_archived: false, sort_order: i, ...stamp, ...c,
  }));

  t.budget_plan = [{ user_id: U, income: 4720, plan_needs: 50, plan_wants: 30, plan_savings: 20, updated_at: stamp.updated_at }];
  t.settings = [{
    user_id: U, theme_mode: "system", debt_strategy: "avalanche", debt_extra: 100,
    debt_surplus: null, autocategorize_imports: true, count_card_purchases: true,
    investments_balance: 18500,
    investments_return: 7, invest_monthly: 300, invest_employer_match: 150,
    invest_current_age: 32, invest_retire_age: 62, surplus_savings_pct: 50,
    surplus_investments_pct: 50, import_start_date: null, updated_at: stamp.updated_at,
  }];
  t.category_budgets = [
    { user_id: U, category_id: "cat-groceries", monthly_target: 520 },
    { user_id: U, category_id: "cat-dining", monthly_target: 220 },
    { user_id: U, category_id: "cat-transport", monthly_target: 200 },
    { user_id: U, category_id: "cat-fun", monthly_target: 150 },
    { user_id: U, category_id: "cat-housing", monthly_target: 1450 },
    { user_id: U, category_id: "cat-utilities", monthly_target: 200 },
  ];

  const addTxn = (row: Record<string, unknown>) => {
    const id = nid();
    t.transactions.push({
      id, user_id: U, merchant: null, description: null, type: "expense",
      transfer_account_id: null, transfer_group_id: null, bucket: null, notes: null,
      source: "sync", external_id: null, import_batch_id: null, reviewed: true,
      commitment_id: null, ...stamp, ...row,
    });
    return id;
  };
  const addSplit = (txnId: string, category_id: string, bucket: string, amount: number) => {
    t.transaction_splits.push({
      id: nid(), user_id: U, transaction_id: txnId, category_id, bucket, amount,
      created_at: stamp.created_at,
    });
  };

  /* the payments that already happened: history up to TODAY only.
     The plan commits the whole month through its commitments; posting
     transactions ahead of their date would read as money already moved.
     Nothing generates these in the app any anymore — a real account gets them
     from the bank, a manual one when you confirm — but a demo needs a past. */
  const rnd0 = prng(dayNum(todayIso.slice(0, 8) + "01"));
  for (const rule of RULES) {
    for (const date of ruleDates(rule, historyStart, today)) {
      // left for you to confirm — see AWAITING
      if (AWAITING.has(rule.id) && date >= iso(monthStart)) continue;
      const external = `recurring:${rule.id}:${date}`;
      const amount = rule.variable
        ? round2(rule.amount * (0.85 + prng(dayNum(date))() * 0.4))
        : rule.amount;
      if (rule.type === "transfer") {
        const group = nid();
        const a = addTxn({ account_id: rule.account_id, date, amount, merchant: rule.name, type: "transfer", transfer_account_id: rule.transfer_account_id, transfer_group_id: group, source: "recurring", external_id: external });
        const b = addTxn({ account_id: rule.transfer_account_id!, date, amount: -amount, merchant: rule.name, type: "transfer", transfer_account_id: rule.account_id, transfer_group_id: group, source: "recurring", external_id: `${external}:c` });
        void a; void b;
      } else {
        const id = addTxn({ account_id: rule.account_id, date, amount, merchant: rule.name, type: rule.type, source: "recurring", external_id: external });
        if (rule.type === "expense" && rule.category_id) addSplit(id, rule.category_id, rule.bucket!, amount);
      }
    }
  }
  void rnd0;

  /* discretionary spending: deterministic per-day noise */
  for (let d = 0; d <= 100; d++) {
    const day = addDays(historyStart, d);
    if (day > today) break;
    const date = iso(day);
    const rnd = prng(dayNum(date));
    const dow = day.getUTCDay();
    const recent = dayNum(todayIso) - dayNum(date) <= 2; // last 3 days → review queue
    const rev = !recent;

    if (rnd() < 0.3) {
      const amt = -round2(45 + rnd() * 95);
      const id = addTxn({ account_id: "acc-chk", date, amount: amt, merchant: pick(rnd, MERCHANTS.groceries), reviewed: rev });
      if (rev) addSplit(id, "cat-groceries", "needs", amt);
    }
    if (rnd() < 0.42) {
      const amt = -round2(9 + rnd() * 34);
      const id = addTxn({ account_id: "acc-cc", date, amount: amt, merchant: pick(rnd, MERCHANTS.dining), reviewed: rev });
      if (rev) addSplit(id, "cat-dining", "wants", amt);
    }
    if (dow === 6 && rnd() < 0.8) {
      const amt = -round2(34 + rnd() * 18);
      const id = addTxn({ account_id: "acc-cc", date, amount: amt, merchant: pick(rnd, MERCHANTS.gas), reviewed: rev });
      if (rev) addSplit(id, "cat-transport", "needs", amt);
    }
    if ((dow === 5 || dow === 0) && rnd() < 0.5) {
      const amt = -round2(12 + rnd() * 48);
      const id = addTxn({ account_id: "acc-cc", date, amount: amt, merchant: pick(rnd, MERCHANTS.fun), reviewed: rev });
      if (rev) addSplit(id, "cat-fun", "wants", amt);
    }
    // the Travel Card: real, ongoing spending with no payment line anywhere —
    // the shape that makes free-to-spend read high if purchases aren't counted
    if (dow === 3 && rnd() < 0.55) {
      const amt = -round2(26 + rnd() * 74);
      const id = addTxn({ account_id: "acc-cc2", date, amount: amt, merchant: pick(rnd, MERCHANTS.dining), reviewed: rev });
      if (rev) addSplit(id, "cat-dining", "wants", amt);
    }
    if (dow === 1 && rnd() < 0.22) {
      const amt = -round2(40 + rnd() * 70);
      const id = addTxn({ account_id: "acc-cc2", date, amount: amt, merchant: pick(rnd, MERCHANTS.fun), reviewed: rev });
      if (rev) addSplit(id, "cat-fun", "wants", amt);
    }
  }

  /* current month's commitments (confirmed on the 1st) + explicit links.
     One row per occurrence, keyed by (series, period, seq). RULES below is a
     description of the demo persona's life, not a table — recurring_rules is
     gone, and each series exists solely as its own commitments. */
  t.plan_periods = [{
    id: nid(), user_id: U, period: month, confirmed_at: `${month}-01T13:00:00Z`, ...stamp,
  }];
  const destKind: Record<string, string> = { "acc-loan": "debt", "acc-cc": "cc_payment", "acc-sav": "savings" };
  for (const rule of RULES) {
    const kind = rule.type === "income" ? "income" : rule.type === "expense" ? "bill" : destKind[rule.transfer_account_id ?? ""];
    if (!kind) continue;
    ruleDates(rule, monthStart, monthEnd).forEach((due, seq) => {
      const cid = nid();
      t.commitments.push({
        id: cid, user_id: U, series_id: rule.id, period: month, seq,
        name: rule.name, kind,
        amount: rule.type === "income" ? Math.abs(rule.amount) : -Math.abs(rule.amount),
        account_id: rule.account_id,
        transfer_account_id: rule.transfer_account_id ?? null,
        category_id: rule.category_id ?? null,
        bucket: rule.bucket ?? null,
        due_hint: due,
        frequency: rule.frequency,
        day_of_month: rule.day_of_month ?? null,
        day_of_month_2: null,
        weekday: rule.weekday ?? null,
        interval: 1,
        series_ended: false,
        skipped: false,
        variable: !!rule.variable,
        auto_confirm: false,
        ...stamp,
      });
      // link the generated rows for this occurrence
      const ext = `recurring:${rule.id}:${due}`;
      for (const txn of t.transactions) {
        const e = txn.external_id as string | null;
        if (e === ext || e === `${ext}:c`) txn.commitment_id = cid;
      }
    });
  }

  return t;
}
