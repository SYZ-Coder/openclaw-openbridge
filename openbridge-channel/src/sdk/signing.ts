/**
 * 请求签名辅助函数。
 *
 * 插件可以按需对 HTTP body 做签名，让 Spring Boot bridge 在传输层之外
 * 也能校验重放或重试请求。
 */
import { createHmac, randomUUID } from "node:crypto";

export function createRequestId(): string {
  return randomUUID();
}

export function signBody(params: {
  body: string;
  secret?: string;
  timestamp: number;
  requestId: string;
}): string | undefined {
  if (!params.secret) {
    return undefined;
  }
  return createHmac("sha256", params.secret)
    .update(`${params.timestamp}.${params.requestId}.${params.body}`)
    .digest("hex");
}

