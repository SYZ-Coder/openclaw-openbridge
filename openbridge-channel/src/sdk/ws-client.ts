import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { ClientFrame, ServerFrame } from "./protocol.js";
import { parseServerFrame, serializeClientFrame } from "./protocol.js";
import { signHello, type SpringImDeviceIdentity } from "./device-identity.js";
import { summarizeClientFrame, summarizeServerFrame } from "./logging.js";
import type { SpringImAccountConfig, SpringImLogger } from "./types.js";

type Handlers = {
  onFrame: (frame: ServerFrame) => Promise<void> | void;
  onClose: (reason: string) => void;
  onActivity?: (kind: "server-frame" | "protocol-pong" | "client-ping") => void;
};

export class SpringImWebSocketClient {
  private ws: WebSocket | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongWatchdog: ReturnType<typeof setInterval> | undefined;
  private lastPongAt = 0;
  private closeNotified = false;
  private notifyClose: ((reason: string) => void) | undefined;

  constructor(
    private readonly account: SpringImAccountConfig,
    private readonly logger: SpringImLogger,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(params: {
    signal: AbortSignal;
    handlers: Handlers;
    identity: SpringImDeviceIdentity;
  }): Promise<void> {
    const url = new URL(this.account.websocketUrl);
    url.searchParams.set("clientId", this.account.clientId);
    url.searchParams.set("accountId", this.account.accountId);
    if (this.account.token) {
      url.searchParams.set("token", this.account.token);
    }

    this.logger.info(
      `openbridge[${this.account.accountId}]: opening websocket url=${url.origin}${url.pathname} clientId=${this.account.clientId}`,
    );

    const ws = new WebSocket(url.toString(), {
      handshakeTimeout: this.account.connectTimeoutMs,
      perMessageDeflate: false,
    });
    this.ws = ws;
    this.lastPongAt = Date.now();
    this.closeNotified = false;

    this.notifyClose = (reason: string) => {
      if (this.closeNotified) {
        return;
      }
      this.closeNotified = true;
      this.stopHeartbeat();
      params.handlers.onClose(reason);
    };

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        return;
      }
      let text: string;
      try {
        text = typeof data === "string" ? data : data.toString("utf8");
      } catch (err) {
        this.logger.warn(`openbridge[${this.account.accountId}]: ignored unreadable server frame error=${String(err)}`);
        return;
      }
      let frame: ServerFrame | undefined;
      try {
        frame = parseServerFrame(text);
      } catch (err) {
        this.logger.warn(`openbridge[${this.account.accountId}]: ignored invalid server frame error=${String(err)}`);
        return;
      }
      if (!frame) {
        return;
      }
      this.lastPongAt = Date.now();
      params.handlers.onActivity?.("server-frame");
      this.logger.debug?.(
        `openbridge[${this.account.accountId}]: websocket frame received ${summarizeServerFrame(frame)}`,
      );
      void params.handlers.onFrame(frame);
    });

    ws.on("pong", () => {
      this.lastPongAt = Date.now();
      params.handlers.onActivity?.("protocol-pong");
      this.logger.debug?.(`openbridge[${this.account.accountId}]: websocket protocol pong received`);
    });

    ws.on("close", (code, reason) => {
      const reasonText = reason.toString("utf8");
      this.logger.warn(
        `openbridge[${this.account.accountId}]: websocket closed code=${code} reason=${reasonText || "n/a"}`,
      );
      this.destroySocket(ws);
      if (this.ws === ws) {
        this.ws = undefined;
      }
      this.notifyClose?.(`closed code=${code} reason=${reasonText || "n/a"}`);
    });

    ws.on("error", (err) => {
      this.logger.warn(`openbridge[${this.account.accountId}]: websocket runtime error error=${String(err)}`);
      this.destroySocket(ws);
      this.notifyClose?.(`error ${String(err)}`);
    });

    await new Promise<void>((resolve, reject) => {
      const cleanupListeners = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("close", onClose);
      };
      const onOpen = () => {
        cleanupListeners();
        this.logger.info(`openbridge[${this.account.accountId}]: websocket connected`);
        resolve();
      };
      const onError = (err: Error) => {
        cleanupListeners();
        this.logger.warn(`openbridge[${this.account.accountId}]: websocket connect error error=${String(err)}`);
        reject(err instanceof Error ? err : new Error("WebSocket connection error"));
      };
      const onClose = (code: number, reason: Buffer) => {
        cleanupListeners();
        reject(new Error(`WebSocket closed during handshake code=${code} reason=${reason.toString("utf8")}`));
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("close", onClose);
      params.signal.addEventListener(
        "abort",
        () => {
          cleanupListeners();
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          resolve();
        },
        { once: true },
      );
    });

    if (!this.connected) {
      return;
    }

    try {
      const socket = (ws as unknown as { _socket?: { setKeepAlive: (enable: boolean, initialDelay?: number) => void; setNoDelay: (noDelay?: boolean) => void } })._socket;
      socket?.setKeepAlive(true, 5_000);
      socket?.setNoDelay(true);
    } catch (err) {
      this.logger.warn(`openbridge[${this.account.accountId}]: setKeepAlive failed error=${String(err)}`);
    }

    const timestamp = Date.now();
    const nonce = `nonce-${randomUUID()}`;
    const signature = signHello({
      identity: params.identity,
      clientId: this.account.clientId,
      accountId: this.account.accountId,
      timestamp,
      nonce,
    });
    const helloFrame: ClientFrame = {
      type: "client.hello",
      protocolVersion: 2,
      deviceId: params.identity.deviceId,
      clientId: this.account.clientId,
      accountId: this.account.accountId,
      timestamp,
      nonce,
      signature,
    };
    this.send(helloFrame);
    this.logger.info(
      `openbridge[${this.account.accountId}]: websocket hello sent deviceId=${params.identity.deviceId}`,
    );

    this.pingTimer = setInterval(() => {
      if (!this.connected) {
        return;
      }
      try {
        this.send({ type: "client.ping", ts: Date.now() });
        ws.ping();
        params.handlers.onActivity?.("client-ping");
      } catch (err) {
        this.logger.warn(`openbridge[${this.account.accountId}]: ping send failed, terminating error=${String(err)}`);
        this.forceTerminate("ping-send-failed");
      }
    }, this.account.heartbeatMs);

    const pongTimeoutMs = this.account.heartbeatMs * 4 + 10_000;
    this.pongWatchdog = setInterval(() => {
      if (!this.connected) {
        return;
      }
      if (Date.now() - this.lastPongAt > pongTimeoutMs) {
        this.logger.warn(
          `openbridge[${this.account.accountId}]: pong watchdog timeout, terminating lastPongAt=${this.lastPongAt} thresholdMs=${pongTimeoutMs}`,
        );
        this.forceTerminate("pong-timeout");
      }
    }, Math.max(this.account.heartbeatMs, 5_000));
  }

  send(frame: ClientFrame): boolean {
    if (!this.connected || !this.ws) {
      this.logger.warn(
        `openbridge[${this.account.accountId}]: websocket send skipped while disconnected ${summarizeClientFrame(frame)}`,
      );
      return false;
    }
    this.logger.debug?.(
      `openbridge[${this.account.accountId}]: websocket frame sent ${summarizeClientFrame(frame)}`,
    );
    try {
      this.ws.send(serializeClientFrame(frame), (err) => {
        if (err) {
          this.logger.warn(`openbridge[${this.account.accountId}]: send callback error error=${String(err)}`);
          this.forceTerminate("send-callback-error");
        }
      });
      return true;
    } catch (err) {
      this.logger.warn(`openbridge[${this.account.accountId}]: send threw error=${String(err)}`);
      this.forceTerminate("send-threw");
      return false;
    }
  }

  close(): void {
    this.stopHeartbeat();
    if (this.ws) {
      const ws = this.ws;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      this.destroySocket(ws);
    }
    this.ws = undefined;
  }

  private forceTerminate(reason: string): void {
    this.stopHeartbeat();
    if (this.ws) {
      const ws = this.ws;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      this.destroySocket(ws);
      this.ws = undefined;
    }
    this.notifyClose?.(reason);
  }

  private destroySocket(ws: WebSocket): void {
    try {
      const socket = (ws as unknown as { _socket?: { destroy: () => void } })._socket;
      socket?.destroy();
    } catch {
      /* ignore */
    }
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.pongWatchdog) {
      clearInterval(this.pongWatchdog);
      this.pongWatchdog = undefined;
    }
  }
}
