# agent-gateway

本机 Agent HTTP 网关（NestJS）。一键二进制启动；按挂载的 Provider 配置对应密钥。

## 一键启动

```bash
pnpm install && pnpm pack:bin
# 使用 Cursor provider 时：
export CURSOR_API_KEY=cursor_...
./release/agent-gateway
```

打开终端打印的 UI。未设 `AGENT_GATEWAY_TOKEN` 时会自动生成。

依赖：系统 **Node ≥ 22.13**。

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
