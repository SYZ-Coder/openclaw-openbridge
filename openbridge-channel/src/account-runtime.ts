import { fork, type ChildProcess } from "node:child_process";
import { dispatchCloudMessage } from "./sdk/dispatch.js";
import type { ClientFrame } from "./sdk/protocol.js";
import type {
  SpringImCloudMessage,
  SpringImLogger,
  SpringImAccountConfig,
} from "./sdk/types.js";
import { getOpenBridgeChannelRuntime } from "./runtime-surface.js";

type LoggerLike = {
  info?: SpringImLogger["info"];
  warn?: SpringImLogger["warn"];
  error?: SpringImLogger["error"];
  debug?: SpringImLogger["debug"];
};

type ManagedRuntimeContext = {
  account: SpringImAccountConfig;
  cfg: Record<string, unknown>;
  channelRuntime?: unknown;
  log?: LoggerLike;
  setStatus?: (snapshot: Record<string, unknown>) => void;
};

type ManagedRuntimeEntry = {
  accountId: string;
  child: ChildProcess;
  ctx: ManagedRuntimeContext;
  lastStatusAt: number;
  watchdog: ReturnType<typeof setInterval> | undefined;
  restartTimer: ReturnType<typeof setTimeout> | undefined;
  stopping: boolean;
  connected: boolean;
};

type SidecarMessage =
  | { type: "log"; level: "info" | "warn" | "error" | "debug"; message: string }
  | { type: "status"; snapshot: Record<string, unknown> }
  | { type: "dispatch"; id: string; message: SpringImCloudMessage }
  | { type: "ready"; accountId: string };

type SidecarParentMessage =
  | { type: "dispatch-result"; id: string; ok: true }
  | { type: "dispatch-result"; id: string; ok: false; error: string }
  | { type: "send-frame"; frame: ClientFrame };

const managedRuntimes = new Map<string, ManagedRuntimeEntry>();
const WATCHDOG_INTERVAL_MS = 15_000;
const STALL_MS = 75_000;
const RESTART_DELAY_MS = 2_000;
const DISPATCH_IPC_TIMEOUT_MS = 170_000;

function resolveLogger(log?: LoggerLike): LoggerLike {
  return log ?? console;
}

export function getManagedOpenBridgeRuntimeCount(): number {
  return managedRuntimes.size;
}

export function getManagedOpenBridgeRuntimeAccountIds(): string[] {
  return Array.from(managedRuntimes.keys()).sort();
}

export function startManagedOpenBridgeAccount(ctx: ManagedRuntimeContext): Promise<void> {
  const existing = managedRuntimes.get(ctx.account.accountId);
  if (existing && !existing.stopping) {
    resolveLogger(ctx.log).info?.(
      `[openbridge] sidecar runtime reuse accountId=${ctx.account.accountId} pid=${existing.child.pid ?? "n/a"}`,
    );
    return Promise.resolve();
  }
  spawnManagedRuntime(ctx);
  return Promise.resolve();
}

function spawnManagedRuntime(ctx: ManagedRuntimeContext): void {
  const logger = resolveLogger(ctx.log);
  const entryPath = new URL("./sidecar-entry.js", import.meta.url);
  const child = fork(entryPath, [], {
    env: {
      ...process.env,
      OPENBRIDGE_SIDECAR_CONTEXT: JSON.stringify({
        account: ctx.account,
        cfg: ctx.cfg,
      }),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  const entry: ManagedRuntimeEntry = {
    accountId: ctx.account.accountId,
    child,
    ctx,
    lastStatusAt: Date.now(),
    watchdog: undefined,
    restartTimer: undefined,
    stopping: false,
    connected: false,
  };
  managedRuntimes.set(ctx.account.accountId, entry);

  logger.info?.(`[openbridge] sidecar runtime spawn accountId=${ctx.account.accountId} pid=${child.pid ?? "n/a"}`);

  child.stdout?.on("data", (chunk) => {
    logger.info?.(`[openbridge/sidecar:${ctx.account.accountId}] ${String(chunk).trimEnd()}`);
  });
  child.stderr?.on("data", (chunk) => {
    logger.warn?.(`[openbridge/sidecar:${ctx.account.accountId}] ${String(chunk).trimEnd()}`);
  });
  child.on("message", (message) => {
    void handleSidecarMessage(entry, message as SidecarMessage);
  });
  child.on("exit", (code, signal) => {
    entry.connected = false;
    if (entry.watchdog) {
      clearInterval(entry.watchdog);
      entry.watchdog = undefined;
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    if (managedRuntimes.get(ctx.account.accountId) === entry) {
      managedRuntimes.delete(ctx.account.accountId);
    }
    logger.warn?.(
      `[openbridge] sidecar runtime exited accountId=${ctx.account.accountId} pid=${child.pid ?? "n/a"} code=${code ?? "n/a"} signal=${signal ?? "n/a"} stopping=${entry.stopping}`,
    );
    if (!entry.stopping && !managedRuntimes.has(ctx.account.accountId)) {
      scheduleRestart(entry, "exit");
    }
  });

  entry.watchdog = setInterval(() => {
    const current = managedRuntimes.get(ctx.account.accountId);
    if (!current || current !== entry || current.stopping) {
      return;
    }
    const stalledFor = Date.now() - current.lastStatusAt;
    if (stalledFor < STALL_MS) {
      return;
    }
    logger.warn?.(
      `[openbridge] sidecar watchdog: runtime stalled accountId=${ctx.account.accountId} stalledMs=${stalledFor} threshold=${STALL_MS}, replacing pid=${child.pid ?? "n/a"}`,
    );
    restartSidecar(current, "watchdog-stalled");
  }, WATCHDOG_INTERVAL_MS);
}

async function handleSidecarMessage(entry: ManagedRuntimeEntry, message: SidecarMessage): Promise<void> {
  const logger = resolveLogger(entry.ctx.log);
  entry.lastStatusAt = Date.now();
  if (message.type === "log") {
    logger[message.level]?.(message.message);
    return;
  }
  if (message.type === "ready") {
    entry.connected = true;
    logger.info?.(`[openbridge] sidecar ready accountId=${message.accountId} pid=${entry.child.pid ?? "n/a"}`);
    return;
  }
  if (message.type === "status") {
    entry.ctx.setStatus?.({
      ...message.snapshot,
      sidecarPid: entry.child.pid ?? null,
      runtimeIsolation: "sidecar",
    });
    return;
  }
  if (message.type === "dispatch") {
    await dispatchFromSidecar(entry, message.id, message.message);
  }
}

async function dispatchFromSidecar(
  entry: ManagedRuntimeEntry,
  id: string,
  message: SpringImCloudMessage,
): Promise<void> {
  const logger = resolveLogger(entry.ctx.log);
  const account = entry.ctx.account;
  const runtime = entry.ctx.channelRuntime ?? getOpenBridgeChannelRuntime();
  try {
    await withTimeout(
      dispatchCloudMessage({
        cfg: entry.ctx.cfg,
        channelRuntime: runtime,
        account,
        message,
        logger: toSdkLogger(entry.ctx.log),
        client: {
          get connected() {
            return entry.connected && !entry.child.killed;
          },
          send: (frame: ClientFrame) => sendToSidecar(entry, { type: "send-frame", frame }),
        } as never,
      }),
      DISPATCH_IPC_TIMEOUT_MS,
      `openbridge[${account.accountId}] sidecar dispatch`,
    );
    sendToSidecar(entry, { type: "dispatch-result", id, ok: true });
  } catch (error) {
    logger.error?.(
      `[openbridge] sidecar dispatch failed accountId=${account.accountId} eventId=${message.eventId} error=${String(error)}`,
    );
    sendToSidecar(entry, { type: "dispatch-result", id, ok: false, error: String(error) });
  }
}

function sendToSidecar(entry: ManagedRuntimeEntry, message: SidecarParentMessage): boolean {
  if (!entry.connected || entry.child.killed || !entry.child.connected) {
    return false;
  }
  try {
    return entry.child.send(message);
  } catch {
    return false;
  }
}

function killSidecar(entry: ManagedRuntimeEntry, reason: string): void {
  const logger = resolveLogger(entry.ctx.log);
  logger.warn?.(`[openbridge] sidecar kill accountId=${entry.accountId} reason=${reason} pid=${entry.child.pid ?? "n/a"}`);
  entry.connected = false;
  try {
    entry.child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      logger.warn?.(
        `[openbridge] sidecar force kill accountId=${entry.accountId} reason=${reason} pid=${entry.child.pid ?? "n/a"}`,
      );
      try {
        entry.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }, 3_000);
}

function restartSidecar(entry: ManagedRuntimeEntry, reason: string): void {
  const logger = resolveLogger(entry.ctx.log);
  if (entry.stopping) {
    return;
  }
  if (entry.watchdog) {
    clearInterval(entry.watchdog);
    entry.watchdog = undefined;
  }
  if (managedRuntimes.get(entry.accountId) === entry) {
    managedRuntimes.delete(entry.accountId);
  }
  killSidecar(entry, reason);
  scheduleRestart(entry, reason);
  logger.warn?.(`[openbridge] sidecar restart scheduled accountId=${entry.accountId} reason=${reason}`);
}

function scheduleRestart(entry: ManagedRuntimeEntry, reason: string): void {
  if (entry.stopping || entry.restartTimer) {
    return;
  }
  entry.restartTimer = setTimeout(() => {
    entry.restartTimer = undefined;
    if (entry.stopping || managedRuntimes.has(entry.accountId)) {
      return;
    }
    resolveLogger(entry.ctx.log).warn?.(
      `[openbridge] sidecar restarting accountId=${entry.accountId} reason=${reason}`,
    );
    spawnManagedRuntime(entry.ctx);
  }, RESTART_DELAY_MS);
}

function toSdkLogger(log?: LoggerLike): SpringImLogger {
  const logger = resolveLogger(log);
  const info = (message: string) => logger.info?.(message);
  const warn = (message: string) => logger.warn?.(message) ?? info(message);
  const error = (message: string) => logger.error?.(message) ?? warn(message);
  const debug = (message: string) => logger.debug?.(message) ?? info(message);
  return { info, warn, error, debug };
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

export async function stopManagedOpenBridgeAccounts(log?: LoggerLike): Promise<void> {
  const logger = resolveLogger(log);
  const entries = Array.from(managedRuntimes.values());
  if (!entries.length) {
    logger.info?.("[openbridge] sidecar runtime stop skipped: none running");
    return;
  }
  logger.info?.(
    `[openbridge] sidecar runtime stopping accounts=${entries.map((entry) => entry.accountId).join(",")}`,
  );
  for (const entry of entries) {
    entry.stopping = true;
    if (entry.watchdog) {
      clearInterval(entry.watchdog);
      entry.watchdog = undefined;
    }
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = undefined;
    }
    killSidecar(entry, "stop");
  }
}
