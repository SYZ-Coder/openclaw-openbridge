# OpenClaw OpenBridge SDK

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)

OpenBridge SDK 是 OpenClaw OpenBridge Channel 插件的底层运行时，提供可靠的 WebSocket 连接、设备注册、消息处理等核心能力。

---

## 📖 简介

OpenBridge SDK 负责：

- 设备身份管理与 Ed25519 签名
- 云服务健康检查
- WebSocket 连接与心跳维护
- 消息去重与状态跟踪
- 回复投递与 ACK 管理

它是一个**独立可复用**的运行时，不依赖 OpenClaw Gateway，可以单独集成到其他项目中。

---

## ✨ 特性

| 特性 | 说明 |
|------|------|
| **设备身份持久化** | SQLite 存储，跨重启稳定 |
| **Ed25519 签名** | 安全的设备认证机制 |
| **指数退避重连** | 自动恢复连接 |
| **双层心跳** | 应用层 ping + TCP keepalive |
| **消息批处理** | 50ms/20条聚合，优化吞吐 |
| **去重保护** | 7天 TTL eventId 去重 |
| **Sequence 跟踪** | 检测消息丢失 |
| **状态持久化** | SQLite 本地状态，可靠存储 |

---

## 🚀 快速使用

### 安装

```bash
npm install @openclaw/openbridge-sdk
```

### 基本用法

```typescript
import {
  startOpenBridgeAccount,
  OpenBridgeStateStore,
  OpenBridgeWebSocketClient,
} from "@openclaw/openbridge-sdk";

// 配置账号
const account = {
  accountId: "default",
  enabled: true,
  baseUrl: "http://localhost:8080",
  websocketUrl: "ws://localhost:8080/api/openclaw/ws",
  clientId: "my-client",
  token: "my-token",
  heartbeatMs: 25000,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
};

// 启动运行时
await startOpenBridgeAccount({
  account,
  onInbound: async (message) => {
    console.log("收到消息:", message);
    // 处理消息并返回回复
    return {
      text: "回复内容",
    };
  },
});
```

---

## 📦 核心模块

### monitor.ts - 主运行循环

管理整个 SDK 的生命周期：

```
idle → registering → connecting → online → (reconnecting)
```

- 健康检查等待
- 设备注册
- WebSocket 连接
- 消息处理循环
- 断线重连

### ws-client.ts - WebSocket 客户端

- 连接管理与握手
- Ed25519 hello 签名
- 心跳维护 (ping/pong)
- Pong Watchdog 超时检测
- TCP Keep-Alive + NoDelay

### device-http.ts - HTTP 设备注册

- `GET /api/openclaw/health` - 健康检查
- `POST /api/openclaw/devices/register` - 设备注册
- HMAC 签名请求

### state.ts - 本地状态存储

SQLite 持久化：

- 去重记录 (dedup)
- Sequence 跟踪
- 运行阶段状态
- 设备身份

### dispatch.ts - 消息派发

- Agent 路由解析
- 媒体下载
- Inbound Context 构造
- Reply Pipeline

### outbox.ts - 回复投递

- Reply 构建
- WebSocket 直发
- 媒体摘要

---

## 🔌 API

### startOpenBridgeAccount(config)

启动账号运行时：

```typescript
await startOpenBridgeAccount({
  account: OpenBridgeAccountConfig,
  channelRuntime?: unknown,     // OpenClaw Runtime
  onInbound?: (message) => Promise<ReplyPayload>,
  log?: Logger,
  setStatus?: (snapshot) => void,
  abortSignal?: AbortSignal,
});
```

### sendOpenBridgeOutboundTextWithAccount(ctx)

主动发送文本消息：

```typescript
const result = await sendOpenBridgeOutboundTextWithAccount({
  account,
  to: "user:user-123",
  text: "Hello!",
  replyToId?: string,
  threadId?: string,
});
```

### parseOpenBridgeTarget(target)

解析消息目标：

```typescript
const parsed = parseOpenBridgeTarget("user:user-123");
// { conversationId: "user-123", conversationType: "direct" }

const parsed = parseOpenBridgeTarget("group:group-456");
// { conversationId: "group-456", conversationType: "group" }
```

---

## 📋 配置类型

```typescript
type OpenBridgeAccountConfig = {
  accountId: string;
  enabled: boolean;
  baseUrl: string;
  websocketUrl: string;
  clientId: string;
  token?: string;
  clientSecret?: string;
  defaultTo?: string;
  allowFrom: string[];
  dmPolicy: "allowlist" | "open";
  reconnectMinMs: number;
  reconnectMaxMs: number;
  heartbeatMs: number;
  connectTimeoutMs: number;
  ackTimeoutMs: number;
  dispatchTimeoutMs: number;
  demoEchoReply: boolean;
  replyOverWebSocket: boolean;
  stateDir?: string;
};
```

---

## 🔧 故障排查

### 日志格式

SDK 使用统一日志前缀：

```
openbridge[accountId]: 消息内容
```

关键日志：

- `bridge ready check success` - 服务端就绪
- `device register success` - 设备注册成功
- `websocket connected` - WebSocket 连接成功
- `inbound message` - 收到消息
- `dispatch done` - 消息处理完成

### 状态文件

位置：`{stateDir}/{accountId}.state.db`

SQLite 表结构：

- `device_identity` - 设备身份
- `dedup` - 去重记录
- `messages` - 消息记录
- `runtime` - 运行状态
- `sync_meta` - 同步元数据

---

## 📄 许可证

MIT License