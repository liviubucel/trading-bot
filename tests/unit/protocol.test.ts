import { describe, it, expect } from "vitest";
import {
  writeVarint,
  readVarint,
  encodeProtoMessage,
  decodeProtoMessage,
  FrameDecoder,
  PayloadType,
} from "../../packages/ctrader-protocol/src/index";

describe("cTrader Open API Protobuf Protocol", () => {
  it("should encode and decode varints correctly", () => {
    const values = [0, 1, 127, 128, 300, 50000];
    for (const val of values) {
      const encoded = writeVarint(val);
      const decoded = readVarint(new Uint8Array(encoded), { val: 0 });
      expect(decoded).toBe(val);
    }
  });

  it("should frame, encode and decode ProtoMessage envelopes", () => {
    const rawPayload = new Uint8Array([10, 20, 30, 40]);
    const message = {
      payloadType: PayloadType.PROTO_PING_REQ,
      payload: rawPayload,
      clientMsgId: "msg_id_123",
    };

    const framedBuffer = encodeProtoMessage(message);

    // Verify length prefix: 4 bytes big endian
    const view = new DataView(framedBuffer.buffer);
    const length = view.getUint32(0, false);
    expect(length).toBe(framedBuffer.length - 4);

    // Extract payload and decode
    const msgBytes = framedBuffer.subarray(4);
    const decoded = decodeProtoMessage(msgBytes);

    expect(decoded.payloadType).toBe(message.payloadType);
    expect(decoded.clientMsgId).toBe(message.clientMsgId);
    expect(Array.from(decoded.payload)).toEqual(Array.from(message.payload));
  });

  it("should assemble fragmented frames using FrameDecoder", () => {
    const rawPayload = new Uint8Array([1, 2, 3, 4, 5]);
    const message = {
      payloadType: PayloadType.PROTO_PING_RES,
      payload: rawPayload,
      clientMsgId: "ping_id",
    };

    const framed = encodeProtoMessage(message);
    const decoder = new FrameDecoder();

    // Split framed into two chunks
    const chunk1 = framed.subarray(0, 6);
    const chunk2 = framed.subarray(6);

    const msgs1 = decoder.append(chunk1);
    expect(msgs1.length).toBe(0); // not fully assembled yet

    const msgs2 = decoder.append(chunk2);
    expect(msgs2.length).toBe(1); // completed assembly

    const decoded = msgs2[0];
    expect(decoded.payloadType).toBe(message.payloadType);
    expect(decoded.clientMsgId).toBe(message.clientMsgId);
  });
});
