import { DurableObjectState } from "@cloudflare/workers-types";
export interface Env {
    DB: D1Database;
    CTRADER_CLIENT_ID: string;
    CTRADER_CLIENT_SECRET: string;
    CTRADER_API_HOST?: string;
    CTRADER_API_PORT?: string;
    CTRADER_USE_SSL?: string;
}
export declare class CTraderAccount {
    private state;
    private env;
    private accountId;
    private socket;
    private isConnected;
    private reconnectTimeout;
    private pingInterval;
    private reconnectDelay;
    private balance;
    private equity;
    private prices;
    private symbolsMap;
    constructor(state: DurableObjectState, env: Env);
    private getHost;
    private getPort;
    private useSsl;
    private connect;
    private authenticate;
    private startPingLoop;
    private stopPingLoop;
    private readStream;
    private handleProtoMessage;
    private getBrokerName;
    private handleDisconnection;
    private logAudit;
    simulateDisconnection(): void;
    fetch(request: Request): Promise<Response>;
}
