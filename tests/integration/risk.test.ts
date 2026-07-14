import { describe, it, expect } from "vitest";
import riskWorker from "../../workers/risk/src/index";

describe("Risk Worker Idempotency & Duplicate Blocking", () => {
  let auditLogs: any[] = [];
  const mockDb: any = {
    prepare: (query: string) => {
      const stmt: any = {
        args: [] as any[],
        bind: (...args: any[]) => {
          stmt.args = args;
          return stmt;
        },
        first: async () => {
          const args = stmt.args;
          if (query.includes("COUNT(*)")) {
            const match = auditLogs.some(
              (log) => log.contextJson && log.contextJson.includes("cmd_dup_check")
            );
            return { count: match ? 1 : 0 };
          }
          if (query.includes("config") && query.includes("risk_config")) {
            return {
              valueJson: JSON.stringify({
                maxRiskPerTradePercent: 1.0,
                maxDailyLossPercent: 5.0,
                maxOpenExposureUnits: { US30: 100, XAUUSD: 500 },
                spreadProtectionPips: { US30: 10, XAUUSD: 3 },
                slippageProtectionPips: 2,
                newsLockMinutesBefore: 15,
                newsLockMinutesAfter: 15,
                globalKillSwitch: false,
              })
            };
          }
          return null;
        },
        run: async () => {
          const args = stmt.args;
          if (query.includes("INSERT INTO audit_logs")) {
            auditLogs.push({
              timestamp: args[0],
              level: args[1],
              accountId: args[2],
              component: args[3],
              action: args[4],
              message: args[5],
              contextJson: args[6],
            });
          }
          return {};
        },
        all: async () => {
          return { results: [] };
        }
      };
      return stmt;
    }
  };

  const mockDoNamespace: any = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async () => {
        return new Response(
          JSON.stringify({
            balance: 100000.0,
            equity: 100000.0,
            prices: { XAUUSD: { bid: 2350.0, ask: 2350.01, timestamp: Date.now() } }
          })
        );
      }
    })
  };

  const env = {
    DB: mockDb,
    CTRADER_ACCOUNT_DO: mockDoNamespace
  };

  it("should process the first command and block the second command as a duplicate", async () => {
    // Reset audit log cache
    auditLogs = [];

    const commandPayload = {
      commandId: "cmd_dup_check",
      accountId: "12345",
      action: "PLACE_ORDER",
      symbol: "XAUUSD",
      volume: 100,
      tradeSide: "BUY",
      orderType: "MARKET",
      price: 2350.01,
      stopLoss: 2345.0,
      timestamp: Date.now()
    };

    // 1. Submit first command
    const req1 = new Request("http://risk/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandPayload)
    });
    
    const res1 = await riskWorker.fetch(req1, env);
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as any;
    expect(body1.allowed).toBe(true);

    // 2. Submit second command (with identical commandId)
    const req2 = new Request("http://risk/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(commandPayload)
    });
    
    const res2 = await riskWorker.fetch(req2, env);
    expect(res2.status).toBe(400); // Bad Request / Blocked
    const body2 = await res2.json() as any;
    expect(body2.allowed).toBe(false);
    expect(body2.ruleEvaluated).toBe("DUPLICATE_ORDER_PROTECTION");
  });
});
