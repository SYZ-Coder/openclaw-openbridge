/**
 * Spring IM 插件共享领域类型。
 *
 * 这些类型刻意保持小而本地化，让 transport、state、config 和 dispatch
 * 代码共享同一套一致的数据模型。
 */

/**
 * OpenClaw 侧看到的 channel id。
 *
 * 这个值会出现在路由、上下文、状态和消息工具目标里，
 * 所以它相当于这套插件在 OpenClaw 世界中的“正式名字”。
 */
export const CHANNEL_ID = "openbridge";

/**
 * 展示给用户或状态面板的人类可读名称。
 */
export const CHANNEL_LABEL = "OpenBridge";

/**
 * 外部 IM 会话类型。
 *
 * `direct` 表示一对一会话，`group` 表示群聊。
 */
export type SpringImConversationType = "direct" | "group";

export type SpringImMediaItem = {
  kind: "image" | "file";
  url: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
};

/**
 * 单个账号的最终运行时配置。
 *
 * 这里的字段不是“原始配置文件长什么样”，而是经过 `config.ts` 归一化后，
 * 运行时真正消费的数据结构。
 */
export type SpringImAccountConfig = {
  /** OpenClaw 内部的账号 id。 */
  accountId: string;
  /** 账号是否启用。 */
  enabled: boolean;
  /** Spring Boot 服务的 HTTP 基础地址。 */
  baseUrl: string;
  /** 插件主动连接云端时使用的 WebSocket 地址。 */
  websocketUrl: string;
  /** 云端识别本地 OpenClaw 客户端的 clientId。 */
  clientId: string;
  /** WebSocket / HTTP 鉴权 token。 */
  token?: string;
  /** 可选 HMAC 签名密钥。 */
  clientSecret?: string;
  /** 可选的默认 conversationId。 */
  defaultTo?: string;
  /** 允许主动消息投递的来源列表。 */
  allowFrom: string[];
  /** 私聊策略。`open` 表示开放，`allowlist` 表示只允许白名单。 */
  dmPolicy: "allowlist" | "open";
  /** 最小重连退避时间。 */
  reconnectMinMs: number;
  /** 最大重连退避时间。 */
  reconnectMaxMs: number;
  /** 心跳周期。 */
  heartbeatMs: number;
  /** 连接超时。 */
  connectTimeoutMs: number;
  /** ack 等待超时。 */
  ackTimeoutMs: number;
  /** OpenClaw agent 派发最大等待时间，超时后标记当前事件失败，避免阻塞后续消息。 */
  dispatchTimeoutMs: number;
  /** 本地联调开关：开启后直接生成测试 reply，不调用模型。 */
  demoEchoReply: boolean;
  /** 是否把 reply 同时镜像到 WebSocket。默认建议关闭。 */
  replyOverWebSocket: boolean;
  /** 本地状态文件目录。 */
  stateDir?: string;
};

/**
 * 对端对象的抽象表示。
 *
 * 这个类型当前没有大量使用，但它体现了插件把“对端”视为统一对象的建模方式，
 * 后续如果要做 thread / 子会话扩展会很方便。
 */
export type SpringImPeer = {
  kind: SpringImConversationType;
  id: string;
  parentId?: string;
};

/**
 * 云端发给插件的一条入站消息。
 *
 * 这里的 `eventId` 是去重主键，
 * `conversationId` 是外部服务的会话 id。
 */
export type SpringImCloudMessage = {
  type: "message";
  eventId: string;
  sequence?: number;
  conversationId: string;
  conversationType: SpringImConversationType;
  senderId: string;
  senderName?: string;
  text: string;
  media?: SpringImMediaItem[];
  timestamp?: number;
  replyToId?: string;
  threadId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * 插件准备发回云端的一条 reply。
 *
 * `localId` 是本地幂等键，用来保证 reply 重试时不会重复入库。
 */
export type SpringImReply = {
  localId: string;
  eventId?: string;
  conversationId: string;
  conversationType: SpringImConversationType;
  text: string;
  media?: SpringImMediaItem[];
  replyToId?: string;
  threadId?: string;
  createdAt: number;
};

export type SpringImRuntimePhase =
  | "idle"
  | "registering"
  | "connecting"
  | "handshaking"
  | "syncing"
  | "online"
  | "degraded"
  | "reconnecting"
  | "stopped";

/**
 * 本地状态文件整体结构。
 *
 * 插件本地只保存短 TTL 去重和运行状态；消息恢复由云服务负责。
 */
export type SpringImState = {
  dedup: Record<string, number>;
  runtime?: {
    phase: SpringImRuntimePhase;
    updatedAt: number;
    reason?: string;
  };
  updatedAt: number;
};

/**
 * 运行时状态快照。
 *
 * 这部分数据会被展示到 OpenClaw 的状态面板中。
 */
export type SpringImStatus = {
  connected: boolean;
  phase?: SpringImRuntimePhase;
  reconnectAttempts: number;
  lastConnectedAt?: number;
  lastDisconnect?: { at: number; error?: string };
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string;
};

/**
 * 轻量日志接口。
 *
 * 这样插件既能接 OpenClaw runtime 的 logger，也能在最简场景下直接退回 `console`。
 */
export type SpringImLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};
