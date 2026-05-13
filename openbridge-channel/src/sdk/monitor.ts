/**
 * 单账号 WebSocket 在线循环。
 *
 * 插件只负责连接、收消息、ack、派发和回复；本地状态只用于短 TTL 去重
 * 与运行状态展示。消息恢复、离线重投递和最终状态由云服务负责。
 */
import { computeReconnectDelayMs, sleep } from "./backoff.js";
import { SpringImMessageBatcher } from "./batcher.js";
import { registerDevice, waitForBridgeReady } from "./device-http.js";
import { SpringImDeviceIdentityStore } from "./device-identity.js";
import { handleSpringImInboundMessage } from "./inbound.js";
import { summarizeCloudMessage, summarizeServerFrame } from "./logging.js";
import type { ServerFrame } from "./protocol.js";
import { SpringImStateStore } from "./state.js";
import type { SpringImAccountConfig, SpringImLogger, SpringImStatus } from "./types.js";
import { SpringImWebSocketClient } from "./ws-client.js";

const STATUS_HEARTBEAT_MAX_MS = 30_000;

type ChannelGatewayContext<TAccount> = {
  account: TAccount;
  cfg: Record<string, unknown>;
  channelRuntime?: unknown;
  abortSignal: AbortSignal;
  log?: SpringImLogger;
  setStatus: (snapshot: Record<string, unknown>) => void;
  onMessage?: (params: {
    account: SpringImAccountConfig;
    message: Extract<ServerFrame, { type: "message" }>;
    store: SpringImStateStore;
    logger: SpringImLogger;
    client: SpringImWebSocketClient;
    signal: AbortSignal;
    cfg: Record<string, unknown>;
    channelRuntime?: unknown;
    onOutbound?: () => void | Promise<void>;
  }) => Promise<void>;
};

function toLogger(log: ChannelGatewayContext<SpringImAccountConfig>["log"]): SpringImLogger {
  return log ?? console;
}

function snapshot(account: SpringImAccountConfig, status: SpringImStatus) {
  return {
    accountId: account.accountId,
    name: account.clientId,
    enabled: account.enabled,
    configured: Boolean(account.baseUrl && account.clientId && account.token),
    linked: Boolean(account.token),
    running: true,
    connected: status.connected,
    phase: status.phase ?? "idle",
    reconnectAttempts: status.reconnectAttempts,
    lastConnectedAt: status.lastConnectedAt ?? null,
    lastDisconnect: status.lastDisconnect ?? null,
    lastInboundAt: status.lastInboundAt ?? null,
    lastOutboundAt: status.lastOutboundAt ?? null,
    lastError: status.lastError ?? null,
    mode: "websocket",
    baseUrl: account.baseUrl,
    dmPolicy: account.dmPolicy,
    allowFrom: account.allowFrom,
  };
}

async function setPhase(params: {
  store: SpringImStateStore;
  status: SpringImStatus;
  phase: NonNullable<SpringImStatus["phase"]>;
  reason?: string;
  ctx: ChannelGatewayContext<SpringImAccountConfig>;
  account: SpringImAccountConfig;
}): Promise<void> {
  params.status.phase = params.phase;
  await params.store.setRuntimePhase(params.phase, params.reason);
  params.ctx.setStatus(snapshot(params.account, params.status));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function sendAck(params: {
  client: SpringImWebSocketClient;
  eventId: string;
  status: "received" | "processed" | "failed" | "duplicate";
  error?: string;
}): Promise<void> {
  params.client.send({
    type: "client.ack",
    eventId: params.eventId,
    status: params.status,
    error: params.error,
  });
}

export async function startSpringImAccount(
  ctx: ChannelGatewayContext<SpringImAccountConfig>,
): Promise<void> {
  const account = ctx.account;
  const logger = toLogger(ctx.log);
  const status: SpringImStatus = {
    connected: false,
    phase: "idle",
    reconnectAttempts: 0,
  };
  const store = new SpringImStateStore(
    SpringImStateStore.resolvePath({ stateDir: account.stateDir, accountId: account.accountId }),
  );
  const identityStore = new SpringImDeviceIdentityStore(
    SpringImDeviceIdentityStore.resolvePath(account.stateDir),
  );
  await store.load();
  logger.info(
    `openbridge[${account.accountId}]: runtime start baseUrl=${account.baseUrl} websocketUrl=${account.websocketUrl} stateDir=${account.stateDir}`,
  );
  const identity = await identityStore.ensure();
  logger.info(
    `openbridge[${account.accountId}]: device identity ready deviceId=${identity.deviceId} installId=${identity.installId}`,
  );
  const inFlightEventIds = new Set<string>();

  const handleInboundMessage = async (params: {
    client: SpringImWebSocketClient;
    frame: Extract<ServerFrame, { type: "message" }>;
  }): Promise<void> => {
    const { client, frame } = params;
    logger.info(
      `openbridge[${account.accountId}]: inbound message ${JSON.stringify(summarizeCloudMessage(frame))}`,
    );
    if (await store.hasSeen(frame.eventId)) {
      await sendAck({ client, eventId: frame.eventId, status: "duplicate" });
      ctx.setStatus(snapshot(account, status));
      return;
    }

    if (inFlightEventIds.has(frame.eventId)) {
      logger.info(
        `openbridge[${account.accountId}]: duplicate in-flight skip eventId=${frame.eventId} sequence=${frame.sequence ?? "n/a"}`,
      );
      return;
    }
    inFlightEventIds.add(frame.eventId);

    try {
      await sendAck({ client, eventId: frame.eventId, status: "received" });
      logger.info(
        `openbridge[${account.accountId}]: dispatch start eventId=${frame.eventId} conversation=${frame.conversationType}:${frame.conversationId}`,
      );
      const handleMessage = ctx.onMessage ?? handleSpringImInboundMessage;
      await withTimeout(
        handleMessage({
          account,
          message: frame,
          store,
          logger,
          client,
          signal: ctx.abortSignal,
          cfg: ctx.cfg,
          channelRuntime: ctx.channelRuntime,
          onOutbound: async () => {
            status.lastOutboundAt = Date.now();
            ctx.setStatus(snapshot(account, status));
          },
        }),
        account.dispatchTimeoutMs,
        `openbridge[${account.accountId}] dispatch`,
      );
      status.lastInboundAt = Date.now();
      logger.info(`openbridge[${account.accountId}]: processed ack start eventId=${frame.eventId}`);
      await sendAck({ client, eventId: frame.eventId, status: "processed" });
      logger.info(`openbridge[${account.accountId}]: processed ack done eventId=${frame.eventId}`);
      void store.markSeen(frame.eventId).catch((error) => {
        logger.warn(`openbridge[${account.accountId}]: markSeen deferred eventId=${frame.eventId} error=${String(error)}`);
      });
      ctx.setStatus(snapshot(account, status));
      logger.info(`openbridge[${account.accountId}]: dispatch done eventId=${frame.eventId}`);
    } catch (err) {
      status.lastError = String(err);
      ctx.setStatus(snapshot(account, status));
      await sendAck({ client, eventId: frame.eventId, status: "failed", error: String(err) });
      logger.error(`openbridge[${account.accountId}]: dispatch failed eventId=${frame.eventId} error=${String(err)}`);
    } finally {
      inFlightEventIds.delete(frame.eventId);
    }
  };

  const processMessageBatch = async (
    client: SpringImWebSocketClient,
    events: Extract<ServerFrame, { type: "message" }>[],
  ): Promise<void> => {
    if (!events.length) {
      return;
    }
    logger.info(`openbridge[${account.accountId}]: processing message batch size=${events.length}`);
    for (const event of events.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))) {
      try {
        await handleInboundMessage({ client, frame: event });
      } catch (err) {
        logger.error(`openbridge[${account.accountId}]: batch item failed eventId=${event.eventId} error=${String(err)}`);
      }
    }
  };

  let attempt = 0;
  while (!ctx.abortSignal.aborted) {
    const client = new SpringImWebSocketClient(account, logger);
    let statusHeartbeat: ReturnType<typeof setInterval> | undefined;
    let queuedFrameCount = 0;
    let activeFrameType: string | undefined;
    let activeMessageEventId: string | undefined;
    let closedResolve: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      closedResolve = resolve;
    });
    let frameChain = Promise.resolve();
    const batcher = new SpringImMessageBatcher({
      maxBatchSize: 20,
      maxDelayMs: 50,
      logger,
      flush: (batch) => processMessageBatch(client, batch),
    });
    const publishStatus = () => {
      ctx.setStatus(snapshot(account, status));
    };

    const handleFrame = async (frame: ServerFrame) => {
      activeFrameType = frame.type;
      activeMessageEventId = frame.type === "message" ? frame.eventId : undefined;
      logger.info(
        `openbridge[${account.accountId}]: frame handling start queued=${queuedFrameCount} activeType=${frame.type} activeEventId=${activeMessageEventId ?? "n/a"} ${JSON.stringify(summarizeServerFrame(frame))}`,
      );
      if (frame.type === "server.hello") {
        publishStatus();
        logger.info(`openbridge[${account.accountId}]: frame handling done type=${frame.type} queued=${queuedFrameCount}`);
        return;
      }
      if (frame.type === "server.pong") {
        status.lastInboundAt = Date.now();
        publishStatus();
        logger.debug?.(`openbridge[${account.accountId}]: frame handling done type=${frame.type} queued=${queuedFrameCount}`);
        return;
      }
      if (frame.type === "server.reply-ack") {
        logger.debug?.(
          `openbridge[${account.accountId}]: reply ack localId=${frame.localId ?? "n/a"} status=${frame.status ?? "n/a"}`,
        );
        return;
      }
      if (frame.type === "server.resync-required") {
        logger.warn(`openbridge[${account.accountId}]: server requested resync, reconnecting`);
        client.close();
        return;
      }
      if (frame.type === "server.bye") {
        logger.warn(`openbridge[${account.accountId}]: server announced shutdown reason=${frame.reason ?? "n/a"}, reconnecting`);
        client.close();
        return;
      }
      logger.info(
        `openbridge[${account.accountId}]: frame queued for batch eventId=${frame.eventId} queued=${queuedFrameCount} sequence=${frame.sequence ?? "n/a"}`,
      );
      batcher.push(frame);
      logger.info(
        `openbridge[${account.accountId}]: frame handling done type=${frame.type} eventId=${frame.eventId} queued=${queuedFrameCount}`,
      );
    };

    try {
      await setPhase({ store, status, phase: "registering", ctx, account });
      await waitForBridgeReady({ account, signal: ctx.abortSignal, logger });
      const registration = await registerDevice({
        account,
        identity,
        signal: ctx.abortSignal,
        logger,
      });
      logger.info(
        `openbridge[${account.accountId}]: device registered deviceId=${registration.deviceId} clientId=${registration.clientId} ownerUserId=${registration.ownerUserId}`,
      );
      await identityStore.updateClientBinding({
        clientId: registration.clientId,
        ownerUserId: registration.ownerUserId,
      });
      if (registration.clientId !== account.clientId) {
        logger.warn(
          `openbridge[${account.accountId}]: registered device bound to clientId=${registration.clientId}, but local account uses clientId=${account.clientId}`,
        );
      }
      await setPhase({ store, status, phase: "connecting", ctx, account });
      await client.connect({
        signal: ctx.abortSignal,
        identity: await identityStore.ensure(),
        handlers: {
          onFrame: (frame) => {
            queuedFrameCount += 1;
            logger.info(
              `openbridge[${account.accountId}]: onFrame queued type=${frame.type} eventId=${frame.type === "message" ? frame.eventId : "n/a"} queued=${queuedFrameCount}`,
            );
            frameChain = frameChain
              .then(async () => {
                logger.info(
                  `openbridge[${account.accountId}]: onFrame dequeued type=${frame.type} eventId=${frame.type === "message" ? frame.eventId : "n/a"} queued=${queuedFrameCount}`,
                );
                await handleFrame(frame);
              })
              .catch((err) =>
                logger.error(
                  `openbridge[${account.accountId}]: frame processing failed activeType=${activeFrameType ?? "n/a"} activeEventId=${activeMessageEventId ?? "n/a"} queued=${queuedFrameCount} error=${String(err)}`,
                ),
              )
              .finally(() => {
                queuedFrameCount = Math.max(queuedFrameCount - 1, 0);
                logger.info(
                  `openbridge[${account.accountId}]: onFrame settled type=${frame.type} eventId=${frame.type === "message" ? frame.eventId : "n/a"} queued=${queuedFrameCount}`,
                );
                if (queuedFrameCount === 0) {
                  activeFrameType = undefined;
                  activeMessageEventId = undefined;
                }
              });
          },
          onClose: (reason) => {
            status.connected = false;
            status.lastDisconnect = { at: Date.now(), error: reason };
            publishStatus();
            logger.warn(
              `openbridge[${account.accountId}]: websocket closed callback reason=${reason} queued=${queuedFrameCount} activeType=${activeFrameType ?? "n/a"} activeEventId=${activeMessageEventId ?? "n/a"}`,
            );
            closedResolve?.();
          },
          onActivity: (kind) => {
            const now = Date.now();
            if (kind === "client-ping") {
              status.lastOutboundAt = now;
            } else {
              status.lastInboundAt = now;
            }
            publishStatus();
          },
        },
      });
      status.connected = true;
      status.reconnectAttempts = attempt;
      status.lastConnectedAt = Date.now();
      status.lastError = undefined;
      await setPhase({ store, status, phase: "online", ctx, account });
      logger.info(`openbridge[${account.accountId}]: connected to ${account.websocketUrl}`);
      const statusHeartbeatMs = Math.min(Math.max(account.heartbeatMs, 5_000), STATUS_HEARTBEAT_MAX_MS);
      statusHeartbeat = setInterval(publishStatus, statusHeartbeatMs);
      await batcher.flushNow();
      publishStatus();
      await closed;
    } catch (err) {
      status.connected = false;
      status.lastDisconnect = { at: Date.now(), error: String(err) };
      status.lastError = String(err);
      await setPhase({ store, status, phase: "degraded", reason: String(err), ctx, account });
      logger.warn(`openbridge[${account.accountId}]: disconnected: ${String(err)}`);
    } finally {
      if (statusHeartbeat) {
        clearInterval(statusHeartbeat);
      }
      await batcher.flushNow();
      client.close();
    }

    if (ctx.abortSignal.aborted) {
      break;
    }
    attempt += 1;
    status.reconnectAttempts = attempt;
    await setPhase({ store, status, phase: "reconnecting", ctx, account });
    const delayMs = computeReconnectDelayMs({
      attempt,
      minMs: account.reconnectMinMs,
      maxMs: account.reconnectMaxMs,
    });
    logger.info(`openbridge[${account.accountId}]: reconnect scheduled attempt=${attempt} delayMs=${delayMs}`);
    await sleep(delayMs, ctx.abortSignal);
  }
}
