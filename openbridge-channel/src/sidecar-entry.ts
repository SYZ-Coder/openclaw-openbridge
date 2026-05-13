import { startOpenBridgeAccount, type OpenBridgeAccountConfig } from "./sdk/index.js";
import type { ClientFrame } from "./sdk/protocol.js";
import type { SpringImCloudMessage, SpringImLogger } from "./sdk/types.js";
import type { SpringImWebSocketClient } from "./sdk/ws-client.js";

type SidecarContext = {
  account: OpenBridgeAccountConfig;
  cfg: Record<string, unknown>;
};

type ParentMessage =
  | { type: "dispatch-result"; id: string; ok: true }
  | { type: "dispatch-result"; id: string; ok: false; error: string }
  | { type: "send-frame"; frame: ClientFrame };

type PendingDispatch = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const DISPATCH_TIMEOUT_MS = 170_000;
const SIDECAR_HEARTBEAT_MS = 10_000;
const pendingDispatches = new Map<string, PendingDispatch>();
let activeClient: SpringImWebSocketClient | undefined;
let sidecarHeartbeat: ReturnType<typeof setInterval> | undefined;
let lastStatusSnapshot: Record<string, unknown> = {
  connected: false,
  running: true,
  phase: "sidecar-starting",
};

function send(message: unknown): boolean {
  try {
    return process.send?.(message) ?? false;
  } catch {
    return false;
  }
}

function log(level: "info" | "warn" | "error" | "debug", message: string): void {
  if (!send({ type: "log", level, message })) {
    const target = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    target(message);
  }
}

function sendStatus(snapshot: Record<string, unknown>): void {
  lastStatusSnapshot = {
    ...lastStatusSnapshot,
    ...snapshot,
    running: snapshot.running ?? true,
  };
  send({ type: "status", snapshot });
}

function startSidecarHeartbeat(accountId: string): void {
  if (sidecarHeartbeat) {
    clearInterval(sidecarHeartbeat);
  }
  sidecarHeartbeat = setInterval(() => {
    sendStatus({
      ...lastStatusSnapshot,
      connected: Boolean(lastStatusSnapshot.connected) || Boolean(activeClient?.connected),
      running: true,
      accountId,
      phase: "sidecar-heartbeat",
      sidecarHeartbeatAt: new Date().toISOString(),
    });
  }, SIDECAR_HEARTBEAT_MS);
  sidecarHeartbeat.unref?.();
}

function stopSidecarHeartbeat(): void {
  if (sidecarHeartbeat) {
    clearInterval(sidecarHeartbeat);
    sidecarHeartbeat = undefined;
  }
}

const logger: SpringImLogger = {
  info: (message) => log("info", message),
  warn: (message) => log("warn", message),
  error: (message) => log("error", message),
  debug: (message) => log("debug", message),
};

function readContext(): SidecarContext {
  const raw = process.env.OPENBRIDGE_SIDECAR_CONTEXT;
  if (!raw) {
    throw new Error("missing OPENBRIDGE_SIDECAR_CONTEXT");
  }
  return JSON.parse(raw) as SidecarContext;
}

function requestParentDispatch(account: OpenBridgeAccountConfig, message: SpringImCloudMessage): Promise<void> {
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingDispatches.delete(id);
      reject(new Error(`sidecar dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms`));
    }, DISPATCH_TIMEOUT_MS);
    pendingDispatches.set(id, { resolve, reject, timer });
    if (!send({ type: "dispatch", id, message })) {
      clearTimeout(timer);
      pendingDispatches.delete(id);
      reject(new Error(`sidecar dispatch IPC unavailable accountId=${account.accountId}`));
    }
  });
}

process.on("message", (message: ParentMessage) => {
  if (message.type === "send-frame") {
    if (!activeClient?.connected) {
      logger.warn("openbridge sidecar: send-frame skipped because websocket is disconnected");
      return;
    }
    activeClient.send(message.frame);
    return;
  }
  const pending = pendingDispatches.get(message.id);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingDispatches.delete(message.id);
  if (message.ok) {
    pending.resolve();
  } else {
    pending.reject(new Error(message.error));
  }
});

process.on("disconnect", () => {
  for (const [id, pending] of pendingDispatches) {
    clearTimeout(pending.timer);
    pending.reject(new Error(`parent disconnected while dispatch was pending id=${id}`));
  }
  pendingDispatches.clear();
  stopSidecarHeartbeat();
  activeClient?.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopSidecarHeartbeat();
  activeClient?.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  stopSidecarHeartbeat();
  activeClient?.close();
  process.exit(0);
});

async function main(): Promise<void> {
  const context = readContext();
  sendStatus({
    connected: false,
    running: true,
    accountId: context.account.accountId,
    phase: "sidecar-starting",
    sidecarHeartbeatAt: new Date().toISOString(),
  });
  startSidecarHeartbeat(context.account.accountId);
  send({ type: "ready", accountId: context.account.accountId });
  await startOpenBridgeAccount({
    account: context.account,
    cfg: context.cfg,
    abortSignal: new AbortController().signal,
    log: logger,
    setStatus: (snapshot) => {
      sendStatus(snapshot);
    },
    onMessage: async ({ account, message, client }) => {
      activeClient = client;
      if (account.demoEchoReply) {
        const { handleSpringImInboundMessage } = await import("./sdk/inbound.js");
        await handleSpringImInboundMessage({
          cfg: context.cfg,
          account,
          message,
          store: {} as never,
          logger,
          client,
        });
        return;
      }
      await requestParentDispatch(account, message);
    },
  });
}

main().catch((error) => {
  logger.error(`openbridge sidecar fatal: ${String(error)}`);
  process.exitCode = 1;
});
