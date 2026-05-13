# OpenClaw OpenBridge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue.svg)](https://www.typescriptlang.org/)
[![Spring Boot](https://img.shields.io/badge/Spring%20Boot-3.3-green.svg)](https://spring.io/projects/spring-boot)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-2026.4-purple.svg)](https://openclaw.ai)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)

**OpenBridge** 是一个开源的即时消息 AI 助手桥接框架，将 [OpenClaw AI Runtime](https://openclaw.ai) 与 IM 服务无缝连接，实现智能对话自动化。

---

## ✨ 核心特性

### 🔌 双向实时通信
- WebSocket 长连接推送消息
- HTTP REST API 补充操作
- 自动心跳保活机制

### 🛡️ 安全认证体系
```
Token认证 → Ed25519设备签名 → HMAC请求签名
    ↓            ↓               ↓
 连接验证      身份确认         数据完整性
```

### 🔄 可靠消息处理
- 基于 eventId 的自动去重
- 断线自动重连（指数退避）
- 未完成消息自动恢复
- Sequence Gap 检测

### 🚀 进程隔离架构
- Sidecar 子进程独立运行
- Watchdog 监控自动重启
- 崩溃不影响主网关
- 多账号并行处理

### 🔧 多账号管理
- 单实例管理多个 IM 账号
- 配置热更新支持
- 独立状态跟踪

---

## 📊 架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户 / IM 客户端                              │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓ 消息
┌─────────────────────────────────────────────────────────────────────┐
│                    Spring Boot IM 云服务端                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────┐ │
│  │ REST API    │  │ WebSocket   │  │ SQLite 持久化               │ │
│  │ /api/im/*   │  │ /ws         │  │ events.db / replies.db      │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────────┘ │
│                                                                      │
│  职责: 消息持久化 / 会话管理 / 未完成事件恢复 / Reply 存储           │
└─────────────────────────────────────────────────────────────────────┘
                                    ↑↓ WebSocket + HTTP
┌─────────────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                                  │
│  ┌────────────────────────┐  ┌────────────────────────┐            │
│  │ OpenBridge Channel     │  │ OpenBridge SDK         │            │
│  │ (插件业务层)            │←→│ (连接运行时)            │            │
│  │                        │  │                        │            │
│  │ - 配置解析              │  │ - 设备注册             │            │
│  │ - 消息分发              │  │ - WebSocket 连接       │            │
│  │ - Reply 发送            │  │ - 心跳维护             │            │
│  │                        │  │ - 去重保护             │            │
│  └────────────────────────┘  └────────────────────────┘            │
│                                                                      │
│  进程隔离: Sidecar 子进程 + Watchdog 监控                            │
└─────────────────────────────────────────────────────────────────────┘
                                    ↓ Runtime API
┌─────────────────────────────────────────────────────────────────────┐
│                    OpenClaw AI Runtime                               │
│                                                                      │
│  职责: 消息理解 / AI 模型推理 / 智能回复生成                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 📦 项目结构

本仓库包含三个核心模块：

| 模块 | 语言 | 说明 | npm/Maven |
|------|------|------|-----------|
| `openbridge-channel` | TypeScript | OpenClaw Gateway 插件 | `@openclaw/openbridge-channel` |
| `openbridge-sdk` | TypeScript | 可复用的连接运行时 SDK | `@openclaw/openbridge-sdk` |
| `openbridge-server` | Java 17 | 示例 IM 云服务端 | `openbridge-server-demo` |

```
openclaw-openbridge/
├── .gitignore                    # Git 忽略配置
├── LICENSE                       # MIT 许可证
├── README.md                     # 本文档
├── doc/                          # 设计文档
│   ├── openbridge-channel-design.md
│   ├── openbridge-feature-analysis.md
│   ├── openbridge-communication-mechanism.md
│   ├── openbridge-debugging-guide.md
│   ├── openbridge-recovery-checklist.md
│   ├── openbridge-sdk-refactor-plan.md
│   └── openbridge-usage-guide.md
│
├── openbridge-channel/           # OpenClaw 插件
│   ├── package.json
│   ├── README.md
│   ├── openclaw.plugin.json      # 插件元数据
│   ├── index.ts                  # 插件入口
│   ├── setup-entry.ts            # 配置入口
│   ├── tsconfig.json
│   └── src/
│       ├── channel.ts            # 插件注册
│       ├── config.ts             # 配置解析
│       ├── clients.ts            # 账号管理
│       ├── account-runtime.ts    # Sidecar 进程管理
│       ├── runtime-surface.ts    # Runtime 暴露
│       └── sdk/                  # SDK 导出层
│
├── openbridge-sdk/               # TypeScript SDK
│   ├── package.json
│   ├── README.md
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts              # SDK 入口
│       ├── monitor.ts            # 主运行循环
│       ├── ws-client.ts          # WebSocket 客户端
│       ├── device-http.ts        # HTTP 设备注册
│       ├── device-identity.ts    # Ed25519 身份
│       ├── dispatch.ts           # 消息派发
│       ├── inbound.ts            # 入站处理
│       ├── outbox.ts             # 回复投递
│       ├── state.ts              # SQLite 状态存储
│       ├── protocol.ts           # 协议帧定义
│       ├── signing.ts            # HMAC 签名
│       ├── batcher.ts            # 消息批处理
│       ├── backoff.ts            # 退避算法
│       ├── targets.ts            # Target 解析
│       ├── media.ts              # 媒体处理
│       ├── logging.ts            # 日志摘要
│       └── types.ts              # 类型定义
│
└── openbridge-server/           # Spring Boot Demo
    ├── pom.xml
    ├── README.md
    └── src/
        ├── main/
        │   ├── java/ai/openclaw/demo/springim/
        │   │   ├── config/           # 配置类
        │   │   ├── dto/              # 数据传输对象
        │   │   ├── model/            # 数据模型
        │   │   ├── security/         # 鉴权服务
        │   │   ├── service/          # 业务服务
        │   │   ├── web/              # REST 控制器
        │   │   ├── websocket/        # WebSocket Handler
        │   │   ├── dao/              # 数据访问层
        │   │   └── support/          # 辅助工具
        │   └── resources/
        │       ├── application.yml   # 服务配置
        │       ├── db/schema.sql     # SQLite Schema
        │       └── static/           # Demo 控制台页面
        └── test/                    # 测试代码
```

---

## 🚀 快速开始

### 前置要求

| 工具 | 版本 | 说明 |
|------|------|------|
| OpenClaw Gateway | ≥ 2026.4 | AI 网关平台 |
| Node.js | ≥ 18 | TypeScript 运行环境 |
| Java | ≥ 17 | Spring Boot 运行环境 |
| Maven | ≥ 3.8 | Java 构建工具 |

### 方式一：从 npm/Maven 安装

```bash
# 安装 OpenClaw 插件
npm install @openclaw/openbridge-channel

# 或安装 SDK（用于自定义集成）
npm install @openclaw/openbridge-sdk
```

### 方式二：本地构建

```bash
# 克隆仓库
git clone https://github.com/openclaw/openclaw-openbridge.git
cd openclaw-openbridge

# 构建插件
cd openbridge-channel
npm install && npm run build

# 构建 SDK
cd ../openbridge-sdk
npm install && npm run typecheck

# 构建服务端 Demo
cd ../openbridge-server
mvn clean package -DskipTests
```

### 配置与运行

#### 1. 启动 Demo 服务端

```bash
cd openbridge-server
mvn spring-boot:run

# 或使用打包后的 jar
java -jar target/openbridge-server-demo-0.1.0.jar
```

服务默认监听 `http://localhost:8080`

访问 `http://localhost:8080` 打开 Demo 控制台页面。

#### 2. 配置 OpenClaw Gateway

编辑配置文件 `~/.openclaw/openclaw.json`：

```json
{
  "channels": {
    "openbridge": {
      "enabled": true,
      "baseUrl": "http://localhost:8080",
      "clientId": "my-client-id",
      "token": "my-secure-token"
    }
  }
}
```

#### 3. 加载插件

将构建的插件放入 OpenClaw 插件目录，或通过 OpenClaw 的插件管理界面安装。

#### 4. 重启 OpenClaw Gateway

```bash
openclaw restart
```

插件自动加载，查看日志确认启动成功：

```
[openbridge] bridge ready check success
[openbridge] device register success
[openbridge] websocket connected
[openbridge] sidecar ready
```

---

## 🔧 配置说明

### 完整配置项

```json
{
  "channels": {
    "openbridge": {
      "enabled": true,
      "baseUrl": "https://im.example.com",
      "websocketUrl": "wss://im.example.com/api/openclaw/ws",
      "clientId": "unique-client-id",
      "token": "secure-auth-token",
      "clientSecret": "optional-hmac-secret",
      "defaultTo": "default-conversation-id",
      "allowFrom": ["user-1", "user-2"],
      "dmPolicy": "allowlist",
      "stateDir": "/var/lib/openclaw-openbridge",
      "heartbeatMs": 25000,
      "reconnectMinMs": 1000,
      "reconnectMaxMs": 30000,
      "connectTimeoutMs": 15000,
      "ackTimeoutMs": 10000,
      "dispatchTimeoutMs": 60000,
      "replyOverWebSocket": false,
      "demoEchoReply": false
    }
  }
}
```

### 多账号配置

```json
{
  "channels": {
    "openbridge": {
      "baseUrl": "https://im.example.com",
      "accounts": {
        "account-1": {
          "enabled": true,
          "clientId": "client-1",
          "token": "token-1"
        },
        "account-2": {
          "enabled": true,
          "clientId": "client-2",
          "token": "token-2",
          "stateDir": "/var/lib/openbridge-account-2"
        }
      }
    }
  }
}
```

---

## 📡 WebSocket 协议

### 客户端帧类型

| 帧类型 | 字段 | 说明 |
|--------|------|------|
| `client.hello` | `deviceId`, `clientId`, `signature` | Ed25519 签名握手 |
| `client.ping` | - | 心跳请求 |
| `client.ack` | `eventId`, `status` | 事件确认 |
| `client.reply` | `localId`, `text`, `media` | 回复消息 |

### 服务端帧类型

| 帧类型 | 字段 | 说明 |
|--------|------|------|
| `server.hello` | `status` | 握手确认 |
| `server.pong` | - | 心跳响应 |
| `message` | `eventId`, `text`, `senderId` | 用户消息推送 |
| `server.reply-ack` | `localId`, `status` | 回复保存确认 |
| `server.resync-required` | - | 要求重新同步 |
| `server.bye` | `reason` | 服务端关闭通知 |

---

## 🛠️ 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| **插件层** | TypeScript | 5.8 |
| | Node.js | 18+ |
| | ws (WebSocket) | 8.x |
| | better-sqlite3 | 11.x |
| **SDK层** | TypeScript | 5.8 |
| | Ed25519 (crypto) | Node.js 内置 |
| | HMAC-SHA256 | Node.js 内置 |
| **服务端** | Spring Boot | 3.3.8 |
| | Java | 17+ |
| | SQLite | 3.x |
| | HikariCP | 连接池 |

---

## 📖 API 参考

### SDK 主要 API

```typescript
import { startOpenBridgeAccount, sendOpenBridgeOutboundTextWithAccount } from '@openclaw/openbridge-sdk';

// 启动账号运行时
await startOpenBridgeAccount({
  account: {
    accountId: 'default',
    baseUrl: 'http://localhost:8080',
    websocketUrl: 'ws://localhost:8080/api/openclaw/ws',
    clientId: 'my-client',
    token: 'my-token',
    heartbeatMs: 25000,
  },
  onInbound: async (message) => {
    console.log('收到消息:', message.eventId);
    return { text: '回复内容' };
  },
});

// 主动发送消息
await sendOpenBridgeOutboundTextWithAccount({
  account,
  to: 'user:user-123',
  text: 'Hello!',
});
```

### Target 格式

```typescript
// 私聊用户
'target': 'user:user-id'

// 群聊
'target': 'group:group-id'

// 直接使用 conversationId
'target': 'conversation-id'
```

---

## 🐛 故障排查

### 三层定位法

1. **云服务层**: 检查 `/api/openclaw/health` 是否返回 `UP`
2. **插件层**: 检查 WebSocket 是否连接，心跳是否正常
3. **Runtime 层**: 检查消息是否到达 OpenClaw AI 处理

### 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 连接失败 | token 无效 | 检查配置中的 token |
| 频繁重连 | 网络不稳定 | 调整 `reconnectMinMs`/`reconnectMaxMs` |
| 消息不处理 | sidecar 崩溃 | 查看日志，检查 watchdog 重启 |
| 重复消息 | 去重失效 | 清理 `stateDir` 重新连接 |
| 回复超时 | AI 处理慢 | 调大 `dispatchTimeoutMs` |

### 日志位置

| 位置 | 说明 |
|------|------|
| `~/.openclaw/logs/openclaw-*.log` | OpenClaw Gateway 日志 |
| `{stateDir}/{accountId}.state.db` | 插件状态 SQLite |
| `{storageDir}/events.db` | 服务端事件 SQLite |

---

## 🗺️ 路线图

### v0.1.0 (当前)
- ✅ WebSocket 双向通信
- ✅ 设备身份管理 (Ed25519)
- ✅ 消息去重与恢复
- ✅ Sidecar 进程隔离
- ✅ 多账号支持

### v0.2.0 (计划)
- 🔲 Redis 状态存储（支持多实例）
- 🔲 Prometheus metrics 暴露
- 🔲 更多媒体类型支持（视频/音频）
- 🔲 流式回复传输

### v0.3.0 (计划)
- 🔲 集群部署支持
- 🔲 Webhook 回调模式
- 🔲 消息模板系统

---

## 🤝 贡献指南

我们欢迎任何形式的贡献！

### 如何贡献

1. **Fork** 本仓库
2. **创建特性分支** (`git checkout -b feature/amazing-feature`)
3. **提交更改** (`git commit -m 'Add amazing feature'`)
4. **推送分支** (`git push origin feature/amazing-feature`)
5. **创建 Pull Request**

### 代码规范

- TypeScript: 使用 ESLint + Prettier
- Java: 遵循 Spring Boot 最佳实践
- 提交信息: 使用 Conventional Commits 格式

### 报告问题

发现 bug或有功能建议？请 [提交 Issue](https://github.com/openclaw/openclaw-openbridge/issues/new)，包含：

- 详细的问题描述
- 复现步骤
- 预期行为与实际行为
- 日志片段（如有）

---

## 👥 致谢

本项目基于以下开源项目构建：

- [OpenClaw](https://openclaw.ai) - AI Gateway 平台
- [Spring Boot](https://spring.io) - Java Web 框架
- [ws](https://github.com/websockets/ws) - WebSocket 客户端
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - SQLite 绑定

---

## 📄 许可证

本项目采用 [MIT License](LICENSE) 开源许可证。

```
MIT License

Copyright (c) 2026 OpenClaw Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

---

## 🔗 相关链接

| 链接 | 说明 |
|------|------|
| [OpenClaw 官网](https://openclaw.ai) | AI Gateway 平台 |
| [OpenClaw 文档](https://docs.openclaw.ai) | 官方文档 |
| [OpenClaw GitHub](https://github.com/openclaw) | 主仓库 |

---

**如果这个项目对你有帮助，请给我们一个 ⭐ Star！**