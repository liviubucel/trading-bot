# Zebrabyte Trading Platform

Zebrabyte is a Cloudflare-native algorithmic trading platform. It connects directly to the cTrader Open API using outbound TCP sockets and Protobuf, removing the need for an always-on VPS, Wine, or MetaTrader terminal.

## Repository Structure

- `apps/dashboard`: Admin panel SPA for monitoring status, prices, positions, and logs.
- `workers/api`: Core HTTP endpoint router, OAuth handler, and asset server.
- `workers/risk`: Check engine enforcing exposure limits, news locks, daily loss, and idempotency.
- `workers/telegram`: Webhook processor routing user queries to status panels.
- `workers/news`: Scheduler fetching upcoming economic calendars to arm news locks.
- `durable-objects/ctrader-account`: DO maintaining persistent TCP socket streams and heartbeats.
- `packages/contracts`: Shared TypeScript data structures and parameter schemas.
- `packages/ctrader-protocol`: Custom Protobuf serialization and socket framing parser.
- `packages/risk-engine`: Core business logic evaluating deterministic trading locks.
- `packages/market-models`: Pip dimensions, broker symbols translation, and metadata.
- `database/migrations`: Database schema definitions and baseline insertions.
- `tests/unit`: Tests validating protocol serialization and risk validations.
- `tests/integration`: Tests checking socket connections, mock server streaming, and command idempotency.
- `docs/architecture`: C4 system layout and component interactions.
- `infrastructure/cloudflare`: Guides to initialize D1 database, R2 storage, and wrangler secrets.

---

## Local Development & Setup

### 1. Prerequisites
- Node.js (v20+ recommended)
- Cloudflare Wrangler CLI (`npm install -g wrangler` or run via `npx wrangler`)

### 2. Install Workspace Dependencies
Execute the command below at the root to map internal workspaces:
```bash
npm install
```

### 3. Initialize D1 Local Database
Set up D1 schema locally:
```bash
npx wrangler d1 migrations apply zebrabyte_db --local
```

### 4. Run Tests
Validate the monorepo using Vitest (which runs all unit and integration tests):
```bash
npm run test
```

### 5. Running Workers Locally
Run wrangler dev servers concurrently:
```bash
# Start API Worker (listening on port 8787)
npx wrangler dev --cwd workers/api

# Start Risk Worker (listening on port 8788)
npx wrangler dev --cwd workers/risk --port 8788

# Start Telegram Bot Worker (listening on port 8789)
npx wrangler dev --cwd workers/telegram --port 8789
```

---

## Testing Webhooks & Sockets Locally

### Test Telegram Webhook Locally
You can test the Telegram webhook locally using a standard `curl` POST command without connecting to real Telegram servers:
```bash
curl -X POST http://localhost:8789 \
     -H "Content-Type: application/json" \
     -d '{"message": {"text": "/status", "chat": {"id": 12345}}}'
```
The response will return the platform status markdown.

### Test cTrader Socket Reconnections
The integration test suite (`tests/integration/ctrader.test.ts`) verifies socket reconnections by starting a mock TCP server, connecting the Durable Object, and manually calling `simulateDisconnection()`. The Durable Object automatically establishes a fresh connection after 1 second.