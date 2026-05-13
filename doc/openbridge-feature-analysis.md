# OpenBridge 插件功能全面分析

本文档详细分析 `@openclaw/openbridge-channel` 插件已实现的功能、通信建立流程和内部架构。

---

## 1. 插件概述

### 1.1 项目定位

OpenBridge 插件是 OpenClaw Gateway 与 Spring Boot IM 云服务之间的桥梁。它：

- 作为 OpenClaw 的一个 **Channel 插件** 注册到网关
- 管理 WebSocket 长连接，接收云端推送的用户消息
- 将消息交给 OpenClaw Runtime 处理，生成 AI 回复
- 通过 WebSocket 将回复发回云端服务

### 1.2 三层架构

插件采用三层架构设计：

```
┌─────────────────────────────────────────────────────────────┐
│                  OpenClaw Gateway (主进程)                   │
│  ┌─────────────┐                                            │
│  │ channel.ts  │  ← 插件注册入口                            │
│  │ clients.ts  │  ← 账号管理                                │
│  │ config.ts   │  ← 配置解析                                │
│  └─────────────┘                                            │
└─────────────────────────────────────────────────────────────┘
                    ↓ IPC (fork + message)
┌─────────────────────────────────────────────────────────────┐
│                  Sidecar Runtime (子进程)                    │
│  ┌─────────────────┐                                        │
│  │ account-runtime │  ← 进程隔离与自动重启                  │
│  │ watchdog        │  ← 停顿检测                            │
│  └─────────────────┘                                        │
└─────────────────────────────────────────────────────────────┘
                    ↓ SDK API
┌─────────────────────────────────────────────────────────────┐
│                    SDK 运行时层                              │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │ monitor.ts  │  │ ws-client   │  │ state.ts          │  │
│  │ 主循环      │  │ WebSocket   │  │ 本地状态          │  │
│  └─────────────┘  └─────────────┘  └───────────────────┘  │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────────────┐  │
│  │ device-http │  │ dispatch.ts │  │ outbox.ts         │  │
│  │ 设备注册    │  │ 消息派发    │  │ 回复投递          │  │
│  └─────────────┘  └─────────────┘  └───────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                    ↓ WebSocket + HTTP
┌─────────────────────────────────────────────────────────────┐
│               Spring Boot 云服务端                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. 已实现功能清单

### 2.1 插件注册与配置

#### 2.1.1 Channel 注册 ([channel.ts](../openbridge-channel/src/channel.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| `id` | ✅ 已实现 | `openbridge` |
| `meta` | ✅ 已实现 | 标签、文档路径、简介 |
| `capabilities` | ✅ 已实现 | 支持 direct/group、reply、threads、media、blockStreaming |
| `defaults` | ✅ 已实现 | queue.debounceMs = 250ms |
| `reload` | ✅ 已实现 | 配置热更新，监听 `channels.openbridge` |
| `config` | ✅ 已实现 | 账号列表、配置解析、enabled/configured 判断 |
| `setup` | ✅ 已实现 | 账号配置写入、输入验证 |
| `status` | ✅ 已实现 | 运行状态快照、channel 概要 |
| `gateway` | ✅ 已实现 | 账号启动入口 |
| `messaging` | ✅ 已实现 | target 解析 (user:xxx / group:xxx) |
| `outbound` | ✅ 已实现 | 主动发送文本消息 |
| `conversationBindings` | ✅ 已实现 | 当前会话绑定支持 |

#### 2.1.2 配置解析 ([config.ts](../openbridge-channel/src/config.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| 单账号配置 | ✅ 已实现 | 顶层 `baseUrl`/`clientId`/`token` |
| 多账号配置 | ✅ 已实现 | `accounts.*` 结构 |
| 配置兼容 | ✅ 已实现 | 兼容 `openbridge`/`openbridge`/`spring-im` 三种写法 |
| WebSocket URL 推导 | ✅ 已实现 | 自动从 baseUrl 推导 `/api/openclaw/ws` |
| 默认值填充 | ✅ 已实现 | reconnectMinMs、heartbeatMs 等默认值 |
| stateDir 解析 | ✅ 已实现 | 支持环境变量和用户目录回退 |

### 2.2 运行时管理

#### 2.2.1 Sidecar 进程隔离 ([account-runtime.ts](../openbridge-channel/src/account-runtime.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| 进程 fork | ✅ 已实现 | 使用 Node.js child_process.fork |
| IPC 通信 | ✅ 已实现 | log/status/dispatch/dispatch-result 消息 |
| Watchdog | ✅ 已实现 | 15s 检查间隔，75s 停顿阈值 |
| 自动重启 | ✅ 已实现 | 退出/停滞后 2s 重启 |
| 多账号管理 | ✅ 已实现 | Map 存储多个 sidecar runtime |
| 优雅停止 | ✅ 已实现 | SIGTERM → SIGKILL 强制终止链 |

#### 2.2.2 账号生命周期 ([clients.ts](../openbridge-channel/src/clients.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| startAllAccountClients | ✅ 已实现 | 批量启动所有账号 |
| startAccountClient | ✅ 已实现 | 单账号启动，检查 enabled/configured |
| stopAllClients | ✅ 已实现 | 批量停止所有 sidecar |
| ensureAllAccountClientsStarted | ✅ 已实现 | 确保 startup task 完成 |
| connectedClientCount | ✅ 已实现 | 已连接账号计数 |

### 2.3 通信层

#### 2.3.1 WebSocket 客户端 ([ws-client.ts](../openbridge-s../openbridge-channel/src/ws-client.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| WebSocket 连接 | ✅ 已实现 | URL 参数携带 clientId/token |
| client.hello 签名 | ✅ 已实现 | Ed25519 签名，包含 timestamp/nonce |
| 心跳机制 | ✅ 已实现 | client.ping + WebSocket ping |
| Pong Watchdog | ✅ 已实现 | 超时自动 terminate |
| 连接超时 | ✅ 已实现 | handshakeTimeout 配置 |
| Keep-Alive | ✅ 已实现 | TCP socket.setKeepAlive(true, 5000) |
| NoDelay | ✅ 已实现 | TCP socket.setNoDelay(true) |
| 断线处理 | ✅ 已实现 | close/error 事件 → notifyClose |
| 恢复进度传递 | ✅ 已实现 | lastProcessedSequence/lastProcessedEventId |

#### 2.3.2 HTTP 设备注册 ([device-http.ts](../openbridge-s../openbridge-channel/src/device-http.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| 健康检查 | ✅ 已实现 | GET /api/openclaw/health，指数退避等待 |
| 设备注册 | ✅ 已实现 | POST /api/openclaw/devices/register |
| HMAC 签名 | ✅ 已实现 | x-openclaw-signature 头 |
| Authorization | ✅ 已实现 | Bearer token |
| 超时控制 | ✅ 已实现 | AbortSignal.timeout |

#### 2.3.3 协议帧 ([protocol.ts](../openbridge-s../openbridge-channel/src/protocol.ts))

**客户端帧类型**：

| 帧类型 | 实现状态 | 说明 |
|--------|----------|------|
| `client.hello` | ✅ 已实现 | v2 协议，签名验证 |
| `client.ping` | ✅ 已实现 | 心跳请求 |
| `client.ack` | ✅ 已实现 | received/processed/failed/duplicate |
| `client.reply` | ✅ 已实现 | 回复消息 |

**服务端帧类型**：

| 帧类型 | 实现状态 | 说明 |
|--------|----------|------|
| `server.hello` | ✅ 已实现 | 握手确认 |
| `server.pong` | ✅ 已实现 | 心跳响应 |
| `message` | ✅ 已实现 | 业务消息推送 |
| `server.reply-ack` | ✅ 已实现 | 回复保存确认 |
| `server.resync-required` | ✅ 已实现 | 要求重新同步 |
| `server.bye` | ✅ 已实现 | 服务端通知关闭 |

### 2.4 消息处理

#### 2.4.1 主运行循环 ([monitor.ts](../openbridge-s../openbridge-channel/src/monitor.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| 运行阶段管理 | ✅ 已实现 | idle/registering/connecting/online/degraded/reconnecting |
| 健康检查等待 | ✅ 已实现 | waitForBridgeReady |
| 设备注册 | ✅ 已实现 | registerDevice + 身份绑定更新 |
| WebSocket 连接 | ✅ 已实现 | connect + hello |
| 消息批处理 | ✅ 已实现 | Batcher 50ms/20条聚合 |
| 去重检测 | ✅ 已实现 | hasSeen + duplicate ack |
| ACK 发送 | ✅ 已实现 | received/processed/failed |
| 超时控制 | ✅ 已实现 | dispatchTimeoutMs |
| 重连退避 | ✅ 已实现 | 指数退避 reconnectMinMs~reconnectMaxMs |
| 状态发布 | ✅ 已实现 | setStatus 周期心跳 |

#### 2.4.2 消息派发 ([dispatch.ts](../openbridge-s../openbridge-channel/src/dispatch.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| Agent 路由 | ✅ 已实现 | routing.resolveAgentRoute |
| Session 解析 | ✅ 已实现 | session.resolveStorePath |
| Inbound Context 构造 | ✅ 已实现 | From/To/SessionKey/SenderId 等 |
| 媒体下载 | ✅ 已实现 | materializeInboundImages |
| Reply Pipeline | ✅ 已实现 | dispatchInboundReplyWithBase |
| 回复投递 | ✅ 已实现 | deliverReply |

#### 2.4.3 回复投递 ([outbox.ts](../openbridge-s../openbridge-channel/src/outbox.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| Reply 构建 | ✅ 已实现 | buildReply，生成 localId |
| WebSocket 直发 | ✅ 已实现 | client.send({ type: "client.reply" }) |
| 媒体摘要 | ✅ 已实现 | appendMediaSummary |
| 主动发送 | ✅ 已实现 | sendOutboundTextWithAccount |

### 2.5 状态管理

#### 2.5.1 本地状态存储 ([state.ts](../openbridge-s../openbridge-channel/src/state.ts))

| 功能 | 实现状态 | 说明 |
|------|----------|------|
| 去重记录 | ✅ 已实现 | dedup Map，7 天 TTL |
| Sequence 跟踪 | ✅ 已实现 | lastSequence |
| 运行阶段 | ✅ 已实现 | runtime.phase/reason |
| 批次记录 | ✅ 已实现 | sync.batches/lastBatchSize |
| Sequence Gap | ✅ 已实现 | lastGap 记录 |
| 文件原子写 | ✅ 已实现 | UUID.tmp → rename |
| 写入重试 | ✅ 已实现 | EPERM/EBUSY 重试 5 次 |
| 超时保护 | ✅ 已实现 | 5s 文件操作超时 |
| tmp 清理 | ✅ 已实现 | 1 小时前的 .tmp 文件清理 |

---

## 3. 通信建立流程

### 3.1 启动流程

```text
OpenClaw Gateway 加载插件
  ↓
register(api) 被调用
  ↓
api.registerChannel({ plugin: openbridgePlugin })
  ↓
api.registerService({ id: "openbridge-sdk", start/stop })
  ↓
ensureAllAccountClientsStarted(api, "plugin-register")
  ↓
startAllAccountClients(api)
  ↓
遍历 listOpenBridgeAccountIds(cfg)
  ↓
对每个账号调用 startAccountClient(api, account)
  ↓
startManagedOpenBridgeAccount(ctx) → fork sidecar 进程
```

### 3.2 Sidecar 进程启动

```text
spawnManagedRuntime(ctx)
  ↓
fork(sidecar-entry.js)
  ↓
子进程接收 OPENBRIDGE_SIDECAR_CONTEXT 环境变量
  ↓
子进程执行 startSpringImAccount(ctx)
  ↓
进入 monitor.ts 主循环
```

### 3.3 连接建立详细流程

```text
Phase 1: 健康检查
─────────────────────────────────────────────
waitForBridgeReady()
  ↓
GET /api/openclaw/health (指数退避重试)
  ↓
返回 status="UP" → 继续
  ↓

Phase 2: 设备注册
─────────────────────────────────────────────
registerDevice()
  ↓
生成请求签名
  headers:
    - Authorization: Bearer {token}
    - x-openclaw-client-id: {clientId}
    - x-openclaw-device-id: {deviceId}
    - x-openclaw-timestamp: {timestamp}
    - x-openclaw-request-id: {uuid}
    - x-openclaw-signature: HMAC-SHA256(timestamp.requestId.body)
  ↓
POST /api/openclaw/devices/register
  body:
    - deviceId
    - installId
    - deviceName
    - publicKeyPem (Ed25519)
  ↓
响应:
    - deviceId
    - clientId
    - ownerUserId
    - token (可选)
    - clientSecret (可选)
  ↓
identityStore.updateClientBinding({ clientId, ownerUserId })
  ↓

Phase 3: WebSocket 连接
─────────────────────────────────────────────
SpringImWebSocketClient.connect()
  ↓
构造 URL:
  ws://baseUrl/api/openclaw/ws?clientId={clientId}&accountId={accountId}&token={token}
  ↓
WebSocket handshake
  ↓
设置 TCP Keep-Alive + NoDelay
  ↓

Phase 4: 握手验证
─────────────────────────────────────────────
生成 client.hello 帧:
  {
    type: "client.hello",
    protocolVersion: 2,
    deviceId: {deviceId},
    clientId: {clientId},
    accountId: {accountId},
    timestamp: {now},
    nonce: {uuid},
    signature: Ed25519(deviceId.clientId.accountId.timestamp.nonce),
    lastProcessedSequence: {lastSequence},
    lastProcessedEventId: {lastEventId}
  }
  ↓
ws.send(client.hello)
  ↓
服务端验证:
  - token 验证
  - hello 签名验证
  - 设备绑定检查
  ↓
服务端响应 server.hello
  ↓
连接建立成功，进入 online 阶段
  ↓

Phase 5: 心跳维护
─────────────────────────────────────────────
启动 pingTimer (interval: heartbeatMs)
  ↓
定时发送:
  - client.ping 帧
  - WebSocket ping()
  ↓
启动 pongWatchdog
  ↓
检测 lastPongAt 是否超过阈值
  ↓
超时 → forceTerminate("pong-timeout")
```

### 3.4 消息处理流程

```text
服务端推送消息帧
─────────────────────────────────────────────
WebSocket receive: { type: "message", eventId, ... }
  ↓
parseServerFrame()
  ↓
batcher.push(frame) (50ms/20条聚合)
  ↓
processMessageBatch()
  ↓
store.recordInboundBatch(events)
  ↓

单条消息处理
─────────────────────────────────────────────
handleInboundMessage()
  ↓
检测 sequence gap:
  if sequence > lastSequence + 1:
    store.noteSequenceGap({ expected, actual })
  ↓
去重检测:
  if store.hasSeen(eventId):
    send ack({ status: "duplicate" })
    return
  ↓
inFlightEventIds.add(eventId)
  ↓
send ack({ status: "received" })
  ↓
调用 handleMessage:
  ↓
dispatchCloudMessage()
─────────────────────────────────────────────
  resolveAgentRoute({ channel, accountId, peer })
  ↓
  materializeInboundImages(media)
  ↓
  构造 inbound context:
    - Body/BodyForAgent
    - From/To
    - SessionKey
    - SenderId/SenderName
    - MessageSid/ReplyToId
  ↓
  dispatchInboundReplyWithBase()
  ↓
  [OpenClaw Runtime 处理]
  ↓
  回调 deliver(payload)
  ↓
buildReply()
  ↓
deliverReply()
─────────────────────────────────────────────
  client.send({ type: "client.reply", reply: {...} })
  ↓
  onSent() → 更新 lastOutboundAt
  ↓

完成确认
─────────────────────────────────────────────
store.finalizeProcessedMessage({ eventId, sequence })
  ↓
send ack({ status: "processed" })
  ↓
inFlightEventIds.delete(eventId)
  ↓
更新状态快照
```

### 3.5 断线重连流程

```text
WebSocket 断开
─────────────────────────────────────────────
触发 onClose:
  - status.connected = false
  - status.lastDisconnect = { at, error }
  ↓
closedResolve() → 退出 try 块
  ↓
catch 块:
  - setPhase("degraded")
  - 等待 abortSignal.aborted 检查
  ↓
attempt += 1
  ↓
setPhase("reconnecting")
  ↓
计算退避延迟:
  delay = min(max(1000 * attempt, reconnectMinMs), reconnectMaxMs)
  ↓
sleep(delay, abortSignal)
  ↓
重新进入循环 → 创建新 WebSocketClient
```

---

## 4. 进程隔离与可靠性

### 4.1 Sidecar 架构优势

| 特性 | 说明 |
|------|------|
| **进程隔离** | 每个账号独立子进程，崩溃不影响主网关 |
| **资源隔离** | 子进程内存/CPU 独立，避免相互干扰 |
| **自动重启** | exit/stalled 后自动重启，2s 延迟 |
| **Watchdog 监控** | 15s 检查，75s 停顿触发重启 |
| **IPC 通信** | 父子进程通过 message 事件通信 |

### 4.2 IPC 消息类型

**子进程 → 父进程**：

```typescript
type SidecarMessage =
  | { type: "log"; level: "info" | "warn" | "error" | "debug"; message: string }
  | { type: "status"; snapshot: Record<string, unknown> }
  | { type: "dispatch"; id: string; message: SpringImCloudMessage }
  | { type: "ready"; accountId: string };
```

**父进程 → 子进程**：

```typescript
type SidecarParentMessage =
  | { type: "dispatch-result"; id: string; ok: true }
  | { type: "dispatch-result"; id: string; ok: false; error: string }
  | { type: "send-frame"; frame: ClientFrame };
```

### 4.3 Watchdog 机制

```text
定时器 (15s)
  ↓
检查 lastStatusAt
  ↓
if now - lastStatusAt > 75s:
  ↓
  记录警告: "sidecar watchdog: runtime stalled"
  ↓
  restartSidecar(entry, "watchdog-stalled")
  ↓
  killSidecar → SIGTERM → 3s → SIGKILL
  ↓
  scheduleRestart → 2s → spawnManagedRuntime
```

---

## 5. 安全机制

### 5.1 认证层级

```
┌─────────────────────────────────────────────────────┐
│  WebSocket URL 参数                                  │
│  - clientId                                          │
│  - accountId                                         │
│  - token (Bearer auth)                               │
└─────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────┐
│  client.hello 签名                                   │
│  - Ed25519 签名                                      │
│  - payload: deviceId.clientId.accountId.timestamp.nonce │
│  - 服务端验证设备公钥                                │
└─────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────┐
│  HTTP HMAC 签名 (可选)                               │
│  - x-openclaw-signature                              │
│  - HMAC-SHA256(timestamp.requestId.body)            │
│  - 需要 clientSecret 配置                            │
└─────────────────────────────────────────────────────┘
```

### 5.2 签名实现

**client.hello Ed25519 签名** ([device-identity.ts](../openbridge-s../openbridge-channel/src/device-identity.ts)):

```typescript
// payload = deviceId + "." + clientId + "." + accountId + "." + timestamp + "." + nonce
const signature = signHello({
  identity: { privateKey, deviceId, publicKeyPem },
  clientId,
  accountId,
  timestamp,
  nonce,
});
```

**HTTP HMAC 签名** ([signing.ts](../openbridge-s../openbridge-channel/src/signing.ts)):

```typescript
// signature = HMAC-SHA256(clientSecret, timestamp + "." + requestId + "." + body)
const signature = signBody({
  body: JSON.stringify(requestBody),
  secret: clientSecret,
  timestamp,
  requestId,
});
```

---

## 6. 配置项完整清单

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | true (有 baseUrl 时) | 是否启用账号 |
| `baseUrl` | string | - | Spring Boot 服务地址 |
| `websocketUrl` | string | 自动推导 | WebSocket 地址 |
| `clientId` | string | accountId | 客户端标识 |
| `token` | string | - | Bearer auth token |
| `clientSecret` | string | - | HMAC 签名密钥 |
| `defaultTo` | string | - | 默认发送目标 |
| `allowFrom` | string[] | [] | 允许的发送者白名单 |
| `dmPolicy` | "allowlist" \| "open" | "allowlist" | DM 消息策略 |
| `reconnectMinMs` | number | 1000 | 重连最小间隔 |
| `reconnectMaxMs` | number | 30000 | 重连最大间隔 |
| `heartbeatMs` | number | 25000 | 心跳间隔 |
| `connectTimeoutMs` | number | 15000 | 连接超时 |
| `ackTimeoutMs` | number | 10000 | ACK 超时 |
| `dispatchTimeoutMs` | number | 60000 | 消息处理超时 |
| `stateDir` | string | ~/.openclaw-openbridge/{accountId} | 状态存储目录 |
| `replyOverWebSocket` | boolean | false | 回复是否走 WebSocket |
| `demoEchoReply` | boolean | false | Demo 模式自动回显 |

---

## 7. 运行状态字段

状态快照包含以下字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `accountId` | string | 账号 ID |
| `name` | string | clientId |
| `enabled` | boolean | 是否启用 |
| `configured` | boolean | baseUrl/clientId/token 是否完整 |
| `linked` | boolean | token 是否配置 |
| `running` | boolean | 是否在运行 |
| `connected` | boolean | WebSocket 是否连接 |
| `phase` | string | 运行阶段 |
| `reconnectAttempts` | number | 重连尝试次数 |
| `lastConnectedAt` | number | 最后连接时间 |
| `lastDisconnect` | object | 最后断开信息 |
| `lastInboundAt` | number | 最后入站时间 |
| `lastOutboundAt` | number | 最后出站时间 |
| `lastError` | string | 最后错误信息 |
| `lastSequence` | number | 最后处理的 sequence |
| `outboxSize` | number | 待发送队列大小 (已废弃) |
| `deadLetterSize` | number | 死信队列大小 (已废弃) |
| `lastGap` | object | sequence gap 信息 |
| `mode` | string | "websocket" |
| `baseUrl` | string | 服务地址 |
| `dmPolicy` | string | DM 策略 |
| `allowFrom` | string[] | 发送者白名单 |

---

## 8. 文件与目录结构

```
openbridge-channel/
├── src/
│   ├── channel.ts          # 插件注册入口
│   ├── config.ts           # 配置解析
│   ├── clients.ts          # 账号管理
│   ├── account-runtime.ts  # Sidecar 进程管理
│   ├── runtime-surface.ts  # Runtime 暴露
│   └── sdk/                # SDK 导出层
│       ├── index.ts        # SDK 类型导出
│       ├── dispatch.ts     # 消息派发
│       ├── inbound.ts      # 入站处理
│       ├── outbox.ts       # 回复投递
│       ├── ws-client.ts    # WebSocket 客户端
│       ├── monitor.ts      # 主运行循环
│       ├── state.ts        # 本地状态
│       ├── device-http.ts  # HTTP 调用
│       ├── device-identity.ts # 设备身份
│       ├── protocol.ts     # 协议帧定义
│       ├── signing.ts      # 签名实现
│       ├── backoff.ts      # 退避算法
│       ├── batcher.ts      # 消息批处理
│       ├── targets.ts      # 目标解析
│       ├── media.ts        # 媒体处理
│       ├── logging.ts      # 日志摘要
│       └── types.ts        # 类型定义
├── doc/
│   ├── README.md           # 文档索引
│   ├── openbridge-channel-design.md
│   ├── openbridge-communication-mechanism.md
│   ├── openbridge-debugging-guide.md
│   ├── openbridge-recovery-checklist.md
│   └── openbridge-feature-analysis.md  # 本文档
├── openclaw.plugin.json    # OpenClaw 插件元数据
├── package.json            # npm 配置
└── index.ts                # 插件默认导出
```

---

## 9. 关键设计决策

### 9.1 为什么使用 Sidecar 进程？

| 原因 | 说明 |
|------|------|
| **隔离崩溃** | SDK 的 WebSocket 循环可能因为异常、内存泄漏等问题崩溃，Sidecar 独立进程不会影响主网关 |
| **独立重启** | 单账号 sidecar 重启不影响其他账号 |
| **资源监控** | 每个账号有独立的 PID，便于监控 CPU/内存 |
| **并行处理** | 多账号可以并行运行，不阻塞主进程 |

### 9.2 为什么本地不维护消息队列？

| 原因 | 说明 |
|------|------|
| **云端是权威** | 云服务端的 `events.json` 是事件状态的权威来源 |
| **避免分裂** | 如果本地和云端各自维护队列，会出现状态分裂 |
| **简化恢复** | 重连后，云端重新投递未完成事件，本地只需去重 |
| **减少复杂度** | 不需要实现本地消息恢复、排序、确认等复杂逻辑 |

### 9.3 为什么使用 Ed25519 签名？

| 原因 | 说明 |
|------|------|
| **设备绑定** | 设备私钥本地保存，云端保存公钥，确保只有合法设备可以连接 |
| **防伪造** | 即使 token 泄露，没有设备私钥也无法伪造 hello 签名 |
| **非对称加密** | 签名验证不需要传输私钥 |
| **Ed25519 优势** | 签名速度快、密钥短、安全性高 |

---

## 10. 已知限制与未来扩展

### 10.1 当前限制

| 限制 | 说明 |
|------|------|
| **单实例** | 插件设计为单实例运行，不支持多实例负载均衡 |
| **无数据库** | 状态存储使用 JSON 文件，不适合高并发 |
| **媒体有限** | 当前仅支持图片下载，其他媒体类型有限 |
| **无 Metrics** | 缺少 Prometheus 指标暴露 |

### 10.2 潜在扩展方向

| 方向 | 说明 |
|------|------|
| **Redis 状态** | 使用 Redis 替代本地 JSON，支持多实例 |
| **Prometheus** | 添加 metrics 暴露，便于监控 |
| **更多媒体** | 支持视频、音频、文件的下载和处理 |
| **流式回复** | 支持 WebSocket 流式传输 AI 回复 |

---

## 11. 总结

OpenBridge 插件是一个功能完整、架构清晰的 OpenClaw Channel 实现：

- **通信层**：完整的 WebSocket + HTTP 双通道，支持握手签名、心跳、断线重连
- **消息处理**：完整的入站派发 → OpenClaw Runtime → 回复投递链路
- **可靠性**：Sidecar 进程隔离、Watchdog 监控、自动重启
- **安全性**：Token + Ed25519 + HMAC 多层认证
- **状态管理**：轻量级去重记录，云端权威持久化

当前实现适合 Demo 和小规模生产使用，要达到大规模生产需要补充数据库持久化和多实例支持。