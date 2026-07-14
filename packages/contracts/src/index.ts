export interface AccountStatus {
  accountId: string;
  brokerName: string;
  depositAsset: string;
  balance: number;
  equity: number;
  isConnected: boolean;
  lastUpdated: number;
}

export type TradeSide = "BUY" | "SELL";

export interface Position {
  positionId: string;
  accountId: string;
  symbol: string;
  volume: number; // Volume in units
  entryPrice: number;
  tradeSide: TradeSide;
  stopLoss?: number;
  takeProfit?: number;
  unrealizedPl: number;
  openedAt: number;
}

export type OrderStatus = "PENDING" | "FILLED" | "CANCELLED";
export type OrderType = "MARKET" | "LIMIT" | "STOP";

export interface Order {
  orderId: string;
  accountId: string;
  symbol: string;
  volume: number;
  limitPrice?: number;
  stopPrice?: number;
  tradeSide: TradeSide;
  orderType: OrderType;
  status: OrderStatus;
  createdAt: number;
}

export interface HistoricalTrade {
  tradeId: string;
  accountId: string;
  symbol: string;
  volume: number;
  entryPrice: number;
  closePrice: number;
  tradeSide: TradeSide;
  realizedPl: number;
  closedAt: number;
}

export interface SymbolMapping {
  baseSymbol: "US30" | "XAUUSD";
  brokerSymbol: string;
}

export interface TradingCommand {
  commandId: string; // Idempotency key / clientMsgId
  accountId: string;
  action: "PLACE_ORDER" | "CANCEL_ORDER" | "CLOSE_POSITION";
  symbol: string;
  volume: number;
  tradeSide?: TradeSide;
  orderType?: OrderType;
  price?: number; // target price for limit/stop, or slippage execution price
  stopLoss?: number;
  takeProfit?: number;
  timestamp: number;
}

export interface RiskConfig {
  maxRiskPerTradePercent: number; // e.g. 1% of equity
  maxDailyLossPercent: number;    // e.g. 5% of daily starting balance
  maxOpenExposureUnits: {
    US30: number;
    XAUUSD: number;
  };
  spreadProtectionPips: {
    US30: number;
    XAUUSD: number;
  };
  slippageProtectionPips: number;
  newsLockMinutesBefore: number;
  newsLockMinutesAfter: number;
  globalKillSwitch: boolean;
}

export interface AuditLog {
  id?: number;
  timestamp: number;
  level: "INFO" | "WARN" | "ERROR" | "CRITICAL";
  accountId: string;
  component: string;
  action: string;
  message: string;
  contextJson?: string;
}

export interface CalendarEvent {
  id: string;
  time: number; // Unix timestamp
  currency: string; // e.g. USD
  eventName: string;
  impactLevel: "LOW" | "MEDIUM" | "HIGH";
  actual?: number;
  forecast?: number;
  previous?: number;
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  scope: string;
  updatedAt: number;
}
