import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
	truncateHead,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MCPContent, MCPToolResponse, OneSSHClient } from "./client.js";
import { TOOL_GROUPS, type OneSSHConfig, type ToolGroup } from "./config.js";
import {
	GROUP_LABELS,
	TOOL_NAMES,
	TOOL_SPECS,
	type OneSSHToolSpec,
} from "./schemas.js";

export const LOADER_TOOL_NAME = "onessh_tools";
const ALL_ONESSH_TOOL_NAMES = new Set([...TOOL_NAMES, LOADER_TOOL_NAME]);

export interface OneSSHRuntime {
	config: OneSSHConfig;
	client: OneSSHClient;
}

export function applyConfiguredTools(
	pi: ExtensionAPI,
	config: OneSSHConfig,
	ready: boolean,
): void {
	const external = pi
		.getActiveTools()
		.filter((name) => !ALL_ONESSH_TOOL_NAMES.has(name));
	if (!ready) {
		pi.setActiveTools(external);
		return;
	}
	const initial = toolsInGroups(config.initialGroups);
	pi.setActiveTools([...new Set([...external, LOADER_TOOL_NAME, ...initial])]);
}

function toolsInGroups(groups: readonly ToolGroup[]): string[] {
	const enabled = new Set(groups);
	return TOOL_SPECS.flatMap((item) =>
		enabled.has(item.group) ? [item.name] : [],
	);
}

export function registerOneSSHTools(
	pi: ExtensionAPI,
	getRuntime: () => OneSSHRuntime | undefined,
): void {
	for (const tool of TOOL_SPECS) registerMCPTool(pi, tool, getRuntime);
	registerLoaderTool(pi);
}

function registerMCPTool(
	pi: ExtensionAPI,
	tool: OneSSHToolSpec,
	getRuntime: () => OneSSHRuntime | undefined,
): void {
	pi.registerTool({
		name: tool.name,
		label: tool.label,
		description: `${tool.description} 通过 Pi-OneSSH 轻量 Streamable HTTP MCP 客户端调用。`,
		parameters: tool.parameters as never,
		async execute(_toolCallId, params, signal, onUpdate) {
			const runtime = getRuntime();
			if (!runtime) {
				throw new Error("OneSSH 尚未配置；请先运行 /onessh-config");
			}
			const input = { ...(params as Record<string, unknown>) };
			prepareInput(
				tool.remoteName,
				tool.defaultHostField,
				input,
				runtime.config,
			);
			onUpdate?.({
				content: [{ type: "text", text: progressText(tool.remoteName, input) }],
				details: { tool: tool.remoteName, transport: "mcp-lite" },
			});
			const started = performance.now();
			const response = await runtime.client.call(
				tool.remoteName,
				input,
				signal,
				requestTimeout(tool.remoteName, input, runtime.config.timeoutMs),
			);
			return toToolResult(
				tool.remoteName,
				input,
				response,
				performance.now() - started,
			);
		},
	});
}

function registerLoaderTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: LOADER_TOOL_NAME,
		label: "OneSSH Tools",
		description: `按需激活 OneSSH 工具组，减少初始工具 schema。可选组：${TOOL_GROUPS.map((group) => `${group}（${GROUP_LABELS[group]}）`).join("、")}。`,
		promptSnippet: "按需启用 OneSSH 的后台任务、记忆、监控或主机管理工具",
		promptGuidelines: [
			"Use onessh_hosts_list as the source of valid host names; do not guess host names.",
			"Prefer dedicated onessh_file_*, onessh_grep, and onessh_find tools over composing shell commands.",
			"Use onessh_job_start for long-running work and onessh_output_read for truncated command artifacts.",
			"Use onessh_tools when a needed OneSSH tool group is inactive; never store passwords, keys, or tokens in memory tools.",
		],
		parameters: Type.Object({
			groups: Type.Array(StringEnum(TOOL_GROUPS), {
				minItems: 1,
				description: "要激活的 OneSSH 工具组；只增加工具，不移除当前工具",
			}),
		}),
		async execute(_toolCallId, params) {
			const requested = [...new Set(params.groups as ToolGroup[])];
			const matches = toolsInGroups(requested);
			const active = pi.getActiveTools();
			const added = matches.filter((name) => !active.includes(name));
			pi.setActiveTools([...new Set([...active, ...added])]);
			return {
				content: [
					{
						type: "text",
						text:
							added.length > 0
								? `已激活 OneSSH 工具：${added.join(", ")}`
								: `工具组已激活：${requested.join(", ")}`,
					},
				],
				details: { groups: requested, added },
			};
		},
	});
}

function prepareInput(
	remoteName: string,
	defaultHostField: "host" | undefined,
	input: Record<string, unknown>,
	config: OneSSHConfig,
): void {
	if (defaultHostField && !input.host) {
		if (!config.defaultHost) {
			throw new Error(
				`onessh_${remoteName} 需要 host；请传入主机名或用 /onessh-config 设置默认主机`,
			);
		}
		input.host = config.defaultHost;
	}
	if (
		(remoteName === "exec" || remoteName === "session_env") &&
		!input.session
	) {
		input.session = config.session;
	}
	if (remoteName === "memory_remember" && !input.source) {
		input.source = "pi";
	}
}

function requestTimeout(
	remoteName: string,
	input: Record<string, unknown>,
	configured: number,
): number {
	if (remoteName === "file_transfer") return Math.max(configured, 610_000);
	if (remoteName === "exec" || remoteName === "exec_many") {
		const timeoutSeconds =
			typeof input.timeout_s === "number" ? input.timeout_s : 60;
		return Math.max(configured, timeoutSeconds * 1_000 + 10_000);
	}
	return configured;
}

function progressText(
	remoteName: string,
	input: Record<string, unknown>,
): string {
	const host = typeof input.host === "string" ? ` @ ${input.host}` : "";
	return `OneSSH ${remoteName}${host}（MCP）`;
}

function toToolResult(
	remoteName: string,
	input: Record<string, unknown>,
	response: MCPToolResponse,
	durationMs: number,
) {
	const content: Array<Record<string, unknown>> = [];
	if (remoteName === "image_view") {
		for (const item of response.content) {
			const converted = convertContent(item);
			if (converted) content.push(converted);
		}
	}

	const hasImageText =
		remoteName === "image_view" &&
		response.content.some((item) => item.type === "text" && item.text);
	if (!hasImageText) {
		const raw = formatOutput(remoteName, response.output);
		const truncation = shouldKeepTail(remoteName, input)
			? truncateTail(raw, {
					maxBytes: DEFAULT_MAX_BYTES,
					maxLines: DEFAULT_MAX_LINES,
				})
			: truncateHead(raw, {
					maxBytes: DEFAULT_MAX_BYTES,
					maxLines: DEFAULT_MAX_LINES,
				});
		let text = truncation.content;
		if (truncation.truncated) {
			text += `\n\n[Pi-OneSSH 本地截断：${truncation.outputLines}/${truncation.totalLines} 行，`;
			text += `${truncation.outputBytes}/${truncation.totalBytes} 字节。请缩小查询范围或使用分页参数。]`;
		}
		content.push({ type: "text", text });
	}

	return {
		content: content as never,
		details: {
			tool: remoteName,
			transport: "mcp-lite",
			durationMs: Math.round(durationMs),
		},
	};
}

function convertContent(item: MCPContent): Record<string, unknown> | undefined {
	if (item.type === "image" && item.data && item.mimeType) {
		return { type: "image", data: item.data, mimeType: item.mimeType };
	}
	if (item.type === "text" && item.text) {
		return { type: "text", text: item.text };
	}
	return undefined;
}

function shouldKeepTail(
	remoteName: string,
	input: Record<string, unknown>,
): boolean {
	return (
		remoteName === "job_logs" || (remoteName === "exec" && input.tail === true)
	);
}

function formatOutput(remoteName: string, output: unknown): string {
	const value = asRecord(output);
	switch (remoteName) {
		case "hosts_list":
			return formatHosts(value);
		case "exec":
		case "host_test":
			return formatExec(value);
		case "output_read":
			return `${stringValue(value.content)}\n\n[total_lines=${numberValue(value.total_lines)}]`;
		case "file_read":
			return `${stringValue(value.content)}\n\n[sha256=${stringValue(value.sha256)} bytes=${numberValue(value.bytes)} total_lines=${numberValue(value.total_lines)}]`;
		case "file_list":
			return formatFileList(value);
		case "grep":
			return formatGrep(value);
		case "find":
			return formatFind(value);
		case "job_logs":
			return stringValue(value.output);
		default:
			return JSON.stringify(output ?? null, null, 2);
	}
}

function formatHosts(output: Record<string, unknown>): string {
	const hosts = Array.isArray(output.hosts) ? output.hosts : [];
	if (hosts.length === 0) return "没有可访问的 OneSSH 主机。";
	return hosts
		.map((item) => {
			const host = asRecord(item);
			const state = host.online === true ? "online" : "offline";
			return `${state}\t${stringValue(host.name)}\t${stringValue(host.username)}@${stringValue(host.addr)}`;
		})
		.join("\n");
}

function formatExec(output: Record<string, unknown>): string {
	const text = stringValue(output.output);
	const metadata = [
		`exit_code=${numberValue(output.exit_code)}`,
		`cwd=${stringValue(output.cwd)}`,
		`timeout=${output.timeout === true}`,
		`total_lines=${numberValue(output.total_lines)}`,
		`total_bytes=${numberValue(output.total_bytes)}`,
	];
	if (output.truncated === true) metadata.push("truncated=true");
	if (typeof output.artifact_id === "string" && output.artifact_id) {
		metadata.push(`artifact_id=${output.artifact_id}`);
	}
	return `${text}\n\n[${metadata.join(" ")}]`;
}

function formatFileList(output: Record<string, unknown>): string {
	const entries = Array.isArray(output.entries) ? output.entries : [];
	if (entries.length === 0) return "目录为空。";
	return entries
		.map((item) => {
			const entry = asRecord(item);
			const name = `${stringValue(entry.name)}${entry.directory === true ? "/" : ""}`;
			const target =
				typeof entry.symlink_target === "string" && entry.symlink_target
					? ` -> ${entry.symlink_target}`
					: "";
			return `${stringValue(entry.mode)}\t${numberValue(entry.size)}\t${name}${target}`;
		})
		.join("\n");
}

function formatGrep(output: Record<string, unknown>): string {
	const lines = Array.isArray(output.lines) ? output.lines : [];
	const body = lines
		.map((item) => {
			const line = asRecord(item);
			const column =
				typeof line.column === "number" && line.column > 0
					? `:${line.column}`
					: "";
			const separator = line.match === true ? ":" : "-";
			return `${stringValue(line.path)}:${numberValue(line.line)}${column}${separator}${stringValue(line.text)}`;
		})
		.join("\n");
	const summary = `[engine=${stringValue(output.engine)} matches=${numberValue(output.match_count)} truncated=${output.truncated === true}]`;
	const warning =
		typeof output.warning === "string" && output.warning
			? `\n[warning=${output.warning}]`
			: "";
	return `${body}${body ? "\n\n" : ""}${summary}${warning}`;
}

function formatFind(output: Record<string, unknown>): string {
	const paths = Array.isArray(output.paths) ? output.paths.map(String) : [];
	const summary = `[engine=${stringValue(output.engine)} paths=${paths.length} truncated=${output.truncated === true}]`;
	const warning =
		typeof output.warning === "string" && output.warning
			? `\n[warning=${output.warning}]`
			: "";
	return `${paths.join("\n")}${paths.length ? "\n\n" : ""}${summary}${warning}`;
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return String(value);
}

function numberValue(value: unknown): number {
	return typeof value === "number" ? value : 0;
}
