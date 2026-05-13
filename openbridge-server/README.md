# Spring IM Demo Server

`openbridge-server` 是当前 `openbridge` 链路里的最小云服务后端。

## 当前职责

服务端负责：

- 设备注册
- 健康检查 `/api/openclaw/health`
- WebSocket 会话管理
- 用户消息事件持久化
- `pending` backlog 投递
- reply 持久化
- ack 后事件状态推进

当前语义已经收敛为：

- 只把 `pending` 当 backlog
- 已 `processed` 的历史消息不会在重连后重放
- 未完成消息只会在原会话失效或租约超时后回队

## 当前主链

```text
create user message
  -> persist pending event
  -> per-client delivery worker
  -> websocket message
  -> client.ack(received)
  -> client.reply
  -> persist reply
  -> mark event processed
  -> client.ack(processed)
```

## 启动要求

这个项目必须用 **JDK 17+**。

```powershell
# 设置 JAVA_HOME (示例)
$env:JAVA_HOME='path/to/your/jdk17'
$env:Path="$env:JAVA_HOME\bin;$env:Path"

# 进入项目目录
Set-Location openbridge-server

# 编译和测试
mvn -DskipTests compile
mvn test
```

## 测试覆盖

当前最小集成测试已经覆盖：

- 在线收消息 -> `ack(received)` -> `reply` -> `ack(processed)`
- 连续两条在线消息都能处理完成
- 重连后不重放已完成历史，但会重投未完成消息
