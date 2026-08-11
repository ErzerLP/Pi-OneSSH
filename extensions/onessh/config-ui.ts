import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { OneSSHClient } from "./client.js";
import {
	TOOL_GROUPS,
	clearConfig,
	describeAuth,
	isConfigured,
	loadConfig,
	normalizeBaseUrl,
	saveConfig,
	summarizeConfig,
	type ConfigScope,
	type LoadedConfig,
	type OneSSHConfig,
	type ToolGroup,
} from "./config.js";
import { GROUP_LABELS, TOOL_SPECS } from "./schemas.js";

export interface ConfigCommandHooks {
	reload: (loaded: LoadedConfig) => void;
}

type ConfigAction =
	| "connection"
	| "server"
	| "auth"
	| "host"
	| "session"
	| "timeout"
	| "groups"
	| "test"
	| "save"
	| "clear"
	| "cancel";

type ConfigMenuItem = { action: ConfigAction; label: string };

export async function runConfigCommand(
	args: string,
	ctx: ExtensionCommandContext,
	hooks: ConfigCommandHooks,
): Promise<void> {
	const command = args.trim().toLowerCase();
	const allowProject = ctx.isProjectTrusted();
	if (await handleImmediateCommand(command, ctx, hooks, allowProject)) return;
	if (!ctx.hasUI) {
		throw new Error(
			"/onessh-config 交互配置需要 TUI 或 RPC UI；可使用 show 或 test 参数查看状态",
		);
	}

	const scope = await selectConfigScope(command, ctx, allowProject);
	if (!scope) return;
	if (scope === "project" && !allowProject) {
		ctx.ui.notify(
			"当前项目尚未受信任，不能写入或加载项目级 OneSSH 配置",
			"error",
		);
		return;
	}

	const loaded = await loadConfig(ctx.cwd, allowProject);
	await editConfig(ctx, scope, cloneConfig(loaded.config), hooks);
}

async function handleImmediateCommand(
	command: string,
	ctx: ExtensionCommandContext,
	hooks: ConfigCommandHooks,
	allowProject: boolean,
): Promise<boolean> {
	if (command === "show" || command === "test") {
		const loaded = await loadConfig(ctx.cwd, allowProject);
		if (command === "show") showConfig(ctx, loaded);
		else await testConnection(ctx, loaded.config);
		return true;
	}
	if (command === "clear-global" || command === "clear-project") {
		const scope: ConfigScope = command.endsWith("global")
			? "global"
			: "project";
		await clearScope(ctx, scope, hooks);
		return true;
	}
	return false;
}

async function selectConfigScope(
	command: string,
	ctx: ExtensionCommandContext,
	allowProject: boolean,
): Promise<ConfigScope | undefined> {
	if (command === "global" || command === "project") return command;
	const selected = await ctx.ui.select("OneSSH 配置范围", [
		"全局配置（推荐）",
		"项目配置",
		"查看当前生效配置",
	]);
	if (!selected) return undefined;
	if (selected === "查看当前生效配置") {
		showConfig(ctx, await loadConfig(ctx.cwd, allowProject));
		return undefined;
	}
	return selected.startsWith("全局") ? "global" : "project";
}

async function editConfig(
	ctx: ExtensionCommandContext,
	scope: ConfigScope,
	draft: OneSSHConfig,
	hooks: ConfigCommandHooks,
): Promise<void> {
	for (;;) {
		const menu = buildConfigMenu(scope, draft);
		const choice = await ctx.ui.select(
			`OneSSH ${scope === "global" ? "全局" : "项目"}配置`,
			menu.map((item) => item.label),
		);
		const action = menu.find((item) => item.label === choice)?.action;
		if (!action || action === "cancel") return;
		try {
			if (await performConfigAction(action, ctx, scope, draft, hooks)) return;
		} catch (error) {
			ctx.ui.notify((error as Error).message, "error");
		}
	}
}

function buildConfigMenu(
	scope: ConfigScope,
	draft: OneSSHConfig,
): ConfigMenuItem[] {
	const connection: ConfigMenuItem[] =
		scope === "global"
			? [
					{ action: "server", label: `服务器地址 · ${draft.baseUrl}` },
					{ action: "auth", label: `认证方式 · ${describeAuth(draft.auth)}` },
				]
			: [
					{
						action: "connection",
						label: `连接配置 · 继承全局 ${draft.baseUrl}`,
					},
				];
	return [
		...connection,
		{ action: "host", label: `默认主机 · ${draft.defaultHost ?? "未设置"}` },
		{ action: "session", label: `命令会话 · ${draft.session}` },
		{ action: "timeout", label: `请求超时 · ${draft.timeoutMs} ms` },
		{
			action: "groups",
			label: `初始工具组 · ${draft.initialGroups.join(", ")}`,
		},
		{ action: "test", label: "测试当前配置" },
		{ action: "save", label: "保存并关闭" },
		{ action: "clear", label: "清除此范围配置" },
		{ action: "cancel", label: "取消" },
	];
}

async function performConfigAction(
	action: Exclude<ConfigAction, "cancel">,
	ctx: ExtensionCommandContext,
	scope: ConfigScope,
	draft: OneSSHConfig,
	hooks: ConfigCommandHooks,
): Promise<boolean> {
	const handlers: Record<
		Exclude<ConfigAction, "cancel">,
		() => Promise<boolean>
	> = {
		connection: async () => {
			ctx.ui.notify(
				"项目配置不能覆盖服务器地址或令牌；请编辑全局连接配置",
				"info",
			);
			return false;
		},
		server: async () => {
			const value = await ctx.ui.input("OneSSH 来源地址", draft.baseUrl);
			if (value !== undefined) draft.baseUrl = normalizeBaseUrl(value);
			return false;
		},
		auth: async () => {
			await editAuth(ctx, draft);
			return false;
		},
		host: async () => {
			await editDefaultHost(ctx, draft);
			return false;
		},
		session: async () => {
			const value = await ctx.ui.input(
				"exec/session_env 默认会话标签",
				draft.session,
			);
			if (value?.trim()) draft.session = value.trim();
			return false;
		},
		timeout: async () => {
			await editTimeout(ctx, draft);
			return false;
		},
		groups: async () => {
			await editGroups(ctx, draft);
			return false;
		},
		test: async () => {
			await testConnection(ctx, draft);
			return false;
		},
		save: async () => {
			const path = await saveConfig(scope, ctx.cwd, draft);
			const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
			hooks.reload(loaded);
			ctx.ui.notify(`OneSSH 配置已保存：${path}`, "info");
			return true;
		},
		clear: () => clearScope(ctx, scope, hooks),
	};
	return handlers[action]();
}

async function editTimeout(
	ctx: ExtensionCommandContext,
	draft: OneSSHConfig,
): Promise<void> {
	const value = await ctx.ui.input(
		"默认 HTTP 请求超时（毫秒，1000-3600000）",
		String(draft.timeoutMs),
	);
	if (value === undefined) return;
	const timeout = Number(value);
	if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 3_600_000) {
		throw new Error("请求超时必须是 1000 到 3600000 之间的整数");
	}
	draft.timeoutMs = timeout;
}

async function editAuth(
	ctx: ExtensionCommandContext,
	draft: OneSSHConfig,
): Promise<void> {
	const choice = await ctx.ui.select("OneSSH 令牌来源", [
		"环境变量（推荐）",
		"保存令牌到全局配置",
	]);
	if (!choice) return;
	if (choice.startsWith("环境变量")) {
		const current = draft.auth.type === "env" ? draft.auth.env : "ONESSH_TOKEN";
		const env = await ctx.ui.input("令牌环境变量名", current);
		if (env?.trim()) draft.auth = { type: "env", env: env.trim() };
		return;
	}
	const accepted = await ctx.ui.confirm(
		"保存敏感令牌？",
		"令牌将明文写入权限为 0600 的全局 onessh.json。环境变量通常更安全。",
	);
	if (!accepted) return;
	const token = await ctx.ui.input(
		"OneSSH Agent 令牌（输入会显示在终端）",
		"osh_...",
	);
	if (!token?.trim()) throw new Error("令牌不能为空");
	draft.auth = { type: "token", token: token.trim() };
}

async function editDefaultHost(
	ctx: ExtensionCommandContext,
	draft: OneSSHConfig,
): Promise<void> {
	try {
		const response = await new OneSSHClient(draft).call<{
			hosts?: Array<{ name?: string }>;
		}>("hosts_list", {});
		const hosts =
			response.output.hosts
				?.map((host) => host.name)
				.filter((name): name is string => Boolean(name)) ?? [];
		const choices = [...hosts, "手动输入", "清除默认主机"];
		const selected = await ctx.ui.select("默认 OneSSH 主机", choices);
		if (!selected) return;
		if (selected === "清除默认主机") {
			draft.defaultHost = undefined;
			return;
		}
		if (selected !== "手动输入") {
			draft.defaultHost = selected;
			return;
		}
	} catch (error) {
		ctx.ui.notify(
			`无法读取主机列表，将改为手动输入：${(error as Error).message}`,
			"warning",
		);
	}
	const value = await ctx.ui.input("默认主机名", draft.defaultHost ?? "");
	if (value !== undefined) draft.defaultHost = value.trim() || undefined;
}

async function editGroups(
	ctx: ExtensionCommandContext,
	draft: OneSSHConfig,
): Promise<void> {
	const selected = new Set<ToolGroup>(draft.initialGroups);
	for (;;) {
		const options = [
			...TOOL_GROUPS.map(
				(group) =>
					`${selected.has(group) ? "✓" : "○"} ${group} · ${GROUP_LABELS[group]}`,
			),
			"完成",
		];
		const choice = await ctx.ui.select("启动时激活的工具组", options);
		if (!choice || choice === "完成") {
			if (selected.size === 0) {
				ctx.ui.notify(
					"至少保留一个初始工具组；其余工具仍可由 onessh_tools 按需激活",
					"warning",
				);
				continue;
			}
			draft.initialGroups = TOOL_GROUPS.filter((group) => selected.has(group));
			return;
		}
		const group = TOOL_GROUPS.find((item) => choice.includes(` ${item} ·`));
		if (!group) continue;
		if (selected.has(group)) selected.delete(group);
		else selected.add(group);
	}
}

async function testConnection(
	ctx: ExtensionCommandContext,
	config: OneSSHConfig,
): Promise<void> {
	if (!isConfigured(config)) {
		throw new Error("当前认证来源没有可用令牌");
	}
	const client = new OneSSHClient(config);
	const started = performance.now();
	const [health, catalog, hosts] = await Promise.all([
		client.health(),
		client.listTools(),
		client.call<{ hosts?: unknown[] }>("hosts_list", {}),
	]);
	const expected = new Set(TOOL_SPECS.map((tool) => tool.remoteName));
	const available = new Set(catalog.toolNames);
	const missing = [...expected].filter((name) => !available.has(name));
	if (missing.length > 0) {
		throw new Error(`OneSSH MCP 缺少扩展所需工具：${missing.join(", ")}`);
	}
	const extra = catalog.toolNames.filter((name) => !expected.has(name));
	const elapsed = Math.round(performance.now() - started);
	const compatibility =
		extra.length > 0 ? `，服务端另有 ${extra.length} 个新工具` : "";
	ctx.ui.notify(
		`连接成功：OneSSH ${health.version}，MCP ${catalog.connection.protocolVersion}，` +
			`目录 ${expected.size}/${expected.size}，可访问 ${hosts.output.hosts?.length ?? 0} 台主机，` +
			`${elapsed} ms${compatibility}`,
		"info",
	);
}

async function clearScope(
	ctx: ExtensionCommandContext,
	scope: ConfigScope,
	hooks: ConfigCommandHooks,
): Promise<boolean> {
	if (scope === "project" && !ctx.isProjectTrusted()) {
		ctx.ui.notify("当前项目尚未受信任", "error");
		return false;
	}
	const confirmed = await ctx.ui.confirm(
		"清除 OneSSH 配置？",
		`将删除${scope === "global" ? "全局" : "项目"}配置文件；另一范围的配置不受影响。`,
	);
	if (!confirmed) return false;
	const path = await clearConfig(scope, ctx.cwd);
	const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
	hooks.reload(loaded);
	ctx.ui.notify(`已清除：${path}`, "info");
	return true;
}

function showConfig(ctx: ExtensionCommandContext, loaded: LoadedConfig): void {
	const source = [
		loaded.globalLoaded ? `全局: ${loaded.globalPath}` : "全局: 未创建",
		loaded.projectLoaded
			? `项目: ${loaded.projectPath}`
			: "项目: 未创建或未加载",
	].join("\n");
	ctx.ui.notify(`${summarizeConfig(loaded.config)}\n${source}`, "info");
}

function cloneConfig(config: OneSSHConfig): OneSSHConfig {
	return {
		...config,
		auth: { ...config.auth },
		initialGroups: [...config.initialGroups],
	};
}
