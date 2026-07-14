import { describe, it, expect } from "vitest";
import { RiskEngine, RiskContext } from "../../packages/risk-engine/src/index";
import { RiskConfig, TradingCommand } from "../../packages/contracts/src/index";

describe("Risk Engine Rules Validation", () => {
  const defaultConfig: RiskConfig = {
    maxRiskPerTradePercent: 1.0,
    maxDailyLossPercent: 5.0,
    maxOpenExposureUnits: {
      US30: 100,
      XAUUSD: 500,
    },
    spreadProtectionPips: {
      US30: 10,
      XAUUSD: 3.0,
    },
    slippageProtectionPips: 2.0,
    newsLockMinutesBefore: 15,
    newsLockMinutesAfter: 15,
    globalKillSwitch: false,
  };

  const defaultContext: RiskContext = {
    equity: 100000.0,
    balance: 100000.0,
    dailyStartingBalance: 100000.0,
    activePositions: [],
    upcomingNews: [],
    latestBid: 2350.0,
    latestAsk: 2350.02, // Spread: 2 pips (for XAUUSD pipSize 0.01)
    symbolPipSize: 0.01,
    symbolPipValue: 0.01,
  };

  const sampleCommand: TradingCommand = {
    commandId: "cmd_123",
    accountId: "12345",
    action: "PLACE_ORDER",
    symbol: "XAUUSD",
    volume: 100, // 100 units = 1 standard lot
    tradeSide: "BUY",
    orderType: "MARKET",
    price: 2350.02,
    stopLoss: 2345.0, // Risk is 5.02 pips distance * $0.01 * 100 units = $5.02
    timestamp: Date.now(),
  };

  it("should allow a normal valid trade", () => {
    const result = RiskEngine.evaluateCommand(sampleCommand, defaultConfig, defaultContext);
    expect(result.allowed).toBe(true);
  });

  it("should block trades if Global Kill Switch is armed", () => {
    const config = { ...defaultConfig, globalKillSwitch: true };
    const result = RiskEngine.evaluateCommand(sampleCommand, config, defaultContext);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Global kill switch");
  });

  it("should block trades if Daily Loss Limit is exceeded", () => {
    // Current equity is 94,900, loss is 5,100 (5.1% loss of 100k start balance)
    const context = { ...defaultContext, equity: 94900.0 };
    const result = RiskEngine.evaluateCommand(sampleCommand, defaultConfig, context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("daily loss");
  });

  it("should enforce spread protection", () => {
    // Bid: 2350, Ask: 2354 -> Spread is 400 pips (allowed is 3.0 pips)
    const context = { ...defaultContext, latestAsk: 2354.0 };
    const result = RiskEngine.evaluateCommand(sampleCommand, defaultConfig, context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Spread is too wide");
  });

  it("should enforce slippage protection", () => {
    // Command price: 2350.5, Market price: Ask 2350.1 -> Deviation is 0.4 / 0.01 = 40 pips (limit is 2.0 pips)
    const cmd = { ...sampleCommand, price: 2350.5 };
    const result = RiskEngine.evaluateCommand(cmd, defaultConfig, defaultContext);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("slippage exceeds limit");
  });

  it("should block trade if it violates news lock window", () => {
    const now = Date.now();
    const context = {
      ...defaultContext,
      upcomingNews: [
        {
          id: "news_1",
          time: now + 5 * 60 * 1000, // event is in 5 minutes (within 15m lock window)
          currency: "USD",
          eventName: "FOMC Statement",
          impactLevel: "HIGH",
        },
      ],
    };
    const result = RiskEngine.evaluateCommand(sampleCommand, defaultConfig, context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("news lock");
  });

  it("should require stop loss for placing orders", () => {
    const cmd = { ...sampleCommand, stopLoss: undefined };
    const result = RiskEngine.evaluateCommand(cmd, defaultConfig, defaultContext);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Stop loss is required");
  });

  it("should enforce maximum open exposure limit", () => {
    const context = {
      ...defaultContext,
      activePositions: [
        {
          positionId: "pos_exist",
          accountId: "12345",
          symbol: "XAUUSD",
          volume: 450, // current exposure 450 units
          entryPrice: 2340.0,
          tradeSide: "BUY" as const,
          unrealizedPl: 0,
          openedAt: Date.now(),
        },
      ],
    };
    // new volume is 100 -> total 550 units (exceeds maxOpenExposureUnits 500)
    const result = RiskEngine.evaluateCommand(sampleCommand, defaultConfig, context);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("maximum open exposure");
  });
});
