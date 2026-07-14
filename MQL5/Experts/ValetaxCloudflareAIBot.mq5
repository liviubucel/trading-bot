//+------------------------------------------------------------------+
//| ValetaxCloudflareAIBot.mq5                                      |
//| Scaffold EA: MT5 <-> Cloudflare Worker AI signal API             |
//| Attach to a Valetax MT5 chart. Test on DEMO first.               |
//+------------------------------------------------------------------+
#property strict
#property version   "1.00"
#property description "Polls Cloudflare Worker AI signal endpoint and optionally executes BUY/SELL on MT5."
#property description "Educational scaffold only; no profit guarantee. Use demo + risk controls."

#include <Trade/Trade.mqh>

input string InpWorkerUrl            = "https://valetax-mt5-ai-bot.certveis.workers.dev"; // no trailing slash
input string InpAppToken             = "change-this-token";

// Account guard: EA cannot log in for you. Login must be done in MT5 terminal.
// These inputs ensure the EA only runs on the intended Valetax MT5 account.
input long   InpExpectedAccountLogin = 0;       // 0 = do not validate login number
input string InpExpectedAccountServer= "";      // empty = do not validate server
input bool   InpRequireAccountMatch  = true;

input bool   InpAllowAutoTrade       = false;   // SAFETY: false = signal only
input bool   InpCloseOpposite        = true;
input int    InpPollSeconds          = 30;
input ulong  InpMagicNumber          = 260604;
input int    InpSlippagePoints       = 30;

input int    InpFastEmaPeriod        = 20;
input int    InpSlowEmaPeriod        = 50;
input int    InpRsiPeriod            = 14;
input int    InpAtrPeriod            = 14;

input double InpRiskPercent          = 1.0;     // % balance risk per trade
input bool   InpUseFixedLot          = false;
input double InpFixedLot             = 0.01;
input int    InpMinConfidence        = 65;
input int    InpMaxSpreadPoints      = 35;
input int    InpDefaultSLPoints      = 250;
input double InpRR                   = 1.5;
input int    InpMinSecondsBetweenTrades = 300;
input string InpTradeComment         = "CF-AI-Valetax";

CTrade trade;
int hFast = INVALID_HANDLE;
int hSlow = INVALID_HANDLE;
int hRsi  = INVALID_HANDLE;
int hAtr  = INVALID_HANDLE;
datetime lastPoll = 0;
datetime lastTrade = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   trade.SetExpertMagicNumber(InpMagicNumber);
   trade.SetDeviationInPoints(InpSlippagePoints);

   PrintAccountInfo();
   if(!IsAccountAllowed())
   {
      Print("Account guard failed. Login to the correct Valetax MT5 account or update InpExpectedAccountLogin/InpExpectedAccountServer.");
      return INIT_FAILED;
   }

   hFast = iMA(_Symbol, _Period, InpFastEmaPeriod, 0, MODE_EMA, PRICE_CLOSE);
   hSlow = iMA(_Symbol, _Period, InpSlowEmaPeriod, 0, MODE_EMA, PRICE_CLOSE);
   hRsi  = iRSI(_Symbol, _Period, InpRsiPeriod, PRICE_CLOSE);
   hAtr  = iATR(_Symbol, _Period, InpAtrPeriod);

   if(hFast == INVALID_HANDLE || hSlow == INVALID_HANDLE || hRsi == INVALID_HANDLE || hAtr == INVALID_HANDLE)
   {
      Print("Indicator handle creation failed. Error=", GetLastError());
      return INIT_FAILED;
   }

   Print("ValetaxCloudflareAIBot initialized. Add Worker URL to MT5 Tools > Options > Expert Advisors > Allow WebRequest: ", InpWorkerUrl);
   if(!InpAllowAutoTrade)
      Print("SAFETY: InpAllowAutoTrade=false. EA will only print signals, not trade.");

   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   if(hFast != INVALID_HANDLE) IndicatorRelease(hFast);
   if(hSlow != INVALID_HANDLE) IndicatorRelease(hSlow);
   if(hRsi  != INVALID_HANDLE) IndicatorRelease(hRsi);
   if(hAtr  != INVALID_HANDLE) IndicatorRelease(hAtr);
}

//+------------------------------------------------------------------+
void OnTick()
{
   if(InpRequireAccountMatch && !IsAccountAllowed())
   {
      Print("Trading blocked: current MT5 account does not match configured Valetax account guard.");
      return;
   }

   if(TimeCurrent() - lastPoll < InpPollSeconds) return;
   lastPoll = TimeCurrent();

   double emaFast, emaSlow, rsi, atr;
   if(!ReadIndicators(emaFast, emaSlow, rsi, atr)) return;

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double price = (bid + ask) / 2.0;
   int spreadPoints = (int)MathRound((ask - bid) / _Point);
   int atrPoints = (int)MathRound(atr / _Point);
   string candleDir = CandleDirection();

   string url = BuildSignalUrl(price, emaFast, emaSlow, rsi, atrPoints, spreadPoints, candleDir);
   string response;
   if(!HttpGet(url, response)) return;

   string action = StringToLowerSafe(JsonString(response, "action", "hold"));
   string direction = JsonString(response, "direction", "neutral");
   double confidence = JsonDouble(response, "confidence", 0);
   int slPoints = (int)JsonDouble(response, "slPoints", InpDefaultSLPoints);
   int tpPoints = (int)JsonDouble(response, "tpPoints", MathMax(InpDefaultSLPoints * InpRR, 20));
   int apiMaxSpread = (int)JsonDouble(response, "maxSpreadPoints", InpMaxSpreadPoints);
   string reason = JsonString(response, "reason", "-");

   PrintFormat("CF-AI Signal %s %s action=%s direction=%s confidence=%.1f spread=%d sl=%d tp=%d reason=%s",
               _Symbol, EnumToString(_Period), action, direction, confidence, spreadPoints, slPoints, tpPoints, reason);

   if(!InpAllowAutoTrade)
      return;

   if(action != "buy" && action != "sell") return;
   if(confidence < InpMinConfidence) { Print("Skip: confidence below minimum."); return; }
   if(spreadPoints > MathMin(InpMaxSpreadPoints, apiMaxSpread)) { Print("Skip: spread too high."); return; }
   if(TimeCurrent() - lastTrade < InpMinSecondsBetweenTrades) { Print("Skip: cooldown active."); return; }

   ExecuteSignal(action, slPoints, tpPoints);
}

//+------------------------------------------------------------------+
bool ReadIndicators(double &emaFast, double &emaSlow, double &rsi, double &atr)
{
   double bFast[], bSlow[], bRsi[], bAtr[];
   ArraySetAsSeries(bFast, true);
   ArraySetAsSeries(bSlow, true);
   ArraySetAsSeries(bRsi, true);
   ArraySetAsSeries(bAtr, true);

   // shift 1 = last closed candle, to reduce repaint/noise
   if(CopyBuffer(hFast, 0, 1, 1, bFast) != 1) { Print("CopyBuffer EMA fast failed: ", GetLastError()); return false; }
   if(CopyBuffer(hSlow, 0, 1, 1, bSlow) != 1) { Print("CopyBuffer EMA slow failed: ", GetLastError()); return false; }
   if(CopyBuffer(hRsi,  0, 1, 1, bRsi)  != 1) { Print("CopyBuffer RSI failed: ", GetLastError()); return false; }
   if(CopyBuffer(hAtr,  0, 1, 1, bAtr)  != 1) { Print("CopyBuffer ATR failed: ", GetLastError()); return false; }

   emaFast = bFast[0];
   emaSlow = bSlow[0];
   rsi = bRsi[0];
   atr = bAtr[0];
   return true;
}

//+------------------------------------------------------------------+
string CandleDirection()
{
   double o = iOpen(_Symbol, _Period, 1);
   double c = iClose(_Symbol, _Period, 1);
   if(c > o) return "bullish";
   if(c < o) return "bearish";
   return "neutral";
}

//+------------------------------------------------------------------+
void PrintAccountInfo()
{
   Print("Current MT5 account: login=", IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)),
         " server=", AccountInfoString(ACCOUNT_SERVER),
         " company=", AccountInfoString(ACCOUNT_COMPANY),
         " currency=", AccountInfoString(ACCOUNT_CURRENCY),
         " balance=", DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2));
}

//+------------------------------------------------------------------+
bool IsAccountAllowed()
{
   if(!InpRequireAccountMatch) return true;

   long currentLogin = AccountInfoInteger(ACCOUNT_LOGIN);
   string currentServer = AccountInfoString(ACCOUNT_SERVER);

   if(InpExpectedAccountLogin > 0 && currentLogin != InpExpectedAccountLogin)
   {
      Print("Account login mismatch. Current=", IntegerToString(currentLogin), " expected=", IntegerToString(InpExpectedAccountLogin));
      return false;
   }

   if(StringLen(InpExpectedAccountServer) > 0)
   {
      string a = StringToLowerSafe(currentServer);
      string b = StringToLowerSafe(InpExpectedAccountServer);
      if(StringFind(a, b) < 0 && StringFind(b, a) < 0)
      {
         Print("Account server mismatch. Current=", currentServer, " expected=", InpExpectedAccountServer);
         return false;
      }
   }

   return true;
}

//+------------------------------------------------------------------+
string BuildSignalUrl(double price, double emaFast, double emaSlow, double rsi, int atrPoints, int spreadPoints, string candleDir)
{
   string base = InpWorkerUrl;
   while(StringLen(base) > 0 && StringSubstr(base, StringLen(base)-1, 1) == "/")
      base = StringSubstr(base, 0, StringLen(base)-1);

   string url = base + "/api/signal" +
      "?symbol=" + UrlEncode(_Symbol) +
      "&price=" + DoubleToString(price, _Digits) +
      "&emaFast=" + DoubleToString(emaFast, _Digits) +
      "&emaSlow=" + DoubleToString(emaSlow, _Digits) +
      "&rsi=" + DoubleToString(rsi, 2) +
      "&atrPoints=" + IntegerToString(atrPoints) +
      "&spreadPoints=" + IntegerToString(spreadPoints) +
      "&candleDir=" + UrlEncode(candleDir) +
      "&riskPercent=" + DoubleToString(InpRiskPercent, 2) +
      "&minConfidence=" + IntegerToString(InpMinConfidence) +
      "&maxSpreadPoints=" + IntegerToString(InpMaxSpreadPoints) +
      "&rr=" + DoubleToString(InpRR, 2) +
      "&mt5Login=" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
      "&mt5Server=" + UrlEncode(AccountInfoString(ACCOUNT_SERVER)) +
      "&accountCompany=" + UrlEncode(AccountInfoString(ACCOUNT_COMPANY)) +
      "&token=" + UrlEncode(InpAppToken);
   return url;
}

//+------------------------------------------------------------------+
bool HttpGet(string url, string &response)
{
   char postData[];
   char result[];
   string resultHeaders;
   string headers = "User-Agent: ValetaxCloudflareAIBot/1.0\r\n";
   ResetLastError();
   int status = WebRequest("GET", url, headers, 10000, postData, result, resultHeaders);
   if(status == -1)
   {
      Print("WebRequest failed. Error=", GetLastError(), ". Add URL to MT5 Allow WebRequest: ", InpWorkerUrl);
      return false;
   }
   response = CharArrayToString(result, 0, -1, CP_UTF8);
   if(status < 200 || status >= 300)
   {
      Print("HTTP status=", status, " response=", response);
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
void ExecuteSignal(string action, int slPoints, int tpPoints)
{
   bool haveBuy=false, haveSell=false;
   ScanPositions(haveBuy, haveSell);

   if(action == "buy" && haveBuy) { Print("Skip: buy position already exists."); return; }
   if(action == "sell" && haveSell) { Print("Skip: sell position already exists."); return; }

   if(InpCloseOpposite)
   {
      if(action == "buy" && haveSell) ClosePositions(POSITION_TYPE_SELL);
      if(action == "sell" && haveBuy) ClosePositions(POSITION_TYPE_BUY);
   }
   else
   {
      if(action == "buy" && haveSell) { Print("Skip: opposite sell exists."); return; }
      if(action == "sell" && haveBuy) { Print("Skip: opposite buy exists."); return; }
   }

   double lot = CalculateLot(slPoints);
   if(lot <= 0) { Print("Lot calculation failed."); return; }

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double sl=0, tp=0;
   bool ok=false;

   if(action == "buy")
   {
      sl = NormalizeDouble(ask - slPoints * _Point, _Digits);
      tp = NormalizeDouble(ask + tpPoints * _Point, _Digits);
      ok = trade.Buy(lot, _Symbol, ask, sl, tp, InpTradeComment);
   }
   else if(action == "sell")
   {
      sl = NormalizeDouble(bid + slPoints * _Point, _Digits);
      tp = NormalizeDouble(bid - tpPoints * _Point, _Digits);
      ok = trade.Sell(lot, _Symbol, bid, sl, tp, InpTradeComment);
   }

   if(ok)
   {
      lastTrade = TimeCurrent();
      Print("Order opened: ", action, " lot=", DoubleToString(lot, 2), " sl=", DoubleToString(sl, _Digits), " tp=", DoubleToString(tp, _Digits));
   }
   else
   {
      Print("Order failed. Retcode=", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
void ScanPositions(bool &haveBuy, bool &haveSell)
{
   haveBuy=false; haveSell=false;
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;
      long type = PositionGetInteger(POSITION_TYPE);
      if(type == POSITION_TYPE_BUY) haveBuy = true;
      if(type == POSITION_TYPE_SELL) haveSell = true;
   }
}

//+------------------------------------------------------------------+
void ClosePositions(long positionType)
{
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(!PositionSelectByTicket(ticket)) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != InpMagicNumber) continue;
      if(PositionGetInteger(POSITION_TYPE) != positionType) continue;
      if(!trade.PositionClose(ticket))
         Print("Failed closing position ", ticket, " retcode=", trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
double CalculateLot(int slPoints)
{
   if(InpUseFixedLot) return NormalizeLot(InpFixedLot);

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskMoney = balance * InpRiskPercent / 100.0;
   double tickValue = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double tickSize = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tickValue <= 0 || tickSize <= 0 || slPoints <= 0) return NormalizeLot(InpFixedLot);

   double valuePerPointPerLot = tickValue * (_Point / tickSize);
   double lossPerLot = slPoints * valuePerPointPerLot;
   if(lossPerLot <= 0) return NormalizeLot(InpFixedLot);

   double lot = riskMoney / lossPerLot;
   return NormalizeLot(lot);
}

//+------------------------------------------------------------------+
double NormalizeLot(double lot)
{
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step   = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   lot = MathMax(minLot, MathMin(maxLot, lot));
   lot = MathFloor(lot / step) * step;
   return NormalizeDouble(lot, VolumeDigits(step));
}

int VolumeDigits(double step)
{
   int digits = 0;
   double v = step;
   while(digits < 8 && MathAbs(v - MathRound(v)) > 0.00000001)
   {
      v *= 10.0;
      digits++;
   }
   return digits;
}

//+------------------------------------------------------------------+
string JsonString(string json, string key, string defValue)
{
   string pat = "\"" + key + "\"";
   int p = StringFind(json, pat);
   if(p < 0) return defValue;
   p = StringFind(json, ":", p + StringLen(pat));
   if(p < 0) return defValue;
   p++;
   while(p < StringLen(json) && IsSpace(StringGetCharacter(json, p))) p++;
   if(p >= StringLen(json)) return defValue;

   if(StringGetCharacter(json, p) == '"')
   {
      p++;
      int e = StringFind(json, "\"", p);
      if(e < 0) return defValue;
      return StringSubstr(json, p, e-p);
   }

   int end = p;
   while(end < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, end);
      if(ch == ',' || ch == '}') break;
      end++;
   }
   string v = StringSubstr(json, p, end-p);
   StringTrimLeft(v); StringTrimRight(v);
   return v;
}

double JsonDouble(string json, string key, double defValue)
{
   string v = JsonString(json, key, DoubleToString(defValue, 8));
   return StringToDouble(v);
}

bool IsSpace(ushort ch)
{
   return (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t');
}

string StringToLowerSafe(string s)
{
   StringToLower(s);
   return s;
}

// Conservative URL encoder for query values.
string UrlEncode(string s)
{
   string out = "";
   uchar bytes[];
   int n = StringToCharArray(s, bytes, 0, WHOLE_ARRAY, CP_UTF8);
   for(int i=0; i<n-1; i++)
   {
      uchar c = bytes[i];
      if((c>='A' && c<='Z') || (c>='a' && c<='z') || (c>='0' && c<='9') || c=='-' || c=='_' || c=='.' || c=='~')
         out += CharToString((char)c);
      else if(c == ' ')
         out += "%20";
      else
         out += "%" + StringFormat("%02X", c);
   }
   return out;
}
//+------------------------------------------------------------------+
