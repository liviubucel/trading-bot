-- Initial Schema for Zebrabyte Trading Platform

-- 1. Connected cTrader / Broker accounts
CREATE TABLE IF NOT EXISTS accounts (
  accountId TEXT PRIMARY KEY,
  brokerName TEXT NOT NULL,
  depositAsset TEXT NOT NULL DEFAULT 'USD',
  balance REAL NOT NULL DEFAULT 0.0,
  equity REAL NOT NULL DEFAULT 0.0,
  isConnected INTEGER NOT NULL DEFAULT 0, -- 0 = false, 1 = true
  tokenData TEXT, -- Encrypted JSON string holding OAuth tokens (accessToken, refreshToken, etc.)
  updatedAt INTEGER NOT NULL
);

-- 2. Open Positions
CREATE TABLE IF NOT EXISTS positions (
  positionId TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  symbol TEXT NOT NULL,
  volume REAL NOT NULL,
  entryPrice REAL NOT NULL,
  tradeSide TEXT NOT NULL CHECK (tradeSide IN ('BUY', 'SELL')),
  stopLoss REAL,
  takeProfit REAL,
  unrealizedPl REAL NOT NULL DEFAULT 0.0,
  openedAt INTEGER NOT NULL,
  FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE
);

-- 3. Pending Orders
CREATE TABLE IF NOT EXISTS orders (
  orderId TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  symbol TEXT NOT NULL,
  volume REAL NOT NULL,
  limitPrice REAL,
  stopPrice REAL,
  tradeSide TEXT NOT NULL CHECK (tradeSide IN ('BUY', 'SELL')),
  orderType TEXT NOT NULL CHECK (orderType IN ('MARKET', 'LIMIT', 'STOP')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'FILLED', 'CANCELLED')),
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE
);

-- 4. Historical Trades
CREATE TABLE IF NOT EXISTS historical_trades (
  tradeId TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  symbol TEXT NOT NULL,
  volume REAL NOT NULL,
  entryPrice REAL NOT NULL,
  closePrice REAL NOT NULL,
  tradeSide TEXT NOT NULL CHECK (tradeSide IN ('BUY', 'SELL')),
  realizedPl REAL NOT NULL,
  closedAt INTEGER NOT NULL,
  FOREIGN KEY (accountId) REFERENCES accounts(accountId) ON DELETE CASCADE
);

-- 5. Audit Log (every command, risk check, heartbeat, error)
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('INFO', 'WARN', 'ERROR', 'CRITICAL')),
  accountId TEXT NOT NULL,
  component TEXT NOT NULL,
  action TEXT NOT NULL,
  message TEXT NOT NULL,
  contextJson TEXT -- Extra contextual JSON metadata
);

-- 6. Configuration (dynamic parameters like risk rules, kill switch, etc.)
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  valueJson TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
);

-- 7. Economic Calendar for News Locks
CREATE TABLE IF NOT EXISTS news_calendar (
  id TEXT PRIMARY KEY,
  time INTEGER NOT NULL, -- Unix timestamp in ms
  currency TEXT NOT NULL,
  eventName TEXT NOT NULL,
  impactLevel TEXT NOT NULL CHECK (impactLevel IN ('LOW', 'MEDIUM', 'HIGH')),
  actual REAL,
  forecast REAL,
  previous REAL
);

-- Insert Default Config Key/Values
INSERT OR REPLACE INTO config (key, valueJson, updatedAt) VALUES (
  'risk_config',
  '{"maxRiskPerTradePercent":1.0,"maxDailyLossPercent":5.0,"maxOpenExposureUnits":{"US30":100,"XAUUSD":500},"spreadProtectionPips":{"US30":15.0,"XAUUSD":3.5},"slippageProtectionPips":2.0,"newsLockMinutesBefore":15,"newsLockMinutesAfter":15,"globalKillSwitch":false}',
  1783984800000 -- Hardcoded baseline timestamp (2026-07-14)
);

INSERT OR REPLACE INTO config (key, valueJson, updatedAt) VALUES (
  'safety_config',
  '{"enableLiveTrading":false}',
  1783984800000
);
