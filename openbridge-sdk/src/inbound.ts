import { dispatchCloudMessage } from "./dispatch.js";
import { buildReply, deliverReply } from "./outbox.js";
import type { SpringImWebSocketClient } from "./ws-client.js";
import type {
  SpringImAccountConfig,
  SpringImCloudMessage,
  SpringImLogger,
} from "./types.js";
import { SpringImStateStore } from "./state.js";

type OpenClawConfig = Record<string, unknown>;

export async function handleSpringImInboundMessage(params: {
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
  if (params.account.demoEchoReply) {
    const reply = buildReply({
      eventId: params.message.eventId,
      conversationId: params.message.conversationId,
      conversationType: params.message.conversationType,
      payload: { text: `[demo] OpenBridge received: ${params.message.text}` },
      replyToId: params.message.replyToId,
      threadId: params.message.threadId,
    });
    if (!reply) {
      return;
    }
    await deliverReply({
      account: params.account,
      reply,
      logger: params.logger,
      signal: params.signal,
      client: params.client,
      onSent: params.onOutbound,
    });
    return;
  }

  await dispatchCloudMessage({
    cfg: params.cfg,
    channelRuntime: params.channelRuntime,
    account: params.account,
    message: params.message,
    store: params.store,
    logger: params.logger,
    client: params.client,
    signal: params.signal,
    onOutbound: params.onOutbound,
  });
}
