// Pure TypeScript Protobuf encoder/decoder and TCP framing for cTrader Open API.

export enum PayloadType {
  PROTO_PING_REQ = 50,
  PROTO_PING_RES = 51,
  PROTO_OA_APPLICATION_AUTH_REQ = 2100,
  PROTO_OA_APPLICATION_AUTH_RES = 2101,
  PROTO_OA_ACCOUNT_AUTH_REQ = 2102,
  PROTO_OA_ACCOUNT_AUTH_RES = 2103,
  PROTO_OA_SYMBOLS_LIST_REQ = 2114,
  PROTO_OA_SYMBOLS_LIST_RES = 2115,
  PROTO_OA_SUBSCRIBE_SPOTS_REQ = 2137,
  PROTO_OA_SUBSCRIBE_SPOTS_RES = 2138,
  PROTO_OA_SPOT_EVENT = 2143,
}

export interface ProtoMessage {
  payloadType: number;
  payload: Uint8Array;
  clientMsgId?: string;
}

// Low-level Protobuf Serialization helpers
export function writeVarint(value: number): number[] {
  const bytes: number[] = [];
  let val = Math.floor(Math.abs(value));
  while (val >= 0x80) {
    bytes.push((val & 0x7f) | 0x80);
    val = Math.floor(val / 128);
  }
  bytes.push(val & 0x7f);
  return bytes;
}

export function readVarint(buffer: Uint8Array, offset: { val: number }): number {
  let result = 0;
  let shift = 0;
  while (true) {
    if (offset.val >= buffer.length) {
      throw new Error("Varint parsing exceeded buffer length");
    }
    const byte = buffer[offset.val++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) {
      break;
    }
    shift += 7;
  }
  return result;
}

export function writeString(tag: number, val: string): number[] {
  const encoder = new TextEncoder();
  const stringBytes = encoder.encode(val);
  return [
    (tag << 3) | 2,
    ...writeVarint(stringBytes.length),
    ...Array.from(stringBytes),
  ];
}

export function readString(buffer: Uint8Array, offset: { val: number }, length: number): string {
  const bytes = buffer.subarray(offset.val, offset.val + length);
  offset.val += length;
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

export function writeBytes(tag: number, val: Uint8Array): number[] {
  return [
    (tag << 3) | 2,
    ...writeVarint(val.length),
    ...Array.from(val),
  ];
}

export function readBytes(buffer: Uint8Array, offset: { val: number }, length: number): Uint8Array {
  const bytes = buffer.slice(offset.val, offset.val + length);
  offset.val += length;
  return bytes;
}

export function writeInt64(tag: number, val: number): number[] {
  return [
    (tag << 3) | 0,
    ...writeVarint(val),
  ];
}

// ProtoMessage Frame Encoding (4-byte length prefix + payload)
export function encodeProtoMessage(msg: ProtoMessage): Uint8Array {
  const bytes: number[] = [];

  // field 1: payloadType (varint)
  bytes.push((1 << 3) | 0);
  bytes.push(...writeVarint(msg.payloadType));

  // field 2: payload (bytes)
  bytes.push(...writeBytes(2, msg.payload));

  // field 3: clientMsgId (string)
  if (msg.clientMsgId !== undefined) {
    bytes.push(...writeString(3, msg.clientMsgId));
  }

  const payloadBuffer = new Uint8Array(bytes);
  const totalLength = payloadBuffer.length;

  const result = new Uint8Array(4 + totalLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, totalLength, false); // 4 bytes Big Endian length
  result.set(payloadBuffer, 4);

  return result;
}

export function decodeProtoMessage(buffer: Uint8Array): ProtoMessage {
  const offset = { val: 0 };
  let payloadType = 0;
  let payload: any = new Uint8Array(0);
  let clientMsgId: string | undefined;

  while (offset.val < buffer.length) {
    const key = readVarint(buffer, offset);
    const tag = key >> 3;
    const wireType = key & 0x07;

    if (tag === 1 && wireType === 0) {
      payloadType = readVarint(buffer, offset);
    } else if (tag === 2 && wireType === 2) {
      const len = readVarint(buffer, offset);
      payload = readBytes(buffer, offset, len) as any;
    } else if (tag === 3 && wireType === 2) {
      const len = readVarint(buffer, offset);
      clientMsgId = readString(buffer, offset, len);
    } else {
      // Skip unknown fields
      if (wireType === 0) {
        readVarint(buffer, offset);
      } else if (wireType === 2) {
        const len = readVarint(buffer, offset);
        offset.val += len;
      } else if (wireType === 1) {
        offset.val += 8;
      } else if (wireType === 5) {
        offset.val += 4;
      } else {
        throw new Error(`Unsupported wire type: ${wireType}`);
      }
    }
  }

  return { payloadType, payload, clientMsgId };
}

// Stream Buffer helper for framing
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  public append(chunk: Uint8Array): ProtoMessage[] {
    const nextBuffer = new Uint8Array(this.buffer.length + chunk.length);
    nextBuffer.set(this.buffer);
    nextBuffer.set(chunk, this.buffer.length);
    this.buffer = nextBuffer;

    const messages: ProtoMessage[] = [];

    while (this.buffer.length >= 4) {
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const expectedLength = view.getUint32(0, false);

      if (this.buffer.length >= 4 + expectedLength) {
        const messageBytes = this.buffer.subarray(4, 4 + expectedLength);
        try {
          const parsed = decodeProtoMessage(messageBytes);
          messages.push(parsed);
        } catch (e) {
          console.error("Failed to decode Protobuf message frame:", e);
        }
        this.buffer = this.buffer.slice(4 + expectedLength);
      } else {
        break; // Message not fully received yet
      }
    }

    return messages;
  }

  public clear(): void {
    this.buffer = new Uint8Array(0);
  }
}

// Sub-message encoders and decoders

// 1. ProtoOAApplicationAuthReq (2100) & Res (2101)
export function encodeOAApplicationAuthReq(clientId: string, clientSecret: string): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...writeString(1, clientId));
  bytes.push(...writeString(2, clientSecret));
  return new Uint8Array(bytes);
}

// 2. ProtoOAAccountAuthReq (2102) & Res (2103)
export function encodeOAAccountAuthReq(ctidTraderAccountId: number, accessToken: string): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...writeInt64(1, ctidTraderAccountId));
  bytes.push(...writeString(2, accessToken));
  return new Uint8Array(bytes);
}

// 3. ProtoOASymbolsListReq (2114) & Res (2115)
export function encodeOASymbolsListReq(ctidTraderAccountId: number): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...writeInt64(1, ctidTraderAccountId));
  return new Uint8Array(bytes);
}

export interface SymbolInfo {
  symbolId: number;
  symbolName: string;
}

export function decodeOASymbolsListRes(payload: Uint8Array): { ctidTraderAccountId: number, symbols: SymbolInfo[] } {
  const offset = { val: 0 };
  let ctidTraderAccountId = 0;
  const symbols: SymbolInfo[] = [];

  while (offset.val < payload.length) {
    const key = readVarint(payload, offset);
    const tag = key >> 3;
    const wireType = key & 0x07;

    if (tag === 1 && wireType === 0) {
      ctidTraderAccountId = readVarint(payload, offset);
    } else if (tag === 2 && wireType === 2) {
      const len = readVarint(payload, offset);
      const subOffset = { val: offset.val };
      let symbolId = 0;
      let symbolName = "";
      while (subOffset.val < offset.val + len) {
        const subKey = readVarint(payload, subOffset);
        const subTag = subKey >> 3;
        const subWireType = subKey & 0x07;
        if (subTag === 1 && subWireType === 0) {
          symbolId = readVarint(payload, subOffset);
        } else if (subTag === 2 && subWireType === 2) {
          const sLen = readVarint(payload, subOffset);
          symbolName = readString(payload, subOffset, sLen);
        } else {
          // Skip
          if (subWireType === 0) readVarint(payload, subOffset);
          else if (subWireType === 2) subOffset.val += readVarint(payload, subOffset);
        }
      }
      symbols.push({ symbolId, symbolName });
      offset.val = subOffset.val;
    } else {
      if (wireType === 0) readVarint(payload, offset);
      else if (wireType === 2) offset.val += readVarint(payload, offset);
    }
  }

  return { ctidTraderAccountId, symbols };
}

// 4. ProtoOASubscribeSpotsReq (2137) & Res (2138)
export function encodeOASubscribeSpotsReq(ctidTraderAccountId: number, symbolIds: number[]): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...writeInt64(1, ctidTraderAccountId));
  for (const id of symbolIds) {
    bytes.push(...writeInt64(2, id));
  }
  return new Uint8Array(bytes);
}

// 5. ProtoOASpotEvent (2143)
export interface SpotEvent {
  ctidTraderAccountId: number;
  symbolId: number;
  bid?: number;
  ask?: number;
  timestamp?: number;
}

export function decodeOASpotEvent(payload: Uint8Array): SpotEvent {
  const offset = { val: 0 };
  let ctidTraderAccountId = 0;
  let symbolId = 0;
  let bid: number | undefined;
  let ask: number | undefined;
  let timestamp: number | undefined;

  while (offset.val < payload.length) {
    const key = readVarint(payload, offset);
    const tag = key >> 3;
    const wireType = key & 0x07;

    if (tag === 1 && wireType === 0) {
      ctidTraderAccountId = readVarint(payload, offset);
    } else if (tag === 2 && wireType === 0) {
      symbolId = readVarint(payload, offset);
    } else if (tag === 3 && wireType === 0) {
      bid = readVarint(payload, offset);
    } else if (tag === 4 && wireType === 0) {
      ask = readVarint(payload, offset);
    } else if (tag === 5 && wireType === 0) {
      timestamp = readVarint(payload, offset);
    } else {
      if (wireType === 0) readVarint(payload, offset);
      else if (wireType === 2) offset.val += readVarint(payload, offset);
    }
  }

  return { ctidTraderAccountId, symbolId, bid, ask, timestamp };
}

export function encodeOASpotEvent(event: SpotEvent): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...writeInt64(1, event.ctidTraderAccountId));
  bytes.push(...writeInt64(2, event.symbolId));
  if (event.bid !== undefined) {
    bytes.push(...writeInt64(3, event.bid));
  }
  if (event.ask !== undefined) {
    bytes.push(...writeInt64(4, event.ask));
  }
  if (event.timestamp !== undefined) {
    bytes.push(...writeInt64(5, event.timestamp));
  }
  return new Uint8Array(bytes);
}

// 6. ProtoPingReq (50) & ProtoPingRes (51)
export function encodeProtoPingReq(timestamp: number): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...writeInt64(1, timestamp));
  return new Uint8Array(bytes);
}

export function decodeProtoPingReq(payload: Uint8Array): { timestamp: number } {
  const offset = { val: 0 };
  let timestamp = 0;
  while (offset.val < payload.length) {
    const key = readVarint(payload, offset);
    const tag = key >> 3;
    if (tag === 1) {
      timestamp = readVarint(payload, offset);
    } else {
      offset.val += (key & 0x07) === 0 ? 1 : 0; // simple skip
    }
  }
  return { timestamp };
}
