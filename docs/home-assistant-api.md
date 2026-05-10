# Home Assistant API

Flight Path exposes a small local API for Home Assistant and other LAN tools.

Default base URL:

```text
http://127.0.0.1:8787
```

If Home Assistant runs on another machine, the API host must be changed from
`127.0.0.1` to a LAN-reachable address in the launchd plist or environment.
Keep it LAN-only; the current API has no authentication.

## Service

Start manually:

```bash
npm run six-pack:api
```

Install/restart as a macOS launch agent:

```bash
npm run six-pack:api:launchd:install
```

Health check:

```http
GET /api/health
```

## 6 Pack

Overall status:

```http
GET /api/home-assistant/six-pack
```

Full panel payload for recreating the six pucks:

```http
GET /api/home-assistant/six-pack/panel
```

Single puck:

```http
GET /api/home-assistant/six-pack/{puck_id}
```

Valid puck ids:

```text
lifestyle_pace
cash_runway
portfolio_weather
plan_integrity
tax_cliffs
watch_items
```

## Recent Spending Transactions

List the newest 33 transactions with Home Assistant-friendly numeric handles:

```http
GET /api/spending/transactions/recent
```

Example response item:

```json
{
  "idNumber": 1,
  "transactionId": "gmail-2026-05-10-cf266c7b",
  "merchant": "DSW",
  "amount": 97.41,
  "categoryId": "uncategorized",
  "ignored": false,
  "actions": {
    "classify": "/api/spending/transactions/recent/1/override",
    "ignore": "/api/spending/transactions/recent/1/ignore",
    "clearOverride": "/api/spending/transactions/recent/1/override"
  }
}
```

Important: `idNumber` is scoped to the current newest 33 transactions. Refresh
`GET /api/spending/transactions/recent` immediately before acting so the number
still points to the intended transaction.

## Classify Or Ignore

Classify by numeric handle:

```http
POST /api/spending/transactions/recent/{idNumber}/override
Content-Type: application/json
```

```json
{
  "categoryId": "essential",
  "title": "Groceries"
}
```

Ignore by numeric handle:

```http
POST /api/spending/transactions/recent/{idNumber}/ignore
Content-Type: application/json
```

```json
{
  "title": "Not budget spend"
}
```

Clear a transaction override:

```http
DELETE /api/spending/transactions/recent/{idNumber}/override
```

You can also act on the stable transaction id directly:

```http
POST /api/spending/transactions/{transactionId}/override
POST /api/spending/transactions/{transactionId}/ignore
DELETE /api/spending/transactions/{transactionId}/override
```

Supported `categoryId` values:

```text
essential
optional
health
travel
taxes_insurance
long_term_items
generosity
family_transfers
ignored
uncategorized
amazon_uncategorized
```

Overrides are stored in:

```text
public/local/spending-overrides.json
```

The Spending tab and 6 Pack API both read that shared override store.

