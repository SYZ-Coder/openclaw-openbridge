/**
 * 配置归一化辅助函数。
 *
 * 插件同时支持顶层单账号配置和 `accounts.*` 多账号布局。
 * 这个文件会把两种写法统一成 runtime 可直接使用的结构。
 */
import type { OpenBridgeAccountConfig } from "./sdk/index.js";

type OpenClawConfig = Record<string, unknown>;

/** 默认账号 id。单账号模式下会回退到这里。 */
const DEFAULT_ACCOUNT_ID = "default";
const CONFIG_LOG_PREFIX = "[openbridge/config]";

function logConfigProbe(message: string): void {
  console.info(`${CONFIG_LOG_PREFIX} ${message}`);
}

/** 把未知值收敛成对象，避免到处写重复的类型判断。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** 读取一个去空格后的非空字符串。 */
function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 读取数字配置；如果无效则回退到默认值。 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 读取布尔配置；如果无效则回退到默认值。 */
function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** 读取字符串数组配置，并自动过滤空值。 */
function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
}

/**
 * 计算最终的 WebSocket 地址。
 *
 * 如果用户已经显式填写，就直接使用；否则基于 `baseUrl` 自动推导出
 * `/api/openclaw/ws` 这条标准路径。
 */
function resolveWebSocketUrl(baseUrl: string, configured?: string): string {
  if (configured) {
    return configured;
  }
  // 如果没有显式配置 WebSocket 地址，就默认使用同源服务上的标准 bridge 路径。
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/openclaw/ws";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** 取出 `channels["openbridge"]` 这一层配置，并兼容旧的 spring-im 配置。 */
function defaultStateDir(accountId: string): string {
  const base =
    process.env.OPENCLAW_STATE_DIR ||
    process.env.USERPROFILE ||
    process.env.HOME ||
    process.cwd();
  return `${base}\\.openclaw-openbridge\\${accountId}`;
}

function readOpenBridgeRoot(cfg: OpenClawConfig): Record<string, unknown> {
  const channels = asRecord((cfg as Record<string, unknown>).channels);
  const canonical = asRecord(channels["openbridge"]);
  if (Object.keys(canonical).length) {
    logConfigProbe(`read root from channels.openbridge keys=${Object.keys(canonical).join(",") || "(none)"}`);
    return canonical;
  }
  const camel = asRecord(channels.openbridge);
  if (Object.keys(camel).length) {
    logConfigProbe(`read root from channels.openbridge keys=${Object.keys(camel).join(",") || "(none)"}`);
    return camel;
  }
  const legacy = asRecord(channels["spring-im"]);
  logConfigProbe(
    `read root from channels.spring-im fallback keys=${Object.keys(legacy).join(",") || "(none)"}`,
  );
  return legacy;
}

/**
 * 把原始账号配置归一化成运行时账号对象。
 *
 * 这里会把“账号级配置”和“根级默认配置”合并成最终结果。
 */
function normalizeAccount(
  accountId: string,
  raw: Record<string, unknown>,
  root: Record<string, unknown>,
): OpenBridgeAccountConfig {
  const baseUrl = readString(raw.baseUrl) ?? readString(root.baseUrl) ?? "";
  return {
    accountId,
    enabled: readBoolean(raw.enabled, readBoolean(root.enabled, Boolean(baseUrl))),
    baseUrl,
    websocketUrl: resolveWebSocketUrl(
      baseUrl || "http://localhost",
      readString(raw.websocketUrl) ?? readString(root.websocketUrl),
    ),
    clientId: readString(raw.clientId) ?? readString(root.clientId) ?? accountId,
    token: readString(raw.token) ?? readString(root.token),
    clientSecret: readString(raw.clientSecret) ?? readString(root.clientSecret),
    defaultTo: readString(raw.defaultTo) ?? readString(root.defaultTo),
    // 当账号级 allowlist 存在时，优先覆盖根级别 allowlist。
    allowFrom: readStringList(raw.allowFrom).length ? readStringList(raw.allowFrom) : readStringList(root.allowFrom),
    dmPolicy:
      readString(raw.dmPolicy) === "open" || readString(root.dmPolicy) === "open"
        ? "open"
        : "allowlist",
    reconnectMinMs: Math.max(250, readNumber(raw.reconnectMinMs, readNumber(root.reconnectMinMs, 1000))),
    reconnectMaxMs: Math.max(1000, readNumber(raw.reconnectMaxMs, readNumber(root.reconnectMaxMs, 30000))),
    heartbeatMs: Math.max(5000, readNumber(raw.heartbeatMs, readNumber(root.heartbeatMs, 25000))),
    connectTimeoutMs: Math.max(1000, readNumber(raw.connectTimeoutMs, readNumber(root.connectTimeoutMs, 15000))),
    ackTimeoutMs: Math.max(1000, readNumber(raw.ackTimeoutMs, readNumber(root.ackTimeoutMs, 10000))),
    dispatchTimeoutMs: Math.max(5000, readNumber(raw.dispatchTimeoutMs, readNumber(root.dispatchTimeoutMs, 60000))),
    demoEchoReply: readBoolean(raw.demoEchoReply, readBoolean(root.demoEchoReply, false)),
    replyOverWebSocket: readBoolean(
      raw.replyOverWebSocket,
      readBoolean(root.replyOverWebSocket, false),
    ),
    stateDir: readString(raw.stateDir) ?? readString(root.stateDir) ?? defaultStateDir(accountId),
  };
}

/**
 * 列出所有可用账号 id。
 *
 * 多账号模式返回排序后的账号列表；单账号模式则回退到 `default`。
 */
export function listOpenBridgeAccountIds(cfg: OpenClawConfig): string[] {
  const root = readOpenBridgeRoot(cfg);
  const accounts = asRecord(root.accounts);
  const ids = Object.keys(accounts).filter((id) => id.trim());
  const resolved = ids.length ? ids.sort() : [DEFAULT_ACCOUNT_ID];
  logConfigProbe(
    `list accounts rootEnabled=${String(root.enabled)} accountKeys=${Object.keys(accounts).join(",") || "(none)"} resolved=${resolved.join(",")}`,
  );
  return resolved;
}

/**
 * 解析某个账号的最终运行时配置。
 *
 * 这是插件最常用的配置入口。其他模块不需要知道原始配置长什么样，
 * 只需要拿到这里返回的 `SpringImAccountConfig` 即可。
 */
export function resolveOpenBridgeAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): OpenBridgeAccountConfig {
  const root = readOpenBridgeRoot(cfg);
  // 回退到第一个可用账号，这样 OpenClaw 可以像处理普通 channel 一样处理它。
  const id = accountId?.trim() || listOpenBridgeAccountIds(cfg)[0] || DEFAULT_ACCOUNT_ID;
  const accountRaw = asRecord(asRecord(root.accounts)[id]);
  const account = normalizeAccount(id, accountRaw, root);
  logConfigProbe(
    `resolve account requested=${accountId?.trim() || "(default)"} resolved=${account.accountId} enabled=${account.enabled} configured=${Boolean(account.baseUrl && account.clientId && account.token)} clientId=${account.clientId} baseUrl=${account.baseUrl || "(missing)"} token=${account.token ? "set" : "missing"} stateDir=${account.stateDir}`,
  );
  return account;
}

/** 判断当前配置里是否已经存在至少一个可用账号。 */
export function hasOpenBridgeConfiguredState(cfg: OpenClawConfig): boolean {
  const configured = listOpenBridgeAccountIds(cfg).some((id) => {
    const account = resolveOpenBridgeAccount(cfg, id);
    return Boolean(account.baseUrl && account.clientId && account.token);
  });
  logConfigProbe(`has configured state=${configured}`);
  return configured;
}
