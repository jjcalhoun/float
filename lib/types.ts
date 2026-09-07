export type AccountType = "checking" | "savings" | "credit" | "loan" | "cash";
export type TransactionType = "expense" | "income" | "transfer" | "refund";
export type BucketType = "needs" | "wants" | "savings";
export type ThemeMode = "system" | "light" | "dark";
export type DebtStrategy = "avalanche" | "snowball";
export type TransactionSource = "manual" | "csv" | "sync" | "recurring" | "interest" | "escrow";

export interface Account {
  id: string;
  user_id: string;
  name: string;
  type: AccountType;
  last4?: string | null;
  starting_balance: number;
  as_of_date: string; // ISO date
  apr: number;
  color?: string | null;
  sort_order: number;
  min_payment?: number | null; // liability accounts: the lender's minimum
  monthly_payment?: number | null; // what you actually pay each month (total)
  escrow_amount?: number | null; // part of the payment that isn't debt paydown
  escrow_category_id?: string | null; // category for the monthly escrow posting
  payment_category_id?: string | null; // home screen: show the whole payment under this category
  statement_day?: number | null; // liability accounts: day interest posts
  live_balance?: number | null; // SimpleFIN live balance for linked accounts
  live_balance_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  user_id: string;
  name: string;
  icon: string; // Material Symbols name
  color: string;
  bucket: BucketType;
  is_archived: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TransactionSplit {
  id: string;
  user_id: string;
  transaction_id: string;
  category_id: string;
  bucket: BucketType;
  amount: number; // signed; sums to parent transaction.amount
  created_at: string;
}

export interface Transaction {
  id: string;
  user_id: string;
  account_id: string;
  date: string; // ISO date
  amount: number; // signed: negative = outflow, positive = inflow
  merchant?: string | null;
  description?: string | null;
  type: TransactionType;
  transfer_account_id?: string | null;
  transfer_group_id?: string | null;
  bucket?: BucketType | null; // transfers only: count toward this budget bucket
  notes?: string | null;
  source: TransactionSource;
  external_id?: string | null;
  import_batch_id?: string | null;
  reviewed: boolean;
  commitment_id?: string | null; // fulfills this commitment — the only link there is
  created_at: string;
  updated_at: string;
  // joined
  splits?: TransactionSplit[];
}

export interface RecurringBill {
  id: string;
  user_id: string;
  name: string;
  amount: number;
  category_id?: string | null;
  account_id?: string | null;
  day_of_month?: number | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface BudgetPlan {
  user_id: string;
  income: number;
  plan_needs: number;
  plan_wants: number;
  plan_savings: number;
  updated_at: string;
}

export interface CategoryBudget {
  user_id: string;
  category_id: string;
  monthly_target: number;
}

export interface Settings {
  user_id: string;
  import_start_date?: string | null;
  theme_mode: ThemeMode;
  debt_strategy: DebtStrategy;
  debt_extra: number;
  debt_surplus?: number | null; // editable surplus; null → 3-month average
  autocategorize_imports: boolean;
  /** spend view: card purchases reduce free-to-spend, the card payment counts zero */
  count_card_purchases: boolean;
  investments_balance: number;
  investments_return: number;
  invest_monthly: number;
  invest_employer_match: number;
  invest_current_age?: number | null;
  invest_retire_age?: number | null;
  surplus_savings_pct: number;
  surplus_investments_pct: number;
  updated_at: string;
}

export type RecurringFrequency = "monthly" | "semimonthly" | "weekly" | "biweekly";

/* Recurring series and month plans used to be two more tables here
   (`recurring_rules`, `month_plans`, `month_plan_items`). They are one table
   now — `commitments`, typed in lib/commitments/types.ts — where a series is
   simply its own occurrences and the newest one carries the schedule. */

export interface SimplefinConnection {
  id: string;
  user_id: string;
  last_synced_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface SimplefinAccountMapping {
  id: string;
  user_id: string;
  connection_id: string;
  simplefin_account_id: string;
  account_id: string;
  org_name?: string | null;
  created_at: string;
}

export interface AccountBalance {
  account_id: string;
  user_id: string;
  balance: number;
}

/* ---- Aggregation result types ---- */
export interface Rollup {
  byCat: Record<string, number>;      // category_id -> net spend (expense minus refunds)
  byBucket: Record<BucketType, number>; // bucket -> net spend
  income: number;
  spend: number;
}
