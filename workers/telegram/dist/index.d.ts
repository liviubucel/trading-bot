export interface Env {
    DB: D1Database;
    CTRADER_ACCOUNT_DO: DurableObjectNamespace;
    TELEGRAM_BOT_TOKEN?: string;
}
declare const _default: {
    fetch(request: Request, env: Env): Promise<Response>;
    handleStatus(env: Env): Promise<string>;
    handleAccounts(env: Env): Promise<string>;
    handlePositions(env: Env): Promise<string>;
    handleOrders(env: Env): Promise<string>;
    handleMarket(env: Env): Promise<string>;
    handleCalendar(env: Env): Promise<string>;
    handleNews(env: Env): Promise<string>;
    handleHealth(env: Env): Promise<string>;
};
export default _default;
