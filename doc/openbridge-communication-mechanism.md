# OpenBridge 通信机制

## 1. 通信模式

当前实现采用 WebSocket 主链和最小 HTTP 控制面。

WebSocket 用于：

- `client.hello`
- `message`
- `client.ack`
- `client.reply`
- `client.ping`
- `server.pong`
- `server.bye`

HTTP 控制面仅用于：

- `GET /api/openclaw/health`
- `POST /api/openclaw/devices/register`

## 2. 服务端投递模型

服务端保存用户消息事件，并把可投递事件推给当前在线会话。

```text
new user message
  -> event status = pending
  -> delivery worker wakes up
  -> push to current WebSocket session
  -> client ack(received)
  -> client reply
  -> server persists reply
  -> event status = processed
```

如果会话关闭、心跳超时或投递租约过期，服务端会把未完成事件重新放回可投递状态，等待新会话上线。

## 3. 插件处理模型

插件收到 `message` 后：

1. 使用本地短 TTL 去重判断是否已处理过。
2. 发送 `ack(received)`。
3. 调用 OpenClaw runtime 处理消息。
4. 通过 WebSocket 发送 `client.reply`。
5. 发送 `ack(processed)`。
6. 把 eventId 写入本地短 TTL 去重表。

插件不会主动维护消息恢复进度，也不会保存本地消息历史。

## 4. 重启恢复语义

重启后的恢复判断由云服务事件状态决定：

- 已完成事件不再投递给插件。
- 未完成事件在新会话上线后重新投递。
- 插件本地状态文件只用于短期避免重复处理刚刚处理过的事件。

浏览器 demo 拉取历史会话用于展示，这不等于插件重新处理历史消息。
