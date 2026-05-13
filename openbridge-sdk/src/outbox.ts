/**
 * Reply outbox。
 *
 * 这个文件通过先写本地状态再尝试发送的方式，让 reply 投递在进程崩溃
 * 或网络波动时依然安全可恢复。
 */
import { randomUUID } from "node:crypto";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { summarizeReply } from "./logging.js";
import { appendMediaSummary, mediaFromReplyPayload } from "./media.js";
import { parseOpenBridgeTarget } from "./targets.js";
import type { SpringImWebSocketClient } from "./ws-client.js";
import type { SpringImAccountConfig, SpringImLogger, SpringImMediaItem, SpringImReply } from "./types.js";

/**
 * message-tool 主动发送文本消息时使用的上下文。
 *
 * 这里的字段很像普通 reply，但它没有对应的入站事件，所以 `eventId` 是空的。
 */
type SpringImOutboundTextContext = {
  account: SpringImAccountConfig;
  to: string;
  text: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  media?: SpringImMediaItem[];
};

/**
 * 把 OpenClaw reply payload 转成云端可保存的纯文本。
 *
 * 当前 bridge 还没有做丰富媒体协议，所以这里采用一种很务实的策略：
 * 正文保留正文，媒体链接转成可见文本行。
 */
function textFromPayload(payload: OutboundReplyPayload): string {
  const parts: string[] = [];
  if (payload.text?.trim()) {
    parts.push(payload.text.trim());
  }
  return parts.join("\n\n").trim();
}

/**
 * 从 OpenClaw payload 构造一条可持久化的 reply。
 *
 * 这里生成的 `localId` 是本地幂等键，后续重试也会一直沿用它。
 */
export function buildReply(params: {
  eventId?: string;
  conversationId: string;
  conversationType: "direct" | "group";
  payload: OutboundReplyPayload;
  replyToId?: string;
  threadId?: string;
}): SpringImReply | null {
  // 空 reply payload 会被主动忽略，避免把无意义回合写入 outbox。
  const text = textFromPayload(params.payload);
  const media = mediaFromReplyPayload(params.payload as OutboundReplyPayload & {
    fileUrl?: string;
    fileName?: string;
    mimeType?: string;
  });
  if (!text && media.length === 0) {
    return null;
  }
  return {
    localId: randomUUID(),
    eventId: params.eventId,
    conversationId: params.conversationId,
    conversationType: params.conversationType,
    text: appendMediaSummary(text, media),
    media,
    replyToId: params.replyToId ?? params.payload.replyToId,
    threadId: params.threadId,
    createdAt: Date.now(),
  };
}

export async function deliverReply(params: {
  account: SpringImAccountConfig;
  reply: SpringImReply;
  logger: SpringImLogger;
  signal?: AbortSignal;
  client?: SpringImWebSocketClient;
  onSent?: () => void | Promise<void>;
}): Promise<void> {
  // 直发：成功则上层 dispatch 用 client.ack(processed) 推进事件；失败则抛错给上层，
  // 由 dispatch 发 client.ack(failed) 让云端把事件保留为 pending 等待重发。
  // 云端 events.json 已经是事件的权威持久化，本地不再维护额外 outbox。
  params.logger.info(
    `openbridge[${params.account.accountId}]: direct reply send start ${summarizeReply(params.reply)}`,
  );
  if (!params.client?.connected) {
    throw new Error("WebSocket reply channel is not connected");
  }
  const sent = params.client.send({
    type: "client.reply",
    reply: {
      localId: params.reply.localId,
      eventId: params.reply.eventId,
      conversationId: params.reply.conversationId,
      conversationType: params.reply.conversationType,
      text: params.reply.text,
      media: params.reply.media,
      replyToId: params.reply.replyToId,
      threadId: params.reply.threadId,
      createdAt: params.reply.createdAt,
    },
  });
  if (!sent) {
    throw new Error("WebSocket reply send returned false");
  }
  params.logger.info(
    `openbridge[${params.account.accountId}]: direct reply send done ${summarizeReply(params.reply)}`,
  );
  await params.onSent?.();
}

/**
 * 给 message-tool 等主动发送路径复用的文本发送入口。
 *
 * 它走与自动 reply 相同的直发链路，不再额外维护本地 outbox。
 */
export async function sendOutboundTextWithAccount(ctx: SpringImOutboundTextContext) {
  const reply = buildReply({
    conversationId: parseOpenBridgeTarget(ctx.to).conversationId,
    conversationType: parseOpenBridgeTarget(ctx.to).conversationType,
    payload: { text: ctx.text, replyToId: ctx.replyToId ?? undefined },
    replyToId: ctx.replyToId ?? undefined,
    threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
  });
  if (!reply) {
    throw new Error("OpenBridge outbound text is empty");
  }
  if (ctx.media?.length) {
    reply.media = ctx.media;
    reply.text = appendMediaSummary(reply.text, ctx.media);
  }
  await deliverReply({
    account: ctx.account,
    reply,
    logger: console,
  });
  return {
    messageId: reply.localId,
    conversationId: reply.conversationId,
    timestamp: reply.createdAt,
    meta: {
      queuedForRetry: false,
      outboxSize: 0,
    },
  };
}
