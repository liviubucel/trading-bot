import { RiskConfig, TradingCommand, Position, CalendarEvent } from "@zebrabyte/contracts";
export interface RiskContext {
    equity: number;
    balance: number;
    dailyStartingBalance: number;
    activePositions: Position[];
    upcomingNews: CalendarEvent[];
    latestBid: number;
    latestAsk: number;
    symbolPipSize: number;
    symbolPipValue: number;
}
export interface RiskResult {
    allowed: boolean;
    reason?: string;
    ruleEvaluated: string;
}
export declare class RiskEngine {
    static evaluateCommand(command: TradingCommand, config: RiskConfig, context: RiskContext): RiskResult;
}
