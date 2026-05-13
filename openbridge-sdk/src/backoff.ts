/**
 * 重连退避辅助函数。
 *
 * 这个文件集中维护在线客户端循环和 reply outbox 重试共用的延迟计算逻辑，
 * 让两条路径遵循同一套退避模型。
 */
export function computeReconnectDelayMs(params: {
  attempt: number;
  minMs: number;
  maxMs: number;
}): number {
  // 给指数增长设置上限，避免重试等待时间无限膨胀。
  const exponent = Math.min(params.attempt, 8);
  const base = params.minMs * 2 ** exponent;
  // 加一点随机抖动，避免多个客户端在同一时刻一起重连。
  const jitter = Math.floor(Math.random() * params.minMs);
  return Math.min(params.maxMs, base + jitter);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}



