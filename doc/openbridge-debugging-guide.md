# OpenBridge 排障指南

## 1. 先判断卡在哪一层

优先按三层定位：

1. 云服务是否 ready。
2. 插件 sidecar 是否注册并连接 WebSocket。
3. 消息是否已进入插件业务处理。

不要先怀疑模型回复逻辑。先确认消息是否真的到达插件。

## 2. 看服务端

关注文件和接口：

- `openbridge-server`
- `{storageDir}/events.json`
- `{storageDir}/replies.json`
- `GET /api/openclaw/health`

重点字段：

- `status`
- `lastError`
- `deliverySessionId`
- `deliveryLeaseUntil`

判断方式：

- `pending`：等待当前在线会话投递或重新投递。
- `received`：插件已收到但还没完成处理。
- `processed`：主链路已经完成。
- `failed`：插件处理失败，服务端保留错误信息。

## 3. 看插件

日志文件：

- `C:\tmp\openclaw\openclaw-YYYY-MM-DD.log`

重点日志：

- `bridge ready check success`
- `device register success`
- `websocket connected`
- `sidecar ready`
- `inbound message`
- `direct reply send done`
- `processed ack done`

本地状态文件：

- `{stateDir}/{accountId}.state.json`

该文件只应包含短期去重和运行状态。它不应该被当成消息恢复队列。

## 4. 重启场景预期

服务端或网关重启后，正常顺序是：

1. health ready。
2. device register success。
3. websocket connected。
4. sidecar ready。
5. 服务端只投递未完成事件。
6. 新消息继续实时进入插件。

如果重启后没有响应，优先看：

- sidecar 是否被 watchdog 重启。
- WebSocket 是否持续心跳。
- 事件是否停在 `pending` 或 `received`。
- 服务端当前会话是否还是旧 session。