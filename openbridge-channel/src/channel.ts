/**
 * 插件主注册入口。
 *
 * 这个文件声明 `openbridge` channel，并把配置解析、setup、运行时状态、
 * gateway 启动和出站发送这些能力组合在一起。
 */
import {
  CHANNEL_ID,
  CHANNEL_LABEL,
  sendOpenBridgeOutboundTextWithAccount,
  parseOpenBridgeTarget,
  type OpenBridgeAccountConfig,
} from "./sdk/index.js";
import { startManagedOpenBridgeAccount } from "./account-runtime.js";
import { hasOpenBridgeConfiguredState, listOpenBridgeAccountIds, resolveOpenBridgeAccount } from "./config.js";

type OpenClawConfig = Record<string, unknown>;
type MinimalGatewayLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};
type AccountContext = { account: OpenBridgeAccountConfig };
type ConfigContext = { cfg: OpenClawConfig; accountId?: string | null };
type AllowFromContext = { allowFrom: Array<string | number> };
type SetupAccountContext = {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
};
type SetupInputContext = { input: Record<string, unknown> };
type SnapshotContext = {
  account: OpenBridgeAccountConfig;
  runtime: Record<string, unknown>;
};
type SummaryContext = {
  account: OpenBridgeAccountConfig;
  snapshot: Record<string, unknown>;
};
type AccountStateContext = { configured: boolean; enabled: boolean };

/**
 * 生成状态页里的账号描述。
 *
 * 可以把它理解成：给 OpenClaw UI / 状态面板看的账号快照。
 */
function describeAccount(account: OpenBridgeAccountConfig) {
  console.info(
    `[${CHANNEL_ID}] describeAccount accountId=${account.accountId} enabled=${account.enabled} clientId=${account.clientId} baseUrl=${account.baseUrl || "(missing)"} token=${account.token ? "set" : "missing"}`,
  );
  // 这个快照会展示在 OpenClaw 的 channel 状态页和诊断视图里。
  return {
    accountId: account.accountId,
    name: account.clientId,
    enabled: account.enabled,
    configured: Boolean(account.baseUrl && account.clientId && account.token),
    linked: Boolean(account.token),
    connected: false,
    running: false,
    mode: "websocket",
    baseUrl: account.baseUrl,
    dmPolicy: account.dmPolicy,
    allowFrom: account.allowFrom,
    tokenStatus: account.token ? "configured" : "missing",
    secretSource: account.clientSecret ? "configured" : "not-configured",
    audienceType: account.replyOverWebSocket ? "http+websocket" : "http-only",
  };
}

/**
 * 把 setup 表单输入合并回 OpenClaw 配置对象。
 *
 * 这里不是简单覆盖，而是保留已有 `accounts.*` 结构后做定点更新。
 */
function applyAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
}): OpenClawConfig {
  // setup 写入时采用合并而不是整体替换，避免编辑时丢掉已有账号字段。
  const current = params.cfg as Record<string, unknown>;
  const channels =
    current.channels && typeof current.channels === "object"
      ? { ...(current.channels as Record<string, unknown>) }
      : {};
  const root =
    channels["openbridge"] && typeof channels["openbridge"] === "object"
      ? { ...(channels["openbridge"] as Record<string, unknown>) }
      : channels.openbridge && typeof channels.openbridge === "object"
        ? { ...(channels.openbridge as Record<string, unknown>) }
        : {};
  const accounts =
    root.accounts && typeof root.accounts === "object"
      ? { ...(root.accounts as Record<string, unknown>) }
      : {};
  accounts[params.accountId] = {
    ...(accounts[params.accountId] && typeof accounts[params.accountId] === "object"
      ? (accounts[params.accountId] as Record<string, unknown>)
      : {}),
    ...params.input,
    enabled: true,
  };
  return {
    ...params.cfg,
    channels: {
      ...channels,
      "openbridge": {
        ...root,
        accounts,
      },
    },
  } as OpenClawConfig;
}

/**
 * `openbridgePlugin` 是整套插件真正暴露给 OpenClaw 的对象。
 *
 * 可以把下面这些区块理解成：
 * - `config`：怎么找账号、怎么判断是否配置完整
 * - `setup`：怎么把用户输入写回配置
 * - `status`：怎么显示运行状态
 * - `gateway`：怎么启动长驻在线循环
 * - `outbound`：怎么把 OpenClaw 生成的消息发回外部服务
 */
export const openBridgePlugin = {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: CHANNEL_LABEL,
      selectionLabel: CHANNEL_LABEL,
      docsPath: "doc/openbridge-channel-design.md",
      docsLabel: "OpenBridge channel design",
      blurb:
        "Thin channel adapter backed by the reusable OpenBridge SDK.",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      reply: true,
      threads: true,
      media: true,
      blockStreaming: true,
    },
    defaults: {
      queue: {
        debounceMs: 250,
      },
    },
    reload: {
      configPrefixes: ["channels.openbridge", "channels.openbridge"],
    },
    config: {
      // config 适配层负责让 OpenClaw 枚举并解析 channel 账号。
      listAccountIds: listOpenBridgeAccountIds,
      defaultAccountId: (cfg: OpenClawConfig) => listOpenBridgeAccountIds(cfg)[0] ?? "default",
      resolveAccount: resolveOpenBridgeAccount,
      isEnabled: (account: OpenBridgeAccountConfig) => {
        console.info(
          `[${CHANNEL_ID}] isEnabled accountId=${account.accountId} enabled=${account.enabled}`,
        );
        return account.enabled;
      },
      disabledReason: () => "OpenBridge account is disabled",
      isConfigured: (account: OpenBridgeAccountConfig) => {
        const configured = Boolean(account.baseUrl && account.clientId && account.token);
        console.info(
          `[${CHANNEL_ID}] isConfigured accountId=${account.accountId} configured=${configured} baseUrl=${account.baseUrl || "(missing)"} clientId=${account.clientId || "(missing)"} token=${account.token ? "set" : "missing"}`,
        );
        return configured;
      },
      unconfiguredReason: () =>
        "Set channels.openbridge.baseUrl, channels.openbridge.clientId, and channels.openbridge.token.",
      describeAccount: (account: OpenBridgeAccountConfig) => describeAccount(account),
      resolveAllowFrom: ({ cfg, accountId }: ConfigContext) => resolveOpenBridgeAccount(cfg, accountId).allowFrom,
      formatAllowFrom: ({ allowFrom }: AllowFromContext) => allowFrom.map(String),
      hasConfiguredState: ({ cfg }: { cfg: OpenClawConfig }) => hasOpenBridgeConfiguredState(cfg),
      hasPersistedAuthState: ({ cfg }: { cfg: OpenClawConfig }) => hasOpenBridgeConfiguredState(cfg),
      resolveDefaultTo: ({ cfg, accountId }: ConfigContext) => resolveOpenBridgeAccount(cfg, accountId).defaultTo,
    },
    setup: {
      // setup 只需要最小信息，因为可靠性逻辑在 runtime，而不在 setup 状态中。
      resolveAccountId: ({ accountId }: { accountId?: string | null }) => accountId?.trim() || "default",
      applyAccountConfig: ({ cfg, accountId, input }: SetupAccountContext) =>
        applyAccountConfig({ cfg, accountId, input: input as Record<string, unknown> }),
      validateInput: ({ input }: SetupInputContext) => {
        const values = input as Record<string, unknown>;
        if (typeof values.baseUrl !== "string" || !values.baseUrl.trim()) {
          return "baseUrl is required";
        }
        if (typeof values.clientId !== "string" || !values.clientId.trim()) {
          return "clientId is required";
        }
        if (typeof values.token !== "string" || !values.token.trim()) {
          return "token is required";
        }
        return null;
      },
    },
    status: {
      // 这些运行时字段会在账号循环运行过程中由 `monitor.ts` 持续更新。
      defaultRuntime: {
        accountId: "default",
        enabled: false,
        configured: false,
        linked: false,
        running: false,
        connected: false,
        mode: "websocket",
      },
      buildAccountSnapshot: ({ account, runtime }: SnapshotContext) => {
        console.info(
          `[${CHANNEL_ID}] buildAccountSnapshot accountId=${account.accountId} runtimeKeys=${Object.keys(runtime).join(",") || "(none)"}`,
        );
        return {
          ...describeAccount(account),
          ...runtime,
        };
      },
      buildChannelSummary: ({ account, snapshot }: SummaryContext) => {
        console.info(
          `[${CHANNEL_ID}] buildChannelSummary accountId=${account.accountId} connected=${String(snapshot.connected)} running=${String(snapshot.running)}`,
        );
        return {
          accountId: account.accountId,
          clientId: account.clientId,
          baseUrl: account.baseUrl,
          connected: snapshot.connected,
          lastInboundAt: snapshot.lastInboundAt,
          lastOutboundAt: snapshot.lastOutboundAt,
          reconnectAttempts: snapshot.reconnectAttempts,
        };
      },
      resolveAccountState: ({ configured, enabled }: AccountStateContext) => {
        console.info(
          `[${CHANNEL_ID}] resolveAccountState configured=${configured} enabled=${enabled}`,
        );
        if (!configured) {
          return "not configured";
        }
        return enabled ? "enabled" : "disabled";
      },
    },
    gateway: {
      // Gateway 启动后会进入 `monitor.ts` 里的长生命周期在线客户端循环。
      startAccount: async (ctx: {
        account: OpenBridgeAccountConfig;
        cfg: OpenClawConfig;
        channelRuntime?: unknown;
        abortSignal: AbortSignal;
        log?: MinimalGatewayLogger;
        setStatus: (snapshot: Record<string, unknown>) => void;
      }) => {
        ctx.log?.info?.(
          `[${CHANNEL_ID}] gateway start accountId=${ctx.account.accountId} clientId=${ctx.account.clientId} baseUrl=${ctx.account.baseUrl}`,
        );
        await startManagedOpenBridgeAccount(ctx);
      },
    },
    messaging: {
      // 支持 user:<id>、group:<id>，也兼容直接传 conversationId。
      normalizeTarget: (target: string) => {
        const parsed = parseOpenBridgeTarget(target);
        return `${parsed.conversationType === "group" ? "group" : "user"}:${parsed.conversationId}`;
      },
      targetResolver: {
        looksLikeId: (id: string) => Boolean(id?.trim()),
        hint: "<conversationId>",
      },
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### OpenBridge",
        "Use the OpenBridge channel for user conversations hosted by the cloud IM service.",
        "Targets can be `user:<id>`, `group:<id>`, or a raw conversation id.",
      ],
    },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    // 直接出站消息走 WebSocket 直发；可靠性由云服务事件状态和连接恢复负责。
    sendText: async (ctx: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      to: string;
      text: string;
      replyToId?: string | null;
      threadId?: string | number | null;
    }) => {
      const account = resolveOpenBridgeAccount(ctx.cfg, ctx.accountId);
      console.info(
        `[${CHANNEL_ID}] outbound sendText accountId=${account.accountId} clientId=${account.clientId} to=${ctx.to} textLength=${ctx.text.length} replyToId=${ctx.replyToId ?? ""} threadId=${ctx.threadId ?? ""}`,
      );
      return {
        channel: CHANNEL_ID,
        ...(await sendOpenBridgeOutboundTextWithAccount({
          account,
          to: ctx.to,
          text: ctx.text,
          replyToId: ctx.replyToId,
          threadId: ctx.threadId,
        })),
      };
    },
  },
  conversationBindings: {
    supportsCurrentConversationBinding: true,
    defaultTopLevelPlacement: "current",
  },
};


