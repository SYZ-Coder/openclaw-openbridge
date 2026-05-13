# OpenBridge 恢复检查清单

## 1. 服务端是否 ready

确认：

- `GET /api/openclaw/health` 返回 200。
- 服务端日志显示启动完成。

如果服务端尚未 ready，插件注册失败是预期现象，等待重连即可。

## 2. 插件是否恢复注册

确认网关日志里有：

- `bridge ready check success`
- `device register success`
- `websocket connected`
- `sidecar ready`

没有这几步时，先看连接和注册，不要先看业务回复。

## 3. 服务端事件状态是否正确

查看 `events.json`：

- 已完成消息应为 `processed`。
- 未完成消息可以等待新会话投递。
- 长时间停在 `received` 的事件应由服务端租约扫描恢复。

## 4. 新消息是否实时入站

创建新消息后，插件日志应很快出现：

- `inbound message`
- `direct reply send done`
- `processed ack done`

## 5. 插件本地状态是否健康

查看 `default.state.json`：

- `dedup` 只保存近期 eventId。
- `runtime.phase` 表示当前运行阶段。
- `runtime.reason` 表示最近一次降级原因。

该文件不承担消息恢复职责。
