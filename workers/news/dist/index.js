"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = {
    // 1. HTTP Trigger for manual sync / testing
    async fetch(request, env) {
        await this.syncNews(env);
        return new Response(JSON.stringify({ success: true, message: "News database synchronized." }), {
            headers: { "Content-Type": "application/json" }
        });
    },
    // 2. Cron Trigger
    async scheduled(event, env, ctx) {
        console.log("Running news sync cron...");
        ctx.waitUntil(this.syncNews(env));
    },
    async syncNews(env) {
        const now = Date.now();
        // Setup dynamic dates for realistic high impact calendar mock items
        const events = [
            {
                id: "evt_cpi",
                time: now + 4 * 3600 * 1000, // 4 hours in future
                currency: "USD",
                eventName: "Core CPI Inflation Rate MoM",
                impactLevel: "HIGH",
                forecast: 0.3,
                previous: 0.2
            },
            {
                id: "evt_nfp",
                time: now + 24 * 3600 * 1000, // tomorrow
                currency: "USD",
                eventName: "Non-Farm Payrolls",
                impactLevel: "HIGH",
                forecast: 185000,
                previous: 206000
            },
            {
                id: "evt_fomc",
                time: now + 48 * 3600 * 1000, // 2 days in future
                currency: "USD",
                eventName: "FED Interest Rate Decision",
                impactLevel: "HIGH",
                forecast: 5.25,
                previous: 5.25
            },
            {
                id: "evt_gdp",
                time: now - 2 * 3600 * 1000, // 2 hours ago (news lock cleared)
                currency: "USD",
                eventName: "GDP Growth Rate QoQ (Prelim)",
                impactLevel: "HIGH",
                actual: 2.1,
                forecast: 2.0,
                previous: 1.8
            }
        ];
        try {
            // Clear old events older than 24 hours
            const cutoff = now - 24 * 3600 * 1000;
            await env.DB.prepare("DELETE FROM news_calendar WHERE time < ?").bind(cutoff).run();
            // Insert/replace current events
            for (const ev of events) {
                await env.DB.prepare("INSERT OR REPLACE INTO news_calendar (id, time, currency, eventName, impactLevel, actual, forecast, previous) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(ev.id, ev.time, ev.currency, ev.eventName, ev.impactLevel, ev.actual !== undefined ? ev.actual : null, ev.forecast !== undefined ? ev.forecast : null, ev.previous !== undefined ? ev.previous : null).run();
            }
            // Log audit
            await env.DB.prepare("INSERT INTO audit_logs (timestamp, level, accountId, component, action, message) VALUES (?, ?, ?, ?, ?, ?)").bind(now, "INFO", "SYSTEM", "news-worker", "NEWS_SYNC_COMPLETE", `Successfully updated news calendar with ${events.length} events.`).run();
            console.log("News sync completed successfully.");
        }
        catch (e) {
            console.error("Failed to sync news calendar:", e.message);
            try {
                await env.DB.prepare("INSERT INTO audit_logs (timestamp, level, accountId, component, action, message) VALUES (?, ?, ?, ?, ?, ?)").bind(now, "ERROR", "SYSTEM", "news-worker", "NEWS_SYNC_FAILED", `News calendar update failed: ${e.message}`).run();
            }
            catch { }
        }
    }
};
