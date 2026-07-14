export declare enum PayloadType {
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
    PROTO_OA_SPOT_EVENT = 2143
}
export interface ProtoMessage {
    payloadType: number;
    payload: Uint8Array;
    clientMsgId?: string;
}
export declare function writeVarint(value: number): number[];
export declare function readVarint(buffer: Uint8Array, offset: {
    val: number;
}): number;
export declare function writeString(tag: number, val: string): number[];
export declare function readString(buffer: Uint8Array, offset: {
    val: number;
}, length: number): string;
export declare function writeBytes(tag: number, val: Uint8Array): number[];
export declare function readBytes(buffer: Uint8Array, offset: {
    val: number;
}, length: number): Uint8Array;
export declare function writeInt64(tag: number, val: number): number[];
export declare function encodeProtoMessage(msg: ProtoMessage): Uint8Array;
export declare function decodeProtoMessage(buffer: Uint8Array): ProtoMessage;
export declare class FrameDecoder {
    private buffer;
    append(chunk: Uint8Array): ProtoMessage[];
    clear(): void;
}
export declare function encodeOAApplicationAuthReq(clientId: string, clientSecret: string): Uint8Array;
export declare function encodeOAAccountAuthReq(ctidTraderAccountId: number, accessToken: string): Uint8Array;
export declare function encodeOASymbolsListReq(ctidTraderAccountId: number): Uint8Array;
export interface SymbolInfo {
    symbolId: number;
    symbolName: string;
}
export declare function decodeOASymbolsListRes(payload: Uint8Array): {
    ctidTraderAccountId: number;
    symbols: SymbolInfo[];
};
export declare function encodeOASubscribeSpotsReq(ctidTraderAccountId: number, symbolIds: number[]): Uint8Array;
export interface SpotEvent {
    ctidTraderAccountId: number;
    symbolId: number;
    bid?: number;
    ask?: number;
    timestamp?: number;
}
export declare function decodeOASpotEvent(payload: Uint8Array): SpotEvent;
export declare function encodeOASpotEvent(event: SpotEvent): Uint8Array;
export declare function encodeProtoPingReq(timestamp: number): Uint8Array;
export declare function decodeProtoPingReq(payload: Uint8Array): {
    timestamp: number;
};
