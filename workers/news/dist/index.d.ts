export interface Env {
    DB: D1Database;
}
declare const _default: {
    fetch(request: Request, env: Env): Promise<Response>;
    scheduled(event: any, env: Env, ctx: any): Promise<void>;
    syncNews(env: Env): Promise<void>;
};
export default _default;
