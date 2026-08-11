# Pi-OneSSH

Pi-OneSSH 是 OneSSH 的原生 Pi 扩展。它在不修改 OneSSH 服务端的前提下，把现有 `/mcp` 中的 32 个 Agent 工具注册为命名空间隔离的 `onessh_*` 工具。

扩展使用一个针对 OneSSH 的轻量 Streamable HTTP MCP 客户端，并将性能优化集中在 Pi 一侧：静态 schema、懒协议协商、连接复用、按组激活工具、默认参数注入和紧凑输出。

## 优化方式

### 减少模型上下文

通用 MCP 客户端通常先执行 `tools/list`，再把全部工具 schema 加入模型上下文。Pi-OneSSH 在本地维护静态 TypeBox schema：

- 正常会话不调用 `tools/list`。
- 默认只激活 13 个业务工具和一个 `onessh_tools` 加载器。
- `jobs`、`memory`、`monitor`、`management` 在需要时追加。
- 已激活的其他 Pi 工具不会被移除。

这不会改变 OneSSH 的服务端行为，主要减少首轮工具 schema token、工具选择干扰和无关管理工具的误调用风险。

### 精简 MCP 生命周期

客户端优先使用 OneSSH 当前支持的 MCP `2026-07-28`：

1. 第一次 OneSSH 调用时懒执行一次 `server/discover`。
2. 并发到达的首次调用共享同一个协商 Promise。
3. 后续直接发送 `tools/call`，不重复协商。
4. 每个请求携带协议 `_meta`、`Mcp-Method` 和 `Mcp-Name`。
5. HTTP AbortSignal 会传播到 OneSSH，进而取消正在执行的工具。

旧版 MCP 服务端会自动回退到 `2025-11-25 initialize` 和 `notifications/initialized`。客户端同时支持 `application/json` 与 `text/event-stream` 响应，但不加载完整 MCP SDK 中本扩展不需要的 resources、prompts、sampling、subscriptions 等功能。

### 减少结果 token

扩展优先使用 MCP `structuredContent`，再按工具类型转换：

- `hosts_list` 输出紧凑主机表。
- `file_list` 输出类 `ls` 列表。
- `grep`、`find` 输出可直接定位的行。
- `exec` 保留退出码、cwd、截断状态和 `artifact_id`。
- `job_logs` 与 `tail=true` 的命令保留尾部。
- 图片直接映射为 Pi 图片内容块。
- 所有文本遵守 Pi 的 50 KiB 或 2000 行限制。

MCP 自动生成的结构化 JSON 文本 fallback 不会和扩展格式化结果重复进入模型上下文。

## 边界

Pi-OneSSH 不修改或代理 OneSSH，因此不能减少服务端 JSON-RPC 校验、Bearer 鉴权、审计写入、网络 RTT、SSH 握手或远端命令耗时。优化目标是客户端启动、模型上下文、连续调用固定开销和结果 token，而不是改变 SSH/SFTP 本身的性能。

扩展只依赖 OneSSH 的公开 MCP 契约。OneSSH 可以继续使用官方二进制或容器更新，无需维护服务端补丁。

## 前置条件

- Node.js 22.19 或更新版本
- Pi 0.84.1 或兼容版本
- 可访问的 OneSSH `/mcp` 端点
- OneSSH Agent 令牌，或由外部流程维护的 OAuth 访问令牌

推荐使用 OneSSH 控制台创建的主机范围 Agent 令牌。扩展可以发送 OAuth Bearer 访问令牌，但当前不负责浏览器授权和刷新令牌轮换。

## 安装

在本目录执行：

```bash
npm install
pi install .
```

只在当前项目安装：

```bash
pi install . -l
```

开发阶段临时加载：

```bash
pi -e ./extensions/onessh/index.ts
```

Pi package 的运行时只使用 Pi 自带的 `@earendil-works/pi-*`、`typebox` 和 Node Fetch，不附带 MCP SDK。

## 快速配置

推荐把令牌放在环境变量中：

```bash
export ONESSH_TOKEN='osh_REPLACE_ME'
pi
```

进入 Pi 后运行：

```text
/onessh-config
```

配置向导可以设置：

- OneSSH 服务器来源地址
- 令牌来源：环境变量或全局 `0600` 配置文件
- 默认主机
- `exec` 和 `session_env` 的默认会话标签
- 默认 HTTP 请求超时
- 启动时激活的工具组
- 健康检查、MCP 协商、目录兼容性和 `hosts_list` 调用
- 全局或项目配置清理

命令参数：

| 命令 | 作用 |
| --- | --- |
| `/onessh-config` | 打开配置范围选择和完整向导 |
| `/onessh-config global` | 编辑全局连接与默认行为 |
| `/onessh-config project` | 编辑当前项目的行为覆盖 |
| `/onessh-config show` | 显示当前生效配置，令牌始终隐藏 |
| `/onessh-config test` | 检查健康、MCP 版本、32 个工具和主机访问 |
| `/onessh-config clear-global` | 删除全局配置 |
| `/onessh-config clear-project` | 删除项目配置 |

配置保存后立即生效，不需要 `/reload`。

## 配置范围与安全

全局配置位于：

```text
$PI_CODING_AGENT_DIR/onessh.json
```

未设置 `PI_CODING_AGENT_DIR` 时默认为：

```text
~/.pi/agent/onessh.json
```

项目配置位于：

```text
<project>/.pi/onessh.json
```

服务器地址和令牌来源组成不可拆分的全局连接配置。项目配置只能覆盖：

- `defaultHost`
- `session`
- `timeoutMs`
- `initialGroups`

项目文件中的 `baseUrl` 和 `auth` 字段即使被手工加入也会被忽略。这可以防止项目把全局令牌继承后发送到项目指定的其他地址。项目配置仅在 Pi 已信任当前项目时加载。

环境变量认证是默认方式。选择“保存令牌到全局配置”时，扩展会原子写入文件，并在支持 POSIX 权限的平台设置为 `0600`。生产环境应使用 HTTPS，并为 OneSSH 配置稳定的 `ONESSH_PUBLIC_URL`。

## 工具组

| 组 | 默认激活 | 工具 |
| --- | :---: | --- |
| `core` | 是 | `onessh_hosts_list` |
| `execution` | 是 | `onessh_exec`、`onessh_session_env`、`onessh_exec_many`、`onessh_output_read` |
| `files` | 是 | `onessh_file_read`、`onessh_file_write`、`onessh_file_edit`、`onessh_file_list`、`onessh_file_transfer`、`onessh_image_view` |
| `search` | 是 | `onessh_grep`、`onessh_find` |
| `jobs` | 否 | `onessh_job_start`、`onessh_job_list`、`onessh_job_status`、`onessh_job_logs`、`onessh_job_kill` |
| `memory` | 否 | `onessh_memory_remember`、`onessh_memory_recall`、`onessh_memory_list`、`onessh_memory_update`、`onessh_memory_forget`、`onessh_memory_stats`、`onessh_memory_sleep` |
| `monitor` | 否 | `onessh_host_status` |
| `management` | 否 | `onessh_hosts_manage_list`、`onessh_host_create`、`onessh_host_update`、`onessh_host_test`、`onessh_host_reset_fingerprint`、`onessh_host_delete` |

按需启用示例：

```json
{
  "groups": ["jobs", "memory"]
}
```

`onessh_tools` 只追加工具，不移除其他扩展或当前会话已经启用的工具。管理组需要令牌具有 `manage_hosts` 权限；该权限不会扩大远程执行主机范围。

## 默认参数

大部分单主机工具允许省略 `host`，此时使用 `/onessh-config` 设置的默认主机。以下情况仍要求显式参数：

- `onessh_exec_many` 的 `hosts`
- `onessh_file_transfer` 的 `src_host` 和 `dst_host`
- 主机管理工具的目标主机

记忆工具不会自动套用默认主机，因为省略 `host` 在 OneSSH 中表示全局记忆库。

`onessh_exec` 和 `onessh_session_env` 省略 `session` 时使用扩展配置的会话标签。`onessh_memory_remember` 省略 `source` 时自动使用 `pi`。

## MCP 契约

扩展调用原生端点：

```text
POST <baseUrl>/mcp
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json, text/event-stream
```

正常会话不会请求 `tools/list`。运行 `/onessh-config test` 时会显式读取完整目录，并检查扩展所需的 32 个工具是否全部存在；服务端新增工具只会提示，不会破坏现有扩展。

扩展优先读取 `structuredContent`。服务端返回 `isError=true` 或 JSON-RPC error 时，扩展会抛出 Pi 工具错误，而不是把错误包装成看似成功的文本结果。

## 开发验证

```bash
npm run typecheck
npm test
npm run check
npm pack --dry-run
```

验证 Pi 实际 Jiti loader：

```bash
node --input-type=module -e '
import { discoverAndLoadExtensions } from "./node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const result = await discoverAndLoadExtensions(["./extensions/onessh/index.ts"], process.cwd());
console.log({ errors: result.errors, tools: result.extensions[0]?.tools.size });
'
```

预期结果为 0 个加载错误、33 个工具定义和一个 `/onessh-config` 命令。

测试套件覆盖现代 MCP、SSE、共享懒协商、旧版回退、显式目录分页、工具错误、超时、配置凭据边界和工具组激活。开发验证还应确认 OneSSH 原仓库没有由本扩展产生的有效内容 diff。

## 许可证

GPL-3.0-only，与 OneSSH 项目保持一致。
