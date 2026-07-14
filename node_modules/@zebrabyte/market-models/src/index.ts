export interface SymbolSpec {
  baseSymbol: "US30" | "XAUUSD";
  pipSize: number;
  pipValue: number; // Value of 1 pip for 1 unit (or standard lot equivalent)
  minVolume: number;
  lotSize: number;
}

export const SYMBOL_SPECS: Record<string, SymbolSpec> = {
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

export class SymbolMapper {
  private static mappings: Record<string, Record<string, string>> = {
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

  public static mapToBrokerSymbol(symbol: "US30" | "XAUUSD", broker: string): string {
    const brokerMap = this.mappings[broker];
    if (brokerMap && brokerMap[symbol]) {
      return brokerMap[symbol];
    }
    return symbol; // fallback
  }

  public static mapFromBrokerSymbol(brokerSymbol: string, broker: string): "US30" | "XAUUSD" | undefined {
    const brokerMap = this.mappings[broker];
    if (brokerMap) {
      for (const [key, val] of Object.entries(brokerMap)) {
        if (val === brokerSymbol) {
          return key as "US30" | "XAUUSD";
        }
      }
    }
    if (brokerSymbol === "US30" || brokerSymbol === "US30.cash") return "US30";
    if (brokerSymbol === "XAUUSD" || brokerSymbol === "XAUUSD.r" || brokerSymbol === "XAUUSD+") return "XAUUSD";
    return undefined;
  }
}
