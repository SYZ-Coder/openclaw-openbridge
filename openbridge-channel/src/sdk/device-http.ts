/**
 * 设备注册与重绑相关的 HTTP 调用。
 *
 * 插件仍使用配置里的 clientId/token 作为基础身份；设备注册接口负责把长期 device identity
 * 绑定到当前客户端，供云端区分多设备、设备移交和凭证吊销场景。
 */
import { createRequestId, signBody } from "./signing.js";
import type { SpringImAccountConfig } from "./types.js";
import type { SpringImDeviceIdentity } from "./device-identity.js";
import type { SpringImLogger } from "./types.js";

type DeviceRegisterResponse = {
  deviceId: string;
  clientId: string;
  token?: string;
  clientSecret?: string;
  ownerUserId?: string;
};

type BridgeHealthResponse = {
  status?: string;
};

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function previewText(value: string, maxLength = 200): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function describeError(error: Error): string {
  const details: string[] = [error.message];
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    if (typeof causeRecord.code === "string") {
      details.push(`code=${causeRecord.code}`);
    }
    if (typeof causeRecord.errno === "number") {
      details.push(`errno=${causeRecord.errno}`);
    }
    if (typeof causeRecord.address === "string") {
      details.push(`address=${causeRecord.address}`);
    }
    if (typeof causeRecord.port === "number") {
      details.push(`port=${causeRecord.port}`);
    }
  }
  return details.join(" ");
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (!signal) {
      return;
    }
    const abortHandler = () => {
      clearTimeout(timeout);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    if (signal.aborted) {
      abortHandler();
      return;
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

export async function waitForBridgeReady(params: {
  account: SpringImAccountConfig;
  signal?: AbortSignal;
  logger?: SpringImLogger;
}): Promise<void> {
  const url = joinUrl(params.account.baseUrl, "/api/openclaw/health");
  let attempt = 0;
  while (!params.signal?.aborted) {
    attempt += 1;
    try {
      const timeoutSignal = AbortSignal.timeout(3_000);
      const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(url, { method: "GET", signal });
      if (response.ok) {
        const payload = (await response.json().catch(() => ({}))) as BridgeHealthResponse;
        params.logger?.info(
          `openbridge[${params.account.accountId}]: bridge ready check success attempt=${attempt} url=${url} status=${payload.status ?? response.status}`,
        );
        return;
      }
      params.logger?.warn(
        `openbridge[${params.account.accountId}]: bridge ready check failed attempt=${attempt} url=${url} http=${response.status}`,
      );
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      params.logger?.warn(
        `openbridge[${params.account.accountId}]: bridge ready check failed attempt=${attempt} url=${url} error=${describeError(wrapped)}`,
      );
    }
    await sleep(Math.min(1000 * attempt, 5000), params.signal);
  }
  throw params.signal?.reason instanceof Error ? params.signal.reason : new Error("bridge ready check aborted");
}

export async function registerDevice(params: {
  account: SpringImAccountConfig;
  identity: SpringImDeviceIdentity;
  signal?: AbortSignal;
  logger?: SpringImLogger;
}): Promise<DeviceRegisterResponse> {
  const requestId = createRequestId();
  const timestamp = Date.now();
  const url = joinUrl(params.account.baseUrl, "/api/openclaw/devices/register");
  const body = JSON.stringify({
    deviceId: params.identity.deviceId,
    installId: params.identity.installId,
    deviceName: params.identity.deviceId,
    publicKeyPem: params.identity.publicKeyPem,
  });
  const signature = signBody({
    body,
    secret: params.account.clientSecret,
    timestamp,
    requestId,
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-openclaw-client-id": params.account.clientId,
    "x-openclaw-device-id": params.identity.deviceId,
    "x-openclaw-request-id": requestId,
    "x-openclaw-timestamp": String(timestamp),
  };
  if (params.account.token) {
    headers.authorization = `Bearer ${params.account.token}`;
  }
  if (signature) {
    headers["x-openclaw-signature"] = signature;
  }
  const maxAttempts = 3;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    params.logger?.info(
      `openbridge[${params.account.accountId}]: device register attempt=${attempt}/${maxAttempts} url=${url} clientId=${params.account.clientId} deviceId=${params.identity.deviceId} requestId=${requestId}`,
    );
    try {
      const timeoutSignal = AbortSignal.timeout(10_000);
      const signal = params.signal ? AbortSignal.any([params.signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal,
      });
      if (!response.ok) {
        const responseText = await response.text().catch(() => "");
        throw new Error(
          `device register failed: HTTP ${response.status} ${response.statusText}${responseText ? ` body=${previewText(responseText)}` : ""}`,
        );
      }
      const payload = (await response.json()) as DeviceRegisterResponse;
      params.logger?.info(
        `openbridge[${params.account.accountId}]: device register success clientId=${payload.clientId} deviceId=${payload.deviceId} ownerUserId=${payload.ownerUserId ?? ""} attempt=${attempt}/${maxAttempts}`,
      );
      return payload;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      params.logger?.warn(
        `openbridge[${params.account.accountId}]: device register attempt failed attempt=${attempt}/${maxAttempts} url=${url} error=${describeError(error)}`,
      );
      if (attempt >= maxAttempts || params.signal?.aborted) {
        break;
      }
      await sleep(attempt * 1000, params.signal);
    }
  }

  throw lastError ?? new Error("device register failed");
}
