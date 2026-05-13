import {
  getManagedOpenBridgeRuntimeAccountIds,
  getManagedOpenBridgeRuntimeCount,
  startManagedOpenBridgeAccount,
  stopManagedOpenBridgeAccounts,
} from "./account-runtime.js";
import { listOpenBridgeAccountIds, resolveOpenBridgeAccount } from "./config.js";
import type { OpenBridgeAccountConfig } from "./sdk/index.js";

const connectedAccounts = new Map<string, OpenBridgeAccountConfig>();
let startPromise: Promise<void> | null = null;

export function getConnectedClient(accountId?: string): OpenBridgeAccountConfig | null {
  if (accountId && connectedAccounts.has(accountId)) {
    return connectedAccounts.get(accountId) ?? null;
  }
  if (connectedAccounts.has("default")) {
    return connectedAccounts.get("default") ?? null;
  }
  const first = connectedAccounts.values().next();
  return first.done ? null : first.value;
}

export function connectedClientCount(): number {
  return connectedAccounts.size;
}

export async function startAccountClient(api: any, account: OpenBridgeAccountConfig): Promise<void> {
  if (!account.enabled || !account.baseUrl || !account.clientId || !account.token) {
    api.logger?.warn?.(
      `[openbridge] skip account ${account.accountId}: enabled=${account.enabled} configured=${Boolean(account.baseUrl && account.clientId && account.token)}`,
    );
    return;
  }
  await startManagedOpenBridgeAccount({
    account,
    cfg: (api?.config ?? {}) as Record<string, unknown>,
    log: api.logger,
  });
  connectedAccounts.set(account.accountId, account);
  api.logger?.info?.(`[openbridge] account ${account.accountId} connected`);
}

export async function startAllAccountClients(api: any): Promise<void> {
  if (startPromise) {
    api.logger?.info?.("[openbridge] service start reuse existing startup task");
    return startPromise;
  }
  startPromise = (async () => {
  const cfg = (api?.config ?? {}) as Record<string, unknown>;
  const accountIds = listOpenBridgeAccountIds(cfg);
  for (const accountId of accountIds) {
    const account = resolveOpenBridgeAccount(cfg, accountId);
    await startAccountClient(api, account);
  }
  api.logger?.info?.(
    `[openbridge] service started with ${connectedClientCount()}/${accountIds.length} connected accounts; managed=${getManagedOpenBridgeRuntimeCount()} accounts=${getManagedOpenBridgeRuntimeAccountIds().join(",") || "(none)"}`,
  );
  })().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

export async function stopAllClients(api: any): Promise<void> {
  startPromise = null;
  connectedAccounts.clear();
  await stopManagedOpenBridgeAccounts(api?.logger);
  api?.logger?.info?.("[openbridge] service stopped");
}

export function ensureAllAccountClientsStarted(api: any, reason: string): void {
  void startAllAccountClients(api)
    .then(() => {
      api.logger?.info?.(`[openbridge] ensure start complete reason=${reason}`);
    })
    .catch((error: unknown) => {
      api.logger?.error?.(
        `[openbridge] ensure start failed reason=${reason} error=${String(error)}`,
      );
    });
}
