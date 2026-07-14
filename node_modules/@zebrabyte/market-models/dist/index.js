"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymbolMapper = exports.SYMBOL_SPECS = void 0;
exports.SYMBOL_SPECS = {
    US30: {
        baseSymbol: "US30",
        pipSize: 1.0,
        pipValue: 1.0,
        minVolume: 1.0,
        lotSize: 1,
    },
    XAUUSD: {
        baseSymbol: "XAUUSD",
        pipSize: 0.01,
        pipValue: 0.01,
        minVolume: 0.01,
        lotSize: 100,
    },
};
class SymbolMapper {
    static mappings = {
        ICMarkets: {
            US30: "US30.cash",
            XAUUSD: "XAUUSD+",
        },
        Pepperstone: {
            US30: "US30",
            XAUUSD: "XAUUSD",
        },
        FTMO: {
            US30: "US30.cash",
            XAUUSD: "XAUUSD.r",
        },
    };
    static mapToBrokerSymbol(symbol, broker) {
        const brokerMap = this.mappings[broker];
        if (brokerMap && brokerMap[symbol]) {
            return brokerMap[symbol];
        }
        return symbol; // fallback
    }
    static mapFromBrokerSymbol(brokerSymbol, broker) {
        const brokerMap = this.mappings[broker];
        if (brokerMap) {
            for (const [key, val] of Object.entries(brokerMap)) {
                if (val === brokerSymbol) {
                    return key;
                }
            }
        }
        if (brokerSymbol === "US30" || brokerSymbol === "US30.cash")
            return "US30";
        if (brokerSymbol === "XAUUSD" || brokerSymbol === "XAUUSD.r" || brokerSymbol === "XAUUSD+")
            return "XAUUSD";
        return undefined;
    }
}
exports.SymbolMapper = SymbolMapper;
