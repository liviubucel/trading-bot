import { AccountStatus, Position, Order, TradingCommand, HistoricalTrade } from "./index";
export interface BrokerAdapter {
    /**
     * Establishes connection to the broker's API.
     */
    connect(): Promise<void>;
    /**
     * Closes connection to the broker's API.
     */
    disconnect(): Promise<void>;
    /**
     * Retrieves account information (balance, equity, connected state).
     */
    getAccountStatus(): Promise<AccountStatus>;
    /**
     * Retrieves active open positions from the broker.
     */
    getPositions(): Promise<Position[]>;
    /**
     * Retrieves active pending orders from the broker.
     */
    getOrders(): Promise<Order[]>;
    /**
     * Retrieves historical completed trades from the broker.
     */
    getTradeHistory(): Promise<HistoricalTrade[]>;
    /**
     * Sends a execution command (place order, cancel order, close position) to the broker.
     */
    executeCommand(command: TradingCommand): Promise<{
        success: boolean;
        orderId?: string;
        positionId?: string;
        errorCode?: string;
        message?: string;
    }>;
}
