export interface SymbolSpec {
    baseSymbol: "US30" | "XAUUSD";
    pipSize: number;
    pipValue: number;
    minVolume: number;
    lotSize: number;
}
export declare const SYMBOL_SPECS: Record<string, SymbolSpec>;
export declare class SymbolMapper {
    private static mappings;
    static mapToBrokerSymbol(symbol: "US30" | "XAUUSD", broker: string): string;
    static mapFromBrokerSymbol(brokerSymbol: string, broker: string): "US30" | "XAUUSD" | undefined;
}
