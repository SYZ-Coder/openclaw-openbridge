/**
 * Reply 直发工具。
 *
 * 插件不维护本地发送队列；未完成事件由云服务保持 pending 并在连接恢复后重投递。
 */
import { createHash, randomUUID } from "node:crypto";
import { summarizeReply } from "./logging.js";
import { appendMediaSummary, mediaFromReplyPayload } from "./media.js";
import { parseOpenBridgeTarget } from "./targets.js";
import type { SpringImWebSocketClient } from "./ws-client.js";
import type { SpringImAccountConfig, SpringImLogger, SpringImMediaItem, SpringImReply } from "./types.js";

type OutboundReplyPayload = {
  text?: string;
  replyToId?: string;
  [key: string]: unknown;
};

type SpringImOutboundTextContext = {
  account: SpringImAccountConfig;
  to: string;
  text: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  media?: SpringImMediaItem[];
};

function textFromPayload(payload: OutboundReplyPayload): string {
  const parts: string[] = [];
  if (payload.text?.trim()) {
    parts.push(payload.text.trim());
  }
  return parts.join("\n\n").trim();
}

function deriveDeterministicReplyLocalId(params: {
  eventId: string;
  conversationId: string;
  conversationType: "direct" | "group";
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        eventId: params.eventId,
        conversationId: params.conversationId,
        conversationType: params.conversationType,
      }),
      "utf8",
    )
    .digest("hex");
  return `openbridge-${digest.slice(0, 32)}`;
}

export function buildReply(params: {
  localId?: string;
  eventId?: string;
  conversationId: string;
  conversationType: "direct" | "group";
  payload: OutboundReplyPayload;
  replyToId?: string;
  threadId?: string;
}): SpringImReply | null {
  const text = textFromPayload(params.payload);
  const media = mediaFromReplyPayload(params.payload as OutboundReplyPayload & {
    fileUrl?: string;
    fileName?: string;
    mimeType?: string;
  });
  if (!text && media.length === 0) {
    return null;
  }
  const localId =
    params.localId ??
    (params.eventId
      ? deriveDeterministicReplyLocalId({
          eventId: params.eventId,
          conversationId: params.conversationId,
          conversationType: params.conversationType,
        })
      : randomUUID());
  return {
    localId,
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

export async function sendOutboundTextWithAccount(ctx: SpringImOutboundTextContext) {
  const target = parseOpenBridgeTarget(ctx.to);
  const reply = buildReply({
    conversationId: target.conversationId,
    conversationType: target.conversationType,
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
    },
  };
}
