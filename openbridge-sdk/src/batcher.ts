import type { SpringImCloudMessage, SpringImLogger } from "./types.js";

export class SpringImMessageBatcher {
  private queue: SpringImCloudMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private draining = false;

  constructor(
    private readonly options: {
      maxBatchSize: number;
      maxDelayMs: number;
      logger: SpringImLogger;
      flush: (batch: SpringImCloudMessage[]) => Promise<void>;
    },
  ) {}

  push(message: SpringImCloudMessage): void {
    this.queue.push(message);
    if (this.queue.length >= this.options.maxBatchSize) {
      void this.flushNow();
      return;
    }
    this.timer ??= setTimeout(() => void this.flushNow(), this.options.maxDelayMs);
  }

  async flushNow(): Promise<void> {
    if (this.draining) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.queue.splice(0, this.options.maxBatchSize);
    if (!batch.length) {
      return;
    }
    this.draining = true;
    try {
      await this.options.flush(batch);
    } catch (err) {
      this.options.logger.error(`openbridge: message batch flush failed: ${String(err)}`);
      throw err;
    } finally {
      this.draining = false;
      if (this.queue.length) {
        void this.flushNow();
      }
    }
  }
}
