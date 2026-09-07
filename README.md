# Float

A personal-finance PWA. Next.js + Supabase + React Query, deployed on Vercel.

**Live demo: https://jrock-wise-demo.vercel.app/** — no sign-in, no database. A
fictional user's finances generated in the browser, editable, reset daily.

## What it is for

One number, on the home screen:

```
   what comes in      income expected this month, whether or not it has arrived
 − what goes out      every planned bill, debt, card and savings payment,
                      counted from the 1st — paid or not
 − what you've spent  everything else that actually happened
 = free to spend
```

Two rules make that trustworthy, and both are pinned in
`lib/commitments/contract.test.ts`:

1. **Every dollar counts exactly once.** A bill counts as its estimate until a
   payment matches it, then as the payment — never both. A transfer between two
   of your own accounts counts nowhere.
2. **Expected and actual are the same line.** An unpaid bill reduces the number
   on the 1st, not the 28th.

Its one honest limitation: **the ledger can only expect what the plan knows
about.** A bill with no plan line doesn't reduce the number until the day it
lands. Everything the plan nags about — duplicate series, cards with no payment
line — exists to keep that gap visible.

## How the model works

One table, `commitments`, holds both "what repeats" and "what this month
expects". One row per **occurrence**, with the schedule denormalized onto it, so
the newest row in a series *is* the rule. Identity is `(series_id, period, seq)`
— never the due date, which is a hint for ordering and nothing more.

This replaced a `recurring_rules` + `month_plan_items` pair that had to be kept
in step. The sync step was where the bugs lived: duplicate bills a day apart,
edits that reached one copy and not the other, and a generator that wrote a
transaction the moment a date passed whether or not the payment had happened.

Nothing writes a transaction on a schedule now. A bank-synced account gets the
real one from its feed; a manual account waits for you to confirm it. The only
scheduled writers left are the charges an account accrues on its own — interest
and mortgage escrow (`lib/interest.ts`, `lib/escrow.ts`).

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # vitest
npx tsc --noEmit     # typecheck
```

Needs `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
The cron route also needs `CRON_SECRET` and `SUPABASE_SERVICE_ROLE_KEY`.

### Demo mode

Set `NEXT_PUBLIC_DEMO=1`. Sign-in is skipped and every Supabase call is served
by an in-memory client (`lib/demo/client.ts`) over a seed built fresh in the
browser (`lib/demo/seed.ts`). The seed is deterministic per calendar day, so
refreshing doesn't reshuffle history, and edits last until the next day.

The demo runs the same application code as production — only the data layer
differs. Its seed deliberately includes a card with no payment line and a
couple of unconfirmed payments, so the prompts the app shows when something is
missing are visible rather than theoretical.

## Migrations

`supabase/migrations/`, applied in order. Run them by hand in the Supabase SQL
editor; several are wrapped in a transaction and will refuse rather than half-
apply. Anything destructive says so in its header and explains what moves where
before it drops anything.

## Diagnostics

`scripts/` holds read-only reports and their matching `-apply.sql` writers.
Each report runs as-is; nothing needs uncommenting.

| script | what it answers |
| --- | --- |
| `ledger-explain.sql` | why is free-to-spend that number? Mirrors the ledger in SQL, input by input. |
| `series-timeline.sql` | one recurring series week by week: planned, paid, covered, still open. |
| `duplicate-report.sql` | which series look like the same bill twice. |
| `cover-multi-week-payments.sql` | lump payments whose later weeks still read unpaid. |
| `flip-skipped-to-covered.sql` | a week settled by a lump but recorded as skipped. |
| `merge-duplicate-series.sql` | merges two duplicate series, repointing real payments. |

When a number looks wrong, start with `ledger-explain.sql`. Its section 4 lists
any live series with no line in the month, which is the usual culprit.
