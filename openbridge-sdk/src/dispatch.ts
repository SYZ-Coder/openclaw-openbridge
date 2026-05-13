/**
 * OpenClaw 桥接层。
 *
 * 这个文件负责把云端 IM 事件转换成 OpenClaw 的入站消息轮次，
 * 然后调用共享的 OpenClaw reply pipeline，并把最终 reply payload
 * 交给本地 outbox/投递层。
 */
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { previewText, summarizeCloudMessage, summarizeReply } from "./logging.js";
import { appendMediaSummary, materializeInboundImages } from "./media.js";
import { buildReply, deliverReply } from "./outbox.js";
import type { SpringImWebSocketClient } from "./ws-client.js";
import type { SpringImAccountConfig, SpringImCloudMessage, SpringImLogger } from "./types.js";
import { CHANNEL_ID, CHANNEL_LABEL } from "./types.js";
import { SpringImStateStore } from "./state.js";

/**
 * OpenClaw runtime 中与 channel 直接相关的那部分能力。
 *
 * 这里单独抽出 `RuntimeChannel`，是为了在类型层面更清晰地表达：
 * 我们只依赖 routing / session / reply 三块能力，而不是整个 runtime。
 */
type RuntimeChannel = PluginRuntime["channel"];

/**
 * `resolveStorePath` 的第一个参数类型。
 *
 * 这样做可以避免手写复杂类型，也让后续跟随 OpenClaw SDK 变化自动同步。
 */
type SessionStoreArg = Parameters<RuntimeChannel["session"]["resolveStorePath"]>[0];

/**
 * 从未知 runtime surface 中安全取出 channel runtime。
 *
 * 教学上可以把它理解成一层“窄门”：
 * 外部传进来的是 unknown，只有同时具备 reply / routing / session 三个区块，
 * 我们才把它认定为可用的 OpenClaw channel runtime。
 */
function resolveRuntimeChannel(surface: unknown): RuntimeChannel | undefined {
  if (!surface || typeof surface !== "object") {
    return undefined;
  }
  const candidate = surface as Partial<RuntimeChannel>;
  if (candidate.reply && candidate.routing && candidate.session) {
    return candidate as RuntimeChannel;
  }
  return undefined;
}

/**
 * 把一条云端消息送进 OpenClaw 的标准入站派发链路。
 *
 * 这整个函数就是插件最核心的“翻译器”：
 * 云端消息 -> OpenClaw inbound context -> OpenClaw reply -> 云端 reply
 */
export async function dispatchCloudMessage(params: {
  cfg: OpenClawConfig;
  channelRuntime?: unknown;
  account: SpringImAccountConfig;
  message: SpringImCloudMessage;
  store: SpringImStateStore;
  logger: SpringImLogger;
  client?: SpringImWebSocketClient;
  signal?: AbortSignal;
  onOutbound?: () => void | Promise<void>;
}): Promise<void> {
  const runtime = resolveRuntimeChannel(params.channelRuntime);
  if (!runtime) {
    throw new Error("OpenClaw channel runtime is not available for OpenBridge dispatch");
  }

  // 把云端会话路由到正确的 OpenClaw agent 和 session。
  const route = runtime.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    peer: {
      kind: params.message.conversationType === "group" ? "group" : "direct",
      id: params.message.conversationId,
    },
  });
  params.logger.info(
    `openbridge[${params.account.accountId}]: dispatch route resolved ${summarizeCloudMessage(params.message)} agentId=${route.agentId} sessionKey=${route.sessionKey}`,
  );

  /**
   * `from` / `to` 是 OpenClaw 侧理解消息来源和目标的标准形式。
   *
   * - `from` 强调是谁发来的
   * - `to` 强调这是哪种会话里的哪一个会话 id
   */
  const from = `${CHANNEL_ID}:${params.message.senderId}`;
  const to = `${params.message.conversationType}:${params.message.conversationId}`;
  const mediaResult = await materializeInboundImages(params.message.media);
  const mediaWarnings = mediaResult.warnings.map((warning) => `[Media fetch failed] ${warning}`).join("\n");
  const rawBody = appendMediaSummary(params.message.text, params.message.media);
  const body = [rawBody, mediaWarnings].filter(Boolean).join("\n");
  params.logger.debug?.(
    `openbridge[${params.account.accountId}]: inbound context prepared eventId=${params.message.eventId} body="${previewText(body)}" images=${mediaResult.images.length} mediaWarnings=${mediaResult.warnings.length}`,
  );

  // 构造标准的 OpenClaw inbound context，保证下游行为
  // （session、tools、prompts、memory）和其他原生 channel 保持一致。
  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: `${params.message.senderName ?? params.message.senderId}: ${body}`,
    RawBody: rawBody,
    CommandBody: body,
    From: from,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: params.account.accountId,
    ChatType: params.message.conversationType,
    GroupSubject:
      params.message.conversationType === "group" ? params.message.conversationId : undefined,
    SenderName: params.message.senderName ?? params.message.senderId,
    SenderId: params.message.senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_LABEL,
    MessageSid: params.message.eventId,
    ReplyToId: params.message.replyToId,
    MessageThreadId: params.message.threadId,
    Timestamp: params.message.timestamp ?? Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: params.message.conversationId,
    _openbridge: {
      media: params.message.media ?? [],
      mediaCount: params.message.media?.length ?? 0,
    },
  });

  /**
   * 这里取到的 `storePath` 是 OpenClaw 会话存储的落点路径。
   *
   * 它非常重要，因为只要 sessionKey 和 storePath 的解析方式稳定，
   * OpenClaw 的记忆和对话上下文就能连续。
   */
  const sessionStore = (params.cfg as { session?: { store?: SessionStoreArg } }).session?.store;
  // 按内置 channel 的同样方式解析 session 存储路径。
  const storePath = runtime.session.resolveStorePath(sessionStore, { agentId: route.agentId });
  params.logger.debug?.(
    `openbridge[${params.account.accountId}]: inbound session store resolved eventId=${params.message.eventId} storePath=${storePath}`,
  );

  await dispatchInboundReplyWithBase({
    cfg: params.cfg,
    channel: CHANNEL_ID,
    accountId: params.account.accountId,
    route,
    storePath,
    ctxPayload,
    core: {
      channel: {
        session: {
          recordInboundSession: runtime.session.recordInboundSession,
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher:
            runtime.reply.dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    },
    deliver: async (payload: OutboundReplyPayload) => {
      const reply = buildReply({
        eventId: params.message.eventId,
        conversationId: params.message.conversationId,
        conversationType: params.message.conversationType,
        payload,
        replyToId: params.message.replyToId,
        threadId: params.message.threadId,
      });
      if (!reply) {
        params.logger.info(
          `openbridge[${params.account.accountId}]: agent produced empty reply eventId=${params.message.eventId}`,
        );
        return;
      }
      params.logger.info(
        `openbridge[${params.account.accountId}]: agent reply built ${summarizeReply(reply)}`,
      );
      await deliverReply({
        account: params.account,
        reply,
        logger: params.logger,
        signal: params.signal,
        client: params.client,
        onSent: params.onOutbound,
      });
    },
    onRecordError: (err) => {
      params.logger.warn(
        `openbridge[${params.account.accountId}]: failed to record inbound session: ${String(err)}`,
      );
    },
    onDispatchError: (err, info) => {
      params.logger.error(
        `openbridge[${params.account.accountId}]: dispatch ${info.kind} failed eventId=${params.message.eventId}: ${String(err)}`,
      );
    },
    replyOptions: {
      images: mediaResult.images,
    },
  });
}
