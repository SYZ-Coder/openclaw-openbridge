/**
 * 线上协议定义。
 *
 * 这些类型描述插件与 Spring Boot bridge 服务之间交换的 JSON frame。
 */
import type { SpringImCloudMessage, SpringImReply } from "./types.js";
import { normalizeMediaItems } from "./media.js";

/**
 * 插件建立连接后首先发送的 hello 帧。
 *
 * v2 hello 会声明 clientId、accountId、deviceId、时间戳、nonce 和设备签名，
 * 让服务端确认当前连接属于哪台设备以及凭证是否仍然有效。
 */
export type ClientHelloFrame = {
  type: "client.hello";
  protocolVersion: 2;
  deviceId: string;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
  signature: string;
  lastProcessedSequence?: number;
  lastProcessedEventId?: string;
};

/** 插件定时发送的 ping 帧，用来保活连接。 */
export type ClientPingFrame = {
  type: "client.ping";
  ts: number;
};

/** 插件回给云端的 ack 帧。 */
/**
 * ACK 状态语义：
 * - `received`: 本地已收到消息，准备开始处理；不代表已经生成回复。
 * - `processed`: 本地已完成处理；通常意味着 dispatch 成功结束。
 * - `failed`: 本地已收到消息，但处理过程中失败。
 * - `duplicate`: 本地判定这条消息已经处理过，本次不再重复执行。
 */
export type ClientAckFrame = {
  type: "client.ack";
  eventId: string;
  status: "received" | "processed" | "failed" | "duplicate";
  error?: string;
};

/** 插件通过 WebSocket 镜像发送 reply 时使用的 frame。 */
export type ClientReplyFrame = {
  type: "client.reply";
  reply: SpringImReply;
};

/** 插件发往服务端的所有 frame 联合类型。 */
export type ClientFrame = ClientHelloFrame | ClientPingFrame | ClientAckFrame | ClientReplyFrame;

/** 服务端握手确认帧。 */
export type ServerHelloFrame = {
  type: "server.hello";
};

/** 服务端对 ping 的响应。 */
export type ServerPongFrame = {
  type: "server.pong";
  ts: number;
};

/** 服务端推送的真实业务消息。 */
export type ServerMessageFrame = SpringImCloudMessage;

/** 服务端要求客户端重新同步时使用的 frame。 */
export type ServerResyncFrame = {
  type: "server.resync-required";
  reason?: string;
};

/** 服务端在优雅关闭时广播给客户端，要求立即断开重连。 */
export type ServerByeFrame = {
  type: "server.bye";
  reason?: string;
};

/** 服务端对某条 reply 的确认。 */
export type ServerReplyAckFrame = {
  type: "server.reply-ack";
  localId?: string;
  messageId?: string;
  status?: string;
};

/** 服务端可能发来的所有 frame 联合类型。 */
export type ServerFrame =
  | ServerHelloFrame
  | ServerPongFrame
  | ServerMessageFrame
  | ServerResyncFrame
  | ServerByeFrame
  | ServerReplyAckFrame;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseServerFrame(raw: string): ServerFrame {
  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed);
  const type = readString(record, "type");
  if (type === "server.hello") {
    return { type };
  }
  if (type === "server.pong") {
    return {
      type,
      ts: typeof record.ts === "number" ? record.ts : Date.now(),
    };
  }
  if (type === "server.resync-required") {
    return {
      type,
      reason: readString(record, "reason"),
    };
  }
  if (type === "server.bye") {
    return {
      type,
      reason: readString(record, "reason"),
    };
  }
  if (type === "server.reply-ack") {
    return {
      type,
      localId: readString(record, "localId"),
      messageId: readString(record, "messageId"),
      status: readString(record, "status"),
    };
  }
  // demo 服务的早期实现发送 "message"，正式协议推荐发送 "server.message"。
  // 两者都按业务消息处理，方便本地联调和后续协议平滑升级。
  if (type === "server.message" || type === "message") {
    return { ...(parsed as ServerMessageFrame), type: "message", media: normalizeMediaItems(record.media) };
  }
  throw new Error(`unsupported openbridge server frame: ${type ?? "unknown"}`);
}

export function serializeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}
