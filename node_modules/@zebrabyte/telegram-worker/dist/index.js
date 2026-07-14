"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = {
    async fetch(request, env) {
        // Standard webhook is POST. Let's support POST for webhook updates
        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "Only POST requests accepted for Telegram webhook" }), { status: 405, headers: { "Content-Type": "application/json" } });
        }
        try {
            const update = await request.json();
            const message = update.message;
            if (!message || !message.text || !message.chat || !message.chat.id) {
                return new Response(JSON.stringify({ status: "ignored" }), { headers: { "Content-Type": "application/json" } });
            }
            const text = message.text.trim();
            const chatId = message.chat.id;
            // Extract command
            const command = text.split(" ")[0].split("@")[0].toLowerCase();
            let responseText = "";
            switch (command) {
                case "/status":
                    responseText = await this.handleStatus(env);
                    break;
                case "/accounts":
                    responseText = await this.handleAccounts(env);
                    break;
                case "/positions":
                    responseText = await this.handlePositions(env);
                    break;
                case "/orders":
                    responseText = await this.handleOrders(env);
                    break;
                case "/market":
                    responseText = await this.handleMarket(env);
                    break;
                case "/calendar":
                    responseText = await this.handleCalendar(env);
                    break;
                case "/news":
                    responseText = await this.handleNews(env);
                    break;
                case "/health":
                    responseText = await this.handleHealth(env);
                    break;
                default:
                    responseText = `Unknown command: ${command}\nAvailable commands:\n/status, /accounts, /positions, /orders, /market, /calendar, /news, /health`;
            }
            // Return the standard Telegram Webhook JSON response
            return new Response(JSON.stringify({
                method: "sendMessage",
                chat_id: chatId,
                text: responseText,
                parse_mode: "Markdown",
            }), { headers: { "Content-Type": "application/json" } });
        }
        catch (e) {
            console.error("Telegram worker error:", e);
            return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    },
    async handleStatus(env) {
        let statusText = "*ZEBRABYTE PLATFORM STATUS*\n\n";
        // Global kill switch check
        const configRecord = await env.DB.prepare("SELECT valueJson FROM config WHERE key = 'risk_config'").first();
        const riskConfig = configRecord ? JSON.parse(configRecord.valueJson) : { globalKillSwitch: false };
        statusText += `*Global Kill Switch:* ${riskConfig.globalKillSwitch ? "⚠️ ACTIVE (BLOCKING)" : "✅ INACTIVE (NORMAL)"}\n`;
        // Live trading flag
        const safetyRecord = await env.DB.prepare("SELECT valueJson FROM config WHERE key = 'safety_config'").first();
        const safety = safetyRecord ? JSON.parse(safetyRecord.valueJson) : { enableLiveTrading: false };
        statusText += `*Live Trading Mode:* ${safety.enableLiveTrading ? "⚠️ ACTIVE" : "🛡️ READ-ONLY (SIMULATED)"}\n\n`;
        // Accounts list status
        const { results: accounts } = await env.DB.prepare("SELECT accountId, brokerName, isConnected FROM accounts").all();
        statusText += `*Connected Accounts (${accounts.length}):*\n`;
        for (const acct of accounts) {
            statusText += `- ID: \`${acct.accountId}\` (${acct.brokerName}) -> ${acct.isConnected ? "🟢 ONLINE" : "🔴 OFFLINE"}\n`;
        }
        return statusText;
    },
    async handleAccounts(env) {
        const { results: accounts } = await env.DB.prepare("SELECT * FROM accounts").all();
        if (accounts.length === 0) {
            return "No accounts registered on the platform.";
        }
        let response = "*ZEBRABYTE ACCOUNTS REPORT*\n\n";
        let totalBal = 0;
        let totalEq = 0;
        for (const acct of accounts) {
            // Query DO for latest balance & equity
            const doId = env.CTRADER_ACCOUNT_DO.idFromName(acct.accountId);
            const doStub = env.CTRADER_ACCOUNT_DO.get(doId);
            let balance = acct.balance;
            let equity = acct.equity;
            let isConnected = acct.isConnected;
            try {
                const doRes = await doStub.fetch(new Request("http://do/status"));
                if (doRes.ok) {
                    const doStatus = await doRes.json();
                    balance = doStatus.balance;
                    equity = doStatus.equity;
                    isConnected = doStatus.isConnected;
                }
            }
            catch (err) { }
            totalBal += balance;
            totalEq += equity;
            response += `*Account:* \`${acct.accountId}\` (${acct.brokerName})\n`;
            response += `- Status: ${isConnected ? "🟢 Connected" : "🔴 Disconnected"}\n`;
            response += `- Balance: \`$${balance.toFixed(2)}\`\n`;
            response += `- Equity: \`$${equity.toFixed(2)}\`\n\n`;
        }
        response += `*TOTALS*\n- Total Balance: \`$${totalBal.toFixed(2)}\`\n- Total Equity: \`$${totalEq.toFixed(2)}\``;
        return response;
    },
    async handlePositions(env) {
        const { results: accounts } = await env.DB.prepare("SELECT accountId FROM accounts").all();
        if (accounts.length === 0)
            return "No connected accounts found.";
        let response = "*ACTIVE OPEN POSITIONS*\n\n";
        let count = 0;
        for (const acct of accounts) {
            const doId = env.CTRADER_ACCOUNT_DO.idFromName(acct.accountId);
            const doStub = env.CTRADER_ACCOUNT_DO.get(doId);
            try {
                const doRes = await doStub.fetch(new Request("http://do/positions"));
                if (doRes.ok) {
                    const positions = await doRes.json();
                    for (const pos of positions) {
                        count++;
                        response += `*Position:* \`${pos.positionId}\` (Acct: \`${pos.accountId}\`)\n`;
                        response += `- Symbol: \`${pos.symbol}\` | Side: \`${pos.tradeSide}\`\n`;
                        response += `- Volume: \`${pos.volume}\` units | Entry: \`${pos.entryPrice.toFixed(2)}\`\n`;
                        response += `- Floating PnL: \`$${pos.unrealizedPl.toFixed(2)}\`\n\n`;
                    }
                }
            }
            catch (err) { }
        }
        if (count === 0) {
            return "There are currently no active open positions.";
        }
        return response;
    },
    async handleOrders(env) {
        const { results: accounts } = await env.DB.prepare("SELECT accountId FROM accounts").all();
        if (accounts.length === 0)
            return "No connected accounts found.";
        let response = "*PENDING ORDERS*\n\n";
        let count = 0;
        for (const acct of accounts) {
            const doId = env.CTRADER_ACCOUNT_DO.idFromName(acct.accountId);
            const doStub = env.CTRADER_ACCOUNT_DO.get(doId);
            try {
                const doRes = await doStub.fetch(new Request("http://do/orders"));
                if (doRes.ok) {
                    const orders = await doRes.json();
                    for (const ord of orders) {
                        count++;
                        response += `*Order:* \`${ord.orderId}\`\n`;
                        response += `- Symbol: \`${ord.symbol}\` | Side: \`${ord.tradeSide}\` | Type: \`${ord.orderType}\`\n`;
                        response += `- Volume: \`${ord.volume}\` units | Target Price: \`${(ord.limitPrice || ord.stopPrice || 0).toFixed(2)}\`\n\n`;
                    }
                }
            }
            catch (err) { }
        }
        if (count === 0) {
            return "There are currently no active pending orders.";
        }
        return response;
    },
    async handleMarket(env) {
        const { results: accounts } = await env.DB.prepare("SELECT accountId FROM accounts LIMIT 1").all();
        if (accounts.length === 0)
            return "No registered accounts to query prices from.";
        const accountId = accounts[0].accountId;
        const doId = env.CTRADER_ACCOUNT_DO.idFromName(accountId);
        const doStub = env.CTRADER_ACCOUNT_DO.get(doId);
        try {
            const doRes = await doStub.fetch(new Request("http://do/prices"));
            if (doRes.ok) {
                const prices = await doRes.json();
                let response = "*ZEBRABYTE MARKET MONITOR*\n\n";
                for (const [sym, price] of Object.entries(prices)) {
                    const spread = (price.ask - price.bid).toFixed(2);
                    const ageSec = ((Date.now() - price.timestamp) / 1000).toFixed(1);
                    response += `*Symbol:* \`${sym}\`\n`;
                    response += `- Bid: \`${price.bid.toFixed(2)}\`\n`;
                    response += `- Ask: \`${price.ask.toFixed(2)}\`\n`;
                    response += `- Spread: \`${spread}\` | Latency: \`${ageSec}s\`\n\n`;
                }
                return response;
            }
        }
        catch (err) { }
        return "Failed to fetch current market prices.";
    },
    async handleCalendar(env) {
        const { results: news } = await env.DB.prepare("SELECT * FROM news_calendar WHERE time >= ? ORDER BY time ASC LIMIT 5").bind(Date.now() - 3600000).all(); // shows starting 1hr ago
        if (news.length === 0) {
            return "No upcoming economic events in calendar.";
        }
        let response = "*ECONOMIC CALENDAR (UPCOMING)*\n\n";
        for (const item of news) {
            const dateStr = new Date(item.time).toLocaleString();
            const impactSymbol = item.impactLevel === "HIGH" ? "🔴" : item.impactLevel === "MEDIUM" ? "🟡" : "🟢";
            response += `${impactSymbol} *${item.eventName}* (${item.currency})\n`;
            response += `- Time: \`${dateStr}\`\n`;
            response += `- Forecast: \`${item.forecast || "N/A"}\` | Previous: \`${item.previous || "N/A"}\`\n\n`;
        }
        return response;
    },
    async handleNews(env) {
        // Show high-impact log events or general updates
        const { results: logs } = await env.DB.prepare("SELECT * FROM audit_logs WHERE component = 'news-worker' OR component = 'risk-worker' ORDER BY timestamp DESC LIMIT 5").all();
        if (logs.length === 0) {
            return "No news feeds or risk alerts cached recently.";
        }
        let response = "*ZEBRABYTE ALERTS FEED*\n\n";
        for (const log of logs) {
            const dateStr = new Date(log.timestamp).toLocaleTimeString();
            response += `[${dateStr}] [${log.level}] *${log.action}*\n${log.message}\n\n`;
        }
        return response;
    },
    async handleHealth(env) {
        let healthText = "*ZEBRABYTE PLATFORM HEALTH DIAGNOSTICS*\n\n";
        try {
            const dbStatus = await env.DB.prepare("SELECT 1").first();
            healthText += `- *Database (D1):* ${dbStatus ? "💚 HEALTHY" : "💔 UNRESPONSIVE"}\n`;
        }
        catch {
            healthText += `- *Database (D1):* 💔 ERROR\n`;
        }
        const { results: accounts } = await env.DB.prepare("SELECT accountId FROM accounts").all();
        if (accounts.length > 0) {
            let doReachable = 0;
            for (const acct of accounts) {
                const doId = env.CTRADER_ACCOUNT_DO.idFromName(acct.accountId);
                const doStub = env.CTRADER_ACCOUNT_DO.get(doId);
                try {
                    const res = await doStub.fetch(new Request("http://do/status"));
                    if (res.ok)
                        doReachable++;
                }
                catch { }
            }
            healthText += `- *Durable Objects:* ${doReachable === accounts.length ? "💚 HEALTHY" : `💛 PARTIAL (${doReachable}/${accounts.length} reachable)`}\n`;
        }
        else {
            healthText += `- *Durable Objects:* ⚪ NO ACCOUNTS MOUNTED\n`;
        }
        healthText += `\n*System UTC:* \`${new Date().toISOString()}\``;
        return healthText;
    }
};
