# Local Spending Data

Generated spending-ledger JSON files can live here for local development.

These files are intentionally ignored by git because they contain household
financial history. Generate the Chase backfill with:

```sh
node --import tsx scripts/import-chase-spending.ts \
  --out public/local/spending-ledger.chase4582.json \
  /path/to/Chase4582_Activity.csv
```

Generate the Amex travel-card backfill with:

```sh
node --import tsx scripts/import-amex-spending.ts \
  --account amex-11000 \
  --out public/local/spending-ledger.amex.json \
  /path/to/activity.csv
```

Generate the SoFi bank-statement backfill with:

```sh
node --import tsx scripts/import-sofi-spending.ts \
  --out public/local/spending-ledger.sofi.json \
  /path/to/SOFI-JointSavings.csv \
  /path/to/SOFI-JointChecking.csv
```

Peek at the transaction Gmail account over IMAP with:

```sh
node --import tsx scripts/peek-gmail-imap.ts \
  --since 2026-01-01 \
  --limit 50 \
  --out public/local/gmail-imap-peek.json
```

Or peek with Gmail search syntax:

```sh
node --import tsx scripts/peek-gmail-imap.ts \
  --gmail-query 'amazon newer:2026/1/1' \
  --limit 25 \
  --out public/local/gmail-amazon-query-peek.json
```

The peek script fetches only message headers by default: UID, date, from,
subject, message id, and size. It does not fetch email bodies.

Import recent Gmail transaction emails with:

```sh
node --import tsx scripts/import-gmail-spending.ts \
  --since 2026-01-01 \
  --limit 100 \
  --out public/local/spending-ledger.gmail.json
```

Run the stateful sync once with:

```sh
npm run spending:gmail:sync
```

Install or refresh the 5-minute LaunchAgent with:

```sh
npm run spending:gmail:launchd:install
```

Both Gmail scripts read credentials from `.env.local` at the project root:

```sh
GMAIL_IMAP_USER=bonnertransactions@gmail.com
GMAIL_IMAP_APP_PASSWORD=<gmail app password>
```

Use a Gmail app password, not the regular account password.
