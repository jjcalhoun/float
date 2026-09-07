import { buildSeed, type DemoTables } from "./seed";
import { DEMO_USER_ID } from "./isDemo";

/* A miniature Supabase-shaped client over an in-browser dataset.
 *
 * Supports exactly the query surface the hooks use: select (incl. the
 * `splits:transaction_splits(*)` embed and `count/head`), insert / update /
 * upsert / delete, and the filters eq · in · is · not · gt/gte/lt/lte · like,
 * plus order / limit / single / maybeSingle. Data persists in localStorage
 * for the day and reseeds daily, so the demo always has fresh transactions.
 */

const LS_KEY = "jrw-demo-db-v2";

type Row = Record<string, unknown>;
interface Store {
  seededOn: string;
  tables: DemoTables;
}

let mem: Store | null = null;

const todayIso = () => new Date().toISOString().slice(0, 10);

function loadStore(): Store {
  const today = todayIso();
  if (mem && mem.seededOn === today) return mem;
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Store;
        if (parsed.seededOn === today) {
          mem = parsed;
          return parsed;
        }
      }
    } catch {
      /* corrupted → reseed */
    }
  }
  mem = { seededOn: today, tables: buildSeed(today) };
  persist();
  return mem;
}

function persist() {
  if (typeof window === "undefined" || !mem) return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(mem));
  } catch {
    /* storage full/blocked — demo still works in-memory */
  }
}

let idSeq = 10000;
const genId = () => `dm${++idSeq}`;

/* the computed account_balances view */
function accountBalances(tables: DemoTables): Row[] {
  const today = todayIso();
  return tables.accounts.map((a) => {
    const sum = tables.transactions
      .filter(
        (t) =>
          t.account_id === a.id &&
          (t.date as string) > (a.as_of_date as string) &&
          (t.date as string) <= today,
      )
      .reduce((s, t) => s + Number(t.amount), 0);
    return { account_id: a.id, user_id: DEMO_USER_ID, balance: Number(a.starting_balance) + sum };
  });
}

type Filter = (r: Row) => boolean;

class Query implements PromiseLike<{ data: unknown; error: null; count: number | null }> {
  private filters: Filter[] = [];
  private orderBy: { col: string; asc: boolean } | null = null;
  private limitN: number | null = null;
  private mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: Row[] | Row | null = null;
  private wantSingle: "single" | "maybe" | null = null;
  private wantCountOnly = false;
  private embedSplits = false;

  constructor(private table: string) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.mode === "select") {
      this.embedSplits = !!cols && cols.includes("transaction_splits");
      if (opts?.head && opts?.count) this.wantCountOnly = true;
    }
    return this;
  }
  insert(rows: Row | Row[]) {
    this.mode = "insert";
    this.payload = rows;
    return this;
  }
  upsert(rows: Row | Row[]) {
    this.mode = "upsert";
    this.payload = rows;
    return this;
  }
  update(patch: Row) {
    this.mode = "update";
    this.payload = patch;
    return this;
  }
  delete() {
    this.mode = "delete";
    return this;
  }

  eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this; }
  neq(col: string, v: unknown) { this.filters.push((r) => r[col] !== v); return this; }
  is(col: string, v: unknown) { this.filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return this; }
  in(col: string, vs: unknown[]) { const s = new Set(vs); this.filters.push((r) => s.has(r[col])); return this; }
  gt(col: string, v: never) { this.filters.push((r) => (r[col] as never) > v); return this; }
  gte(col: string, v: never) { this.filters.push((r) => (r[col] as never) >= v); return this; }
  lt(col: string, v: never) { this.filters.push((r) => (r[col] as never) < v); return this; }
  lte(col: string, v: never) { this.filters.push((r) => (r[col] as never) <= v); return this; }
  like(col: string, pattern: string) {
    const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$");
    this.filters.push((r) => typeof r[col] === "string" && re.test(r[col] as string));
    return this;
  }
  not(col: string, op: string, v: unknown) {
    if (op === "is" && v === null) this.filters.push((r) => r[col] != null);
    else this.filters.push((r) => r[col] !== v);
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) { this.limitN = n; return this; }
  single() { this.wantSingle = "single"; return this; }
  maybeSingle() { this.wantSingle = "maybe"; return this; }

  private rows(tables: DemoTables): Row[] {
    if (this.table === "account_balances") return accountBalances(tables);
    return tables[this.table] ?? (tables[this.table] = []);
  }

  private run() {
    const store = loadStore();
    const tables = store.tables;
    const all = this.rows(tables);
    const match = (r: Row) => this.filters.every((f) => f(r));

    let result: Row[] = [];

    if (this.mode === "insert" || this.mode === "upsert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      for (const raw of rows) {
        const row: Row = { created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...raw };
        // upsert: match by id, or by the table's natural key
        let existing: Row | undefined;
        if (this.mode === "upsert") {
          if (row.id != null) existing = all.find((r) => r.id === row.id);
          else if (this.table === "budget_plan" || this.table === "settings")
            existing = all.find((r) => r.user_id === row.user_id);
          else if (this.table === "recurring_suggestion_dismissals")
            existing = all.find((r) => r.user_id === row.user_id && r.signature === row.signature);
          else if (this.table === "plan_periods")
            existing = all.find((r) => r.user_id === row.user_id && r.period === row.period);
        }
        if (existing) {
          Object.assign(existing, row);
          result.push(existing);
        } else {
          if (row.id == null) row.id = genId();
          all.push(row);
          result.push(row);
        }
      }
      persist();
    } else if (this.mode === "update") {
      for (const r of all) {
        if (match(r)) {
          Object.assign(r, this.payload, { updated_at: new Date().toISOString() });
          result.push(r);
        }
      }
      persist();
    } else if (this.mode === "delete") {
      const keep = all.filter((r) => !match(r));
      result = all.filter((r) => match(r));
      tables[this.table] = keep;
      // deleting transactions also drops their splits (FK cascade)
      if (this.table === "transactions") {
        const gone = new Set(result.map((r) => r.id));
        tables.transaction_splits = tables.transaction_splits.filter((s) => !gone.has(s.transaction_id));
      }
      // deleting a commitment unlinks the transactions that fulfilled it
      if (this.table === "commitments") {
        const gone = new Set(result.map((r) => r.id));
        for (const t of tables.transactions) {
          if (gone.has(t.commitment_id as string)) t.commitment_id = null;
        }
      }
      persist();
    } else {
      result = all.filter(match);
      if (this.orderBy) {
        const { col, asc } = this.orderBy;
        result = [...result].sort((a, b) => {
          const x = a[col] as never;
          const y = b[col] as never;
          return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      if (this.limitN != null) result = result.slice(0, this.limitN);
      if (this.embedSplits) {
        const byTxn = new Map<unknown, Row[]>();
        for (const s of tables.transaction_splits) {
          const arr = byTxn.get(s.transaction_id);
          if (arr) arr.push(s);
          else byTxn.set(s.transaction_id, [s]);
        }
        result = result.map((r) => ({ ...r, splits: byTxn.get(r.id) ?? [] }));
      }
    }

    if (this.wantCountOnly) return { data: null, error: null, count: result.length };
    if (this.wantSingle) {
      if (result.length === 0)
        return this.wantSingle === "maybe"
          ? { data: null, error: null, count: null }
          : { data: null, error: { message: "Row not found" } as never, count: null };
      return { data: result[0], error: null, count: null };
    }
    return { data: result, error: null, count: result.length };
  }

  then<R1, R2>(
    onfulfilled?: ((v: { data: unknown; error: null; count: number | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ) {
    return Promise.resolve(this.run() as { data: unknown; error: null; count: number | null }).then(onfulfilled, onrejected);
  }
}

export function createDemoClient() {
  return {
    from: (table: string) => new Query(table),
    auth: {
      getUser: async () => ({
        data: { user: { id: DEMO_USER_ID, email: "alex@demo.float.app" } },
        error: null,
      }),
      signOut: async () => ({ error: null }),
    },
  };
}
