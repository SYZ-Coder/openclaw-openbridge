# OpenClaw OpenBridge Channel

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.4-green.svg)](https://openclaw.ai)

OpenBridge 是一个 OpenClaw Gateway Channel 插件，用于连接 OpenClaw AI Runtime 与 Spring Boot IM 云服务，实现可靠的即时消息 AI 助手功能。

---

## 📖 简介

### 什么是 OpenBridge？

OpenBridge 让你能够：

- 将 OpenClaw AI 助手接入现有的 IM 服务
- 通过 WebSocket 实现双向实时通信
- 自动处理消息去重、重连恢复、心跳维护
- 支持多账号、多会话并发运行

### 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                    Spring Boot 云服务端                          │
│         消息持久化 / 会话管理 / 未完成事件恢复                      │
└─────────────────────────────────────────────────────────────────┘
                              ↑↓ WebSocket + HTTP
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                              │
│  ┌──────────────────┐  ┌──────────────────┐                    │
│  │ OpenBridge Plugin │  │ OpenBridge SDK   │                    │
│  │ (业务处理层)       │←→│ (连接运行时)      │                    │
│  └──────────────────┘  └──────────────────┘                    │
└─────────────────────────────────────────────────────────────────┘
                              ↑↓ Runtime API
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw AI Runtime                           │
│              消息理解 / AI 回复生成                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## ✨ 特性

### 核心功能

| 特性 | 说明 |
|------|------|
| **WebSocket 双向通信** | 实时消息推送与回复投递 |
| **设备身份管理** | Ed25519 签名验证，确保设备身份可信 |
| **消息去重** | 基于 eventId 的短 TTL 去重机制 |
| **自动重连** | 指数退避重连策略，断线自动恢复 |
| **心跳维护** | 双层心跳（应用层 + TCP 层）保活 |
| **多账号支持** | 单插件实例管理多个 IM 账号 |
| **进程隔离** | Sidecar 子进程架构，崩溃不影响主网关 |
| **Watchdog 监控** | 自动检测停滞并重启异常进程 |

### 消息处理能力

- ✅ **私聊消息** (direct)
- ✅ **群聊消息** (group)
- ✅ **回复引用** (reply-to)
- ✅ **话题回复** (threads)
- ✅ **图片媒体** (images)
- ✅ **主动发送** (outbound)

### 安全机制

```
┌─────────────────────────────────────────────────────┐
│  WebSocket URL Token 认证                            │
│  - Bearer Token 验证连接身份                          │
└─────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────┐
│  client.hello Ed25519 签名                           │
│  - 设备私钥签名，服务端公钥验证                         │
│  - payload: deviceId.clientId.timestamp.nonce        │
└─────────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────┐
│  HTTP HMAC 签名 (可选)                                │
│  - x-openclaw-signature: HMAC-SHA256                 │
│  - 需配置 clientSecret                                │
└─────────────────────────────────────────────────────┘
```

---

## 🚀 快速开始

### 前置要求

- OpenClaw Gateway >= 2026.4
- Node.js >= 18
- Spring Boot IM 服务端（或使用提供的 Demo）

### 安装

#### 方式一：从 npm 安装

```bash
npm install @openclaw/openbridge-channel
```

#### 方式二：本地开发安装

```bash
# 克隆仓库
git clone https://github.com/your-org/openclaw-openbridge.git
cd openclaw-openbridge/openbridge-channel

# 安装依赖
npm install

# 构建
npm run build

# 打包为 tgz
npm pack
```

### 配置

在 OpenClaw Gateway 配置文件 (`~/.openclaw/openclaw.json`) 中添加：

```json
{
  "channels": {
    "openbridge": {
      "enabled": true,
      "baseUrl": "http://localhost:8080",
      "clientId": "my-client-01",
      "token": "your-token-here"
    }
  }
}
```

### 配置项说明

| 配置项 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | 否 | true | 是否启用通道 |
| `baseUrl` | **是** | - | Spring Boot 服务地址 |
| `websocketUrl` | 否 | 自动推导 | WebSocket 地址 |
| `clientId` | **是** | - | 客户端标识 |
| `token` | **是** | - | 连接认证令牌 |
| `clientSecret` | 否 | - | HMAC 签名密钥 |
| `stateDir` | 否 | ~/.openclaw-openbridge | 状态存储目录 |
| `heartbeatMs` | 否 | 25000 | 心跳间隔 (ms) |
| `reconnectMinMs` | 否 | 1000 | 重连最小间隔 |
| `reconnectMaxMs` | 否 | 30000 | 重连最大间隔 |
| `dispatchTimeoutMs` | 否 | 60000 | 消息处理超时 |

### 多账号配置

```json
{
  "channels": {
    "openbridge": {
      "baseUrl": "https://im.example.com",
      "accounts": {
        "home": {
          "enabled": true,
          "clientId": "home-client",
          "token": "home-token"
        },
        "work": {
          "enabled": true,
          "clientId": "work-client",
          "token": "work-token"
        }
      }
    }
  }
}
```

---

## 📦 项目结构

本项目包含三个模块：

```
openclaw-openbridge/
├── openbridge-channel/     # OpenClaw 插件
│   ├── src/
│   │   ├── channel.ts              # 插件注册入口
│   │   ├── config.ts               # 配置解析
│   │   ├── account-runtime.ts      # Sidecar 进程管理
│   │   └── sdk/                    # SDK 导出层
│   ├── openclaw.plugin.json        # 插件元数据
│   └── package.json
│
├── openbridge-sdk/         # TypeScript SDK
│   ├── src/
│   │   ├── monitor.ts              # 主运行循环
│   │   ├── ws-client.ts            # WebSocket 客户端
│   │   ├── device-http.ts          # HTTP 设备注册
│   │   ├── dispatch.ts             # 消息派发
│   │   ├── state.ts                # 本地状态存储
│   │   └── protocol.ts             # 协议帧定义
│   └── package.json
│
└── openbridge-server/     # Spring Boot Demo 服务端
    ├── src/main/java/
    │   └── ai/openclaw/demo/springim/
    │       ├── web/                 # REST API
    │       ├── websocket/           # WebSocket Handler
    │       ├── service/             # 业务服务
    │       └── model/               # 数据模型
    └── pom.xml
```

---

## 🔧 使用指南

### 启动 Demo 服务端

```bash
cd openbridge-server

# 开发模式
mvn spring-boot:run

# 或打包运行
mvn clean package -DskipTests
java -jar target/spring-im-demo-0.1.0.jar
```

服务默认监听 `http://localhost:8080`。

### 在 OpenClaw 中使用

#### 1. 加载插件

插件会自动通过 OpenClaw 的插件系统加载。你也可以手动导入：

```typescript
import openBridgePlugin from "@openclaw/openbridge-channel";

// 插件 ID: "openbridge"
// 支持会话类型: ["direct", "group"]
```

#### 2. 处理入站消息

插件自动处理消息流程：

```
服务端推送消息
  → WebSocket receive
  → ack(received)
  → OpenClaw Runtime 处理
  → 生成 AI 回复
  → WebSocket send reply
  → ack(processed)
```

#### 3. 主动发送消息

通过 OpenClaw 的 message-tool API：

```typescript
// 发送给私聊用户
await sendText({ to: "user:user-123", text: "Hello!" });

// 发送给群聊
await sendText({ to: "group:group-456", text: "Hello group!" });
```

#### 4. Target 格式

支持以下格式：

- `user:<userId>` - 私聊用户
- `group:<groupId>` - 群聊
- `<conversationId>` - 直接使用会话 ID

---

## 🔌 WebSocket 协议

### 客户端帧类型

| 帧类型 | 说明 |
|--------|------|
| `client.hello` | 连接握手（含 Ed25519 签名） |
| `client.ping` | 心跳请求 |
| `client.ack` | 事件确认 (received/processed/failed/duplicate) |
| `client.reply` | 回复消息 |

### 服务端帧类型

| 帧类型 | 说明 |
|--------|------|
| `server.hello` | 握手确认 |
| `server.pong` | 心跳响应 |
| `message` | 用户消息推送 |
| `server.reply-ack` | 回复保存确认 |
| `server.resync-required` | 要求重新同步 |
| `server.bye` | 服务端通知关闭 |

---

## 🛠️ 故障排查

### 三层定位法

1. **云服务层**: 检查 `/api/openclaw/health` 是否返回 UP
2. **插件层**: 检查 WebSocket 是否连接，心跳是否正常
3. **Runtime 层**: 检查消息是否到达 OpenClaw AI 处理

### 常见问题

| 问题 | 可能原因 | 解决方案 |
|------|----------|----------|
| 无法连接 | token 无效 | 检查 token 配置 |
| 频繁重连 | 网络不稳定 | 调整 reconnect 参数 |
| 消息不处理 | sidecar 崩溃 | 查看日志，检查 watchdog |
| 重复消息 | 去重失效 | 清理 stateDir 重新连接 |

### 日志位置

- OpenClaw Gateway: `~/.openclaw/logs/openclaw-*.log`
- 插件状态: `{stateDir}/{accountId}.state.json`
- 服务端事件: `{storageDir}/events.json`

---

## 📚 文档

- [设计文档](../doc/openbridge-channel-design.md)
- [通信机制](../doc/openbridge-communication-mechanism.md)
- [功能分析](../doc/openbridge-feature-analysis.md)
- [排障指南](../doc/openbridge-debugging-guide.md)

---

## 🤝 贡献

欢迎贡献代码、报告问题或提出建议！

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

---

## 📄 许可证

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。

---

## 🔗 相关链接

- [OpenClaw 官网](https://openclaw.ai)
- [OpenClaw 文档](https://docs.openclaw.ai)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)