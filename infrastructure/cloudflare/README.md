# Cloudflare Infrastructure Setup Guide

This directory contains configuration templates and guides for setting up the required Cloudflare bindings and secrets.

## Required Bindings

### 1. D1 Database
Create a D1 database named `zebrabyte_db`:
```bash
npx wrangler d1 create zebrabyte_db
```
Configure the database ID in the `wrangler.toml` file of each worker.

Run migrations to initialize the database schema:
```bash
npx wrangler d1 migrations apply zebrabyte_db --local
# For production:
npx wrangler d1 migrations apply zebrabyte_db --remote
```

### 2. R2 Storage Bucket
Create an R2 bucket for ticks and backtesting history:
```bash
npx wrangler r2 bucket create zebrabyte_r2
```

### 3. Service Bindings
Verify that `workers/api` has the `RISK_WORKER` binding referencing the `zebrabyte-risk` worker.

---

## Secrets Configuration

Configure the following secrets in your Cloudflare environment.

### API Worker / Durable Object Secrets
```bash
# Set cTrader application access credentials
npx wrangler secret put CTRADER_CLIENT_ID
npx wrangler secret put CTRADER_CLIENT_SECRET
```

### Telegram Bot Webhook Secrets
```bash
# Set Telegram Token for bot communications
npx wrangler secret put TELEGRAM_BOT_TOKEN
```
Set the Webhook URI on Telegram:
```bash
curl -X POST "https://api.telegram.org/bot<YOUR_TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://telegram.YOUR_SUBDOMAIN.workers.dev"}'
```
