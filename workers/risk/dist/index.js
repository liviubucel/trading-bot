"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const risk_engine_1 = require("@zebrabyte/risk-engine");
const market_models_1 = require("@zebrabyte/market-models");
exports.default = {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method !== "POST" || url.pathname !== "/evaluate") {
            return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
        }
        try {
            const command = await request.json();
            if (!command.commandId || !command.accountId || !command.symbol) {
                return new Response(JSON.stringify({ error: "Invalid request payload" }), { status: 400 });
            }
            // 1. Idempotency / Duplicate Command Check (10 seconds window)
            const tenSecondsAgo = Date.now() - 10000;
            const dupCheck = await env.DB.prepare("SELECT COUNT(*) as count FROM audit_logs WHERE accountId = ? AND contextJson LIKE ? AND timestamp >= ?").bind(command.accountId, `%"commandId":"${command.commandId}"%`, tenSecondsAgo).first();
            if (dupCheck && dupCheck.count > 0) {
                await env.DB.prepare("INSERT INTO audit_logs (timestamp, level, accountId, component, action, message, contextJson) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(Date.now(), "WARN", command.accountId, "risk-worker", "COMMAND_DUPLICATE_BLOCKED", `Blocked duplicate command execution for ID: ${command.commandId} (within 10s)`, JSON.stringify(command)).run();
                return new Response(JSON.stringify({
                    allowed: false,
                    reason: `Duplicate command submission. Command ${command.commandId} was already submitted within the last 10 seconds.`,
                    ruleEvaluated: "DUPLICATE_ORDER_PROTECTION",
                }), { status: 400 });
            }
            // Log receipt of command
            await env.DB.prepare("INSERT INTO audit_logs (timestamp, level, accountId, component, action, message, contextJson) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(Date.now(), "INFO", command.accountId, "risk-worker", "COMMAND_RECEIVED", `Evaluating command ${command.action} for ${command.symbol}`, JSON.stringify(command)).run();
            // 2. Fetch Risk Config from D1
            const configRecord = await env.DB.prepare("SELECT valueJson FROM config WHERE key = 'risk_config'").first();
            if (!configRecord) {
                return new Response(JSON.stringify({ error: "Risk configuration not found in database" }), { status: 500 });
            }
            const riskConfig = JSON.parse(configRecord.valueJson);
            // 3. Query Real-Time state from the Account's Durable Object (Balance, Equity, Prices)
            const doId = env.CTRADER_ACCOUNT_DO.idFromName(command.accountId);
            const doStub = env.CTRADER_ACCOUNT_DO.get(doId);
            const doStatusResponse = await doStub.fetch(new Request("http://do/status"));
            let balance = 100000;
            let equity = 100000;
            let prices = {
                US30: { bid: 39500, ask: 39501, timestamp: Date.now() },
                XAUUSD: { bid: 2350, ask: 2350.5, timestamp: Date.now() },
            };
            if (doStatusResponse.ok) {
                const doStatus = await doStatusResponse.json();
                balance = doStatus.balance;
                equity = doStatus.equity;
                if (doStatus.prices) {
                    prices = doStatus.prices;
                }
            }
            // 4. Fetch Active Positions from D1
            const { results: rawPositions } = await env.DB.prepare("SELECT * FROM positions WHERE accountId = ?").bind(command.accountId).all();
            const activePositions = rawPositions.map((p) => ({
                positionId: p.positionId,
                accountId: p.accountId,
                symbol: p.symbol,
                volume: p.volume,
                entryPrice: p.entryPrice,
                tradeSide: p.tradeSide,
                stopLoss: p.stopLoss || undefined,
                takeProfit: p.takeProfit || undefined,
                unrealizedPl: p.unrealizedPl,
                openedAt: p.openedAt,
            }));
            // 5. Fetch High Impact News from D1
            const now = Date.now();
            const lookahead = now + (riskConfig.newsLockMinutesBefore * 60 * 1000);
            const lookbehind = now - (riskConfig.newsLockMinutesAfter * 60 * 1000);
            const { results: rawNews } = await env.DB.prepare("SELECT * FROM news_calendar WHERE time >= ? AND time <= ? AND impactLevel = 'HIGH'").bind(lookbehind, lookahead).all();
            const upcomingNews = rawNews.map((n) => ({
                id: n.id,
                time: n.time,
                currency: n.currency,
                eventName: n.eventName,
                impactLevel: n.impactLevel,
            }));
            // 6. Build Risk Context
            const baseSymbol = command.symbol;
            const spec = market_models_1.SYMBOL_SPECS[baseSymbol] || { pipSize: 0.01, pipValue: 0.01 };
            const riskContext = {
                equity,
                balance,
                dailyStartingBalance: balance, // fallback for simplicity in milestone 1
                activePositions,
                upcomingNews,
                latestBid: prices[baseSymbol]?.bid || 0,
                latestAsk: prices[baseSymbol]?.ask || 0,
                symbolPipSize: spec.pipSize,
                symbolPipValue: spec.pipValue,
            };
            // 7. Evaluate with Risk Engine
            const riskResult = risk_engine_1.RiskEngine.evaluateCommand(command, riskConfig, riskContext);
            // Log Decision in D1
            await env.DB.prepare("INSERT INTO audit_logs (timestamp, level, accountId, component, action, message, contextJson) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(Date.now(), riskResult.allowed ? "INFO" : "WARN", command.accountId, "risk-worker", riskResult.allowed ? "COMMAND_ALLOWED" : "COMMAND_REJECTED", riskResult.allowed
                ? `Command ${command.commandId} successfully passed all risk checks.`
                : `Command ${command.commandId} rejected: ${riskResult.reason}`, JSON.stringify({ command, decision: riskResult })).run();
            return new Response(JSON.stringify(riskResult), {
                headers: { "Content-Type": "application/json" },
            });
        }
        catch (e) {
            console.error("Risk Worker error:", e);
            return new Response(JSON.stringify({ error: e.message }), { status: 500 });
        }
    }
};
