/**
 * SQLite-based local state store for OpenBridge SDK.
 *
 * Uses better-sqlite3 for reliable persistence.
 * Provides dedup tracking, sequence tracking, runtime state, and device identity.
 */
import { randomUUID, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  SpringImCloudMessage,
  SpringImRuntimePhase,
} from "./types.js";

/**
 * Device identity record for local OpenClaw instance.
 */
export type SpringImDeviceIdentity = {
  deviceId: string;
  installId: string;
  clientId?: string;
  ownerUserId?: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * Create a new device identity with Ed25519 key pair.
 */
export function createDeviceIdentity(): SpringImDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    deviceId: `dev-${randomUUID()}`,
    installId: `inst-${randomUUID()}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/**
 * Build signing string for hello message.
 */
export function buildHelloSigningString(input: {
  deviceId: string;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
}): string {
  return [
    input.deviceId,
    input.clientId,
    input.accountId,
    String(input.timestamp),
    input.nonce,
  ].join(".");
}

/**
 * Sign hello message using device private key.
 */
export function signHello(input: {
  identity: SpringImDeviceIdentity;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
}): string {
  const payload = buildHelloSigningString({
    deviceId: input.identity.deviceId,
    clientId: input.clientId,
    accountId: input.accountId,
    timestamp: input.timestamp,
    nonce: input.nonce,
  });
  return sign(null, Buffer.from(payload, "utf8"), input.identity.privateKeyPem).toString("base64");
}

/**
 * Verify hello signature using public key.
 */
export function verifyHelloSignature(input: {
  publicKeyPem: string;
  deviceId: string;
  clientId: string;
  accountId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}): boolean {
  const payload = buildHelloSigningString(input);
  return verify(
    null,
    Buffer.from(payload, "utf8"),
    input.publicKeyPem,
    Buffer.from(input.signature, "base64"),
  );
}

const DEDUP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_QUEUED_MESSAGES = 20;
const MAX_FAILED_MESSAGES = 50;

/**
 * Schema for the SQLite state database.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS state_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_identity (
    device_id TEXT PRIMARY KEY,
    install_id TEXT NOT NULL,
    client_id TEXT,
    owner_user_id TEXT,
    public_key_pem TEXT NOT NULL,
    private_key_pem TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS dedup (
    event_id TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    event_id TEXT PRIMARY KEY,
    sequence INTEGER,
    client_id TEXT,
    conversation_id TEXT,
    conversation_type TEXT,
    sender_id TEXT,
    sender_name TEXT,
    text TEXT,
    media_json TEXT,
    status TEXT,
    reply_to_id TEXT,
    thread_id TEXT,
    timestamp INTEGER,
    received_at INTEGER,
    dispatch_status TEXT,
    last_error TEXT
);

CREATE TABLE IF NOT EXISTS runtime (
    phase TEXT NOT NULL,
    reason TEXT,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_meta (
    batches INTEGER NOT NULL DEFAULT 0,
    last_batch_size INTEGER NOT NULL DEFAULT 0,
    last_synced_at INTEGER,
    last_gap_expected INTEGER,
    last_gap_actual INTEGER,
    last_gap_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_dedup_seen_at ON dedup(seen_at);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(dispatch_status);
CREATE INDEX IF NOT EXISTS idx_messages_received_at ON messages(received_at);

INSERT OR IGNORE INTO state_meta (key, value) VALUES ('lastSequence', '0');
INSERT OR IGNORE INTO runtime (phase, reason, updated_at) VALUES ('idle', NULL, strftime('%s','now') * 1000);
INSERT OR IGNORE INTO sync_meta (batches, last_batch_size) VALUES (0, 0);
`;

/**
 * SQLite-based state store for OpenBridge SDK.
 *
 * Replaces JSON file storage with SQLite for better reliability and concurrency.
 */
export class SpringImStateStore {
  private db: Database.Database | null = null;
  private filePath: string;
  private mutationChain = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  static resolvePath(params: { stateDir?: string; accountId: string }): string {
    const base = params.stateDir?.trim() || joinPaths(process.cwd(), ".openclaw-openbridge");
    return joinPaths(base, `${params.accountId}.state.db`);
  }

  async load(): Promise<void> {
    if (this.db) {
      return;
    }

    await mkdir(dirname(this.filePath), { recursive: true });

    this.db = new Database(this.filePath);

    // Enable WAL mode for better concurrency
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 30000");

    // Initialize schema
    this.db.exec(SCHEMA_SQL);

    // Clean up old entries
    this.pruneDedup();
    this.pruneMessages();
  }

  private pruneDedup(): void {
    if (!this.db) return;
    const cutoff = Date.now() - DEDUP_TTL_MS;
    this.db.exec(`DELETE FROM dedup WHERE seen_at < ${cutoff}`);
  }

  private pruneMessages(): void {
    if (!this.db) return;

    // Get queued messages to retain
    const queuedStmt = this.db.prepare(`
      SELECT event_id FROM messages WHERE dispatch_status = 'queued'
      ORDER BY sequence DESC, received_at DESC LIMIT ?
    `);
    const queued = queuedStmt.all(MAX_QUEUED_MESSAGES) as { event_id: string }[];

    // Get failed messages to retain
    const failedStmt = this.db.prepare(`
      SELECT event_id FROM messages WHERE dispatch_status = 'failed'
      ORDER BY received_at DESC LIMIT ?
    `);
    const failed = failedStmt.all(MAX_FAILED_MESSAGES) as { event_id: string }[];

    const retained = new Set([
      ...queued.map(r => r.event_id),
      ...failed.map(r => r.event_id),
    ]);

    // Delete non-retained messages
    if (retained.size > 0) {
      const deleteStmt = this.db.prepare(
        `DELETE FROM messages WHERE event_id NOT IN (${Array.from(retained).map(() => '?').join(',')})`
      );
      deleteStmt.run(...Array.from(retained));
    }
  }

  async hasSeen(eventId: string): Promise<boolean> {
    await this.load();
    const stmt = this.db!.prepare("SELECT 1 FROM dedup WHERE event_id = ?");
    const result = stmt.get(eventId);
    return result !== undefined;
  }

  async markSeen(eventId: string): Promise<void> {
    await this.withMutation(() => {
      const stmt = this.db!.prepare(
        "INSERT OR REPLACE INTO dedup (event_id, seen_at) VALUES (?, ?)"
      );
      stmt.run(eventId, Date.now());
    });
  }

  async getLastSequence(): Promise<number | undefined> {
    await this.load();
    const stmt = this.db!.prepare(
      "SELECT value FROM state_meta WHERE key = 'lastSequence'"
    );
    const result = stmt.get() as { value: string } | undefined;
    if (result) {
      const seq = parseInt(result.value, 10);
      return seq > 0 ? seq : undefined;
    }
    return undefined;
  }

  async advanceCheckpoint(input: { sequence?: number }): Promise<void> {
    if (typeof input.sequence !== "number") return;
    await this.withMutation(() => {
      const stmt = this.db!.prepare(`
        UPDATE state_meta SET value = ?
        WHERE key = 'lastSequence' AND CAST(value AS INTEGER) < ?
      `);
      stmt.run(String(input.sequence), input.sequence);
    });
  }

  async finalizeProcessedMessage(input: {
    eventId: string;
    sequence?: number;
  }): Promise<void> {
    await this.withMutation(() => {
      const dedupStmt = this.db!.prepare(
        "INSERT OR REPLACE INTO dedup (event_id, seen_at) VALUES (?, ?)"
      );
      dedupStmt.run(input.eventId, Date.now());

      const msgStmt = this.db!.prepare(`
        UPDATE messages SET dispatch_status = 'processed', last_error = NULL
        WHERE event_id = ?
      `);
      msgStmt.run(input.eventId);

      if (typeof input.sequence === "number") {
        const seqStmt = this.db!.prepare(`
          UPDATE state_meta SET value = ?
          WHERE key = 'lastSequence' AND CAST(value AS INTEGER) < ?
        `);
        seqStmt.run(String(input.sequence), input.sequence);
      }
    });
  }

  async noteSequenceGap(input: { expected: number; actual: number }): Promise<void> {
    await this.withMutation(() => {
      const stmt = this.db!.prepare(`
        UPDATE sync_meta SET
          last_gap_expected = ?,
          last_gap_actual = ?,
          last_gap_at = ?
      `);
      stmt.run(input.expected, input.actual, Date.now());
    });
  }

  async setRuntimePhase(phase: SpringImRuntimePhase, reason?: string): Promise<void> {
    await this.withMutation(() => {
      const stmt = this.db!.prepare(`
        UPDATE runtime SET phase = ?, reason = ?, updated_at = ?
      `);
      stmt.run(phase, reason ?? null, Date.now());
    });
  }

  async recordInboundBatch(messages: SpringImCloudMessage[]): Promise<void> {
    await this.withMutation(() => {
      const insertStmt = this.db!.prepare(`
        INSERT OR REPLACE INTO messages (
          event_id, sequence, conversation_id, conversation_type,
          sender_id, sender_name, text, media_json,
          reply_to_id, thread_id, timestamp, received_at, dispatch_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued')
      `);

      for (const msg of messages) {
        insertStmt.run(
          msg.eventId,
          msg.sequence ?? null,
          msg.conversationId,
          msg.conversationType,
          msg.senderId,
          msg.senderName ?? null,
          msg.text ?? null,
          msg.media ? JSON.stringify(msg.media) : null,
          msg.replyToId ?? null,
          msg.threadId ?? null,
          msg.timestamp ?? null,
          Date.now()
        );
      }

      const syncStmt = this.db!.prepare(`
        UPDATE sync_meta SET
          batches = batches + 1,
          last_batch_size = ?,
          last_synced_at = ?
      `);
      syncStmt.run(messages.length, Date.now());
    });
  }

  async getOutboxSize(): Promise<number> {
    await this.load();
    const stmt = this.db!.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE dispatch_status = 'queued'"
    );
    const result = stmt.get() as { count: number };
    return result?.count ?? 0;
  }

  async getDeadLetterSize(): Promise<number> {
    await this.load();
    const stmt = this.db!.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE dispatch_status = 'failed'"
    );
    const result = stmt.get() as { count: number };
    return result?.count ?? 0;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ============================================================
  // Device Identity Methods
  // ============================================================

  /**
   * Load device identity from database.
   */
  async loadDeviceIdentity(): Promise<SpringImDeviceIdentity | undefined> {
    await this.load();
    const stmt = this.db!.prepare("SELECT * FROM device_identity LIMIT 1");
    const row = stmt.get() as {
      device_id: string;
      install_id: string;
      client_id: string | null;
      owner_user_id: string | null;
      public_key_pem: string;
      private_key_pem: string;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (row) {
      return {
        deviceId: row.device_id,
        installId: row.install_id,
        clientId: row.client_id ?? undefined,
        ownerUserId: row.owner_user_id ?? undefined,
        publicKeyPem: row.public_key_pem,
        privateKeyPem: row.private_key_pem,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }
    return undefined;
  }

  /**
   * Save device identity to database.
   */
  async saveDeviceIdentity(identity: SpringImDeviceIdentity): Promise<void> {
    await this.withMutation(() => {
      const stmt = this.db!.prepare(`
        INSERT OR REPLACE INTO device_identity (
          device_id, install_id, client_id, owner_user_id,
          public_key_pem, private_key_pem, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        identity.deviceId,
        identity.installId,
        identity.clientId ?? null,
        identity.ownerUserId ?? null,
        identity.publicKeyPem,
        identity.privateKeyPem,
        identity.createdAt,
        Date.now()
      );
    });
  }

  /**
   * Create and save a new device identity.
   */
  async ensureDeviceIdentity(): Promise<SpringImDeviceIdentity> {
    const existing = await this.loadDeviceIdentity();
    if (existing) {
      return existing;
    }
    const created = createDeviceIdentity();
    await this.saveDeviceIdentity(created);
    return created;
  }

  /**
   * Update client binding for device identity.
   */
  async updateDeviceClientBinding(input: {
    clientId: string;
    ownerUserId?: string;
  }): Promise<SpringImDeviceIdentity> {
    const identity = await this.ensureDeviceIdentity();
    identity.clientId = input.clientId;
    identity.ownerUserId = input.ownerUserId;
    await this.saveDeviceIdentity(identity);
    return identity;
  }

  private async withMutation<T>(mutate: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      await this.load();
      return mutate();
    };

    const pending = this.mutationChain.then(run, run);
    this.mutationChain = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }
}

function joinPaths(...parts: string[]): string {
  return parts.join("/").replace(/\\/g, "/");
}