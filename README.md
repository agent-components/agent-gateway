# agent-gateway

本机 Agent HTTP 网关（NestJS）。一键二进制启动；按挂载的 Provider 配置对应密钥。

## 背景与动机

我们要在本机起一个服务，让第三方按固定 HTTP 协议调用，背后可挂 Cursor、千问等多家 harness，并附带 Web 调试界面方便联调。业界已有 [ACP](https://agentclientprotocol.com/) 做 Client ↔ Agent 的标准会话；本项目选择另一条形状，差异见下。

### 与 ACP 对比

| 维度 | ACP | agent-gateway |
|------|-----|---------------|
| 角色 | Client 与单个 Agent 对等对话 | 本机网关：调用方 → Gateway → 多家 Provider |
| 交互 | JSON-RPC，可双向（含权限审批） | REST + SSE，单向控制面（create / resume / connect / steer / cancel） |
| 权限 | Agent 可 `request_permission`，由 Client 审批 | 不需要权限环；策略留在各 harness |
| 连接心智 | 会话式长连接（stdio / WebSocket / Streamable HTTP） | 普通 HTTP 多请求并行，互不占用一条会话管道 |
| 多厂家 | 各家各自当 ACP Agent，Client 分别连 | 一个进程内挂多个 Provider，对外一份 API |
| 中途注入（steer） | 协议侧尚在演进；**Cursor 的 ACP（`agent acp`）目前不支持 steer** | 一等能力：`POST /api/v1/chat/steer`（经 Cursor SDK 等 Provider 注入进行中的 run） |
| 调试体验 | 依赖 IDE / ACP Client | 自带 Web 调试页（`public/`，启动后浏览器打开） |
| 典型调用方 | IDE、ACP Client | curl、脚本、CI、内部平台、自有前端 |

一句话：ACP 适合「标准方式连上 Agent」；这里适合「本机一个 HTTP 口、无权限环、多 harness、能 steer、带 Web 调试页」。尤其对 Cursor，走 ACP 目前拿不到中途注入，网关通过 SDK 把 steer 暴露成稳定 HTTP。二者目标层不同，因此不实现 ACP。

> **关于 Cursor SDK 与 Web 调试页：** `@cursor/sdk` 提供 create / stream / steer（本地 run）/ cancel 等能力，足以支撑调试 UI 所需交互，但它是 **Node ≥ 22.13 专用**，不能在浏览器里直接跑。因此调试页必须经本机 HTTP 网关（本项目）再挂静态前端，而不是把 SDK 打进浏览器。

## 一键启动

本地打包：

```bash
pnpm install && pnpm pack:bin
# 使用 Cursor provider 时：
export CURSOR_API_KEY=cursor_...
./release/agent-gateway
```

或从 [GitHub Releases](https://github.com/agent-components/agent-gateway/releases) 下载对应平台产物（如 `agent-gateway-linux-x64`），赋予执行权限后直接跑。打 `v*` tag 并 push 会自动构建并挂上二进制。

打开终端打印的 UI。未设 `AGENT_GATEWAY_TOKEN` 时会自动生成。

依赖：系统 **Node ≥ 22.13**（产物内嵌 `@cursor/sdk` 的平台原生依赖，请下载与机器匹配的 asset）。

默认监听：`http://0.0.0.0:6090`  
机器可读契约：`GET /openapi.json`

## 环境变量

网关级（与具体厂家无关）：

| 变量 | 说明 |
|------|------|
| `AGENT_GATEWAY_TOKEN` | 可选；缺省自动生成 |
| `AGENT_GATEWAY_CWD` | 默认工作区 |
| `PORT` / `HOST` | 默认 `6090` / `0.0.0.0` |

Provider 级（按需选填，由对应 Provider 自行读取，多选一即可）：

| 变量 | 说明 |
|------|------|
| `CURSOR_API_KEY` | Cursor provider |
| `QWEN_API_KEY` | 预留：千问等后续 provider |

## OpenAPI（公开 Chat API）

以下接口需要鉴权，与 `/openapi.json` 一致。厂家密钥（如 `CURSOR_API_KEY`）**只读环境变量**，不出现在请求体中。

### 鉴权

`Authorization: Bearer <AGENT_GATEWAY_TOKEN>`

### 接口一览

| 方法 | 路径 | 说明 | 响应 |
|------|------|------|------|
| POST | `/api/v1/chat/create` | 新建会话并跑首轮 | SSE |
| POST | `/api/v1/chat/resume` | 在已有会话上续聊 | SSE |
| POST | `/api/v1/chat/connect` | 重连进行中的 run（先 replay 再 live） | SSE |
| POST | `/api/v1/chat/steer` | 向进行中的 run 注入文本 | JSON |
| POST | `/api/v1/chat/cancel` | 取消进行中的 run | JSON |

### 请求体

**POST `/api/v1/chat/create`**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | ✓ | 用户提示 |
| `model` | string | ✓ | 模型 id |
| `cwd` | string | ✓ | 工作区绝对路径 |
| `name` | string | | 会话名 |
| `mode` | string | | 如 `agent` / `plan`（视 Provider） |
| `mcpServers` | object | | MCP 服务配置 map |
| `providerOptions` | object | | Provider 扩展参数 |

**POST `/api/v1/chat/resume`**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | ✓ | 会话 id |
| `prompt` | string | ✓ | 用户提示 |
| `model` | string | | 模型 id |
| `cwd` | string | | 工作区 |
| `mcpServers` | object | | MCP |
| `providerOptions` | object | | 扩展参数 |

**POST `/api/v1/chat/connect`**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | ✓ | 会话 id |
| `runId` | string | | 指定 run；省略则用该 session 当前活跃 run |

**POST `/api/v1/chat/steer`**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | ✓ | 会话 id |
| `text` | string | ✓ | 注入文本 |

**POST `/api/v1/chat/cancel`**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sessionId` | string | ✓ | 会话 id |

### SSE 事件

`create` / `resume` / `connect` 返回 `Content-Type: text/event-stream`，事件类型：

| event | data | 说明 |
|-------|------|------|
| `message` | 统一消息信封 JSON | 流式片段（assistant / tool_call / thinking 等） |
| `result` | `{ sessionId, runId, status, text?, error?, … }` | 本轮结束摘要 |
| `done` | `{}` | 流结束 |
| `error` | `{ message, code? }` | 错误 |

`message` 信封至少包含：`type`、`sessionId`、`runId`（其余字段随 `type` 变化）。

### 示例

```bash
TOKEN=dev-secret   # 启动日志里打印的 token
BASE=http://127.0.0.1:6090

# 新建会话
curl -N -X POST "$BASE/api/v1/chat/create" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"hello","model":"composer-2.5","cwd":"/path/to/repo"}'

# 续聊
curl -N -X POST "$BASE/api/v1/chat/resume" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<id>","prompt":"继续","cwd":"/path/to/repo"}'

# 重连进行中的流
curl -N -X POST "$BASE/api/v1/chat/connect" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<id>"}'

# 中途注入
curl -X POST "$BASE/api/v1/chat/steer" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<id>","text":"改用 TypeScript"}'

# 取消
curl -X POST "$BASE/api/v1/chat/cancel" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"<id>"}'
```

## 结构

```
src/       # Nest API + providers/
public/    # 静态 UI（CDN React/antd）
scripts/pack-bin.mjs
```

## 开发

```bash
pnpm install && pnpm build && pnpm start
```
