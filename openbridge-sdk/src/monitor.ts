/**
 * Gateway 监控主循环。
 *
 * 这是单个 Spring IM 账号的长生命周期在线客户端进程，负责 WebSocket 连接、
 * replay、ack 顺序、状态更新、入站派发，以及重连后的 outbox 刷新。
 */
import type { ChannelGatewayContext } from "openclaw/plugin-sdk";
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

type CallbackGatewayContext = ChannelGatewayContext<SpringImAccountConfig> & {
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

function toLogger(log: ChannelGatewayContext["log"]): SpringImLogger {
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
    lastSequence: status.lastSequence ?? null,
    outboxSize: status.outboxSize ?? 0,
    deadLetterSize: status.deadLetterSize ?? 0,
    lastGap: status.lastGap ?? null,
    mode: "websocket",
    baseUrl: account.baseUrl,
    dmPolicy: account.dmPolicy,
    allowFrom: account.allowFrom,
  };
}

async function refreshStateSnapshot(params: {
  store: SpringImStateStore;
  status: SpringImStatus;
}): Promise<void> {
  params.status.lastSequence = await params.store.getLastSequence();
  params.status.outboxSize = await params.store.getOutboxSize();
  params.status.deadLetterSize = await params.store.getDeadLetterSize();
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
  await refreshStateSnapshot({ store: params.store, status: params.status });
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
  account: SpringImAccountConfig;
  eventId: string;
  status: "received" | "processed" | "failed" | "duplicate";
  error?: string;
  signal?: AbortSignal;
  logger?: SpringImLogger;
  httpRequired?: boolean;
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
  const callbackCtx = ctx as CallbackGatewayContext;
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
  const identityStore = new SpringImDeviceIdentityStore(store);
  await store.load();
  logger.info(
    `openbridge[${account.accountId}]: runtime start baseUrl=${account.baseUrl} websocketUrl=${account.websocketUrl} stateDir=${account.stateDir}`,
  );
  const identity = await identityStore.ensure();
  logger.info(
    `openbridge[${account.accountId}]: device identity ready deviceId=${identity.deviceId} installId=${identity.installId}`,
  );
  await refreshStateSnapshot({ store, status });
  const inFlightEventIds = new Set<string>();

  const handleInboundMessage = async (params: {
    client: SpringImWebSocketClient;
    frame: Extract<ServerFrame, { type: "message" }>;
  }): Promise<void> => {
    const { client, frame } = params;
    logger.info(
      `openbridge[${account.accountId}]: inbound message ${JSON.stringify(summarizeCloudMessage(frame))}`,
    );
    const previousSequence = await store.getLastSequence();
    if (
      typeof frame.sequence === "number" &&
      typeof previousSequence === "number" &&
      frame.sequence > previousSequence + 1
    ) {
      const gap = { expected: previousSequence + 1, actual: frame.sequence };
      await store.noteSequenceGap(gap);
      status.lastGap = gap;
      logger.warn(
        `openbridge[${account.accountId}]: sequence gap detected expected=${gap.expected} actual=${gap.actual}`,
      );
    }
    if (await store.hasSeen(frame.eventId)) {
      await sendAck({
        client,
        account,
        eventId: frame.eventId,
        status: "duplicate",
        logger,
        httpRequired: true,
        signal: ctx.abortSignal,
      });
      await store.advanceCheckpoint({ sequence: frame.sequence });
      await refreshStateSnapshot({ store, status });
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
      await sendAck({
        client,
        account,
        eventId: frame.eventId,
        status: "received",
        logger,
        httpRequired: false,
        signal: ctx.abortSignal,
      });
      logger.info(
        `openbridge[${account.accountId}]: dispatch start eventId=${frame.eventId} conversation=${frame.conversationType}:${frame.conversationId}`,
      );
      const handleMessage = callbackCtx.onMessage ?? handleSpringImInboundMessage;
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
            await refreshStateSnapshot({ store, status });
            ctx.setStatus(snapshot(account, status));
          },
        }),
        account.dispatchTimeoutMs,
        `openbridge[${account.accountId}] dispatch`,
      );
      await store.finalizeProcessedMessage({
        eventId: frame.eventId,
        sequence: frame.sequence,
      });
      status.lastInboundAt = Date.now();
      await sendAck({
        client,
        account,
        eventId: frame.eventId,
        status: "processed",
        logger,
        httpRequired: true,
        signal: ctx.abortSignal,
      });
      await refreshStateSnapshot({ store, status });
      ctx.setStatus(snapshot(account, status));
      logger.info(
        `openbridge[${account.accountId}]: dispatch done eventId=${frame.eventId}`,
      );
    } catch (err) {
      status.lastError = String(err);
      await refreshStateSnapshot({ store, status });
      ctx.setStatus(snapshot(account, status));
      await sendAck({
        client,
        account,
        eventId: frame.eventId,
        status: "failed",
        error: String(err),
        logger,
        httpRequired: true,
        signal: ctx.abortSignal,
      });
      logger.error(
        `openbridge[${account.accountId}]: dispatch failed eventId=${frame.eventId} error=${String(err)}`,
      );
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
    await store.recordInboundBatch(events);
    for (const event of events.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))) {
      try {
        await handleInboundMessage({ client, frame: event });
      } catch (err) {
        logger.error(
          `openbridge[${account.accountId}]: batch item failed eventId=${event.eventId} error=${String(err)}`,
        );
      }
    }
  };

  let attempt = 0;
  while (!ctx.abortSignal.aborted) {
    const client = new SpringImWebSocketClient(account, logger);
    let statusHeartbeat: ReturnType<typeof setInterval> | undefined;
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
      logger.info(
        `openbridge[${account.accountId}]: frame received ${JSON.stringify(summarizeServerFrame(frame))}`,
      );
      if (frame.type === "server.hello") {
        await refreshStateSnapshot({ store, status });
        ctx.setStatus(snapshot(account, status));
        return;
      }
      if (frame.type === "server.pong") {
        status.lastInboundAt = Date.now();
        publishStatus();
        return;
      }
      if (frame.type === "server.reply-ack") {
        logger.debug?.(
          `openbridge[${account.accountId}]: reply ack localId=${frame.localId ?? "n/a"} status=${frame.status ?? "n/a"}`,
        );
        return;
      }
      if (frame.type === "server.resync-required") {
        logger.warn(
          `openbridge[${account.accountId}]: server requested resync, reconnecting`,
        );
        client.close();
        return;
      }
      if (frame.type === "server.bye") {
        logger.warn(
          `openbridge[${account.accountId}]: server announced shutdown reason=${frame.reason ?? "n/a"}, reconnecting`,
        );
        client.close();
        return;
      }
      batcher.push(frame);
    };

    try {
      await setPhase({ store, status, phase: "registering", ctx, account });
      await waitForBridgeReady({
        account,
        signal: ctx.abortSignal,
        logger,
      });
      const registration = await registerDevice({
        account,
        identity,
        signal: ctx.abortSignal,
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
      ctx.setStatus(snapshot(account, status));
      const lastProcessedSequence = await store.getLastSequence();
      await client.connect({
        signal: ctx.abortSignal,
        identity: await identityStore.ensure(),
        resumeMetadata: {
          lastProcessedSequence,
        },
        handlers: {
          onFrame: (frame) => {
            frameChain = frameChain.then(() => handleFrame(frame)).catch((err) =>
              logger.error(`openbridge[${account.accountId}]: frame processing failed: ${String(err)}`),
            );
          },
          onClose: (reason) => {
            status.connected = false;
            status.lastDisconnect = { at: Date.now(), error: reason };
            publishStatus();
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
      await setPhase({ store, status, phase: "online", ctx, account });
      status.reconnectAttempts = attempt;
      status.lastConnectedAt = Date.now();
      status.lastError = undefined;
      await setPhase({ store, status, phase: "online", ctx, account });
      await refreshStateSnapshot({ store, status });
      ctx.setStatus(snapshot(account, status));
      logger.info(`openbridge[${account.accountId}]: connected to ${account.websocketUrl}`);
      const statusHeartbeatMs = Math.min(Math.max(account.heartbeatMs, 5_000), STATUS_HEARTBEAT_MAX_MS);
      statusHeartbeat = setInterval(() => {
        publishStatus();
      }, statusHeartbeatMs);
      await batcher.flushNow();
      await refreshStateSnapshot({ store, status });
      ctx.setStatus(snapshot(account, status));
      await closed;
    } catch (err) {
      status.connected = false;
      await setPhase({ store, status, phase: "degraded", reason: String(err), ctx, account });
      status.lastDisconnect = { at: Date.now(), error: String(err) };
      status.lastError = String(err);
      await refreshStateSnapshot({ store, status });
      ctx.setStatus(snapshot(account, status));
      logger.warn(`openbridge[${account.accountId}]: disconnected: ${String(err)}`);
    } finally {
      if (statusHeartbeat) {
        clearInterval(statusHeartbeat);
        statusHeartbeat = undefined;
      }
      await batcher.flushNow();
      client.close();
    }

    if (ctx.abortSignal.aborted) {
      break;
    }
    attempt += 1;
    await setPhase({ store, status, phase: "reconnecting", ctx, account });
    status.reconnectAttempts = attempt;
    const delayMs = computeReconnectDelayMs({
      attempt,
      minMs: account.reconnectMinMs,
      maxMs: account.reconnectMaxMs,
    });
    logger.info(`openbridge[${account.accountId}]: reconnect scheduled attempt=${attempt} delayMs=${delayMs}`);
    await sleep(delayMs, ctx.abortSignal);
  }
}
