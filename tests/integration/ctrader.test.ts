import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as net from "net";
import { CTraderAccount } from "../../durable-objects/ctrader-account/src/index";
import {
  encodeProtoMessage,
  PayloadType,
  FrameDecoder,
  encodeProtoPingReq,
  encodeOASpotEvent,
  writeInt64,
  writeString,
  writeVarint,
} from "../../packages/ctrader-protocol/src/index";

// Mock cloudflare:sockets module in Vitest
const mockSockets: { activeSocket: any | null } = { activeSocket: null };
vi.mock("cloudflare:sockets", () => {
  return {
    connect: (address: { hostname: string; port: number }, options?: any) => {
      // Connect standard Node net socket to the mock server port
      const client = net.createConnection({ host: address.hostname, port: address.port });
      
      const readable = new ReadableStream({
        start(controller) {
          client.on("data", (chunk) => {
            controller.enqueue(new Uint8Array(chunk));
          });
          client.on("end", () => {
            controller.close();
          });
          client.on("error", (err) => {
            controller.error(err);
          });
        }
      });

      const writable = new WritableStream({
        write(chunk) {
          return new Promise<void>((resolve, reject) => {
            client.write(Buffer.from(chunk), (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        },
        close() {
          client.end();
        }
      });

      const mockSocket = {
        readable,
        writable,
        close: () => {
          client.destroy();
        }
      };

      mockSockets.activeSocket = mockSocket;
      return mockSocket;
    }
  };
});

describe("cTrader Connection Integration Tests", () => {
  let tcpServer: net.Server;
  let serverPort = 0;
  let receivedMessages: any[] = [];
  let connectionCount = 0;

  beforeAll(() => {
    // Spin up mock cTrader TCP server
    tcpServer = net.createServer((socket) => {
      connectionCount++;
      const decoder = new FrameDecoder();

      socket.on("data", (chunk) => {
        const messages = decoder.append(new Uint8Array(chunk));
        for (const msg of messages) {
          receivedMessages.push(msg);

          // Auto-respond to pings & requests for protocol mock
          if (msg.payloadType === PayloadType.PROTO_PING_REQ) {
            // Respond with PingRes
            const resp = encodeProtoMessage({
              payloadType: PayloadType.PROTO_PING_RES,
              payload: new Uint8Array(0),
              clientMsgId: msg.clientMsgId
            });
            socket.write(Buffer.from(resp));
          } else if (msg.payloadType === PayloadType.PROTO_OA_APPLICATION_AUTH_REQ) {
            // Respond with AppAuthRes
            const resp = encodeProtoMessage({
              payloadType: PayloadType.PROTO_OA_APPLICATION_AUTH_RES,
              payload: new Uint8Array(0),
              clientMsgId: msg.clientMsgId
            });
            socket.write(Buffer.from(resp));
          } else if (msg.payloadType === PayloadType.PROTO_OA_ACCOUNT_AUTH_REQ) {
            // Respond with AccountAuthRes
            const resp = encodeProtoMessage({
              payloadType: PayloadType.PROTO_OA_ACCOUNT_AUTH_RES,
              payload: new Uint8Array(0),
              clientMsgId: msg.clientMsgId
            });
            socket.write(Buffer.from(resp));
          } else if (msg.payloadType === PayloadType.PROTO_OA_SYMBOLS_LIST_REQ) {
            const encodeMockSymbolInfo = (id: number, name: string): number[] => {
              const inner: number[] = [];
              inner.push(...writeInt64(1, id));
              inner.push(...writeString(2, name));
              return [
                (2 << 3) | 2,
                ...writeVarint(inner.length),
                ...inner
              ];
            };

            const symbolsPayload = new Uint8Array([
              ...writeInt64(1, 12345),
              ...encodeMockSymbolInfo(100, "US30.cash"),
              ...encodeMockSymbolInfo(200, "XAUUSD+")
            ]);

            const resp = encodeProtoMessage({
              payloadType: PayloadType.PROTO_OA_SYMBOLS_LIST_RES,
              payload: symbolsPayload,
              clientMsgId: msg.clientMsgId
            });
            socket.write(Buffer.from(resp));

            // Immediately start streaming mock prices after symbols query
            setTimeout(() => {
              // US30 Spot Event
              const spot1 = encodeOASpotEvent({ ctidTraderAccountId: 12345, symbolId: 100, bid: 39520, ask: 39522 });
              const msg1 = encodeProtoMessage({ payloadType: PayloadType.PROTO_OA_SPOT_EVENT, payload: spot1 });
              socket.write(Buffer.from(msg1));

              // XAUUSD Spot Event
              const spot2 = encodeOASpotEvent({ ctidTraderAccountId: 12345, symbolId: 200, bid: 2360, ask: 2361 });
              const msg2 = encodeProtoMessage({ payloadType: PayloadType.PROTO_OA_SPOT_EVENT, payload: spot2 });
              socket.write(Buffer.from(msg2));
            }, 50);
          }
        }
      });
    });

    return new Promise<void>((resolve) => {
      tcpServer.listen(0, "127.0.0.1", () => {
        serverPort = (tcpServer.address() as net.AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    tcpServer.close();
  });

  it("should connect, authenticate, receive price updates and reconnect on drop", async () => {
    // Mock D1 Database interface
    const mockDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ tokenData: JSON.stringify({ accessToken: "test_tok" }) }),
          run: async () => ({})
        })
      })
    };

    // Instantiate Durable Object state
    const mockStorage = {
      get: async () => undefined,
      put: async () => {}
    };

    const doState: any = {
      id: { toString: () => "12345" },
      storage: mockStorage,
      blockConcurrencyWhile: (fn: any) => fn()
    };

    const env: any = {
      DB: mockDb,
      CTRADER_CLIENT_ID: "mock_client",
      CTRADER_CLIENT_SECRET: "mock_secret",
      CTRADER_API_HOST: "127.0.0.1",
      CTRADER_API_PORT: String(serverPort),
      CTRADER_USE_SSL: "false"
    };

    // 1. Initialize Durable Object (triggers connect())
    const accountDO = new CTraderAccount(doState, env);

    // Wait for connection and symbols queries to complete
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(connectionCount).toBe(1);
    
    // Verify client sent correct auth messages to TCP server
    const payloadTypes = receivedMessages.map(m => m.payloadType);
    expect(payloadTypes).toContain(PayloadType.PROTO_OA_APPLICATION_AUTH_REQ);
    expect(payloadTypes).toContain(PayloadType.PROTO_OA_ACCOUNT_AUTH_REQ);
    expect(payloadTypes).toContain(PayloadType.PROTO_OA_SYMBOLS_LIST_REQ);

    // Verify prices are populated inside Durable Object state via spot events stream
    const statusRes = await accountDO.fetch(new Request("http://localhost/status"));
    const status = await statusRes.json() as any;
    expect(status.isConnected).toBe(true);
    expect(status.prices.US30.bid).toBe(39520);
    expect(status.prices.XAUUSD.bid).toBe(2360);

    // 2. Simulate manual disconnection
    accountDO.simulateDisconnection();
    
    // Wait for DO to disconnect and reconnect
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Verify reconnect has taken place (connectionCount is incremented)
    expect(connectionCount).toBe(2);
  });
});
