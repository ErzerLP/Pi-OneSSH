import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { OneSSHClient } from "./client.js";
import { runConfigCommand } from "./config-ui.js";
import {
	configurePiPaths,
	isConfigured,
	loadConfig,
	type LoadedConfig,
} from "./config.js";
import {
	applyConfiguredTools,
	registerOneSSHTools,
	type OneSSHRuntime,
} from "./tools.js";

export default function oneSSHExtension(pi: ExtensionAPI) {
	configurePiPaths(getAgentDir(), CONFIG_DIR_NAME);
	let runtime: OneSSHRuntime | undefined;

	registerOneSSHTools(pi, () => runtime);

	const applyLoadedConfig = (loaded: LoadedConfig, ctx: ExtensionContext) => {
		runtime = {
			config: loaded.config,
			client: new OneSSHClient(loaded.config),
		};
		const ready = isConfigured(loaded.config);
		applyConfiguredTools(pi, loaded.config, ready);
		if (ready) {
			const host = loaded.config.defaultHost
				? `${loaded.config.defaultHost} @ `
				: "";
			ctx.ui.setStatus(
				"onessh",
				ctx.ui.theme.fg(
					"accent",
					`OneSSH MCP · ${host}${loaded.config.baseUrl}`,
				),
			);
		} else {
			ctx.ui.setStatus("onessh", undefined);
		}
	};

	pi.registerCommand("onessh-config", {
		description: "配置 OneSSH 地址、令牌、默认主机、会话、超时和工具组",
		getArgumentCompletions: (prefix) => {
			const values = [
				"show",
				"test",
				"global",
				"project",
				"clear-global",
				"clear-project",
			];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			await runConfigCommand(args, ctx, {
				reload: (loaded) => applyLoadedConfig(loaded, ctx),
			});
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			const loaded = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
			applyLoadedConfig(loaded, ctx);
			if (!isConfigured(loaded.config) && ctx.hasUI) {
				ctx.ui.notify(
					"Pi-OneSSH 已加载；运行 /onessh-config 完成连接配置",
					"info",
				);
			}
		} catch (error) {
			runtime = undefined;
			applyConfiguredTools(
				pi,
				{
					version: 1,
					baseUrl: "http://localhost:8866",
					auth: { type: "env", env: "ONESSH_TOKEN" },
					session: "pi",
					timeoutMs: 120_000,
					initialGroups: ["core"],
				},
				false,
			);
			ctx.ui.setStatus("onessh", undefined);
			ctx.ui.notify((error as Error).message, "error");
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("onessh", undefined);
	});
}
