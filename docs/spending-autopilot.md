# Spending Autopilot

## Goal

Turn transaction emails into an explicit spending ledger that Home Assistant can
display and Retirenment can use for lookback analysis, future budget forecasts,
and retirement-spending assumptions.

## System Split

```text
IMAP transaction emails
  -> Mac mini spending service
  -> canonical ledger + monthly summaries
  -> Home Assistant dashboard and quick edits
  -> Retirenment analysis and forecast inputs
```

The Mac mini should own ingestion, parsing, dedupe, categorization rules, refund
matching, and durable storage. Home Assistant should stay as the cockpit: month
to date, pacing, alerts, and light transaction correction. Retirenment should
consume structured ledger summaries rather than parse emails directly.

## Canonical Ledger Rules

- Transaction amounts are signed USD values: positive spending, negative
  refunds or credits.
- Every transaction should keep source evidence: source kind, source id,
  parser version, received timestamp, and confidence.
- Category assignment must say whether it was explicit, manual, rule-derived,
  inferred, or still uncategorized.
- Ignored transactions remain in the ledger but are excluded from budget totals.
- Missing source evidence, missing categories, inferred categories, inferred
  budgets, and budget/category mismatches mark the month as reconstructed.

## First Contracts

- `src/spending-ledger.ts`
  - canonical transaction and budget interfaces
  - retirement-seed budget adapter
  - monthly spending summary with intermediate calculations
  - model-completeness reporting

- `src/home-assistant-spending-contract.ts`
  - compact monthly payload for Home Assistant REST sensors
  - transaction classification request shape for Home Assistant edits

- `src/chase-spending-import.ts`
  - Chase activity CSV backfill parser
  - converts Chase's negative purchase convention into ledger-positive spend
  - marks payments ignored and Amazon charges as `amazon_uncategorized`

- `src/amex-spending-import.ts`
  - Amex activity CSV backfill parser
  - keeps Amex's positive-purchase convention
  - dedupes overlapping exports by Amex reference number
  - maps travel/transportation rows into the travel bucket

- `src/sofi-spending-import.ts`
  - SoFi bank CSV backfill parser
  - converts bank-positive inflows / bank-negative outflows into the ledger's
    positive-spend convention
  - excludes payroll, interest, internal transfers, vault moves, and credit-card
    payments from budget spend
  - keeps direct utility/bill pay as household spend and tags P2P/Zelle outflows
    as family transfers

- `scripts/import-chase-spending.ts`
  - writes ignored local dev payloads under `public/local/`
  - gives the browser app real historical CSV data before the Mac mini service
    exists

- `scripts/import-amex-spending.ts`
  - writes ignored local Amex payloads under `public/local/`
  - supports the low-volume travel/points card as a second backfill source

- `scripts/import-sofi-spending.ts`
  - writes ignored local SoFi payloads under `public/local/`
  - adds cashflow context without double-counting credit-card payments

- `scripts/peek-gmail-imap.ts`
  - connects to `bonnertransactions@gmail.com` via Gmail IMAP using local
    environment variables
  - fetches only message headers by default, not bodies
  - writes ignored local metadata to `public/local/gmail-imap-peek.json`

- `src/gmail-transaction-email-import.ts`
  - first-pass parser for transaction email bodies/subjects
  - imports Chase's `You made a $x transaction with merchant` alerts directly
  - keeps Amazon charge/order emails in `amazon_uncategorized` until item detail
    is available

- `scripts/import-gmail-spending.ts`
  - connects to Gmail IMAP, fetches recent message bodies, and writes
    `public/local/spending-ledger.gmail.json`
  - this is the forward-feed companion to the CSV backfills

- `scripts/sync-gmail-spending.ts`
  - stateful Gmail sync for live operation on the Mac mini
  - remembers the last processed Gmail UID in
    `public/local/spending-mail-sync-state.json`
  - appends only new parsed transactions to
    `public/local/spending-ledger.gmail.json`

- `deploy/com.robbonner.spending-mail-sync.plist`
  - launchd job that runs the Gmail sync every 5 minutes
  - logs to `~/worker-logs/spending-mail-sync.log` and
    `~/worker-logs/spending-mail-sync.err.log`

## Candidate Local Endpoints

```http
GET /api/budget/month/current
GET /api/budget/month/:month
GET /api/transactions/recent?limit=25
POST /api/transactions/:id/classify
POST /api/transactions/:id/ignore
POST /api/refunds/:id/mark-received
```

The `GET /api/budget/month/current` response should match
`HomeAssistantMonthlyBudgetPayload`, so Home Assistant can draw the current-date
bar, spending fill, projected month-end spend, category totals, and fidelity
flags without knowing how the ledger is stored.

## Backfill To Live Feed

Historical CSV exports are the bootstrap path. IMAP is the forward path.

```text
Chase CSV backfill
  -> SpendingTransaction[]
IMAP credit-card charge emails
  -> SpendingTransaction[]
Amazon / refund emails
  -> SpendingTransaction[]
```

All three sources must land in the same ledger contract. The CSV importer gives
Retirenment enough history to start computing monthly baselines now; the IMAP
processor can later append new transactions without changing the UI or Home
Assistant payload.

Generate the current local Chase payload:

```sh
node --import tsx scripts/import-chase-spending.ts \
  --out public/local/spending-ledger.chase4582.json \
  /Users/robbonner/Desktop/Chase4582_Activity20250101_20251231_20260508.CSV \
  /Users/robbonner/Desktop/Chase4582_Activity20260101_20260508_20260508.CSV
```

Generate the current local Amex payload:

```sh
node --import tsx scripts/import-amex-spending.ts \
  --account amex-11000 \
  --out public/local/spending-ledger.amex.json \
  /Users/robbonner/Desktop/activity-9.csv \
  /Users/robbonner/Desktop/activity-8.csv \
  /Users/robbonner/Desktop/activity-7.csv \
  /Users/robbonner/Desktop/activity-6.csv \
  /Users/robbonner/Desktop/activity-5.csv
```

Generate the current local SoFi payload:

```sh
node --import tsx scripts/import-sofi-spending.ts \
  --out public/local/spending-ledger.sofi.json \
  /Users/robbonner/Desktop/SOFI-JointSavings•9220-2026-05-08T08_28_20.csv \
  /Users/robbonner/Desktop/SOFI-JointChecking•1882-2026-05-08T08_28_13.csv
```

Peek at transaction Gmail headers:

```sh
node --import tsx scripts/peek-gmail-imap.ts \
  --since 2026-01-01 \
  --limit 50 \
  --out public/local/gmail-imap-peek.json
```

Peek with a Gmail-native search query, useful after forwarding Amazon mail:

```sh
node --import tsx scripts/peek-gmail-imap.ts \
  --gmail-query 'amazon newer:2026/1/1' \
  --limit 25 \
  --out public/local/gmail-amazon-query-peek.json
```

Import recent Gmail transaction emails into the local ledger:

```sh
node --import tsx scripts/import-gmail-spending.ts \
  --since 2026-01-01 \
  --limit 100 \
  --out public/local/spending-ledger.gmail.json
```

Run the stateful live sync once:

```sh
npm run spending:gmail:sync
```

Install or refresh the 5-minute Mac mini LaunchAgent:

```sh
npm run spending:gmail:launchd:install
```

Use a Gmail app password in `.env.local`, not the normal Google account
password. The generated peek/import JSON files are ignored by git. The peek
file contains message metadata only; the Gmail ledger file contains parsed
transactions and source evidence without storing raw email bodies. The sync
state file stores only mailbox identity and the last seen Gmail UID.

The generated JSON is ignored by git because it contains household financial
history. The browser app attempts to fetch it from `/local/spending-ledger.chase4582.json`;
`/local/spending-ledger.amex.json`; and `/local/spending-ledger.sofi.json`. If
`/local/spending-ledger.sofi.json`; and `/local/spending-ledger.gmail.json`. If
none are present, the Spending screen falls back to demo transactions.
