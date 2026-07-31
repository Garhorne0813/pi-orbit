# Pi Orbit 通用性整改记录

## 结论

Pi Orbit 仍然是通用的单用户 Agent Runtime Host，没有在运行时核心中依赖 Pi Science 的任务、artifact、review、数据库或前端协议。本轮整改进一步收紧了通用边界：Pi Orbit 负责 Runtime 生命周期、会话身份、workspace 约束、认证、事件和 Pi 资源加载；具体产品负责进程监督、业务状态、事件持久化和领域对象。

一个 Pi Orbit 进程可以承载同一操作系统用户、同一信任域内的多个 workspace。这里的“隔离”是 Runtime 状态隔离，不是 Provider 凭据、skills、extensions、MCP、文件系统权限或网络权限的安全隔离。需要不同凭据或安全边界时，仍应启动不同进程或容器。

## 本轮发现的问题

| 问题 | 影响 | 整改结果 |
|---|---|---|
| `sessionDir` 被 API 强制要求 | 控制平面必须了解 Pi 的存储布局 | 改为可选；省略时继承启动 Runtime 的持久化策略和目录 |
| 打开已有 session 时隐式覆盖 cwd | 可能把其他 workspace 的历史错误挂到当前 Runtime | Runtime 绑定规范化 `workspaceCwd`，跨 workspace 创建、resume 和 switch 返回 409 |
| Web 模式无法完成项目资源信任决策 | 动态 workspace 加载 extension/skill 时可能需要终端交互 | 新增通用 Project Trust API，创建 Runtime 前可查询和设置决策 |
| 资源加载错误只留在内部诊断 | 控制平面可能得到一个部分可用的 Runtime | descriptor 返回 diagnostics；初始化含 error 时返回 422 并销毁 Runtime |
| 浏览器原生 WebSocket/EventSource 不能设置 Bearer Header | 桌面 Web UI 必须额外实现 Header 注入代理 | 新增 Bearer 到 HttpOnly Cookie 的一次性交换接口 |
| loopback 默认发送宽松 CORS | 本机其他网页可发起跨域请求 | 默认不发送 CORS 许可头，只有显式配置 Origin 才启用 |
| Runtime prompt 限流键未稳定使用 `runtimeId` | 不同 Runtime 可能共享限流桶或绕过限流 | 修正参数键并调整中间件注册顺序，按 Runtime 独立限流 |
| Runtime descriptor 缺少存储和 workspace 信息 | 重启恢复与状态对账需要额外推断 | 增加 `sessionDir`、`workspaceCwd`、`persisted`、`diagnostics` |

## API 变化

### 创建 Runtime

`POST /api/runtimes` 的最小请求现在只有：

```json
{
  "cwd": "/absolute/path/to/workspace"
}
```

可选字段包括 `sessionDir`、`sessionPath`、`cwdOverride`、`model`、`thinking` 和 `runtimeEnv`。`cwdOverride` 仅用于明确迁移已有 session，并且必须与 `cwd` 解析到同一个规范路径。

Runtime descriptor 新增：

- `workspaceCwd`：Runtime 创建后不可变的规范 workspace 路径。
- `sessionDir`：持久化目录；内存会话为 `null`。
- `persisted`：SessionManager 是否启用持久化。
- `diagnostics`：extension、skill、prompt template 等资源的加载诊断。

新增稳定错误：

- `runtime_workspace_mismatch`（HTTP 409）：session 属于其他 workspace。
- `project_trust_required`（HTTP 409）：必须先作出项目信任决策。
- `runtime_initialization_failed`（HTTP 422）：资源加载包含 error，响应附带 diagnostics。

### Project Trust

```text
GET /api/project-trust?cwd=<absolute-path>
PUT /api/project-trust
```

PUT 请求体：

```json
{
  "cwd": "/absolute/path/to/workspace",
  "decision": true
}
```

`true` 表示信任项目资源，`false` 表示不加载需要信任的项目资源，`null` 表示清除已保存的决定。该接口是通用的 Pi 资源信任控制，不包含任何 Pi Science 语义。

### 浏览器认证

```text
POST /api/auth/session
DELETE /api/auth/session
```

POST 使用已有 `Authorization: Bearer <token>` 认证，成功后设置 `HttpOnly; SameSite=Strict` 的 `pi_web_auth` Cookie。同源的 fetch、EventSource 和 WebSocket 随后可直接使用 Cookie。Bearer Token 仍应只交给可信桌面壳层或后端，不应写入浏览器页面、localStorage 或 URL。

## 通用边界

Pi Orbit 核心应继续保留：

- Runtime 创建、销毁、恢复、fork、compact 和并发租约。
- `runtimeId` 与 `piSessionId` 的明确区分。
- workspace 绑定、Session 所有权冲突和资源信任。
- Provider/模型选择、Pi 工具、skills/extensions 命令目录。
- REST、SSE、WebSocket、事件序号和短期回放。
- 进程级认证、容量、限流和健康状态。

以下能力不应放入 Pi Orbit 核心：

- Pi Science 的 task、run、artifact、review、experiment 等数据模型。
- 产品数据库写入、业务状态机和前端专用事件转换。
- Runtime 事件的长期持久化与跨进程队列。
- 桌面应用的进程拉起、崩溃重启和安装升级策略。
- 多租户授权、资源配额计费和操作系统级沙箱。

上层控制平面可以把这些领域能力建立在通用 Runtime API 之上，而不要求 Pi Orbit 感知具体产品。

## 兼容性说明

`/api/sessions` 保留为兼容接口，新控制平面应优先使用 `/api/runtimes`。本轮没有删除已有 Session API，也没有改变 Provider、skills、extensions 或 MCP 的进程级共享定位。

因为 workspace 绑定现在会拒绝隐式跨目录打开 session，依赖旧行为的调用方需要显式迁移 session 元数据，或在目标 workspace 中创建新 session。这个限制用于避免工具在错误目录执行，不应通过自动重写 cwd 绕过。

## 验证

新增或扩展的回归覆盖：

- 省略 `sessionDir` 时继承宿主存储策略。
- 创建和 resume 均拒绝跨 workspace session。
- 未决项目资源信任阻止创建，设置决定后可重试成功。
- 资源加载 error 以结构化 422 返回。
- 不同 Runtime 使用独立 prompt 限流桶。
- loopback 默认禁用 CORS。
- Bearer Token 可交换为 Cookie，HTTP 与 WebSocket 都可使用。

验证命令：

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/web-mode-server.test.ts

cd ../..
npm run check
./test.sh
```

## 后续可选优化

以下事项不阻塞个人桌面使用，但可继续增强通用宿主能力：

1. 持久化 Runtime 注册表或提供标准恢复清单，减少进程重启后的对账工作。
2. 为运行中的 Runtime 增加显式资源 reload API，而不是依赖 extension 命令。
3. 为 legacy `/api/sessions` 响应增加正式的弃用版本策略。
4. 提供可插拔的事件持久化接口；默认实现仍保持内存环形缓冲。
5. 增加按 Runtime 的资源摘要端点，展示已加载的 skills、extensions 和 MCP adapter 状态。

这些能力应保持产品无关，且不改变当前“单用户、单信任域、共享应用资源”的定位。
