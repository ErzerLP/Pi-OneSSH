import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

let piAgentDir =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
let piConfigDirName = ".pi";

export function configurePiPaths(
	agentDir: string,
	configDirName: string,
): void {
	piAgentDir = agentDir;
	piConfigDirName = configDirName;
}

export const TOOL_GROUPS = [
	"core",
	"execution",
	"jobs",
	"files",
	"search",
	"memory",
	"monitor",
	"management",
] as const;

export type ToolGroup = (typeof TOOL_GROUPS)[number];
export type ConfigScope = "global" | "project";

export type AuthConfig =
	| { type: "env"; env: string }
	| { type: "token"; token: string };

export interface OneSSHConfig {
	version: 1;
	baseUrl: string;
	auth: AuthConfig;
	defaultHost?: string;
	session: string;
	timeoutMs: number;
	initialGroups: ToolGroup[];
}

type StoredOneSSHConfig = Partial<
	Omit<OneSSHConfig, "auth" | "initialGroups">
> & {
	auth?: Partial<AuthConfig> & { type?: string };
	initialGroups?: string[];
};

type ProjectOneSSHConfig = Pick<
	StoredOneSSHConfig,
	"version" | "defaultHost" | "session" | "timeoutMs" | "initialGroups"
>;

export interface LoadedConfig {
	config: OneSSHConfig;
	globalPath: string;
	projectPath: string;
	globalLoaded: boolean;
	projectLoaded: boolean;
}

export const DEFAULT_CONFIG: OneSSHConfig = {
	version: 1,
	baseUrl: "http://localhost:8866",
	auth: { type: "env", env: "ONESSH_TOKEN" },
	session: "pi",
	timeoutMs: 120_000,
	initialGroups: ["core", "execution", "files", "search"],
};

export function configPath(scope: ConfigScope, cwd: string): string {
	return scope === "global"
		? join(piAgentDir, "onessh.json")
		: join(cwd, piConfigDirName, "onessh.json");
}

export function normalizeBaseUrl(raw: string): string {
	const value = raw.trim().replace(/\/+$/, "");
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("OneSSH 地址不是有效 URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("OneSSH 地址必须使用 http:// 或 https://");
	}
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("OneSSH 地址不能包含账号、查询参数或片段");
	}
	if (parsed.pathname !== "/") {
		throw new Error("OneSSH 地址只能包含来源地址，不能带路径");
	}
	return parsed.origin;
}

function normalizeAuth(
	raw: StoredOneSSHConfig["auth"],
	fallback: AuthConfig,
): AuthConfig {
	if (!raw) return fallback;
	if (raw.type === "token") {
		const token = typeof raw.token === "string" ? raw.token.trim() : "";
		return token ? { type: "token", token } : fallback;
	}
	if (raw.type === "env") {
		const env = typeof raw.env === "string" ? raw.env.trim() : "";
		return { type: "env", env: env || "ONESSH_TOKEN" };
	}
	return fallback;
}

function normalizeGroups(raw: unknown, fallback: ToolGroup[]): ToolGroup[] {
	if (!Array.isArray(raw)) return fallback;
	const allowed = new Set<string>(TOOL_GROUPS);
	const groups = [
		...new Set(
			raw.filter(
				(item): item is ToolGroup =>
					typeof item === "string" && allowed.has(item),
			),
		),
	];
	return groups.length > 0 ? groups : fallback;
}

function mergeConfig(
	base: OneSSHConfig,
	raw: StoredOneSSHConfig | undefined,
): OneSSHConfig {
	if (!raw) return base;
	let baseUrl = base.baseUrl;
	if (typeof raw.baseUrl === "string") {
		try {
			baseUrl = normalizeBaseUrl(raw.baseUrl);
		} catch {
			baseUrl = base.baseUrl;
		}
	}
	const timeout =
		typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
			? Math.min(3_600_000, Math.max(1_000, Math.round(raw.timeoutMs)))
			: base.timeoutMs;
	const session =
		typeof raw.session === "string" && raw.session.trim()
			? raw.session.trim()
			: base.session;
	const defaultHost =
		typeof raw.defaultHost === "string" && raw.defaultHost.trim()
			? raw.defaultHost.trim()
			: undefined;
	return {
		version: 1,
		baseUrl,
		auth: normalizeAuth(raw.auth, base.auth),
		defaultHost,
		session,
		timeoutMs: timeout,
		initialGroups: normalizeGroups(raw.initialGroups, base.initialGroups),
	};
}

async function readStored(
	path: string,
): Promise<StoredOneSSHConfig | undefined> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new Error("配置根节点必须是 JSON 对象");
		}
		return raw as StoredOneSSHConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(
			`无法读取 OneSSH 配置 ${path}: ${(error as Error).message}`,
		);
	}
}

export async function loadConfig(
	cwd: string,
	allowProject = true,
): Promise<LoadedConfig> {
	const globalPath = configPath("global", cwd);
	const projectPath = configPath("project", cwd);
	const globalConfig = await readStored(globalPath);
	const projectConfig = allowProject
		? await readStored(projectPath)
		: undefined;
	const withGlobal = mergeConfig(DEFAULT_CONFIG, globalConfig);
	// A project may tune behavior, but it cannot replace the origin while inheriting
	// a global credential. Keeping origin+auth indivisible prevents token exfiltration
	// through a trusted repository's .pi/onessh.json.
	const safeProjectConfig: ProjectOneSSHConfig | undefined = projectConfig
		? {
				version: projectConfig.version,
				defaultHost: projectConfig.defaultHost,
				session: projectConfig.session,
				timeoutMs: projectConfig.timeoutMs,
				initialGroups: projectConfig.initialGroups,
			}
		: undefined;
	return {
		config: mergeConfig(withGlobal, safeProjectConfig),
		globalPath,
		projectPath,
		globalLoaded: globalConfig !== undefined,
		projectLoaded: projectConfig !== undefined,
	};
}

export async function saveConfig(
	scope: ConfigScope,
	cwd: string,
	config: OneSSHConfig,
): Promise<string> {
	const path = configPath(scope, cwd);
	const behavior: ProjectOneSSHConfig = {
		version: 1,
		defaultHost: config.defaultHost,
		session: config.session.trim() || "pi",
		timeoutMs: Math.min(
			3_600_000,
			Math.max(1_000, Math.round(config.timeoutMs)),
		),
		initialGroups: normalizeGroups(
			config.initialGroups,
			DEFAULT_CONFIG.initialGroups,
		),
	};
	const stored: StoredOneSSHConfig =
		scope === "global"
			? {
					...behavior,
					baseUrl: normalizeBaseUrl(config.baseUrl),
					auth: config.auth,
				}
			: behavior;

	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		try {
			await rename(temporary, path);
		} catch (error) {
			if (process.platform !== "win32") throw error;
			await rm(path, { force: true });
			await rename(temporary, path);
		}
		await bestEffort(() => chmod(path, 0o600));
	} finally {
		await bestEffort(() => rm(temporary, { force: true }));
	}
	return path;
}

async function bestEffort(operation: () => Promise<unknown>): Promise<void> {
	try {
		await operation();
	} catch {
		// Permissions and cleanup are best-effort on platforms that do not support POSIX modes.
	}
}

export async function clearConfig(
	scope: ConfigScope,
	cwd: string,
): Promise<string> {
	const path = configPath(scope, cwd);
	await rm(path, { force: true });
	return path;
}

export function resolveToken(config: OneSSHConfig): string | undefined {
	if (config.auth.type === "token")
		return config.auth.token.trim() || undefined;
	const value = process.env[config.auth.env];
	return value?.trim() || undefined;
}

export function isConfigured(config: OneSSHConfig): boolean {
	return resolveToken(config) !== undefined;
}

export function describeAuth(auth: AuthConfig): string {
	return auth.type === "env"
		? `环境变量 ${auth.env}`
		: "配置文件令牌（已隐藏）";
}

export function summarizeConfig(config: OneSSHConfig): string {
	return [
		`地址: ${config.baseUrl}`,
		`认证: ${describeAuth(config.auth)}`,
		`默认主机: ${config.defaultHost ?? "未设置"}`,
		`会话标签: ${config.session}`,
		`请求超时: ${config.timeoutMs} ms`,
		`初始工具组: ${config.initialGroups.join(", ")}`,
	].join("\n");
}
