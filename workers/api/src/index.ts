import { TokenData, TradingCommand } from "@zebrabyte/contracts";

export interface Env {
  DB: D1Database;
  CTRADER_ACCOUNT_DO: DurableObjectNamespace;
  RISK_WORKER: { fetch: (req: Request) => Promise<Response> };
  CTRADER_CLIENT_ID: string;
  CTRADER_CLIENT_SECRET: string;
  CTRADER_REDIRECT_URI: string;
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

      // 8. Place Command / Execute
      if ((path === "/commands/execute" || path === "/api/commands/execute") && request.method === "POST") {
        const cmd: TradingCommand = await request.json();

        if (!cmd.accountId || !cmd.action || !cmd.symbol) {
          return new Response(JSON.stringify({ error: "Missing required command fields" }), { status: 400, headers: corsHeaders });
        }

        // 8a. Check with Risk Worker service binding
        const riskResponse = await env.RISK_WORKER.fetch(
          new Request("http://risk/evaluate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cmd),
          })
        );
        const riskResult = await riskResponse.json() as { allowed: boolean; reason?: string; ruleEvaluated: string };

        if (!riskResult.allowed) {
          return new Response(
            JSON.stringify({
              success: false,
              status: "BLOCKED",
              reason: riskResult.reason,
              rule: riskResult.ruleEvaluated,
            }),
            { status: 400, headers: corsHeaders }
          );
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
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: #151d30;
            --text-color: #f3f4f6;
            --text-muted: #9ca3af;
            --primary: #3b82f6;
            --primary-glow: rgba(59, 130, 246, 0.15);
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
            line-height: 1.5;
            padding: 2rem;
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            border-bottom: 1px solid rgba(255,255,255,0.05);
            padding-bottom: 1rem;
        }

        h1 {
            font-size: 1.8rem;
            font-weight: 700;
            background: linear-gradient(135deg, #60a5fa, #3b82f6);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .kill-switch-btn {
            background-color: var(--danger);
            color: white;
            border: none;
            padding: 0.75rem 1.5rem;
            font-size: 1rem;
            font-weight: 600;
            border-radius: 8px;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 14px rgba(239, 68, 68, 0.4);
        }

        .kill-switch-btn.active {
            background-color: var(--success);
            box-shadow: 0 4px 14px rgba(16, 185, 129, 0.4);
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }

        .card {
            background-color: var(--card-bg);
            border-radius: 12px;
            padding: 1.5rem;
            border: 1px solid rgba(255,255,255,0.03);
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
            position: relative;
            overflow: hidden;
        }

        .card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 4px;
            background: var(--primary);
        }

        .card.danger::before { background: var(--danger); }
        .card.success::before { background: var(--success); }

        .card h2 {
            font-size: 1.2rem;
            margin-bottom: 1rem;
            color: var(--text-muted);
        }

        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 0.5rem;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 1rem;
        }

        th, td {
            text-align: left;
            padding: 0.75rem;
            border-bottom: 1px solid rgba(255,255,255,0.05);
        }

        th {
            color: var(--text-muted);
            font-weight: 600;
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

        .log-list {
            max-height: 300px;
            overflow-y: auto;
            font-family: monospace;
            font-size: 0.85rem;
            background: #080c14;
            padding: 1rem;
            border-radius: 8px;
            border: 1px solid rgba(255,255,255,0.05);
        }

        .log-item {
            margin-bottom: 0.5rem;
            border-bottom: 1px solid rgba(255,255,255,0.02);
            padding-bottom: 0.25rem;
        }

        .log-time { color: var(--text-muted); margin-right: 0.5rem; }
        .log-warn { color: var(--warning); }
        .log-error { color: var(--danger); }
        .log-info { color: #60a5fa; }
    </style>
</head>
<body>
    <header>
        <div>
            <h1>ZEBRABYTE TRADING</h1>
            <p style="font-size: 0.9rem; color: var(--text-muted);">Cloudflare-Native Algorithmic Trading Platform</p>
        </div>
        <button id="killSwitchBtn" class="kill-switch-btn" onclick="toggleKillSwitch()">ARM GLOBAL KILL SWITCH</button>
    </header>

    <div class="grid">
        <div class="card">
            <h2>Connected Accounts</h2>
            <div id="accountsCount" class="stat-value">0</div>
            <div id="accountsList">Loading...</div>
        </div>
        <div class="card">
            <h2>Overall Balance & Equity</h2>
            <div id="totalBalance" class="stat-value">$0.00</div>
            <div id="totalEquity" class="stat-value" style="color: var(--success);">$0.00</div>
        </div>
        <div class="card">
            <h2>Market Prices</h2>
            <table>
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Bid</th>
                        <th>Ask</th>
                    </tr>
                </thead>
                <tbody id="pricesBody">
                    <tr><td colspan="3">Waiting for tick updates...</td></tr>
                </tbody>
            </table>
        </div>
    </div>

    <div class="card" style="margin-bottom: 2rem;">
        <h2>Active Open Positions</h2>
        <table>
            <thead>
                <tr>
                    <th>Position ID</th>
                    <th>Account</th>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Volume</th>
                    <th>Entry Price</th>
                    <th>Unrealized PnL</th>
                </tr>
            </thead>
            <tbody id="positionsBody">
                <tr><td colspan="7">No open positions.</td></tr>
            </tbody>
        </table>
    </div>

    <div class="card">
        <h2>System Audit Log</h2>
        <div id="auditLogs" class="log-list">
            Loading system logs...
        </div>
    </div>

    <script>
        let globalKillSwitchActive = false;

        async function refreshDashboard() {
            try {
                // Fetch config to check kill switch state
                const configRes = await fetch('/api/config');
                if (configRes.ok) {
                    const config = await configRes.json();
                    if (config.risk_config) {
                        globalKillSwitchActive = config.risk_config.globalKillSwitch;
                        const btn = document.getElementById('killSwitchBtn');
                        if (globalKillSwitchActive) {
                            btn.innerText = 'DISARM GLOBAL KILL SWITCH';
                            btn.classList.add('active');
                        } else {
                            btn.innerText = 'ARM GLOBAL KILL SWITCH';
                            btn.classList.remove('active');
                        }
                    }
                }

                // Fetch accounts
                const accountsRes = await fetch('/api/accounts');
                if (accountsRes.ok) {
                    const accounts = await accountsRes.all ? await accountsRes.all() : await accountsRes.json();
                    document.getElementById('accountsCount').innerText = accounts.length;

                    let totalBal = 0;
                    let totalEq = 0;
                    let listHtml = '';
                    let pricesHtml = '';
                    let positionsHtml = '';

                    for (const acct of accounts) {
                        totalBal += acct.balance;
                        totalEq += acct.equity;
                        listHtml += \`<div>Account ID: <strong>\${acct.accountId}</strong> (\${acct.brokerName}) - \${acct.isConnected ? '<span class="badge success">ONLINE</span>' : '<span class="badge danger">OFFLINE</span>'}</div>\`;

                        // Fetch prices and positions per account
                        const acctStatusRes = await fetch(\`/api/accounts/\${acct.accountId}/status\`);
                        if (acctStatusRes.ok) {
                            const status = await acctStatusRes.json();
                            if (status.prices) {
                                for (const [sym, price] of Object.entries(status.prices)) {
                                    pricesHtml += \`<tr>
                                        <td><strong>\${sym}</strong></td>
                                        <td>\${price.bid.toFixed(2)}</td>
                                        <td>\${price.ask.toFixed(2)}</td>
                                    </tr>\`;
                                }
                            }
                        }

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
                    }

                    document.getElementById('totalBalance').innerText = '$' + totalBal.toLocaleString(undefined, {minimumFractionDigits: 2});
                    document.getElementById('totalEquity').innerText = '$' + totalEq.toLocaleString(undefined, {minimumFractionDigits: 2});
                    document.getElementById('accountsList').innerHTML = listHtml || 'No accounts connected.';
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
                        let classType = 'log-info';
                        if (log.level === 'WARN') classType = 'log-warn';
                        if (log.level === 'ERROR' || log.level === 'CRITICAL') classType = 'log-error';

                        logsHtml += \`<div class="log-item">
                            <span class="log-time">\${dateStr}</span>
                            <span class="badge \${log.level === 'INFO' ? 'success' : 'danger'}">\${log.level}</span>
                            [\${log.component}] \${log.action} - <span class="\${classType}">\${log.message}</span>
                        </div>\`;
                    }
                    document.getElementById('auditLogs').innerHTML = logsHtml || 'No logs generated.';
                }
            } catch (e) {
                console.error("Dashboard refresh error:", e);
            }
        }

        async function toggleKillSwitch() {
            const nextState = !globalKillSwitchActive;
            const confirmMsg = nextState 
                ? "Are you sure you want to ARM the Global Kill Switch? All execution will be blocked."
                : "Are you sure you want to DISARM the Global Kill Switch?";
            
            if (confirm(confirmMsg)) {
                try {
                    const configRes = await fetch('/api/config');
                    if (configRes.ok) {
                        const config = await configRes.json();
                        const riskConfig = config.risk_config || {};
                        riskConfig.globalKillSwitch = nextState;

                        const updateRes = await fetch('/api/config', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ risk_config: riskConfig })
                        });

                        if (updateRes.ok) {
                            alert(nextState ? "GLOBAL KILL SWITCH ACTIVATED!" : "GLOBAL KILL SWITCH DEACTIVATED!");
                            refreshDashboard();
                        }
                    }
                } catch (e) {
                    alert("Failed to toggle kill switch: " + e.message);
                }
            }
        }

        // Auto-refresh every 5 seconds
        refreshDashboard();
        setInterval(refreshDashboard, 5000);
    </script>
</body>
</html>`;
  }
};
