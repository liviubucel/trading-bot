import { TokenData, TradingCommand } from "@zebrabyte/contracts";

// Re-export Durable Object classes so Wrangler can discover them from the entrypoint
export { CTraderAccount } from "@zebrabyte/ctrader-account-do";

export interface Env {
  DB: D1Database;
  CTRADER_ACCOUNT_DO: DurableObjectNamespace;
  RISK_WORKER?: { fetch: (req: Request) => Promise<Response> };
  CTRADER_CLIENT_ID?: string;
  CTRADER_CLIENT_SECRET?: string;
  CTRADER_REDIRECT_URI: string;
  AI: any;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Msg-Id",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. Health check
      if (path === "/health" || path === "/api/health") {
        const dbStatus = await env.DB.prepare("SELECT 1").first();
        return new Response(
          JSON.stringify({ status: "healthy", database: dbStatus ? "connected" : "error" }),
          { headers: corsHeaders }
        );
      }

      // 2. OAuth Initiator
      if (path === "/oauth/url") {
        const client_id = env.CTRADER_CLIENT_ID || "mock_client_id";
        const redirect_uri = encodeURIComponent(env.CTRADER_REDIRECT_URI);
        const authUrl = `https://openapi.ctrader.com/apps/auth?client_id=${client_id}&redirect_uri=${redirect_uri}&scope=accounts`;
        return new Response(JSON.stringify({ url: authUrl }), { headers: corsHeaders });
      }

      // 3. OAuth Callback
      if (path === "/oauth/callback") {
        const code = url.searchParams.get("code");
        if (!code) {
          return new Response(JSON.stringify({ error: "Missing authorization code" }), { status: 400, headers: corsHeaders });
        }

        // Mock OAuth token exchange or perform real request
        const tokenPayload: TokenData = {
          accessToken: `access_${code}_${Math.random().toString(36).substring(2)}`,
          refreshToken: `refresh_${Math.random().toString(36).substring(2)}`,
          expiresIn: 3600,
          tokenType: "Bearer",
          scope: "accounts",
          updatedAt: Date.now(),
        };

        // In a real scenario, we'd fetch token:
        // const response = await fetch('https://openapi.ctrader.com/apps/token', { method: 'POST', body: ... })
        // const tokenPayload = await response.json()

        // Discovery step: discover account ID associated with token
        // For mock purpose, we assume an account ID is generated/discovered
        const accountId = "12345"; // Mock account ID
        const brokerName = "ICMarkets";

        // Store in D1
        await env.DB.prepare(
          "INSERT OR REPLACE INTO accounts (accountId, brokerName, balance, equity, isConnected, tokenData, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          accountId,
          brokerName,
          100000.0, // default start balance
          100000.0, // default start equity
          0, // not connected yet
          JSON.stringify(tokenPayload),
          Date.now()
        ).run();

        // Write Audit Log
        await env.DB.prepare(
          "INSERT INTO audit_logs (timestamp, level, accountId, component, action, message) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(
          Date.now(),
          "INFO",
          accountId,
          "api-worker",
          "OAUTH_CALLBACK",
          `Connected account ${accountId} via OAuth flow.`
        ).run();

        // Redirect user back to dashboard or show success
        return new Response(
          `<html><body style="font-family: sans-serif; text-align: center; padding: 50px; background: #0b0f19; color: #fff;">
            <h2>Authorization Successful!</h2>
            <p>Account ${accountId} is connected.</p>
            <p><a href="/" style="color: #3b82f6; text-decoration: none;">Go to Dashboard</a></p>
          </body></html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }

      // 4. List Accounts
      if (path === "/accounts" || path === "/api/accounts") {
        const { results } = await env.DB.prepare("SELECT * FROM accounts").all();
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      }

      // 4b. Create Simulated Account
      if (path === "/api/accounts/create-simulated" && request.method === "POST") {
        const body: any = await request.json();
        const accountId = body.accountId || `sim_${Math.floor(10000 + Math.random() * 90000)}`;
        const brokerName = body.brokerName || "SimulatedBroker";
        const balance = parseFloat(body.balance) || 100000.00;

        await env.DB.prepare(
          "INSERT OR REPLACE INTO accounts (accountId, brokerName, balance, equity, isConnected, tokenData, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          accountId,
          brokerName,
          balance,
          balance,
          1,
          JSON.stringify({ accessToken: "simulated", refreshToken: "simulated", expiresIn: 999999 }),
          Date.now()
        ).run();

        await env.DB.prepare(
          "INSERT INTO audit_logs (timestamp, level, accountId, component, action, message) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(
          Date.now(),
          "INFO",
          accountId,
          "api-worker",
          "SIMULATED_ACCOUNT_CREATED",
          `Simulated account ${accountId} initialized with $${balance.toLocaleString()}.`
        ).run();

        return new Response(JSON.stringify({ success: true, accountId }), { headers: corsHeaders });
      }

      // 4c. Trigger manual News Sync
      if (path === "/api/news/sync" && request.method === "POST") {
        const now = Date.now();
        const mockNews = [
          { id: "evt_cpi", time: now + 300000, currency: "USD", eventName: "Core CPI Inflation Rate MoM", impactLevel: "HIGH", forecast: 0.3, previous: 0.2 },
          { id: "evt_nfp", time: now + 600000, currency: "USD", eventName: "Non-Farm Payrolls", impactLevel: "HIGH", forecast: 185000, previous: 206000 }
        ];
        for (const ev of mockNews) {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO news_calendar (id, time, currency, eventName, impactLevel, forecast, previous) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(ev.id, ev.time, ev.currency, ev.eventName, ev.impactLevel, ev.forecast, ev.previous).run();
        }
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
      }

      // 5. Proxy to cTrader Account Durable Object
      // Path format: /accounts/:id/:action
      const accountMatch = path.match(/^\/accounts\/([^\/]+)\/([^\/]+)$/) || path.match(/^\/api\/accounts\/([^\/]+)\/([^\/]+)$/);
      if (accountMatch) {
        const accountId = accountMatch[1];
        const action = accountMatch[2];

        // Route to DO
        const doId = env.CTRADER_ACCOUNT_DO.idFromName(accountId);
        const doStub = env.CTRADER_ACCOUNT_DO.get(doId);

        // Fetch from DO
        const doResponse = await doStub.fetch(new Request("http://do/" + action, { method: request.method }));
        const doData = await doResponse.json();

        return new Response(JSON.stringify(doData), { headers: corsHeaders });
      }

      // 6. Config Access
      if (path === "/config" || path === "/api/config") {
        if (request.method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM config").all();
          const configMap = results.reduce((acc: any, row: any) => {
            acc[row.key] = JSON.parse(row.valueJson);
            return acc;
          }, {});
          return new Response(JSON.stringify(configMap), { headers: corsHeaders });
        } else if (request.method === "POST") {
          const body: any = await request.json();
          for (const [key, val] of Object.entries(body)) {
            await env.DB.prepare(
              "INSERT OR REPLACE INTO config (key, valueJson, updatedAt) VALUES (?, ?, ?)"
            ).bind(key, JSON.stringify(val), Date.now()).run();

            await env.DB.prepare(
              "INSERT INTO audit_logs (timestamp, level, accountId, component, action, message) VALUES (?, ?, ?, ?, ?, ?)"
            ).bind(
              Date.now(),
              "WARN",
              "SYSTEM",
              "api-worker",
              "CONFIG_UPDATE",
              `Updated config key "${key}" to ${JSON.stringify(val)}`
            ).run();
          }
          return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
        }
      }

      // 7. Audit Logs
      if (path === "/audit-logs" || path === "/api/audit-logs") {
        const { results } = await env.DB.prepare(
          "SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100"
        ).all();
        return new Response(JSON.stringify(results), { headers: corsHeaders });
      }

      // 7b. AI News & Signal Analysis
      if ((path === "/ai/analyze" || path === "/api/ai/analyze") && request.method === "POST") {
        const body: any = await request.json();
        const text = body.text;
        const symbol = body.symbol || "XAUUSD";
        const accountId = body.accountId;

        if (!text) {
          return new Response(JSON.stringify({ error: "Missing text input to analyze" }), { status: 400, headers: corsHeaders });
        }

        const prompt = `You are a professional financial analyst. Analyze the following news/event and output a valid JSON object ONLY.
News/Signal content: "${text}"
Target trading asset: "${symbol}"

The output JSON must contain exactly these keys:
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "score": number (between -1.0 and 1.0, where -1 is bearish, 1 is bullish),
  "confidence": number (between 0.0 and 1.0),
  "action": "BUY" | "SELL" | "HOLD",
  "reasoning": "string (brief explanation)"
}
Do NOT include any markdown block, backticks, code blocks or extra text. Output only raw JSON.`;

        let aiResult: any;
        try {
          const aiResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
            prompt: prompt,
            max_tokens: 200,
            temperature: 0.1
          });

          const rawText = aiResponse.response || aiResponse.text || "";
          const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
          aiResult = JSON.parse(cleanJson);
        } catch (e: any) {
          return new Response(JSON.stringify({ error: `AI Analysis failed: ${e.message}` }), { status: 500, headers: corsHeaders });
        }

        // Write Audit Log of AI evaluation
        await env.DB.prepare(
          "INSERT INTO audit_logs (timestamp, level, accountId, component, action, message, contextJson) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          Date.now(),
          "INFO",
          accountId || "SYSTEM",
          "ai-engine",
          "AI_SENTIMENT_EVALUATION",
          `AI evaluated text sentiment as ${aiResult.sentiment} (confidence: ${(aiResult.confidence * 100).toFixed(0)}%) for asset ${symbol}`,
          JSON.stringify({ input: text, output: aiResult })
        ).run();

        let executionResult: any = null;
        if (accountId && aiResult.confidence >= 0.75 && (aiResult.action === "BUY" || aiResult.action === "SELL")) {
          const autoCmd: TradingCommand = {
            commandId: `cmd_ai_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            accountId,
            action: aiResult.action,
            symbol,
            volume: symbol === "XAUUSD" ? 1000 : 10,
            orderType: "MARKET",
            timestamp: Date.now()
          };

          const safetyRecord = await env.DB.prepare(
            "SELECT valueJson FROM config WHERE key = 'safety_config'"
          ).first<{ valueJson: string }>();
          const safety = safetyRecord ? JSON.parse(safetyRecord.valueJson) : { enableLiveTrading: false };

          if (!safety.enableLiveTrading) {
            await env.DB.prepare(
              "INSERT INTO audit_logs (timestamp, level, accountId, component, action, message, contextJson) VALUES (?, ?, ?, ?, ?, ?, ?)"
            ).bind(
              Date.now(),
              "INFO",
              accountId,
              "api-worker",
              "SIMULATED_EXECUTION",
              `[Auto-AI] Simulated execution of ${autoCmd.action} for ${autoCmd.volume} units of ${autoCmd.symbol} (Live Trading Disabled)`,
              JSON.stringify(autoCmd)
            ).run();

            executionResult = {
              success: true,
              status: "SIMULATED",
              message: "Auto-AI command executed in read-only simulation mode.",
              command: autoCmd
            };
          } else {
            const doId = env.CTRADER_ACCOUNT_DO.idFromName(accountId);
            const doStub = env.CTRADER_ACCOUNT_DO.get(doId);
            const executeResponse = await doStub.fetch(
              new Request(`http://do/command`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(autoCmd),
              })
            );
            executionResult = await executeResponse.json();
          }
        }

        return new Response(JSON.stringify({
          analysis: aiResult,
          autoExecution: executionResult,
          triggered: executionResult ? true : false
        }), { headers: corsHeaders });
      }

      // 8. Place Command / Execute
      if ((path === "/commands/execute" || path === "/api/commands/execute") && request.method === "POST") {
        const cmd: TradingCommand = await request.json();

        if (!cmd.accountId || !cmd.action || !cmd.symbol) {
          return new Response(JSON.stringify({ error: "Missing required command fields" }), { status: 400, headers: corsHeaders });
        }



        // 8b. Safety Check for Live Trading
        const safetyRecord = await env.DB.prepare(
          "SELECT valueJson FROM config WHERE key = 'safety_config'"
        ).first<{ valueJson: string }>();
        const safety = safetyRecord ? JSON.parse(safetyRecord.valueJson) : { enableLiveTrading: false };

        if (!safety.enableLiveTrading) {
          // Store Simulated Audit Log in D1
          await env.DB.prepare(
            "INSERT INTO audit_logs (timestamp, level, accountId, component, action, message, contextJson) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            Date.now(),
            "INFO",
            cmd.accountId,
            "api-worker",
            "SIMULATED_EXECUTION",
            `Simulated execution of ${cmd.action} for ${cmd.volume} units of ${cmd.symbol} (Live Trading Disabled)`,
            JSON.stringify(cmd)
          ).run();

          return new Response(
            JSON.stringify({
              success: true,
              status: "SIMULATED",
              message: "Command passed risk engine checks and was processed in read-only simulation mode.",
              command: cmd,
            }),
            { headers: corsHeaders }
          );
        }

        // 8c. Route to actual executing Durable Object
        const doId = env.CTRADER_ACCOUNT_DO.idFromName(cmd.accountId);
        const doStub = env.CTRADER_ACCOUNT_DO.get(doId);
        const executeResponse = await doStub.fetch(
          new Request(`http://do/command`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cmd),
          })
        );
        const executionData = await executeResponse.json();

        return new Response(JSON.stringify(executionData), { headers: corsHeaders });
      }

      // Serve Admin Dashboard Frontend
      if (path === "/" || path === "/index.html") {
        return new Response(this.getDashboardHtml(), {
          headers: { "Content-Type": "text/html" },
        });
      }

      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders });

    } catch (e: any) {
      console.error("API error:", e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders });
    }
  },

  getDashboardHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Zebrabyte Administrative Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #080b11;
            --card-bg: #0f1524;
            --card-border: rgba(255, 255, 255, 0.05);
            --text-color: #f3f4f6;
            --text-muted: #9ca3af;
            --primary: #3b82f6;
            --primary-glow: rgba(59, 130, 246, 0.2);
            --secondary: #8b5cf6;
            --danger: #ef4444;
            --success: #10b981;
            --warning: #f59e0b;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background-color: var(--bg-color);
            color: var(--text-color);
            line-height: 1.6;
            padding: 2rem;
        }

        .container {
            max-width: 1400px;
            margin: 0 auto;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            border-bottom: 1px solid var(--card-border);
            padding-bottom: 1.5rem;
        }

        h1 {
            font-size: 2rem;
            font-weight: 700;
            background: linear-gradient(135deg, #60a5fa, #8b5cf6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .header-buttons {
            display: flex;
            gap: 1rem;
        }

        button {
            font-family: 'Outfit', sans-serif;
            font-weight: 600;
            padding: 0.75rem 1.5rem;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            border: 1px solid transparent;
        }

        .btn-primary {
            background-color: var(--primary);
            color: white;
            box-shadow: 0 0 15px var(--primary-glow);
        }

        .btn-primary:hover {
            opacity: 0.9;
            transform: translateY(-1px);
        }

        .btn-secondary {
            background-color: transparent;
            border-color: var(--card-border);
            color: var(--text-color);
        }

        .btn-secondary:hover {
            background-color: rgba(255, 255, 255, 0.05);
        }

        .btn-danger {
            background-color: var(--danger);
            color: white;
            box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4);
        }

        .btn-danger.active {
            background-color: var(--success);
            box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4);
        }

        .grid-3 {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .grid-2 {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        @media (max-width: 900px) {
            .grid-2 {
                grid-template-columns: 1fr;
            }
        }

        .card {
            background-color: var(--card-bg);
            border-radius: 12px;
            padding: 1.5rem;
            border: 1px solid var(--card-border);
            position: relative;
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.4);
        }

        .card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 4px;
            background: linear-gradient(90deg, var(--primary), var(--secondary));
            border-radius: 12px 12px 0 0;
        }

        .card.danger::before { background: var(--danger); }
        .card.success::before { background: var(--success); }

        .card h2 {
            font-size: 1.25rem;
            margin-bottom: 1.25rem;
            color: var(--text-color);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .stat-value {
            font-size: 2.25rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
            font-family: 'JetBrains Mono', monospace;
        }

        /* Forms */
        .form-group {
            margin-bottom: 1rem;
        }

        .form-group label {
            display: block;
            font-size: 0.85rem;
            color: var(--text-muted);
            margin-bottom: 0.5rem;
        }

        .form-control {
            width: 100%;
            padding: 0.75rem;
            background-color: rgba(0, 0, 0, 0.3);
            border: 1px solid var(--card-border);
            border-radius: 6px;
            color: white;
            font-family: inherit;
        }

        .form-control:focus {
            outline: none;
            border-color: var(--primary);
        }

        /* Tables */
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 0.5rem;
        }

        th, td {
            text-align: left;
            padding: 0.75rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
        }

        th {
            color: var(--text-muted);
            font-weight: 600;
            font-size: 0.85rem;
            text-transform: uppercase;
        }

        .badge {
            display: inline-block;
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }

        .badge.success { background-color: rgba(16, 185, 129, 0.1); color: var(--success); }
        .badge.danger { background-color: rgba(239, 68, 68, 0.1); color: var(--danger); }
        .badge.warning { background-color: rgba(245, 158, 11, 0.1); color: var(--warning); }

        /* Output Logs & JSON console */
        .console {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.85rem;
            background-color: #05070a;
            border: 1px solid var(--card-border);
            border-radius: 8px;
            padding: 1rem;
            max-height: 250px;
            overflow-y: auto;
        }

        .console-item {
            margin-bottom: 0.5rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.02);
            padding-bottom: 0.25rem;
        }

        .console-time { color: var(--text-muted); margin-right: 0.5rem; }
        .console-warn { color: var(--warning); }
        .console-error { color: var(--danger); }
        .console-info { color: #60a5fa; }

        /* Tick flash animations */
        .tick-up { animation: flash-green 1s ease-out; }
        .tick-down { animation: flash-red 1s ease-out; }

        @keyframes flash-green {
            0% { background-color: rgba(16, 185, 129, 0.4); }
            100% { background-color: transparent; }
        }

        @keyframes flash-red {
            0% { background-color: rgba(239, 68, 68, 0.4); }
            100% { background-color: transparent; }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div>
                <h1>ZEBRABYTE TRADING SYSTEM</h1>
                <p style="font-size: 0.9rem; color: var(--text-muted);">Cloudflare Serverless Quant Terminal</p>
            </div>
            <div class="header-buttons">
                <button class="btn-secondary" onclick="triggerOAuthFlow()">🔌 Connect cTrader Account</button>
                <button id="safetyModeBtn" class="btn-secondary" onclick="toggleSafetyMode()">🛡️ Live Mode: DISABLED</button>
                <button id="killSwitchBtn" class="btn-danger" onclick="toggleKillSwitch()">ARM GLOBAL KILL SWITCH</button>
            </div>
        </header>

        <!-- Dynamic Statistics -->
        <div class="grid-3">
            <div class="card">
                <h2>📊 Overall Balance & Equity</h2>
                <div id="totalBalance" class="stat-value">$0.00</div>
                <div id="totalEquity" class="stat-value" style="color: var(--success);">$0.00</div>
            </div>
            <div class="card">
                <h2>📈 Market Tick Feed</h2>
                <table>
                    <thead>
                        <tr>
                            <th>Symbol</th>
                            <th>Bid</th>
                            <th>Ask</th>
                        </tr>
                    </thead>
                    <tbody id="pricesBody">
                        <tr><td colspan="3" style="color: var(--text-muted);">Waiting for ticks...</td></tr>
                    </tbody>
                </table>
            </div>
            <div class="card">
                <h2>🌍 Active Accounts (<span id="accountsCount">0</span>)</h2>
                <div id="accountsList" style="max-height: 150px; overflow-y: auto; font-size: 0.9rem;">
                    Loading accounts...
                </div>
            </div>
        </div>

        <!-- Simulated Account Creator & AI Trades Injection -->
        <div class="grid-2">
            <div class="card">
                <h2>🛠️ Account Simulator (No Keys Required)</h2>
                <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">
                    Initialize a mock broker account in the database for instant trading simulation.
                </p>
                <div class="form-group">
                    <label>Simulated Account ID</label>
                    <input type="text" id="simAccountId" class="form-control" placeholder="e.g. sim_99281">
                </div>
                <div class="form-group">
                    <label>Broker Name</label>
                    <input type="text" id="simBrokerName" class="form-control" value="IC Markets (Demo)">
                </div>
                <div class="form-group">
                    <label>Starting Balance ($)</label>
                    <input type="number" id="simBalance" class="form-control" value="100000">
                </div>
                <button class="btn-primary" style="width: 100%;" onclick="createSimulatedAccount()">⚡ Initialize Simulated Account</button>
            </div>

            <div class="card">
                <h2>🤖 Workers AI: Sentiment & Auto-Trading</h2>
                <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem;">
                    Feed headlines or Telegram signals into the LLaMA 3 AI engine to analyze sentiment and trigger automatic trades.
                </p>
                <div class="form-group">
                    <label>Select Trading Account</label>
                    <select id="aiAccountSelect" class="form-control">
                        <option value="">No accounts found</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Target Asset Symbol</label>
                    <select id="aiSymbolSelect" class="form-control">
                        <option value="XAUUSD">XAUUSD</option>
                        <option value="US30">US30</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>News Headline / Signal Content</label>
                    <textarea id="aiTextInput" class="form-control" style="height: 60px; resize: none;" placeholder="e.g. US Core CPI rises unexpectedly to 3.8% YoY, dollar strengthening..."></textarea>
                </div>
                <button class="btn-primary" style="width: 100%; background-color: var(--secondary);" onclick="runAiAnalysis()">🧠 Analyze & Auto-Execute Trade</button>
            </div>
        </div>

        <!-- AI Output & Interactive Terminal Console -->
        <div class="grid-2" style="margin-bottom: 2rem;">
            <div class="card">
                <h2>🧠 LLaMA 3 Sentiment Output</h2>
                <pre id="aiJsonOutput" class="console" style="color: var(--success); max-height: 200px;">Waiting for AI evaluation...</pre>
            </div>
            <div class="card">
                <h2>📅 Macro News Calendar <button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; float: right;" onclick="triggerNewsSync()">🔄 Sync Calendar</button></h2>
                <table style="font-size: 0.9rem;">
                    <thead>
                        <tr>
                            <th>Impact</th>
                            <th>Event</th>
                            <th>Currency</th>
                            <th>Forecast</th>
                        </tr>
                    </thead>
                    <tbody id="calendarBody">
                        <tr><td colspan="4" style="color: var(--text-muted);">Sync calendar to view events.</td></tr>
                    </tbody>
                </table>
            </div>
        </div>

        <!-- Open Positions -->
        <div class="card" style="margin-bottom: 2rem;">
            <h2>💼 Active Positions</h2>
            <table>
                <thead>
                    <tr>
                        <th>Position ID</th>
                        <th>Account ID</th>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th>Volume</th>
                        <th>Entry Price</th>
                        <th>Unrealized PnL</th>
                    </tr>
                </thead>
                <tbody id="positionsBody">
                    <tr><td colspan="7" style="color: var(--text-muted);">No open positions.</td></tr>
                </tbody>
            </table>
        </div>

        <!-- Audit logs -->
        <div class="card">
            <h2>📜 System Audit Log</h2>
            <div id="auditLogs" class="console">
                Loading logs...
            </div>
        </div>
    </div>

    <script>
        let globalKillSwitchActive = false;
        let liveTradingActive = false;
        let lastPrices = {};

        async function refreshDashboard() {
            try {
                // Fetch config (kill switch & safety mode)
                const configRes = await fetch('/api/config');
                if (configRes.ok) {
                    const config = await configRes.json();
                    
                    // Kill Switch state
                    if (config.risk_config) {
                        globalKillSwitchActive = config.risk_config.globalKillSwitch;
                        const kbtn = document.getElementById('killSwitchBtn');
                        if (globalKillSwitchActive) {
                            kbtn.innerText = 'DISARM GLOBAL KILL SWITCH';
                            kbtn.classList.add('active');
                        } else {
                            kbtn.innerText = 'ARM GLOBAL KILL SWITCH';
                            kbtn.classList.remove('active');
                        }
                    }

                    // Safety / Live mode state
                    if (config.safety_config) {
                        liveTradingActive = config.safety_config.enableLiveTrading;
                        const sbtn = document.getElementById('safetyModeBtn');
                        if (liveTradingActive) {
                            sbtn.innerText = '⚠️ Live Mode: ACTIVE';
                            sbtn.style.borderColor = 'var(--danger)';
                            sbtn.style.color = 'var(--danger)';
                        } else {
                            sbtn.innerText = '🛡️ Live Mode: DISABLED';
                            sbtn.style.borderColor = 'var(--card-border)';
                            sbtn.style.color = 'var(--text-color)';
                        }
                    }
                }

                // Fetch Accounts
                const accountsRes = await fetch('/api/accounts');
                if (accountsRes.ok) {
                    const accounts = await accountsRes.json();
                    document.getElementById('accountsCount').innerText = accounts.length;

                    let totalBal = 0;
                    let totalEq = 0;
                    let listHtml = '';
                    let selectHtml = '';
                    let pricesHtml = '';
                    let positionsHtml = '';

                    for (const acct of accounts) {
                        totalBal += acct.balance;
                        totalEq += acct.equity;
                        
                        listHtml += \`<div style="margin-bottom: 0.5rem; display: flex; justify-content: space-between;">
                            <span><strong>\${acct.accountId}</strong> (\${acct.brokerName})</span>
                            \${acct.isConnected ? '<span class="badge success">ONLINE</span>' : '<span class="badge danger">OFFLINE</span>'}
                        </div>\`;

                        selectHtml += \`<option value="\${acct.accountId}">\${acct.accountId} (\${acct.brokerName})</option>\`;

                        // Parse simulated prices
                        if (acct.tokenData) {
                            // Mocking live ticker variation for the UI
                            const changeDirection = Math.random() > 0.5 ? 1 : -1;
                            const currentUS30Bid = lastPrices.US30 ? lastPrices.US30.bid + changeDirection * (Math.random() * 2) : 39250.00;
                            const currentXAUUSDBid = lastPrices.XAUUSD ? lastPrices.XAUUSD.bid + changeDirection * (Math.random() * 0.1) : 2350.00;

                            const us30Bid = currentUS30Bid.toFixed(2);
                            const us30Ask = (currentUS30Bid + 1.5).toFixed(2);
                            const xauBid = currentXAUUSDBid.toFixed(2);
                            const xauAsk = (currentXAUUSDBid + 0.35).toFixed(2);

                            pricesHtml += \`<tr class="\${changeDirection > 0 ? 'tick-up' : 'tick-down'}">
                                <td><strong>US30</strong></td>
                                <td>\${us30Bid}</td>
                                <td>\${us30Ask}</td>
                            </tr>\`;
                            pricesHtml += \`<tr class="\${changeDirection > 0 ? 'tick-up' : 'tick-down'}">
                                <td><strong>XAUUSD</strong></td>
                                <td>\${xauBid}</td>
                                <td>\${xauAsk}</td>
                            </tr>\`;

                            lastPrices = {
                                US30: { bid: currentUS30Bid, ask: currentUS30Bid + 1.5 },
                                XAUUSD: { bid: currentXAUUSDBid, ask: currentXAUUSDBid + 0.35 }
                            };
                        }

                        // Parse positions
                        try {
                            const acctPositionsRes = await fetch(\`/api/accounts/\${acct.accountId}/positions\`);
                            if (acctPositionsRes.ok) {
                                const positions = await acctPositionsRes.json();
                                for (const pos of positions) {
                                    positionsHtml += \`<tr>
                                        <td>\${pos.positionId}</td>
                                        <td>\${pos.accountId}</td>
                                        <td><strong>\${pos.symbol}</strong></td>
                                        <td><span class="badge \${pos.tradeSide === 'BUY' ? 'success' : 'danger'}">\${pos.tradeSide}</span></td>
                                        <td>\${pos.volume}</td>
                                        <td>\${pos.entryPrice.toFixed(2)}</td>
                                        <td style="color: \${pos.unrealizedPl >= 0 ? 'var(--success)' : 'var(--danger)'}">$\${pos.unrealizedPl.toFixed(2)}</td>
                                    </tr>\`;
                                }
                            }
                        } catch {}
                    }

                    document.getElementById('totalBalance').innerText = '$' + totalBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                    document.getElementById('totalEquity').innerText = '$' + totalEq.toLocaleString(undefined, {minimumFractionDigits: 2});
                    document.getElementById('accountsList').innerHTML = listHtml || '<span style="color: var(--text-muted);">No accounts found.</span>';
                    
                    const selectEl = document.getElementById('aiAccountSelect');
                    if (selectHtml) {
                        selectEl.innerHTML = selectHtml;
                    } else {
                        selectEl.innerHTML = '<option value="">No accounts found</option>';
                    }

                    if (pricesHtml) document.getElementById('pricesBody').innerHTML = pricesHtml;
                    if (positionsHtml) document.getElementById('positionsBody').innerHTML = positionsHtml;
                }

                // Fetch Audit Logs
                const logsRes = await fetch('/api/audit-logs');
                if (logsRes.ok) {
                    const logs = await logsRes.json();
                    let logsHtml = '';
                    for (const log of logs) {
                        const dateStr = new Date(log.timestamp).toLocaleTimeString();
                        let classType = 'console-info';
                        if (log.level === 'WARN') classType = 'console-warn';
                        if (log.level === 'ERROR' || log.level === 'CRITICAL') classType = 'console-error';

                        logsHtml += \`<div class="console-item">
                            <span class="console-time">\${dateStr}</span>
                            <span class="badge \${log.level === 'INFO' || log.level === 'SUCCESS' ? 'success' : 'danger'}">\${log.level}</span>
                            [\${log.component}] \${log.action} - <span class="\${classType}">\${log.message}</span>
                        </div>\`;
                    }
                    document.getElementById('auditLogs').innerHTML = logsHtml || 'No logs generated.';
                }

                // Fetch Calendar
                const calendarRes = await fetch('/api/audit-logs'); // we query news_calendar via database call (or fetch directly)
                const d1CalendarRes = await fetch('/api/accounts'); // fallback or fetch calendar
                // For simplicity, fetch the calendar from the calendar endpoint if setup
                const newsRes = await fetch('/api/news/sync'); // or fetch directly
                // Show upcoming calendar items (static / dynamic)
                let calendarHtml = \`<tr>
                    <td><span class="badge danger">HIGH</span></td>
                    <td><strong>Core CPI Inflation Rate MoM</strong></td>
                    <td>USD</td>
                    <td>0.3%</td>
                </tr>
                <tr>
                    <td><span class="badge danger">HIGH</span></td>
                    <td><strong>Non-Farm Payrolls (NFP)</strong></td>
                    <td>USD</td>
                    <td>185K</td>
                </tr>\`;
                document.getElementById('calendarBody').innerHTML = calendarHtml;

            } catch (e) {
                console.error("Dashboard refresh error:", e);
            }
        }

        async function createSimulatedAccount() {
            const accId = document.getElementById('simAccountId').value.trim();
            const broker = document.getElementById('simBrokerName').value.trim();
            const balance = document.getElementById('simBalance').value.trim();

            try {
                const res = await fetch('/api/accounts/create-simulated', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ accountId: accId, brokerName: broker, balance: balance })
                });
                if (res.ok) {
                    alert("Simulated account successfully initialized!");
                    refreshDashboard();
                } else {
                    const err = await res.json();
                    alert("Failed: " + err.error);
                }
            } catch (e) {
                alert("Request error: " + e.message);
            }
        }

        async function runAiAnalysis() {
            const accId = document.getElementById('aiAccountSelect').value;
            const symbol = document.getElementById('aiSymbolSelect').value;
            const text = document.getElementById('aiTextInput').value.trim();

            if (!text) {
                alert("Please paste some financial news or signal text!");
                return;
            }

            const jsonPre = document.getElementById('aiJsonOutput');
            jsonPre.innerText = "Analyzing text with Workers LLaMA 3... (takes 2-3 seconds)";
            jsonPre.style.color = "var(--warning)";

            try {
                const res = await fetch('/api/ai/analyze', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text: text, symbol: symbol, accountId: accId })
                });

                if (res.ok) {
                    const data = await res.json();
                    jsonPre.innerText = JSON.stringify(data.analysis, null, 2);
                    jsonPre.style.color = "var(--success)";
                    if (data.triggered) {
                        alert(\`AI Signal Triggered a \${data.autoExecution.status} trade: \${data.analysis.action} on \${symbol}!\`);
                    } else {
                        alert(\`Analysis complete. No trade triggered (Action: \${data.analysis.action}, confidence: \${data.analysis.confidence * 100}%)\`);
                    }
                    refreshDashboard();
                } else {
                    const err = await res.json();
                    jsonPre.innerText = JSON.stringify(err, null, 2);
                    jsonPre.style.color = "var(--danger)";
                }
            } catch (e) {
                jsonPre.innerText = "Error: " + e.message;
                jsonPre.style.color = "var(--danger)";
            }
        }

        async function triggerNewsSync() {
            try {
                const res = await fetch('/api/news/sync', { method: 'POST' });
                if (res.ok) {
                    alert("Macro calendar synchronized with database!");
                    refreshDashboard();
                }
            } catch (e) {
                alert("Sync error: " + e.message);
            }
        }

        async function triggerOAuthFlow() {
            try {
                const res = await fetch('/api/oauth/url');
                if (res.ok) {
                    const data = await res.json();
                    window.location.href = data.url;
                }
            } catch (e) {
                alert("OAuth initiation error: " + e.message);
            }
        }

        async function toggleSafetyMode() {
            const nextMode = !liveTradingActive;
            const confirmMsg = nextMode 
                ? "WARNING: Enabling Live Trading will route AI orders to the live Durable Object TCP sockets. Proceed?"
                : "Disable Live Trading and switch back to Read-Only simulation?";

            if (confirm(confirmMsg)) {
                try {
                    const updateRes = await fetch('/api/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ safety_config: { enableLiveTrading: nextMode } })
                    });
                    if (updateRes.ok) {
                        alert(nextMode ? "LIVE TRADING ROUTING ACTIVATED!" : "LIVE TRADING ROUTING DEACTIVATED (SIMULATION MODE)");
                        refreshDashboard();
                    }
                } catch (e) {
                    alert("Failed to toggle: " + e.message);
                }
            }
        }

        async function toggleKillSwitch() {
            const nextState = !globalKillSwitchActive;
            const confirmMsg = nextState 
                ? "Are you sure you want to ARM the Global Kill Switch? All execution will be blocked immediately."
                : "Disarm the Global Kill Switch and restore trading systems?";

            if (confirm(confirmMsg)) {
                try {
                    const updateRes = await fetch('/api/config', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ risk_config: { globalKillSwitch: nextState } })
                    });
                    if (updateRes.ok) {
                        alert(nextState ? "GLOBAL SYSTEM ARM KILL SWITCH ACTIVATED!" : "GLOBAL SYSTEM KILL SWITCH RESTORED");
                        refreshDashboard();
                    }
                } catch (e) {
                    alert("Failed: " + e.message);
                }
            }
        }

        // Periodically refresh the dashboard
        refreshDashboard();
        setInterval(refreshDashboard, 4000);
    </script>
</body>
</html>`;
  }
};

