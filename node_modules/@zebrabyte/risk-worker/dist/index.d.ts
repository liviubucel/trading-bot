export interface Env {
    DB: D1Database;
    CTRADER_ACCOUNT_DO: DurableObjectNamespace;
}
declare const _default: {
    fetch(request: Request, env: Env): Promise<Response>;
};
export default _default;
