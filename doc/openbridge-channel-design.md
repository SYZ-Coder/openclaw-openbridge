# OpenBridge Channel Design

## 1. 目标

目标不是让插件自己实现一套消息同步系统，而是让三层边界保持清楚：

- 云服务负责可靠投递和事件状态。
- SDK 负责连接、注册、心跳和消息回调。
- 插件负责业务处理和回复。

## 2. 三层边界

### 云服务

项目：

- `openbridge-server`

职责：

- 保存用户消息事件。
- 维护当前在线 WebSocket 会话。
- 投递未完成事件。
- 接收 `client.reply` 并保存回复。
- 接收 `client.ack` 并推进事件状态。
- 在会话失效后恢复未完成事件。

### SDK

项目：

- `openbridge-sdk`

职责：

- 加载设备身份。
- 探测云服务健康状态。
- 注册设备。
- 建立 WebSocket 连接。
- 维护心跳。
- 将服务端消息交给上层回调。
- 发送 ack 和 reply frame。

### 插件

项目：

- `openbridge-channel`

职责：

- 读取 OpenClaw channel 配置。
- 启动账号 sidecar runtime。
- 消费 SDK 的入站消息。
- 调用 OpenClaw runtime 生成回复。
- 通过 SDK 回传 reply。

## 3. 本地状态设计

插件本地状态文件只保存：

- `dedup`：近期 eventId 去重表，默认短 TTL。
- `runtime`：运行阶段和最近错误原因。
- `updatedAt`：状态更新时间。

本地状态不保存消息历史，不保存发送队列，不保存跨重启同步进度。

## 4. 主运行链

```text
User message created in service
  -> service marks event pending
  -> service pushes message over WebSocket
  -> plugin ack(received)
  -> plugin dispatches to OpenClaw
  -> plugin sends client.reply
  -> service persists reply and marks event processed
  -> plugin ack(processed)
```

## 5. 恢复链

```text
service or gateway restarts
  -> SDK waits for health ready
  -> device register
  -> websocket reconnect
  -> service registers current session
  -> service delivers unfinished events
```

恢复判断来自服务端事件状态，插件本地只提供短期重复保护。

## 6. 当前限制

插件侧已经收敛到最小本地状态。服务端仍是单机 demo 存储和单机会话表；正式生产高并发、多实例和持久化能力需要在服务端继续增强。