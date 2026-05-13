-- OpenClaw OpenBridge SQLite Schema
-- Version: 1.0.0

-- ============================================
-- 消息事件表 (对应 ImEvent)
-- ============================================
CREATE TABLE IF NOT EXISTS im_events (
    id                  BIGINT PRIMARY KEY,
    event_id            TEXT NOT NULL UNIQUE,
    client_id           TEXT NOT NULL,
    conversation_id     TEXT NOT NULL,
    conversation_type   TEXT NOT NULL DEFAULT 'direct',
    sender_id           TEXT NOT NULL,
    sender_name         TEXT,
    text                TEXT,
    media_json          TEXT,          -- JSON array of MediaItem
    status              TEXT NOT NULL DEFAULT 'pending',
    last_error          TEXT,
    created_at          BIGINT NOT NULL,  -- epoch milliseconds
    updated_at          BIGINT NOT NULL,
    processed_at        BIGINT,
    delivery_session_id TEXT,
    delivery_lease_until BIGINT,
    metadata_json       TEXT           -- JSON map
);

CREATE INDEX IF NOT EXISTS idx_events_client_id ON im_events(client_id);
CREATE INDEX IF NOT EXISTS idx_events_conversation_id ON im_events(conversation_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON im_events(status);
CREATE INDEX IF NOT EXISTS idx_events_delivery_lease ON im_events(delivery_lease_until);

-- ============================================
-- 回复表 (对应 OpenClawReply)
-- ============================================
CREATE TABLE IF NOT EXISTS replies (
    local_id            TEXT PRIMARY KEY,
    event_id            TEXT,
    conversation_id     TEXT NOT NULL,
    conversation_type   TEXT NOT NULL DEFAULT 'direct',
    text                TEXT,
    media_json          TEXT,
    reply_to_id         TEXT,
    thread_id           TEXT,
    created_at          BIGINT NOT NULL,
    received_at         BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_replies_conversation_id ON replies(conversation_id);
CREATE INDEX IF NOT EXISTS idx_replies_event_id ON replies(event_id);

-- ============================================
-- Nonce 存储 (防重放攻击)
-- ============================================
CREATE TABLE IF NOT EXISTS nonces (
    nonce               TEXT PRIMARY KEY,
    created_at          BIGINT NOT NULL
);

-- ============================================
-- 设备注册表
-- ============================================
CREATE TABLE IF NOT EXISTS devices (
    device_id           TEXT PRIMARY KEY,
    install_id          TEXT NOT NULL,
    device_name         TEXT,
    public_key_pem      TEXT NOT NULL,
    fingerprint         TEXT,
    first_seen_at       BIGINT NOT NULL,
    last_seen_at        BIGINT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE INDEX IF NOT EXISTS idx_devices_install_id ON devices(install_id);

-- ============================================
-- 客户端注册表 (动态注册的客户端)
-- ============================================
CREATE TABLE IF NOT EXISTS clients (
    client_id           TEXT PRIMARY KEY,
    device_id           TEXT NOT NULL,
    owner_user_id       TEXT NOT NULL,
    token               TEXT NOT NULL,
    client_secret       TEXT,
    issued_at           BIGINT NOT NULL,
    revoked_at          BIGINT,
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE INDEX IF NOT EXISTS idx_clients_device_id ON clients(device_id);

-- ============================================
-- 设备-用户绑定表
-- ============================================
CREATE TABLE IF NOT EXISTS device_owner_bindings (
    device_id           TEXT PRIMARY KEY,
    owner_user_id       TEXT NOT NULL,
    bound_at            BIGINT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
);

-- ============================================
-- 设备移交审计表
-- ============================================
CREATE TABLE IF NOT EXISTS device_transfer_audits (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id           TEXT NOT NULL,
    from_user_id        TEXT,
    to_user_id          TEXT NOT NULL,
    from_client_id      TEXT,
    to_client_id        TEXT NOT NULL,
    reason              TEXT,
    actor               TEXT,
    created_at          BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transfer_audits_device ON device_transfer_audits(device_id);

-- ============================================
-- 会话绑定表 (多实例协调)
-- ============================================
CREATE TABLE IF NOT EXISTS session_bindings (
    client_id           TEXT PRIMARY KEY,
    instance_id         TEXT NOT NULL,      -- 应用实例标识
    session_id          TEXT NOT NULL,      -- WebSocket session ID
    bound_at            BIGINT NOT NULL,
    last_seen_at        BIGINT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'ACTIVE'
);

CREATE INDEX IF NOT EXISTS idx_session_bindings_instance ON session_bindings(instance_id);
CREATE INDEX IF NOT EXISTS idx_session_bindings_last_seen ON session_bindings(last_seen_at);

-- ============================================
-- 分布式锁表 (多实例协调)
-- ============================================
CREATE TABLE IF NOT EXISTS distributed_locks (
    lock_key            TEXT PRIMARY KEY,
    holder_instance     TEXT NOT NULL,
    acquired_at         BIGINT NOT NULL,
    expires_at          BIGINT NOT NULL
);

-- ============================================
-- 序列号表 (用于生成唯一 ID)
-- ============================================
CREATE TABLE IF NOT EXISTS sequences (
    sequence_name       TEXT PRIMARY KEY,
    next_val            BIGINT NOT NULL DEFAULT 1
);

-- Initialize event sequence
INSERT OR IGNORE INTO sequences (sequence_name, next_val) VALUES ('im_events', 1);