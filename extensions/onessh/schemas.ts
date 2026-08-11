import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import type { ToolGroup } from "./config.js";

export interface OneSSHToolSpec {
	remoteName: string;
	name: string;
	label: string;
	group: ToolGroup;
	description: string;
	parameters: TSchema;
	defaultHostField?: "host";
}

const host = (
	description = "SSH 主机名；省略时使用 /onessh-config 设置的默认主机",
) => Type.Optional(Type.String({ description }));
const requiredHost = (description = "SSH 主机名") =>
	Type.String({ description });
const empty = Type.Object({});
const environment = Type.Record(Type.String(), Type.String());
const authType = StringEnum(["key", "password"] as const, {
	description: "认证方式",
});
const veracity = StringEnum(
	["stated", "inferred", "tool", "unknown"] as const,
	{
		description: "可信类型",
	},
);

const spec = (
	remoteName: string,
	label: string,
	group: ToolGroup,
	description: string,
	parameters: TSchema,
	defaultHostField?: "host",
): OneSSHToolSpec => ({
	remoteName,
	name: `onessh_${remoteName}`,
	label,
	group,
	description,
	parameters,
	defaultHostField,
});

export const TOOL_SPECS: OneSSHToolSpec[] = [
	spec(
		"hosts_list",
		"OneSSH Hosts",
		"core",
		"列出当前令牌可访问的 OneSSH 主机及在线状态。其他 OneSSH 工具的 host 参数必须来自这里。",
		empty,
	),
	spec(
		"exec",
		"OneSSH Exec",
		"execution",
		"通过 OneSSH 在一台授权主机同步执行 shell 命令。cwd 按 host+session 持久保存；长任务使用 onessh_job_start，大输出用 onessh_output_read。",
		Type.Object({
			host: host(),
			command: Type.String({ description: "交给远端 shell 执行的命令" }),
			session: Type.Optional(
				Type.String({ description: "持久会话标签，省略时使用插件配置" }),
			),
			timeout_s: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 600,
					description: "超时秒数，默认 60",
				}),
			),
			max_lines: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 5000,
					description: "返回最大行数，默认 200",
				}),
			),
			tail: Type.Optional(
				Type.Boolean({ description: "返回末尾行而不是开头行" }),
			),
		}),
		"host",
	),
	spec(
		"session_env",
		"OneSSH Session Env",
		"execution",
		"设置或删除 OneSSH 持久命令会话的环境变量。不要用它存储密码或令牌。",
		Type.Object({
			host: host(),
			session: Type.Optional(
				Type.String({ description: "会话标签，省略时使用插件配置" }),
			),
			set: Type.Optional(environment),
			unset: Type.Optional(Type.Array(Type.String())),
		}),
		"host",
	),
	spec(
		"exec_many",
		"OneSSH Exec Many",
		"execution",
		"在最多 16 台授权主机上并发执行同一条命令。每台输出最多 4096 字节，不生成 artifact。",
		Type.Object({
			hosts: Type.Array(Type.String(), {
				minItems: 1,
				description: "目标主机名列表",
			}),
			command: Type.String({ description: "每台主机执行的命令" }),
			timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
		}),
	),
	spec(
		"output_read",
		"OneSSH Output Read",
		"execution",
		"读取 onessh_exec 因输出过大而保存的 artifact，支持翻页和 Go 正则过滤。",
		Type.Object({
			artifact_id: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
			grep: Type.Optional(Type.String({ description: "Go 正则" })),
		}),
	),
	spec(
		"job_start",
		"OneSSH Job Start",
		"jobs",
		"在远程主机启动断开 SSH 后仍继续运行的后台任务，返回 job_id 和 PID。",
		Type.Object({
			host: host(),
			command: Type.String(),
			cwd: Type.Optional(Type.String({ description: "工作目录，默认 ~" })),
			env: Type.Optional(environment),
		}),
		"host",
	),
	spec(
		"job_list",
		"OneSSH Job List",
		"jobs",
		"列出当前令牌启动的后台任务；host 省略时列出所有授权主机上的任务。",
		Type.Object({ host: Type.Optional(Type.String()) }),
	),
	spec(
		"job_status",
		"OneSSH Job Status",
		"jobs",
		"刷新并返回后台任务状态、退出码和日志字节数。",
		Type.Object({ job_id: Type.String() }),
	),
	spec(
		"job_logs",
		"OneSSH Job Logs",
		"jobs",
		"读取后台任务日志，可按尾部行、扩展正则或字节偏移增量读取。",
		Type.Object({
			job_id: Type.String(),
			tail_lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
			grep: Type.Optional(Type.String()),
			offset_bytes: Type.Optional(Type.Integer({ minimum: 1 })),
		}),
	),
	spec(
		"job_kill",
		"OneSSH Job Kill",
		"jobs",
		"终止后台任务。优先 TERM，确认无效后再使用 KILL。",
		Type.Object({
			job_id: Type.String(),
			signal: Type.Optional(StringEnum(["TERM", "KILL"] as const)),
		}),
	),
	spec(
		"file_read",
		"OneSSH File Read",
		"files",
		"按行读取远程文本文件，返回内容、全文 SHA-256、字节数和总行数。二进制图片使用 onessh_image_view。",
		Type.Object({
			host: host(),
			path: Type.String(),
			offset: Type.Optional(Type.Integer({ minimum: 1 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
		}),
		"host",
	),
	spec(
		"file_write",
		"OneSSH File Write",
		"files",
		"原子覆盖远程文件并自动创建父目录。局部修改优先使用 onessh_file_edit。",
		Type.Object({
			host: host(),
			path: Type.String(),
			content: Type.String(),
			mode: Type.Optional(Type.String({ description: "八进制权限，如 0644" })),
		}),
		"host",
	),
	spec(
		"file_edit",
		"OneSSH File Edit",
		"files",
		"精确替换远程文本文件。每个 old_text 必须唯一匹配；传 expected_sha256 可防止并发覆盖。",
		Type.Object({
			host: host(),
			path: Type.String(),
			edits: Type.Array(
				Type.Object({
					old_text: Type.String(),
					new_text: Type.String(),
				}),
				{ minItems: 1 },
			),
			expected_sha256: Type.Optional(Type.String()),
		}),
		"host",
	),
	spec(
		"file_list",
		"OneSSH File List",
		"files",
		"列出远程目录的一层条目、大小、权限、时间和符号链接目标。",
		Type.Object({
			host: host(),
			path: Type.Optional(Type.String({ description: "默认登录目录" })),
		}),
		"host",
	),
	spec(
		"file_transfer",
		"OneSSH File Transfer",
		"files",
		"经网关在两台授权主机之间流式复制文件并校验 SHA-256，无需主机间互通 SSH。",
		Type.Object({
			src_host: requiredHost("源主机名"),
			src_path: Type.String(),
			dst_host: requiredHost("目标主机名"),
			dst_path: Type.String(),
		}),
	),
	spec(
		"image_view",
		"OneSSH Image View",
		"files",
		"读取并缩放远程 PNG、JPEG、GIF 或 WebP 图片，直接返回给支持图片的 Pi 模型。",
		Type.Object({
			host: host(),
			path: Type.String(),
			max_dim: Type.Optional(Type.Integer({ minimum: 1, maximum: 2048 })),
		}),
		"host",
	),
	spec(
		"grep",
		"OneSSH Grep",
		"search",
		"搜索远程文件内容，优先使用 rg，并自动降级到临时 helper 或纯 SFTP。返回结构化匹配和上下文。",
		Type.Object({
			host: host(),
			pattern: Type.String(),
			path: Type.Optional(Type.String()),
			glob: Type.Optional(Type.String()),
			ignoreCase: Type.Optional(Type.Boolean()),
			literal: Type.Optional(Type.Boolean()),
			context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
		}),
		"host",
	),
	spec(
		"find",
		"OneSSH Find",
		"search",
		"按 glob 查找远程路径，优先使用 fd/fdfind，并自动降级到 helper 或纯 SFTP。",
		Type.Object({
			host: host(),
			pattern: Type.String(),
			path: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000 })),
		}),
		"host",
	),
	spec(
		"memory_remember",
		"OneSSH Memory Remember",
		"memory",
		"保存长期有价值的运维事实。指定 host 写入主机 bank，留空写入全局 bank；禁止保存秘密。",
		Type.Object({
			host: Type.Optional(Type.String()),
			content: Type.String(),
			source: Type.Optional(Type.String()),
			importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			veracity: Type.Optional(veracity),
		}),
	),
	spec(
		"memory_recall",
		"OneSSH Memory Recall",
		"memory",
		"按当前问题召回运维记忆。指定 host 时合并主机与全局 bank；结果必须用现场状态验证。",
		Type.Object({
			host: Type.Optional(Type.String()),
			query: Type.String(),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
		}),
	),
	spec(
		"memory_list",
		"OneSSH Memory List",
		"memory",
		"按写入时间分页浏览一个记忆 bank；host 留空表示全局 bank。",
		Type.Object({
			host: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
		}),
	),
	spec(
		"memory_update",
		"OneSSH Memory Update",
		"memory",
		"修正已有记忆的正文、重要度或可信类型，避免产生互相矛盾的重复记录。",
		Type.Object({
			id: Type.Integer({ minimum: 1 }),
			content: Type.Optional(Type.String()),
			importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
			veracity: Type.Optional(veracity),
		}),
	),
	spec(
		"memory_forget",
		"OneSSH Memory Forget",
		"memory",
		"永久删除确认错误、失效或不应保存的记忆。事实变化优先使用 onessh_memory_update。",
		Type.Object({ id: Type.Integer({ minimum: 1 }) }),
	),
	spec(
		"memory_stats",
		"OneSSH Memory Stats",
		"memory",
		"统计当前令牌可见的全局和主机记忆 bank。",
		empty,
	),
	spec(
		"memory_sleep",
		"OneSSH Memory Sleep",
		"memory",
		"确定性整理一个记忆 bank：去重、衰减长期未用记忆并清理低分旧记录。",
		Type.Object({ host: Type.Optional(Type.String()) }),
	),
	spec(
		"host_status",
		"OneSSH Host Status",
		"monitor",
		"读取 CPU、内存、负载与磁盘快照；fresh=true 会立即登录主机采样。",
		Type.Object({
			host: host(),
			fresh: Type.Optional(Type.Boolean()),
		}),
		"host",
	),
	spec(
		"hosts_manage_list",
		"OneSSH Managed Hosts",
		"management",
		"列出网关中的完整主机配置。需要独立 manage_hosts 权限，不代表执行权限。",
		empty,
	),
	spec(
		"host_create",
		"OneSSH Host Create",
		"management",
		"新增 SSH 主机配置。创建后用 onessh_host_test 验证凭据并固定 TOFU 指纹。",
		Type.Object({
			name: Type.String(),
			addr: Type.String(),
			port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
			username: Type.String(),
			auth_type: authType,
			key_id: Type.Optional(Type.Integer({ minimum: 1 })),
			password: Type.Optional(Type.String()),
			jump_host: Type.Optional(Type.String()),
			monitor_enabled: Type.Optional(Type.Boolean()),
		}),
	),
	spec(
		"host_update",
		"OneSSH Host Update",
		"management",
		"整体替换主机配置。除密码可沿用外，应先读取完整配置再提交所有字段。",
		Type.Object({
			host: Type.String({ description: "当前主机名" }),
			name: Type.String({ description: "替换后的主机名" }),
			addr: Type.String(),
			port: Type.Integer({ minimum: 0, maximum: 65535 }),
			username: Type.String(),
			auth_type: authType,
			key_id: Type.Optional(Type.Integer({ minimum: 1 })),
			password: Type.Optional(Type.String()),
			jump_host: Type.Optional(Type.String()),
			monitor_enabled: Type.Optional(Type.Boolean()),
		}),
	),
	spec(
		"host_test",
		"OneSSH Host Test",
		"management",
		"测试已配置主机的网络、凭据和账号；首次成功会固定 TOFU 指纹。",
		Type.Object({ host: requiredHost() }),
	),
	spec(
		"host_reset_fingerprint",
		"OneSSH Reset Fingerprint",
		"management",
		"清除 TOFU 主机指纹。仅在确认主机密钥发生可信变更后使用。",
		Type.Object({ host: requiredHost() }),
	),
	spec(
		"host_delete",
		"OneSSH Host Delete",
		"management",
		"删除主机及授权、会话、任务记录、指标和主机记忆，不可撤销。",
		Type.Object({ host: requiredHost() }),
	),
];

export const TOOL_NAMES = new Set(TOOL_SPECS.map((item) => item.name));

export const GROUP_LABELS: Record<ToolGroup, string> = {
	core: "主机发现",
	execution: "命令执行",
	jobs: "后台任务",
	files: "文件与图片",
	search: "远程搜索",
	memory: "运维记忆",
	monitor: "资源监控",
	management: "主机管理（高权限）",
};
