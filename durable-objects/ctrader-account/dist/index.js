"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CTraderAccount = void 0;
const cloudflare_sockets_1 = require("cloudflare:sockets");
const ctrader_protocol_1 = require("@zebrabyte/ctrader-protocol");
const market_models_1 = require("@zebrabyte/market-models");
class CTraderAccount {
    state;
    env;
    accountId;
    socket = null;
    isConnected = false;
    reconnectTimeout = null;
    pingInterval = null;
    reconnectDelay = 1000; // start with 1 second
    // In-memory states updated via streams
    balance = 100000;
    equity = 100000;
    prices = {
        US30: { bid: 39500, ask: 39501, timestamp: Date.now() },
        XAUUSD: { bid: 2350, ask: 2350.5, timestamp: Date.now() },
    };
    symbolsMap = {};
    constructor(state, env) {
        this.state = state;
        this.env = env;
        // Derive accountId from the Durable Object ID / name
        this.accountId = state.id.toString();
        // Start background connection
        this.state.blockConcurrencyWhile(async () => {
            // Load stored state if any
            const storedBalance = await this.state.storage.get("balance");
            const storedEquity = await this.state.storage.get("equity");
            if (storedBalance !== undefined)
                this.balance = storedBalance;
            if (storedEquity !== undefined)
                this.equity = storedEquity;
            // Asynchronously trigger connection so it doesn't block startup indefinitely
            this.connect();
        });
    }
    getHost() {
        return this.env.CTRADER_API_HOST || "demo.ctraderapi.com";
    }
    getPort() {
        return parseInt(this.env.CTRADER_API_PORT || "5035", 10);
    }
    useSsl() {
        return this.env.CTRADER_USE_SSL !== "false";
    }
    async connect() {
        if (this.socket) {
            return;
        }
        const host = this.getHost();
        const port = this.getPort();
        const ssl = this.useSsl();
        console.log(`[CTraderAccount ${this.accountId}] Connecting to TCP socket ${host}:${port} (SSL: ${ssl})...`);
        try {
            // Connect to TCP endpoint
            this.socket = (0, cloudflare_sockets_1.connect)({ hostname: host, port }, {
                secureTransport: ssl ? "ssl" : "off",
                allowHalfOpen: false
            });
            this.isConnected = true;
            this.reconnectDelay = 1000; // Reset reconnect delay
            // Log successful socket creation
            await this.logAudit("INFO", "TCP_SOCKET_CONNECTED", `Established socket connection to ${host}:${port}`);
            // Start ping loop
            this.startPingLoop();
            // Start reading stream in background
            this.readStream(this.socket.readable);
            // Trigger cTrader Open API authentication sequence
            await this.authenticate();
        }
        catch (err) {
            console.error(`[CTraderAccount ${this.accountId}] Socket connection failed:`, err);
            await this.logAudit("ERROR", "TCP_SOCKET_FAILED", `Failed to connect to ${host}:${port}: ${err.message}`);
            this.handleDisconnection();
        }
    }
    async authenticate() {
        if (!this.socket)
            return;
        const writer = this.socket.writable.getWriter();
        try {
            const clientId = this.env.CTRADER_CLIENT_ID || "mock_client_id";
            const clientSecret = this.env.CTRADER_CLIENT_SECRET || "mock_client_secret";
            console.log(`[CTraderAccount ${this.accountId}] Sending Application Auth...`);
            // 1. App Auth Request
            const appAuthPayload = (0, ctrader_protocol_1.encodeOAApplicationAuthReq)(clientId, clientSecret);
            const appAuthMsg = (0, ctrader_protocol_1.encodeProtoMessage)({
                payloadType: ctrader_protocol_1.PayloadType.PROTO_OA_APPLICATION_AUTH_REQ,
                payload: appAuthPayload,
                clientMsgId: `app_auth_${Date.now()}`
            });
            await writer.write(appAuthMsg);
            // We'll fetch account token from database to authenticate the account
            let accessToken = "mock_access_token";
            try {
                const dbRecord = await this.env.DB.prepare("SELECT tokenData FROM accounts WHERE accountId = ?").bind(this.accountId).first();
                if (dbRecord && dbRecord.tokenData) {
                    const parsed = JSON.parse(dbRecord.tokenData);
                    if (parsed.accessToken)
                        accessToken = parsed.accessToken;
                }
            }
            catch (e) {
                console.warn(`[CTraderAccount ${this.accountId}] D1 error while fetching access token, falling back to mock:`, e.message);
            }
            console.log(`[CTraderAccount ${this.accountId}] Sending Account Auth...`);
            // 2. Account Auth Request
            const parsedAcctId = parseInt(this.accountId, 10) || 12345;
            const acctAuthPayload = (0, ctrader_protocol_1.encodeOAAccountAuthReq)(parsedAcctId, accessToken);
            const acctAuthMsg = (0, ctrader_protocol_1.encodeProtoMessage)({
                payloadType: ctrader_protocol_1.PayloadType.PROTO_OA_ACCOUNT_AUTH_REQ,
                payload: acctAuthPayload,
                clientMsgId: `acct_auth_${Date.now()}`
            });
            await writer.write(acctAuthMsg);
            // 3. Symbols List Request
            console.log(`[CTraderAccount ${this.accountId}] Querying symbols list...`);
            const symbolsPayload = (0, ctrader_protocol_1.encodeOASymbolsListReq)(parsedAcctId);
            const symbolsMsg = (0, ctrader_protocol_1.encodeProtoMessage)({
                payloadType: ctrader_protocol_1.PayloadType.PROTO_OA_SYMBOLS_LIST_REQ,
                payload: symbolsPayload,
                clientMsgId: `symbols_${Date.now()}`
            });
            await writer.write(symbolsMsg);
        }
        catch (err) {
            console.error(`[CTraderAccount ${this.accountId}] Authentication setup failed:`, err);
        }
        finally {
            writer.releaseLock();
        }
    }
    startPingLoop() {
        this.stopPingLoop();
        this.pingInterval = setInterval(async () => {
            if (!this.socket)
                return;
            const writer = this.socket.writable.getWriter();
            try {
                const pingPayload = (0, ctrader_protocol_1.encodeProtoPingReq)(Date.now());
                const pingMsg = (0, ctrader_protocol_1.encodeProtoMessage)({
                    payloadType: ctrader_protocol_1.PayloadType.PROTO_PING_REQ,
                    payload: pingPayload,
                    clientMsgId: `ping_${Date.now()}`
                });
                await writer.write(pingMsg);
            }
            catch (err) {
                console.error("Ping error:", err);
            }
            finally {
                writer.releaseLock();
            }
        }, 20000); // Send heartbeat every 20 seconds
    }
    stopPingLoop() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
    async readStream(readable) {
        const reader = readable.getReader();
        const decoder = new ctrader_protocol_1.FrameDecoder();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    console.log(`[CTraderAccount ${this.accountId}] Socket stream closed.`);
                    break;
                }
                const messages = decoder.append(value);
                for (const msg of messages) {
                    await this.handleProtoMessage(msg);
                }
            }
        }
        catch (err) {
            console.error(`[CTraderAccount ${this.accountId}] Error in reader loop:`, err.message);
        }
        finally {
            reader.releaseLock();
            this.handleDisconnection();
        }
    }
    async handleProtoMessage(msg) {
        switch (msg.payloadType) {
            case ctrader_protocol_1.PayloadType.PROTO_PING_RES:
                // Heartbeat response, noop
                break;
            case ctrader_protocol_1.PayloadType.PROTO_OA_APPLICATION_AUTH_RES:
                console.log(`[CTraderAccount ${this.accountId}] Application successfully authenticated.`);
                await this.logAudit("INFO", "APP_AUTH_SUCCESS", "Application authenticated with cTrader OpenAPI");
                break;
            case ctrader_protocol_1.PayloadType.PROTO_OA_ACCOUNT_AUTH_RES:
                console.log(`[CTraderAccount ${this.accountId}] Account successfully authenticated.`);
                await this.logAudit("INFO", "ACCOUNT_AUTH_SUCCESS", `Account ${this.accountId} authenticated successfully`);
                break;
            case ctrader_protocol_1.PayloadType.PROTO_OA_SYMBOLS_LIST_RES: {
                const { symbols } = (0, ctrader_protocol_1.decodeOASymbolsListRes)(msg.payload);
                console.log(`[CTraderAccount ${this.accountId}] Received ${symbols.length} symbols.`);
                // Cache symbols in memory
                for (const sym of symbols) {
                    this.symbolsMap[sym.symbolId] = sym.symbolName;
                }
                // Now subscribe to US30 and XAUUSD spot events
                const broker = await this.getBrokerName();
                const brokerUS30 = market_models_1.SymbolMapper.mapToBrokerSymbol("US30", broker);
                const brokerXAUUSD = market_models_1.SymbolMapper.mapToBrokerSymbol("XAUUSD", broker);
                const targetIds = [];
                for (const sym of symbols) {
                    if (sym.symbolName === brokerUS30 || sym.symbolName === brokerXAUUSD) {
                        targetIds.push(sym.symbolId);
                    }
                }
                if (targetIds.length > 0 && this.socket) {
                    console.log(`[CTraderAccount ${this.accountId}] Subscribing to spot prices for symbols:`, targetIds.map(id => this.symbolsMap[id]));
                    const writer = this.socket.writable.getWriter();
                    try {
                        const parsedAcctId = parseInt(this.accountId, 10) || 12345;
                        const subPayload = (0, ctrader_protocol_1.encodeOASubscribeSpotsReq)(parsedAcctId, targetIds);
                        const subMsg = (0, ctrader_protocol_1.encodeProtoMessage)({
                            payloadType: ctrader_protocol_1.PayloadType.PROTO_OA_SUBSCRIBE_SPOTS_REQ,
                            payload: subPayload,
                            clientMsgId: `sub_${Date.now()}`
                        });
                        await writer.write(subMsg);
                    }
                    catch (e) {
                        console.error("Subscription write error:", e);
                    }
                    finally {
                        writer.releaseLock();
                    }
                }
                break;
            }
            case ctrader_protocol_1.PayloadType.PROTO_OA_SUBSCRIBE_SPOTS_RES:
                console.log(`[CTraderAccount ${this.accountId}] Successfully subscribed to spot prices.`);
                break;
            case ctrader_protocol_1.PayloadType.PROTO_OA_SPOT_EVENT: {
                const event = (0, ctrader_protocol_1.decodeOASpotEvent)(msg.payload);
                const symName = this.symbolsMap[event.symbolId];
                if (symName) {
                    const broker = await this.getBrokerName();
                    const baseSymbol = market_models_1.SymbolMapper.mapFromBrokerSymbol(symName, broker);
                    if (baseSymbol) {
                        // Factor down bid/ask values from protobuf integers if using custom float-as-integer representation
                        const bidVal = event.bid !== undefined ? event.bid : this.prices[baseSymbol].bid;
                        const askVal = event.ask !== undefined ? event.ask : this.prices[baseSymbol].ask;
                        this.prices[baseSymbol] = {
                            bid: bidVal,
                            ask: askVal,
                            timestamp: event.timestamp || Date.now(),
                        };
                    }
                }
                break;
            }
            case ctrader_protocol_1.PayloadType.PROTO_PING_REQ: {
                // Handle mock ping from mock server
                if (this.socket) {
                    const writer = this.socket.writable.getWriter();
                    try {
                        const responsePayload = (0, ctrader_protocol_1.encodeProtoPingReq)(Date.now());
                        const responseMsg = (0, ctrader_protocol_1.encodeProtoMessage)({
                            payloadType: ctrader_protocol_1.PayloadType.PROTO_PING_RES,
                            payload: responsePayload,
                            clientMsgId: msg.clientMsgId
                        });
                        await writer.write(responseMsg);
                    }
                    catch (e) {
                        console.error("Error writing ping response", e);
                    }
                    finally {
                        writer.releaseLock();
                    }
                }
                break;
            }
        }
    }
    async getBrokerName() {
        try {
            const record = await this.env.DB.prepare("SELECT brokerName FROM accounts WHERE accountId = ?").bind(this.accountId).first();
            return record?.brokerName || "ICMarkets";
        }
        catch {
            return "ICMarkets";
        }
    }
    handleDisconnection() {
        this.isConnected = false;
        this.socket = null;
        this.stopPingLoop();
        console.log(`[CTraderAccount ${this.accountId}] Socket disconnected. Reconnecting in ${this.reconnectDelay}ms...`);
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = setTimeout(() => {
            this.connect();
            // Exponential backoff
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        }, this.reconnectDelay);
    }
    async logAudit(level, action, message) {
        try {
            await this.env.DB.prepare("INSERT INTO audit_logs (timestamp, level, accountId, component, action, message) VALUES (?, ?, ?, ?, ?, ?)").bind(Date.now(), level, this.accountId, "ctrader-account-do", action, message).run();
        }
        catch (e) {
            console.error("Failed to write DO audit log to D1:", e.message);
        }
    }
    // Force close connection for manual testing of reconnects
    simulateDisconnection() {
        console.log(`[CTraderAccount ${this.accountId}] Simulating manual socket disconnection...`);
        if (this.socket) {
            try {
                this.socket.close();
            }
            catch (e) { }
            this.socket = null;
        }
        this.handleDisconnection();
    }
    // HTTP endpoints
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        // Handle CORS headers
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Content-Type": "application/json",
        };
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }
        if (path === "/status") {
            // Sync latest values to D1 so API can query
            try {
                await this.env.DB.prepare("UPDATE accounts SET balance = ?, equity = ?, isConnected = ?, updatedAt = ? WHERE accountId = ?").bind(this.balance, this.equity, this.isConnected ? 1 : 0, Date.now(), this.accountId).run();
            }
            catch (e) {
                console.error("Failed to sync status to D1:", e.message);
            }
            return new Response(JSON.stringify({
                accountId: this.accountId,
                isConnected: this.isConnected,
                balance: this.balance,
                equity: this.equity,
                prices: this.prices,
            }), { headers: corsHeaders });
        }
        if (path === "/prices") {
            return new Response(JSON.stringify(this.prices), { headers: corsHeaders });
        }
        if (path === "/reconnect") {
            this.simulateDisconnection();
            return new Response(JSON.stringify({ message: "Disconnection simulated" }), { headers: corsHeaders });
        }
        // Read-only implementation for mock lists
        if (path === "/positions") {
            // Return a mocked open position list or read from database (which are synced from OpenAPI)
            // For this milestone, we'll return mock open positions to demonstrate read-only position displays
            const positions = [
                {
                    positionId: "pos_1",
                    accountId: this.accountId,
                    symbol: "XAUUSD",
                    volume: 100, // 1 Standard Lot
                    entryPrice: 2345.50,
                    tradeSide: "BUY",
                    stopLoss: 2335.0,
                    takeProfit: 2370.0,
                    unrealizedPl: (this.prices.XAUUSD.bid - 2345.50) * 100,
                    openedAt: Date.now() - 3600000,
                }
            ];
            return new Response(JSON.stringify(positions), { headers: corsHeaders });
        }
        if (path === "/orders") {
            // Return mock pending orders
            const orders = [
                {
                    orderId: "ord_1",
                    accountId: this.accountId,
                    symbol: "US30",
                    volume: 10,
                    limitPrice: 39200.0,
                    tradeSide: "BUY",
                    orderType: "LIMIT",
                    status: "PENDING",
                    createdAt: Date.now() - 1800000,
                }
            ];
            return new Response(JSON.stringify(orders), { headers: corsHeaders });
        }
        if (path === "/history") {
            const history = [
                {
                    tradeId: "trd_1",
                    accountId: this.accountId,
                    symbol: "XAUUSD",
                    volume: 50,
                    entryPrice: 2320.0,
                    closePrice: 2335.0,
                    tradeSide: "BUY",
                    realizedPl: 750.0,
                    closedAt: Date.now() - 7200000,
                }
            ];
            return new Response(JSON.stringify(history), { headers: corsHeaders });
        }
        return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders });
    }
}
exports.CTraderAccount = CTraderAccount;
