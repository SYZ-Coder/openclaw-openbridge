# OpenBridge 使用指南

## 1. 基本配置

当前有效配置位于：

- `~/.openclaw/openclaw.json` (Linux/Mac)
- `%USERPROFILE%\.openclaw\openclaw.json` (Windows)

关键项：

- `channels.openbridge.baseUrl`
- `channels.openbridge.websocketUrl`
- `channels.openbridge.clientId`
- `channels.openbridge.token`
- `channels.openbridge.stateDir`

建议生产环境使用稳定域名或服务名，不要把临时物理机 IP 写死在配置里。

## 2. 启动顺序

推荐顺序：

1. 启动 Spring Boot 服务。
2. 确认 `/api/openclaw/health` 返回 ready。
3. 启动 OpenClaw gateway。

插件会在注册设备前先做健康检查，服务未 ready 时会进入降级并等待重连。

## 3. 正常运行日志

插件上线后应看到：

- `bridge ready check success`
- `device register success`
- `websocket connected`
- `sidecar ready`

发送消息后应看到：

- `inbound message`
- `direct reply send done`
- `processed ack done`

## 4. 重启后的正确行为

重启后：

- 已完成消息不应再次进入插件处理。
- 未完成消息可以重新投递。
- 新消息应继续实时进入插件。
- 浏览器页面可以展示历史会话，但这只是 UI 查询历史，不代表插件重新处理历史消息。

## 5. 本地状态文件

`stateDir` 下的状态文件只保存：

- 近期 eventId 去重记录
- runtime phase 和 reason

删除该文件不会删除云服务消息，只会丢失插件本地短期去重和状态展示信息。