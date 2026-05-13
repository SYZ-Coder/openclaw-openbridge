import { describe, it, expect } from "vitest";
import { computeReconnectDelayMs, sleep } from "./backoff.js";

describe("computeReconnectDelayMs", () => {
  it("returns minMs for attempt 0", () => {
    const result = computeReconnectDelayMs({ attempt: 0, minMs: 1000, maxMs: 60000 });
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThanOrEqual(2000); // minMs + jitter (max jitter = minMs)
  });

  it("exponentially increases delay with attempt", () => {
    const minMs = 1000;
    const maxMs = 60000;
    const attempt0 = computeReconnectDelayMs({ attempt: 0, minMs, maxMs });
    const attempt1 = computeReconnectDelayMs({ attempt: 1, minMs, maxMs });
    const attempt2 = computeReconnectDelayMs({ attempt: 2, minMs, maxMs });

    expect(attempt1).toBeGreaterThanOrEqual(attempt0);
    expect(attempt2).toBeGreaterThanOrEqual(attempt1);
  });

  it("caps exponent at 8 to prevent infinite growth", () => {
    const minMs = 1000;
    const maxMs = 60000;
    const attempt8 = computeReconnectDelayMs({ attempt: 8, minMs, maxMs });
    const attempt10 = computeReconnectDelayMs({ attempt: 10, minMs, maxMs });
    const attempt100 = computeReconnectDelayMs({ attempt: 100, minMs, maxMs });

    // All should be similar since exponent is capped at 8
    expect(attempt10).toBeGreaterThanOrEqual(attempt8);
    expect(attempt100).toBeGreaterThanOrEqual(attempt8);
    expect(attempt100 - attempt8).toBeLessThan(minMs * 2); // Only jitter difference
  });

  it("respects maxMs limit", () => {
    const result = computeReconnectDelayMs({ attempt: 100, minMs: 1000, maxMs: 5000 });
    expect(result).toBeLessThanOrEqual(5000);
  });

  it("includes jitter to avoid synchronized retries", () => {
    const minMs = 1000;
    const maxMs = 60000;
    const results = new Set<number>();

    // Run multiple times to detect jitter
    for (let i = 0; i < 10; i++) {
      results.add(computeReconnectDelayMs({ attempt: 1, minMs, maxMs }));
    }

    // Should have some variation due to jitter
    expect(results.size).toBeGreaterThan(1);
  });

  it("handles edge case: minMs equals maxMs", () => {
    const result = computeReconnectDelayMs({ attempt: 5, minMs: 1000, maxMs: 1000 });
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThanOrEqual(2000); // minMs + jitter
  });
});

describe("sleep", () => {
  it("resolves after specified milliseconds", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some variance
    expect(elapsed).toBeLessThan(200);
  });

  it("resolves immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await sleep(1000, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it("can be aborted during sleep", async () => {
    const controller = new AbortController();
    const start = Date.now();

    // Abort after 30ms
    setTimeout(() => controller.abort(), 30);

    await sleep(1000, controller.signal);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("resolves without signal parameter", async () => {
    const start = Date.now();
    await sleep(30);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });
});