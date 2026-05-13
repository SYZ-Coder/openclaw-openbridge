# OpenBridge 文档索引

这组文档以当前代码实现为准，覆盖：

- `openbridge-channel`
- `openbridge-sdk`
- `openbridge-server`

## 当前实现结论

当前主链路收敛为：

1. 云服务保存用户消息事件，并负责在线投递和未完成事件恢复。
2. SDK 负责设备注册、健康检查、WebSocket 连接和消息回调。
3. 插件负责把消息交给 OpenClaw runtime，并通过 WebSocket 回传 reply。

插件本地状态只保留短期去重和运行状态，不作为消息恢复真相。

## 主路径

```text
Spring Boot event store
  -> WebSocket push message
  -> plugin inbound callback
  -> ack(received)
  -> OpenClaw dispatch
  -> WebSocket client.reply
  -> server persist reply
  -> ack(processed)
```

## 文档列表

| 文档 | 说明 |
|------|------|
| [openbridge-feature-analysis.md](openbridge-feature-analysis.md) | **功能全面分析**：已实现功能清单、通信建立流程、进程隔离架构、安全机制、配置项 |
| [openbridge-channel-design.md](openbridge-channel-design.md) | **设计概览**：三层边界、本地状态设计、主运行链、恢复链、当前限制 |
| [openbridge-communication-mechanism.md](openbridge-communication-mechanism.md) | **通信机制**：WebSocket/HTTP 帧类型、服务端投递模型、插件处理模型、重启恢复语义 |
| [openbridge-debugging-guide.md](openbridge-debugging-guide.md) | **排障指南**：三层定位、服务端排查、插件排查、重启场景预期 |
| [openbridge-recovery-checklist.md](openbridge-recovery-checklist.md) | **恢复检查清单**：服务端 ready、插件恢复、事件状态、新消息入站 |

## 阅读顺序

1. [openbridge-feature-analysis.md](openbridge-feature-analysis.md) ← **新文档：功能全面分析**
2. [openbridge-channel-design.md](openbridge-channel-design.md)
3. [openbridge-communication-mechanism.md](openbridge-communication-mechanism.md)
4. [openbridge-debugging-guide.md](openbridge-debugging-guide.md)
5. [openbridge-recovery-checklist.md](openbridge-recovery-checklist.md)

## 当前重点观察项

- 服务端 `/api/openclaw/health` 是否 ready。
- 设备注册是否成功。
- WebSocket 是否连接并持续心跳。
- 新消息是否进入 `pending -> received -> processed`。
- sidecar 是否发生 watchdog 重启。