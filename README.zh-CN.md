<div align="center">
  <h1>Pi Web</h1>
  <p><strong>基于 Pi Agent Harness、聚焦 Web 场景的非官方 fork。</strong></p>
  <p>
    你可以交互式运行 Pi，通过 SDK 或 RPC 嵌入 Pi，
    也可以在一个经过认证的 HTTP 进程中承载多个相互隔离的智能体会话。
  </p>
  <p>
    <a href="README.md">English</a>
    · <a href="#快速开始">快速开始</a>
    · <a href="#web-mode">Web Mode</a>
    · <a href="#架构">架构</a>
    · <a href="#开发">开发</a>
  </p>
  <p>
    <img src="https://img.shields.io/badge/status-unofficial%20fork-orange?style=flat-square" alt="非官方 fork" />
    <img src="https://img.shields.io/badge/Node.js-%E2%89%A522-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22+" />
    <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square" alt="MIT License" />
  </p>
</div>

---

> **非官方 fork：** Pi Web 是 [Pi Agent Harness](https://github.com/earendil-works/pi) 的独立 fork，与 Mario Zechner 或 Earendil Works 不存在隶属关系，也未获得其官方背书。

Pi Web 构建于 Pi 之上。Pi 是一个具备可靠默认能力和开放扩展模型的小型智能体框架，提供智能体循环、模型集成、会话持久化、终端界面、工具和传输层，同时把具体产品工作流交给扩展或宿主应用定义。

本仓库包含面向控制平面和浏览器产品的一等 Web mode。单个 `pi --mode web` 进程可以管理多个会话；每个会话都拥有独立的 `AgentSessionRuntime`、消息历史、模型状态、工作目录和事件流。

> 新贡献者提交的 Issue 和 Pull Request 会自动关闭并交由维护者审核。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 主要特性

| 领域 | Pi 提供的能力 |
|---|---|
| 编码智能体 | 内置 `read`、`write`、`edit` 和 `bash` 工具，支持模型流式输出 |
| 模型接入 | Anthropic、OpenAI、Google、Bedrock、OpenRouter、本地 OpenAI 兼容端点等 |
| 会话管理 | 持久化历史、分支、派生、上下文压缩、命名、导出和会话树导航 |
| 自定义 | TypeScript 扩展、技能、提示词模板、主题和可安装的 Pi 包 |
| 集成方式 | SDK、JSON 事件、stdin/stdout RPC、REST、WebSocket 和 SSE |
| Web 并发 | 在一个 Pi 进程中管理多个可独立寻址的智能体会话 |
| 部署能力 | 可选 Bearer 认证、可配置 CORS、提示请求限流和连接心跳 |

Pi 不强制内置子智能体或计划模式等工作流。你可以通过扩展和技能加入这些能力，也可以将运行时嵌入应用，由应用定义自己的工作流。

## 快速开始

### 环境要求

- Node.js 22.19 或更高版本
- API Key、受支持的服务商订阅，或可信的本地模型端点

### 从源码安装 Pi Web

```bash
git clone https://github.com/Garhorne0813/pi-web.git
cd pi-web
npm ci --ignore-scripts
```

`--ignore-scripts` 会禁用依赖生命周期脚本；Pi Web 的常规安装不依赖这些脚本。

配置模型服务商并启动交互式智能体：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
./pi-test.sh
```

你也可以在 Pi 中执行 `/login`，通过受支持的订阅服务商完成认证。

## 运行模式

| 模式 | 命令 | 用途 |
|---|---|---|
| 交互模式 | `pi` 或 `pi --mode text` | 完整终端界面，支持会话、主题、扩展和快捷键 |
| 打印模式 | `pi -p "prompt"` | 执行一次提示，输出最终回复后退出 |
| JSON 模式 | `pi --mode json "prompt"` | 以 JSON Lines 格式输出会话事件 |
| RPC 模式 | `pi --mode rpc` | 通过 stdin/stdout 上的 JSON-Line 协议控制 Pi |
| Web 模式 | `pi --mode web` | 提供 REST API、WebSocket 和 SSE 事件流 |

不同运行模式的详细说明参见[编码智能体指南](packages/coding-agent/README.md)、[JSON 协议](packages/coding-agent/docs/json.md)和 [RPC 协议](packages/coding-agent/docs/rpc.md)。

## Web Mode

Web mode 会把 Pi 转换为本地智能体服务。一个进程包含一个默认会话，并可通过 API 创建任意数量的动态会话。

### 启动服务

```bash
export PI_WEB_AUTH_TOKEN='replace-with-a-long-random-token'
export PI_WEB_CORS_ORIGIN='https://your-control-plane.example'

./pi-test.sh --mode web --host 127.0.0.1 --port 3000
```

| 设置 | 默认值 | 说明 |
|---|---|---|
| `--host`、`PI_WEB_HOST` | `127.0.0.1` | HTTP 监听地址 |
| `--port`、`PI_WEB_PORT` | `3000` | HTTP 端口，范围为 1–65535 |
| `--auth-token`、`PI_WEB_AUTH_TOKEN` | 未设置 | 进程级 Bearer Token |
| `PI_WEB_CORS_ORIGIN` | `*` | 允许访问的浏览器来源 |

健康检查端点无需认证。配置 Token 后，其他所有 `/api/*` 路由和 WebSocket 升级请求都必须通过认证。

### 创建会话并接收事件

```bash
BASE_URL=http://127.0.0.1:3000
AUTH_HEADER="Authorization: Bearer $PI_WEB_AUTH_TOKEN"

curl "$BASE_URL/api/health"

SESSION_ID=$(curl -fsS -X POST "$BASE_URL/api/sessions" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"cwd":"/absolute/path/to/project","name":"web session"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["sessionId"])')

# 发送提示前，在另一个终端中保持此请求运行。
curl -N "$BASE_URL/api/sessions/$SESSION_ID/events" -H "$AUTH_HEADER"
```

发送提示：

```bash
curl -fsS -X POST "$BASE_URL/api/sessions/$SESSION_ID/prompt" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d '{"message":"检查这个项目并总结其架构。"}'
```

提示预检成功后，接口返回 HTTP `202`。随后生成的回复和工具事件会继续通过 SSE 或 WebSocket 推送。预检失败会直接返回错误，不会再被静默接受。

### 会话 API

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/sessions` | 使用可选的 `cwd` 和 `name` 创建会话 |
| `GET` | `/api/sessions` | 列出当前进程管理的会话 |
| `GET` | `/api/sessions/:id` | 获取会话元数据 |
| `GET` | `/api/sessions/:id/state` | 获取模型、思考级别、流式和压缩状态 |
| `GET` | `/api/sessions/:id/stats` | 获取消息、Token、成本和上下文统计 |
| `GET` | `/api/sessions/:id/messages` | 获取当前消息历史 |
| `GET` | `/api/sessions/:id/entries?since=<id>` | 获取全部或增量会话条目 |
| `GET` | `/api/sessions/:id/tree` | 获取会话分支树和当前叶节点 |
| `GET` | `/api/sessions/:id/commands` | 获取扩展、提示模板和技能命令 |
| `GET` | `/api/sessions/:id/fork-messages` | 获取可作为派生点的用户消息 |
| `GET` | `/api/sessions/:id/last-assistant-text` | 获取最后一条助手文本 |
| `PATCH` | `/api/sessions/:id` | 使用 `{ "name": "..." }` 重命名会话 |
| `POST` | `/api/sessions/:id/switch` | 切换到 `{ "sessionPath": "...", "cwdOverride": "..." }` 指定的会话 |
| `POST` | `/api/sessions/:id/clone` | 在当前活动叶节点克隆会话 |
| `POST` | `/api/sessions/:id/restart` | 重建运行时，同时保持 Web 会话 ID 不变 |
| `POST` | `/api/sessions/:id/export` | 将持久化会话导出为 HTML |
| `DELETE` | `/api/sessions/:id` | 销毁动态会话 |

启动时创建的默认会话不能删除。如果需要替换其运行时，请调用 `restart` 端点。

### 智能体与模型 API

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/sessions/:id/prompt` | 提交 `{ "message": "..." }` |
| `POST` | `/api/sessions/:id/steer` | 将 `{ "message": "...", "images": [...] }` 加入 steering 队列 |
| `POST` | `/api/sessions/:id/follow-up` | 将消息加入当前轮次后的 follow-up 队列 |
| `POST` | `/api/sessions/:id/abort` | 中止当前智能体运行 |
| `POST` | `/api/sessions/:id/abort-bash` | 中止当前直接执行的 bash 命令 |
| `POST` | `/api/sessions/:id/abort-retry` | 中止自动重试等待 |
| `POST` | `/api/sessions/:id/bash` | 执行 shell 命令并返回结果 |
| `POST` | `/api/sessions/:id/compact` | 压缩上下文并返回压缩结果 |
| `POST` | `/api/sessions/:id/fork` | 在可选的 `entryId` 处派生会话 |
| `GET` | `/api/models?session_id=<id>` | 列出已配置认证的模型 |
| `POST` | `/api/sessions/:id/model` | 精确选择 `{ "provider": "...", "modelId": "..." }` |
| `POST` | `/api/sessions/:id/cycle-model` | 向前或向后循环切换模型 |
| `POST` | `/api/sessions/:id/thinking` | 设置 `off`、`minimal`、`low`、`medium`、`high` 或 `xhigh` |
| `POST` | `/api/sessions/:id/cycle-thinking` | 循环切换当前模型支持的思考级别 |
| `GET` | `/api/sessions/:id/thinking-levels` | 获取当前模型支持的思考级别 |
| `PUT` | `/api/sessions/:id/steering-mode` | 将队列模式设为 `all` 或 `one-at-a-time` |
| `PUT` | `/api/sessions/:id/follow-up-mode` | 设置 follow-up 队列模式 |
| `PUT` | `/api/sessions/:id/auto-compaction` | 开启或关闭自动压缩 |
| `PUT` | `/api/sessions/:id/auto-retry` | 开启或关闭自动重试 |

提示请求使用按会话划分的 Token Bucket 进行限流，当前默认值为每分钟 30 次。

### 事件传输

以下两种方式传输相同的序列化 `AgentSessionEvent` 事件流：

- SSE：`GET /api/sessions/:id/events`
- WebSocket：`GET /ws?session_id=<id>`

WebSocket 客户端还可以发送提示命令：

```json
{ "type": "prompt", "message": "运行相关测试。" }
```

客户端也可以用 `{ "type": "abort" }` 中止当前智能体运行。扩展调用 `ctx.ui` 时，会通过同一连接发送限定在当前 session 的 `extension_ui_request`；客户端使用 `extension_ui_response` 响应阻塞式对话框。通知、状态、标题、编辑器文本和字符串数组 widget 无需响应。完整格式参见 [Web mode 协议](packages/coding-agent/docs/web-mode.md#extension-ui-protocol)。

经过认证的 WebSocket 升级请求必须通过 HTTP Header 携带 `Authorization: Bearer <token>`。服务器会拒绝 URL query 中的 Token。Node 客户端和 `websocat` 等命令行客户端可以直接设置 Header：

```bash
websocat -H="Authorization: Bearer $PI_WEB_AUTH_TOKEN" \
  "ws://127.0.0.1:3000/ws?session_id=$SESSION_ID"
```

浏览器原生 `WebSocket` 和 `EventSource` API 无法设置任意认证 Header。在需要认证的浏览器部署中，应将 Pi 放在同源后端或反向代理之后，由该组件认证用户并注入 Pi Bearer Header。不要把 Token 放入浏览器可见的 URL。

## 架构

```mermaid
flowchart LR
    UI["终端、IDE、控制平面或 Web 应用"] --> T["Text / JSON / RPC / HTTP 传输层"]
    T --> CORE["智能体运行时"]
    CORE --> AI["多服务商模型 API"]
    CORE --> TOOLS["工具与扩展"]

    subgraph WEB["单个 Pi Web mode 进程"]
        API["Hono REST API"]
        EVENTS["WebSocket 与 SSE 事件分发"]
        HOST["WebSessionHost"]
        S1["AgentSessionRuntime A"]
        S2["AgentSessionRuntime B"]
        SN["AgentSessionRuntime N"]
        API --> HOST
        EVENTS --> HOST
        HOST --> S1
        HOST --> S2
        HOST --> SN
    end

    T --> API
```

Web mode 是构建在 `AgentSession` 之上的传输层，交互模式和 RPC 模式同样使用该会话核心。`WebSessionHost` 管理进程内会话注册表；`ConnectionManager` 把客户端订阅到正确的运行时，并在运行时替换底层会话后重新绑定事件流。

会话隔离是逻辑隔离，不是操作系统安全边界。不同会话具有独立的运行时状态，但共享 Pi 进程、主机凭据、文件系统权限和网络访问能力。

## 软件包

| 软件包 | 说明 |
|---|---|
| [@earendil-works/pi-ai](packages/ai) | 统一的多服务商 LLM API |
| [@earendil-works/pi-agent-core](packages/agent) | 智能体循环、工具调用、事件和状态管理 |
| [@earendil-works/pi-coding-agent](packages/coding-agent) | CLI、会话、工具、扩展、RPC 和 Web mode |
| [@earendil-works/pi-tui](packages/tui) | 使用差分渲染的终端 UI 库 |

编码智能体包还提供 SDK，应用可以直接嵌入 Pi，而不必启动传输服务。详见 [SDK 文档](packages/coding-agent/docs/sdk.md)。

## 安全与部署

Pi 使用启动它的操作系统用户权限运行。Web Token 用于认证整个进程，不提供会话级授权，也不会对工具执行进行沙箱隔离。

生产环境部署建议：

- 始终配置一个足够长且随机的 `PI_WEB_AUTH_TOKEN`。
- 除非可信网络路径确有需要，否则只监听 localhost。
- 在反向代理处终止 TLS 并限制请求体大小。
- 将 `PI_WEB_CORS_ORIGIN` 设置为准确的控制平面来源。
- 为互不信任的用户运行不同的 Pi 进程或容器。
- 在 Pi 外部施加 CPU、内存、文件系统和网络限制。
- 将 bash 端点和智能体工具视为 Pi 信任域内的远程代码执行能力。

服务器每 30 秒向 WebSocket 客户端发送一次 ping，并终止不再响应的连接。事件发送失败时也会关闭对应连接。会话注册表保存在内存中；使用持久化 `SessionManager` 的会话仍可把历史写入磁盘。

Gondolin、Docker 和 OpenShell 隔离方式参见[容器化指南](packages/coding-agent/docs/containerization.md)。将 Pi 暴露到本地信任边界以外之前，请先阅读 [SECURITY.md](SECURITY.md)。

## 开发

如果尚未完成[快速开始](#快速开始)，请克隆仓库并安装锁定的工作区依赖：

```bash
git clone https://github.com/Garhorne0813/pi-web.git
cd pi-web
npm ci --ignore-scripts
```

常用命令：

```bash
npm run check        # 格式化、Lint、依赖检查和 TypeScript 检查
./test.sh            # 非端到端测试套件
./pi-test.sh         # 直接从源码运行 Pi
./pi-test.sh --mode web --port 3000
```

构建和完整测试命令与 `npm run check` 相互独立：

```bash
npm run build
npm test
```

仓库开发规则参见 [AGENTS.md](AGENTS.md)，贡献者门槛和审查流程参见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 供应链加固

- 直接外部依赖锁定为精确版本。
- 除非生命周期脚本已明确审查，否则本地安装和 CI 均使用 `--ignore-scripts`。
- `package-lock.json` 是依赖版本的唯一依据。
- 发布的 coding-agent 包包含生成的 shrinkwrap，用于锁定传递依赖。
- `npm run check` 会验证依赖锁定、TypeScript import、shrinkwrap 和安装锁。
- 发布冒烟测试会先在仓库外安装未发布的 Node 和 Bun 产物，再创建版本标签。

## 文档

- [编码智能体指南](packages/coding-agent/README.md)
- [Web mode 协议](packages/coding-agent/docs/web-mode.md)
- [RPC 协议](packages/coding-agent/docs/rpc.md)
- [模型服务商配置](packages/coding-agent/docs/providers.md)
- [扩展](packages/coding-agent/docs/extensions.md)
- [技能](packages/coding-agent/docs/skills.md)
- [容器化](packages/coding-agent/docs/containerization.md)

上游 Pi 项目的网站和版本化文档位于 [pi.dev](https://pi.dev) 和 [pi.dev/docs/latest](https://pi.dev/docs/latest)。

## 参与贡献

欢迎提交 Issue 和 Pull Request。运行时行为变更应包含对应的回归测试。提交前请执行 [CONTRIBUTING.md](CONTRIBUTING.md) 要求的检查。

长期设计工作记录在 [Pi RFC](https://rfc.earendil.com/keyword/pi/) 中。

## 致谢

Pi Web 构建于 [Pi Agent Harness](https://github.com/earendil-works/pi) 之上。该项目由 [Mario Zechner](https://github.com/badlogic) 创建，并由 Earendil Works 及其贡献者维护。

本 fork 保留上游 MIT 许可证和版权声明。Pi Web 由独立维护者维护，不是 Pi 的官方发行版。

## 许可证

MIT

上游版权声明和许可证条款参见 [LICENSE](LICENSE)。
