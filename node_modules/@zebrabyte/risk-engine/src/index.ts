import { RiskConfig, TradingCommand, Position, CalendarEvent } from "@zebrabyte/contracts";

export interface RiskContext {
  equity: number;
  balance: number;
  dailyStartingBalance: number;
  activePositions: Position[];
  upcomingNews: CalendarEvent[];
  latestBid: number;
  latestAsk: number;
  symbolPipSize: number; // e.g. 0.01 for XAUUSD, 1.0 for US30
  symbolPipValue: number; // USD value per unit change in pip
}

export interface RiskResult {
  allowed: boolean;
  reason?: string;
  ruleEvaluated: string;
}

export class RiskEngine {
  public static evaluateCommand(
    command: TradingCommand,
    config: RiskConfig,
    context: RiskContext
  ): RiskResult {
    // 1. Global Kill Switch Check
    if (config.globalKillSwitch) {
      return {
        allowed: false,
        reason: "Global kill switch is active. All execution is blocked.",
        ruleEvaluated: "GLOBAL_KILL_SWITCH",
      };
    }

    // 2. Maximum Daily Loss Check
    const dailyStartingBalance = context.dailyStartingBalance;
    const currentEquity = context.equity;
    const maxDailyLossAmount = dailyStartingBalance * (config.maxDailyLossPercent / 100);
    const currentDailyLoss = dailyStartingBalance - currentEquity;

    if (currentDailyLoss >= maxDailyLossAmount) {
      return {
        allowed: false,
        reason: `Maximum daily loss limit reached. Daily loss: $${currentDailyLoss.toFixed(2)}, Limit: $${maxDailyLossAmount.toFixed(2)}`,
        ruleEvaluated: "MAX_DAILY_LOSS",
      };
    }

    // Only apply trading exposure, spread, slippage, and risk limits for PLACE_ORDER action
    if (command.action === "PLACE_ORDER") {
      const symbol = command.symbol as "US30" | "XAUUSD";
      if (symbol !== "US30" && symbol !== "XAUUSD") {
        return {
          allowed: false,
          reason: `Unsupported symbol for risk evaluation: ${command.symbol}`,
          ruleEvaluated: "SYMBOL_VALIDATION",
        };
      }

      // 3. Spread Protection
      const currentSpreadPips = (context.latestAsk - context.latestBid) / context.symbolPipSize;
      const allowedSpreadPips = config.spreadProtectionPips[symbol];
      if (currentSpreadPips > allowedSpreadPips) {
        return {
          allowed: false,
          reason: `Spread is too wide. Current spread: ${currentSpreadPips.toFixed(1)} pips, Max allowed: ${allowedSpreadPips} pips`,
          ruleEvaluated: "SPREAD_PROTECTION",
        };
      }

      // 4. Slippage Protection (if command contains a requested execution price)
      if (command.price !== undefined) {
        const marketPrice = command.tradeSide === "BUY" ? context.latestAsk : context.latestBid;
        const slippagePips = Math.abs(command.price - marketPrice) / context.symbolPipSize;
        if (slippagePips > config.slippageProtectionPips) {
          return {
            allowed: false,
            reason: `Potential slippage exceeds limit. Market price: ${marketPrice}, Command price: ${command.price}, Deviation: ${slippagePips.toFixed(1)} pips, Max allowed: ${config.slippageProtectionPips} pips`,
            ruleEvaluated: "SLIPPAGE_PROTECTION",
          };
        }
      }

      // 5. Maximum Open Exposure
      const existingExposure = context.activePositions
        .filter((p) => p.symbol === command.symbol)
        .reduce((sum, p) => sum + p.volume, 0);
      const newExposure = existingExposure + command.volume;
      const maxAllowedExposure = config.maxOpenExposureUnits[symbol];
      if (newExposure > maxAllowedExposure) {
        return {
          allowed: false,
          reason: `Command exceeds maximum open exposure for ${symbol}. Current: ${existingExposure} units, Proposed: ${newExposure} units, Limit: ${maxAllowedExposure} units`,
          ruleEvaluated: "MAX_OPEN_EXPOSURE",
        };
      }

      // 6. Maximum Risk Per Trade (requires Stop Loss to calculate)
      if (command.stopLoss !== undefined && command.price !== undefined) {
        const entryPrice = command.price;
        const stopLoss = command.stopLoss;
        const distancePips = Math.abs(entryPrice - stopLoss) / context.symbolPipSize;
        const riskAmount = distancePips * context.symbolPipValue * command.volume;
        const maxRiskAmount = context.equity * (config.maxRiskPerTradePercent / 100);

        if (riskAmount > maxRiskAmount) {
          return {
            allowed: false,
            reason: `Risk per trade too high. Projected loss: $${riskAmount.toFixed(2)}, Max allowed (1% equity): $${maxRiskAmount.toFixed(2)}`,
            ruleEvaluated: "MAX_RISK_PER_TRADE",
          };
        }
      } else if (command.stopLoss === undefined) {
        // We require a Stop Loss for all executed orders to prevent uncapped risk
        return {
          allowed: false,
          reason: "Stop loss is required for all order placement commands.",
          ruleEvaluated: "STOP_LOSS_REQUIRED",
        };
      }

      // 7. News Lock check
      const now = Date.now();
      for (const event of context.upcomingNews) {
        if (event.impactLevel === "HIGH") {
          const lockStart = event.time - config.newsLockMinutesBefore * 60 * 1000;
          const lockEnd = event.time + config.newsLockMinutesAfter * 60 * 1000;
          if (now >= lockStart && now <= lockEnd) {
            return {
              allowed: false,
              reason: `Trading blocked due to news lock for high-impact event: "${event.eventName}" at ${new Date(event.time).toISOString()}`,
              ruleEvaluated: "NEWS_LOCK",
            };
          }
        }
      }
    }

    return {
      allowed: true,
      ruleEvaluated: "ALL_PASSED",
    };
  }
}
