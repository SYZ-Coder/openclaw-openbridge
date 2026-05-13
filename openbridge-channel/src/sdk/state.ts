/**
 * 本地最小状态存储。
 *
 * 这里仅保存短 TTL 去重记录和运行状态，消息恢复与重投递由云服务负责。
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SpringImRuntimePhase, SpringImState } from "./types.js";

const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const SAVE_RETRYABLE_ERROR_CODES = new Set(["EPERM", "EBUSY", "EMFILE", "ENFILE"]);
const SAVE_MAX_ATTEMPTS = 5;
const FS_OP_TIMEOUT_MS = 5_000;
const TMP_CLEANUP_AGE_MS = 60 * 60 * 1000;

function isRetryableSaveError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as NodeJS.ErrnoException).code === "string" &&
      SAVE_RETRYABLE_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? ""),
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function withFsTimeout<T>(label: string, op: () => Promise<T>, ms: number = FS_OP_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function emptyState(): SpringImState {
  return {
    dedup: {},
    runtime: { phase: "idle", updatedAt: Date.now() },
    updatedAt: Date.now(),
  };
}

function normalizeNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") {
    return {};
  }
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
    }
  }
  return result;
}

function normalizeState(raw: unknown): SpringImState {
  if (!raw || typeof raw !== "object") {
    return emptyState();
  }
  const record = raw as Record<string, unknown>;
  return {
    dedup: normalizeNumberMap(record.dedup),
    runtime:
      record.runtime && typeof record.runtime === "object"
        ? (record.runtime as SpringImState["runtime"])
        : { phase: "idle", updatedAt: Date.now() },
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now(),
  };
}

export class SpringImStateStore {
  private state: SpringImState | undefined;
  private mutationChain = Promise.resolve();

  constructor(private readonly filePath: string) {}

  static resolvePath(params: { stateDir?: string; accountId: string }): string {
    const base = params.stateDir?.trim() || join(process.cwd(), ".openclaw-openbridge");
    return join(base, `${params.accountId}.state.json`);
  }

  async load(): Promise<SpringImState> {
    if (this.state) {
      return this.state;
    }
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(raw));
    } catch {
      this.state = emptyState();
    }
    this.pruneDedup();
    void this.cleanupStaleTempFiles();
    return this.state;
  }

  async save(): Promise<void> {
    await this.withMutation(() => undefined);
  }

  async hasSeen(eventId: string): Promise<boolean> {
    const state = await this.load();
    return Boolean(state.dedup[eventId]);
  }

  async markSeen(eventId: string): Promise<void> {
    await this.withMutation((state) => {
      state.dedup[eventId] = Date.now();
    });
  }

  async setRuntimePhase(phase: SpringImRuntimePhase, reason?: string): Promise<void> {
    await this.withMutation((state) => {
      state.runtime = { phase, reason, updatedAt: Date.now() };
    });
  }

  private async withMutation<T>(mutate: (state: SpringImState) => Promise<T> | T): Promise<T> {
    const run = async (): Promise<T> => {
      const state = await this.load();
      const result = await mutate(state);
      this.pruneDedup();
      await this.persistLoadedState();
      return result;
    };
    const pending = this.mutationChain.then(run, run);
    this.mutationChain = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async persistLoadedState(): Promise<void> {
    const state = await this.load();
    state.updatedAt = Date.now();
    await mkdir(dirname(this.filePath), { recursive: true });
    const serialized = JSON.stringify(state, null, 2);

    for (let attempt = 1; attempt <= SAVE_MAX_ATTEMPTS; attempt += 1) {
      const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
      try {
        await withFsTimeout(`writeFile ${tmpPath}`, () => writeFile(tmpPath, serialized, "utf8"));
        await withFsTimeout(`rename ${tmpPath}`, () => rename(tmpPath, this.filePath));
        return;
      } catch (error) {
        if (isRetryableSaveError(error) && attempt < SAVE_MAX_ATTEMPTS) {
          await sleep(attempt * 25);
          continue;
        }
        try {
          await withFsTimeout(`unlink ${tmpPath}`, () => unlink(tmpPath));
        } catch {
          /* best-effort */
        }
        throw error;
      }
    }
  }

  private pruneDedup(): void {
    if (!this.state) {
      return;
    }
    const now = Date.now();
    for (const [eventId, seenAt] of Object.entries(this.state.dedup)) {
      if (now - seenAt > DEDUP_TTL_MS) {
        delete this.state.dedup[eventId];
      }
    }
  }

  private async cleanupStaleTempFiles(): Promise<void> {
    try {
      const dir = dirname(this.filePath);
      const baseName = this.filePath.substring(dir.length + 1);
      const entries = await readdir(dir);
      const cutoff = Date.now() - TMP_CLEANUP_AGE_MS;
      const candidates = entries.filter((name) => name.startsWith(`${baseName}.`) && name.endsWith(".tmp"));
      for (const name of candidates) {
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < cutoff) {
            await unlink(path);
          }
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* best-effort */
    }
  }
}
