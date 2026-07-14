import { describe, it, expect } from "vitest";
import telegramWorker from "../../workers/telegram/src/index";

describe("Telegram Webhook Integration Tests", () => {
  const mockDb: any = {
    prepare: (query: string) => {
      return {
        bind: (...args: any[]) => {
          return {
            first: async () => {
              if (query.includes("config") && query.includes("risk_config")) {
                return { valueJson: JSON.stringify({ globalKillSwitch: false }) };
              }
              if (query.includes("config") && query.includes("safety_config")) {
                return { valueJson: JSON.stringify({ enableLiveTrading: false }) };
              }
              return null;
            },
            all: async () => {
              if (query.includes("accounts")) {
                return {
                  results: [
                    { accountId: "12345", brokerName: "ICMarkets", balance: 95000.0, equity: 95150.0, isConnected: 1 }
                  ]
                };
              }
              if (query.includes("news_calendar")) {
                return {
                  results: [
                    { id: "1", time: Date.now() + 600000, currency: "USD", eventName: "FOMC Minutes", impactLevel: "HIGH" }
                  ]
                };
              }
              if (query.includes("audit_logs")) {
                return {
                  results: [
                    { timestamp: Date.now(), level: "INFO", component: "news-worker", action: "NEWS_SYNC", message: "Mock news sync complete" }
                  ]
                };
              }
              return { results: [] };
            }
          };
        },
        all: async () => {
          if (query.includes("accounts")) {
            return {
              results: [
                { accountId: "12345", brokerName: "ICMarkets", balance: 95000.0, equity: 95150.0, isConnected: 1 }
              ]
            };
          }
          if (query.includes("news_calendar")) {
            return {
              results: [
                { id: "1", time: Date.now() + 600000, currency: "USD", eventName: "FOMC Minutes", impactLevel: "HIGH" }
              ]
            };
          }
          if (query.includes("audit_logs")) {
            return {
              results: [
                { timestamp: Date.now(), level: "INFO", component: "news-worker", action: "NEWS_SYNC", message: "Mock news sync complete" }
              ]
            };
          }
          return { results: [] };
        },
        first: async () => {
          if (query.includes("config") && query.includes("risk_config")) {
            return { valueJson: JSON.stringify({ globalKillSwitch: false }) };
          }
          if (query.includes("config") && query.includes("safety_config")) {
            return { valueJson: JSON.stringify({ enableLiveTrading: false }) };
          }
          return null;
        }
      };
    }
  };

  const mockDoNamespace: any = {
    idFromName: () => ({}),
    get: () => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        if (url.pathname === "/status") {
          return new Response(JSON.stringify({ balance: 95000.0, equity: 95150.0, isConnected: true }));
        }
        if (url.pathname === "/positions") {
          return new Response(JSON.stringify([
            { positionId: "pos_1", accountId: "12345", symbol: "XAUUSD", volume: 100, entryPrice: 2345.0, tradeSide: "BUY", unrealizedPl: 150.0, openedAt: Date.now() }
          ]));
        }
        if (url.pathname === "/orders") {
          return new Response(JSON.stringify([]));
        }
        if (url.pathname === "/prices") {
          return new Response(JSON.stringify({
            XAUUSD: { bid: 2346.5, ask: 2347.0, timestamp: Date.now() }
          }));
        }
        return new Response(JSON.stringify({}));
      }
    })
  };

  const env = {
    DB: mockDb,
    CTRADER_ACCOUNT_DO: mockDoNamespace
  };

  const makeTelegramRequest = (commandText: string) => {
    return new Request("http://telegram/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          text: commandText,
          chat: { id: 987654 }
        }
      })
    });
  };

  it("should process /status command and report correct platform state", async () => {
    const req = makeTelegramRequest("/status");
    const response = await telegramWorker.fetch(req, env);
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.method).toBe("sendMessage");
    expect(body.chat_id).toBe(987654);
    expect(body.text).toContain("ZEBRABYTE PLATFORM STATUS");
    expect(body.text).toContain("Kill Switch:");
  });

  it("should process /accounts and read stats from Durable Object", async () => {
    const req = makeTelegramRequest("/accounts");
    const response = await telegramWorker.fetch(req, env);
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.text).toContain("ZEBRABYTE ACCOUNTS REPORT");
    expect(body.text).toContain("Balance: `$95000.00`");
  });

  it("should process /positions and read active positions", async () => {
    const req = makeTelegramRequest("/positions");
    const response = await telegramWorker.fetch(req, env);
    const body: any = await response.json();
    expect(body.text).toContain("ACTIVE OPEN POSITIONS");
    expect(body.text).toContain("Symbol: `XAUUSD` | Side: `BUY`");
  });

  it("should process /market prices command", async () => {
    const req = makeTelegramRequest("/market");
    const response = await telegramWorker.fetch(req, env);
    const body: any = await response.json();
    expect(body.text).toContain("ZEBRABYTE MARKET MONITOR");
    expect(body.text).toContain("Bid: `2346.50`");
  });
});
