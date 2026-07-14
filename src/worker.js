const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-app-token"
};

const DEFAULT_AGENTS = [
  { id: "trend", name: "Trend Agent", weight: 0.26, icon: "📈" },
  { id: "momentum", name: "Momentum Agent", weight: 0.22, icon: "⚡" },
  { id: "volatility", name: "Volatility Agent", weight: 0.18, icon: "🌊" },
  { id: "pattern", name: "Price Action Agent", weight: 0.18, icon: "🕯️" },
  { id: "risk", name: "Risk Guard Agent", weight: 0.16, icon: "🛡️" }
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: JSON_HEADERS });

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health") return json({ ok: true, service: "valetax-mt5-ai-bot", time: new Date().toISOString() });
      if (url.pathname === "/api/agents") return json({ ok: true, agents: DEFAULT_AGENTS, aiModel: env.AI_MODEL || "fallback-vote" });
      if (url.pathname === "/api/analyze" && request.method === "POST") return handleAnalyze(request, env);
      if (url.pathname === "/api/signal" && request.method === "GET") return handleSignal(request, env);
      if (url.pathname === "/api/quote" && request.method === "GET") return handleQuote(request, env);
      if (url.pathname === "/api/prompt" && request.method === "POST") return handlePrompt(request, env);

      if (env.ASSETS) return env.ASSETS.fetch(request);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ ok: false, error: err?.message || String(err) }, err?.status || 500);
    }
  }
};

async function handleAnalyze(request, env) {
  requireAuth(request, env);
  const body = await safeJson(request);
  const input = normalizeInput(body || {});
  const result = await computeSignal(input, env);
  return json({ ok: true, ...result });
}

async function handleSignal(request, env) {
  requireAuth(request, env);
  const url = new URL(request.url);
  const input = normalizeInput(Object.fromEntries(url.searchParams.entries()));
  const result = await computeSignal(input, env);

  // Compact format for MT5 EA. Keep keys stable and primitive.
  return json({
    ok: true,
    symbol: result.symbol,
    mt5Login: result.account?.mt5Login || "",
    mt5Server: result.account?.mt5Server || "",
    action: result.action,
    direction: result.direction,
    confidence: result.confidence,
    lotRiskPercent: result.risk.riskPercent,
    slPoints: result.risk.slPoints,
    tpPoints: result.risk.tpPoints,
    maxSpreadPoints: result.risk.maxSpreadPoints,
    reason: result.summary,
    time: result.time
  });
}

async function handleQuote(request, env) {
  requireAuth(request, env);
  const url = new URL(request.url);
  const symbol = String(url.searchParams.get("symbol") || "XAUUSD").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "XAUUSD";
  const quote = await fetchStooqQuote(symbol);
  return json({ ok: true, ...quote });
}

async function handlePrompt(request, env) {
  requireAuth(request, env);
  const body = await safeJson(request);
  const prompt = String(body?.prompt || "").slice(0, 4000);
  if (!prompt) return json({ ok: false, error: "prompt required" }, 400);
  const answer = await runCloudflareAi(env, [
    { role: "system", content: "You are a concise trading-risk assistant. Never guarantee profit. Always mention risk management." },
    { role: "user", content: prompt }
  ]);
  return json({ ok: true, answer });
}

async function computeSignal(input, env) {
  const agents = evaluateAgents(input);
  const fallback = weightedVote(agents, input, env);
  const aiDecision = await aiConsensus(input, agents, fallback, env);
  const chosen = sanitizeDecision(aiDecision || fallback, fallback);
  const risk = riskPlan(input, chosen, env);

  return {
    ok: true,
    time: new Date().toISOString(),
    symbol: input.symbol,
    account: {
      mt5Login: input.mt5Login,
      mt5Server: input.mt5Server,
      accountType: input.accountType
    },
    action: chosen.action,
    direction: chosen.direction,
    confidence: chosen.confidence,
    summary: chosen.summary,
    risk,
    agents,
    warning: "Ini scaffold edukasi/teknis, bukan nasihat finansial. Uji di akun demo terlebih dahulu. Tidak ada jaminan profit."
  };
}

function evaluateAgents(input) {
  const emaFast = num(input.emaFast);
  const emaSlow = num(input.emaSlow);
  const rsi = num(input.rsi, 50);
  const atrPoints = num(input.atrPoints, 0);
  const price = num(input.price, 0);
  const spreadPoints = num(input.spreadPoints, 0);
  const candleDir = String(input.candleDir || "neutral").toLowerCase();

  const trendScore = emaFast && emaSlow ? clamp((emaFast - emaSlow) / Math.max(Math.abs(emaSlow), 0.00001) * 12000, -100, 100) : 0;
  const momentumScore = clamp((rsi - 50) * 2.2, -100, 100);
  const volRatio = price > 0 ? (atrPoints / Math.max(price, 0.00001)) * 10000 : atrPoints;
  const volPenalty = volRatio > 40 ? -25 : volRatio < 2 && volRatio > 0 ? -10 : 10;
  const patternScore = candleDir.startsWith("bull") ? 45 : candleDir.startsWith("bear") ? -45 : 0;
  const riskScore = spreadPoints > num(input.maxSpreadPoints, 35) ? 0 : 25;

  return [
    buildAgent("trend", trendScore, "EMA fast vs EMA slow"),
    buildAgent("momentum", momentumScore, `RSI ${round(rsi, 2)}`),
    buildAgent("volatility", volPenalty, `ATR/spread filter ${round(volRatio, 2)}`),
    buildAgent("pattern", patternScore, `Candle direction ${candleDir}`),
    buildAgent("risk", riskScore, `Spread ${spreadPoints} pts`)
  ];
}

function buildAgent(id, score, reason) {
  const meta = DEFAULT_AGENTS.find(a => a.id === id);
  const direction = score > 12 ? "bullish" : score < -12 ? "bearish" : "neutral";
  const confidence = Math.round(clamp(Math.abs(score), 0, 100));
  return { ...meta, score: Math.round(score), direction, confidence, reason };
}

function weightedVote(agents, input, env) {
  const weighted = agents.reduce((sum, a) => sum + a.score * a.weight, 0);
  const confidence = Math.round(clamp(Math.abs(weighted) * 1.6 + 35, 0, 100));
  const minConfidence = num(input.minConfidence, num(env.DEFAULT_MIN_CONFIDENCE, 65));
  let action = "hold";
  let direction = "neutral";
  if (confidence >= minConfidence && weighted > 12) { action = "buy"; direction = "bullish"; }
  if (confidence >= minConfidence && weighted < -12) { action = "sell"; direction = "bearish"; }
  return {
    action,
    direction,
    confidence,
    summary: `Weighted 5-agent vote: ${round(weighted, 2)}. Minimum confidence: ${minConfidence}.`
  };
}

async function aiConsensus(input, agents, fallback, env) {
  if (!env.AI) return fallback;
  const compact = { input, agents, fallback };
  const prompt = `Return ONLY valid JSON with keys action(buy/sell/hold), direction(bullish/bearish/neutral), confidence(0-100), summary. Do not add markdown. Use strict risk management and choose hold when uncertain. Data: ${JSON.stringify(compact).slice(0, 7000)}`;
  try {
    const text = await runCloudflareAi(env, [
      { role: "system", content: "You are a conservative MT5 trading signal consensus engine. You do not guarantee profit. You prefer HOLD unless signal quality is adequate." },
      { role: "user", content: prompt }
    ]);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    return JSON.parse(match[0]);
  } catch (_) {
    return fallback;
  }
}

async function runCloudflareAi(env, messages) {
  if (!env.AI) return "Cloudflare AI binding is not enabled. Fallback rules are active.";
  const model = env.AI_MODEL || "@cf/meta/llama-3.1-8b-instruct";
  const out = await env.AI.run(model, { messages, max_tokens: 512, temperature: 0.2 });
  return out?.response || out?.result?.response || JSON.stringify(out);
}

function sanitizeDecision(value, fallback) {
  const action = ["buy", "sell", "hold"].includes(String(value.action).toLowerCase()) ? String(value.action).toLowerCase() : fallback.action;
  const direction = action === "buy" ? "bullish" : action === "sell" ? "bearish" : "neutral";
  return {
    action,
    direction,
    confidence: Math.round(clamp(num(value.confidence, fallback.confidence), 0, 100)),
    summary: String(value.summary || fallback.summary).slice(0, 240)
  };
}

function riskPlan(input, decision, env) {
  const riskPercent = clamp(num(input.riskPercent, num(env.DEFAULT_MAX_RISK_PERCENT, 1)), 0.1, 5);
  const atr = num(input.atrPoints, 0);
  const rr = clamp(num(input.rr, 1.5), 0.5, 5);
  const rawSl = num(input.slPoints, 0);
  const slBasis = rawSl > 0 ? rawSl : (atr ? atr * 1.5 : 250);
  const slPoints = Math.round(clamp(slBasis, 20, 10000));
  const rawTp = num(input.tpPoints, 0);
  const tpBasis = rawTp > 0 ? rawTp : slPoints * rr;
  const tpPoints = Math.round(clamp(tpBasis, 20, 50000));
  const maxSpreadPoints = Math.round(clamp(num(input.maxSpreadPoints, 35), 1, 1000));
  return { riskPercent, slPoints, tpPoints, rr, maxSpreadPoints, allowed: decision.action !== "hold" && decision.confidence >= num(input.minConfidence, 65) };
}

async function fetchStooqQuote(symbol) {
  // No-key quote source for UI convenience. Broker/MT5 prices can differ by spread/liquidity.
  const stooqSymbol = symbol === "XAUUSD" ? "xauusd" : symbol.toLowerCase();
  const res = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&f=sd2t2ohlcv&h&e=csv`, {
    headers: { "user-agent": "ValetaxCloudflareAIBot/1.0" },
    cf: { cacheTtl: 15, cacheEverything: false }
  });
  if (!res.ok) throw Object.assign(new Error(`Quote provider HTTP ${res.status}`), { status: 502 });
  const text = await res.text();
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw Object.assign(new Error("Quote provider returned no data"), { status: 502 });
  const row = parseCsvLine(lines[1]);
  const [srcSymbol, date, time, open, high, low, close, volume] = row;
  const price = num(close, NaN);
  if (!Number.isFinite(price)) throw Object.assign(new Error("Quote provider returned invalid price"), { status: 502 });
  return {
    symbol,
    provider: "stooq",
    providerSymbol: srcSymbol,
    price,
    open: num(open, 0),
    high: num(high, 0),
    low: num(low, 0),
    close: price,
    quoteTime: `${date} ${time} UTC`,
    fetchedAt: new Date().toISOString(),
    note: "Harga referensi; harga broker Valetax/MT5 dapat berbeda. EA memakai bid/ask dari MT5."
  };
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function normalizeInput(raw) {
  return {
    symbol: String(raw.symbol || raw.pair || "XAUUSD").toUpperCase().slice(0, 24),
    pairLink: String(raw.pairLink || raw.link || "").slice(0, 500),
    price: num(raw.price, 0),
    emaFast: num(raw.emaFast, 0),
    emaSlow: num(raw.emaSlow, 0),
    rsi: num(raw.rsi, 50),
    atrPoints: num(raw.atrPoints, 0),
    spreadPoints: num(raw.spreadPoints, 0),
    candleDir: String(raw.candleDir || "neutral").slice(0, 16),
    riskPercent: num(raw.riskPercent, 1),
    minConfidence: num(raw.minConfidence, 65),
    maxSpreadPoints: num(raw.maxSpreadPoints, 35),
    slPoints: num(raw.slPoints, 0),
    tpPoints: num(raw.tpPoints, 0),
    rr: num(raw.rr, 1.5),
    mt5Login: String(raw.mt5Login || raw.accountLogin || "").replace(/[^0-9]/g, "").slice(0, 32),
    mt5Server: String(raw.mt5Server || raw.accountServer || "").slice(0, 80),
    accountType: ["demo", "live"].includes(String(raw.accountType).toLowerCase()) ? String(raw.accountType).toLowerCase() : "demo"
  };
}

function requireAuth(request, env) {
  const expected = env.APP_TOKEN;
  if (!expected) return;
  const url = new URL(request.url);
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const token = request.headers.get("x-app-token") || bearer || url.searchParams.get("token");
  if (token !== expected) {
    throw Object.assign(new Error("Unauthorized: set APP_TOKEN in UI/EA and Worker secret."), { status: 401 });
  }
}

async function safeJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function json(obj, status = 200) {
  const code = obj?.error?.startsWith?.("Unauthorized") ? 401 : status;
  return new Response(JSON.stringify(obj, null, 2), { status: code, headers: JSON_HEADERS });
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round(n, digits = 2) { return Math.round(n * 10 ** digits) / 10 ** digits; }
