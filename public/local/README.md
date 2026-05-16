# Local Spending Data

Generated spending-ledger JSON files can live here for local development.

These files are intentionally ignored by git because they contain household
financial history. Generate the Chase backfill with:

```sh
node --import tsx scripts/import-chase-spending.ts \
  --out public/local/spending-ledger.chase4582.json \
  /path/to/Chase4582_Activity.csv
```

## Model Verification Reports

The Model Health screen reads the latest local verifier output from:

```txt
public/local/model-verification-report.json
public/local/model-verification-quick-report.json
```

Refresh those files by running:

```sh
npm run verify:model:quick:strict
npm run verify:model:strict
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

## 6 Pack Home Assistant API

Run the local read-only API that Home Assistant can poll:

```sh
npm run six-pack:api
```

Install it as a macOS LaunchAgent so it starts at login and restarts if it
crashes:

```sh
npm run six-pack:api:launchd:install
```

Uninstall it:

```sh
npm run six-pack:api:launchd:uninstall
```

Logs:

```txt
~/worker-logs/six-pack-api.log
~/worker-logs/six-pack-api.err.log
```

By default, the API runs a reduced deterministic plan evaluation and caches it
for 15 minutes so `Plan Integrity` and `Tax / ACA / IRMAA` are available to the
wall panel. To temporarily disable that heavier read:

```sh
SIX_PACK_API_PLAN_EVAL=off npm run six-pack:api
```

Refresh the local market quote snapshot used by the Portfolio Weather puck:

```sh
npm run portfolio:quotes
```

Install the quote refresh as an hourly macOS LaunchAgent:

```sh
npm run portfolio:quotes:launchd:install
```

Uninstall it:

```sh
npm run portfolio:quotes:launchd:uninstall
```

Logs:

```txt
~/worker-logs/portfolio-quotes-refresh.log
~/worker-logs/portfolio-quotes-refresh.err.log
```

When a new Fidelity positions export is available, enrich `seed-data.json` with
share quantities and import prices before refreshing quotes:

```sh
npm run portfolio:fidelity:enrich -- --csv "$HOME/Obfuscate/Portfolio_Positions_Apr-30-2026.redacted.csv"
npm run portfolio:fidelity:enrich -- --csv "$HOME/Obfuscate/Portfolio_Positions_Apr-30-2026.redacted.csv" --apply
```

Compare a newer Fidelity export against the current Portfolio Weather estimate
without loading that export into the model:

```sh
npm run portfolio:weather:compare -- --csv "$HOME/Obfuscate/Portfolio_Positions_May-10-2026.redacted.csv"
```

The comparison keeps the model cash bucket separate because it is not part of
the Fidelity positions export.

Default base URL:

```txt
http://127.0.0.1:8787
```

Available endpoints:

```txt
GET /api/health
GET /api/six-pack
GET /api/home-assistant/six-pack
GET /api/home-assistant/six-pack/panel
GET /api/home-assistant/six-pack/lifestyle_pace
GET /api/home-assistant/six-pack/cash_runway
GET /api/home-assistant/six-pack/portfolio_weather
GET /api/home-assistant/six-pack/plan_integrity
GET /api/home-assistant/six-pack/tax_cliffs
GET /api/home-assistant/six-pack/watch_items
```

The Home Assistant payload intentionally exposes sweep status and puck summaries,
not raw transactions or holding-level account detail.

For a wall-panel card, use `GET /api/home-assistant/six-pack/panel`. It returns
one compact payload with all six pucks in display order, including status color,
headline, trend symbol, optional front metric, stale flag, and reason.

Example Home Assistant files:

```txt
deploy/home-assistant/six-pack-panel-package.yaml
deploy/home-assistant/six-pack-markdown-card.yaml
```

The package creates one REST sensor for the full panel plus a few template
sensors for common summary fields. The markdown card is a native dashboard card
that renders all six pucks from `sensor.six_pack_panel`.
