export interface Env {
    DB: D1Database;
    CTRADER_ACCOUNT_DO: DurableObjectNamespace;
    RISK_WORKER: {
        fetch: (req: Request) => Promise<Response>;
    };
    CTRADER_CLIENT_ID: string;
    CTRADER_CLIENT_SECRET: string;
    CTRADER_REDIRECT_URI: string;
}
declare const _default: {
    fetch(request: Request, env: Env): Promise<Response>;
    getDashboardHtml(): string;
};
export default _default;
