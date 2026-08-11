import type { OneSSHConfig } from "./config.js";
import { resolveToken } from "./config.js";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const CLIENT_INFO = { name: "pi-onessh", version: "0.1.0" } as const;
const CLIENT_CAPABILITIES = {} as const;
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

export interface MCPContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
	[key: string]: unknown;
}

export interface MCPToolResponse<T = unknown> {
	output: T;
	content: MCPContent[];
}

export interface MCPConnectionInfo {
	protocolVersion: string;
	mode: "modern" | "legacy";
	serverName?: string;
	serverVersion?: string;
	instructions?: string;
}

export interface MCPToolCatalog {
	connection: MCPConnectionInfo;
	toolNames: string[];
}

export interface HealthResponse {
	ok: boolean;
	version: string;
}

interface Implementation {
	name?: string;
	version?: string;
}

interface DiscoverResult {
	supportedVersions?: string[];
	instructions?: string;
	_meta?: Record<string, unknown>;
}

interface InitializeResult {
	protocolVersion?: string;
	instructions?: string;
	serverInfo?: Implementation;
}

interface ListToolsResult {
	tools?: Array<{ name?: string }>;
	nextCursor?: string;
}

interface CallToolResult {
	content?: MCPContent[];
	structuredContent?: unknown;
	isError?: boolean;
}

interface JSONRPCError {
	code?: number;
	message?: string;
	data?: unknown;
}

interface JSONRPCEnvelope<T = unknown> {
	jsonrpc?: string;
	id?: number | string | null;
	result?: T;
	error?: JSONRPCError;
}

interface RPCOptions {
	protocolVersion: string;
	method: string;
	name?: string;
	signal?: AbortSignal;
	timeoutMs: number;
}

interface ErrorResponse {
	error?: string | { message?: string };
}

export class OneSSHClientError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly tool?: string,
		readonly rpcCode?: number,
	) {
		super(message);
		this.name = "OneSSHClientError";
	}
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface ManagedResponse {
	response: Response;
	finish: () => void;
	mapError: (error: unknown) => OneSSHClientError;
}

export class OneSSHClient {
	private nextRequestID = 1;
	private readyPromise?: Promise<MCPConnectionInfo>;
	private sessionID?: string;

	constructor(
		private readonly config: OneSSHConfig,
		private readonly fetchImpl: FetchLike = globalThis.fetch,
	) {}

	async health(signal?: AbortSignal): Promise<HealthResponse> {
		const pending = await this.request(
			`${this.config.baseUrl}/healthz`,
			{ method: "GET", headers: { Accept: "application/json" } },
			signal,
			Math.min(this.config.timeoutMs, 10_000),
		);
		try {
			const body = await readJSON<HealthResponse>(pending.response);
			if (!pending.response.ok || !body?.ok) {
				throw new OneSSHClientError(
					`OneSSH 健康检查失败（HTTP ${pending.response.status}）`,
					pending.response.status,
				);
			}
			return body;
		} catch (error) {
			throw pending.mapError(error);
		} finally {
			pending.finish();
		}
	}

	async connect(signal?: AbortSignal): Promise<MCPConnectionInfo> {
		if (!this.readyPromise) this.readyPromise = this.negotiateAndReset();
		return waitForSignal(this.readyPromise, signal);
	}

	private async negotiateAndReset(): Promise<MCPConnectionInfo> {
		try {
			return await this.negotiate();
		} catch (error) {
			this.readyPromise = undefined;
			throw error;
		}
	}

	async call<T = unknown>(
		tool: string,
		input: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutMs = this.config.timeoutMs,
	): Promise<MCPToolResponse<T>> {
		const connection = await this.connect(signal);
		const result = await this.rpc<CallToolResult>(
			"tools/call",
			this.withRequestMeta({ name: tool, arguments: input }, connection),
			{
				protocolVersion: connection.protocolVersion,
				method: "tools/call",
				name: tool,
				signal,
				timeoutMs,
			},
		);
		const content = Array.isArray(result.content) ? result.content : [];
		if (result.isError) {
			throw new OneSSHClientError(toolErrorMessage(content), 200, tool);
		}
		return {
			output: outputFromResult(result, content) as T,
			content,
		};
	}

	async listTools(signal?: AbortSignal): Promise<MCPToolCatalog> {
		const connection = await this.connect(signal);
		const names: string[] = [];
		let cursor: string | undefined;
		do {
			const params = cursor ? { cursor } : {};
			const result = await this.rpc<ListToolsResult>(
				"tools/list",
				this.withRequestMeta(params, connection),
				{
					protocolVersion: connection.protocolVersion,
					method: "tools/list",
					signal,
					timeoutMs: Math.min(this.config.timeoutMs, 30_000),
				},
			);
			for (const tool of result.tools ?? []) {
				if (tool.name) names.push(tool.name);
			}
			cursor = result.nextCursor || undefined;
		} while (cursor);
		return { connection, toolNames: [...new Set(names)] };
	}

	private async negotiate(): Promise<MCPConnectionInfo> {
		const timeoutMs = Math.min(this.config.timeoutMs, 30_000);
		try {
			const discovery = await this.rpc<DiscoverResult>(
				"server/discover",
				{
					_meta: modernMeta(),
				},
				{
					protocolVersion: MODERN_PROTOCOL_VERSION,
					method: "server/discover",
					timeoutMs,
				},
			);
			if (discovery.supportedVersions?.includes(MODERN_PROTOCOL_VERSION)) {
				const serverInfo = asImplementation(
					discovery._meta?.[META_SERVER_INFO],
				);
				return {
					protocolVersion: MODERN_PROTOCOL_VERSION,
					mode: "modern",
					serverName: serverInfo?.name,
					serverVersion: serverInfo?.version,
					instructions: discovery.instructions,
				};
			}
		} catch (error) {
			if (!canFallbackToLegacy(error)) throw error;
		}

		this.sessionID = undefined;
		const initialized = await this.rpc<InitializeResult>(
			"initialize",
			{
				protocolVersion: LEGACY_PROTOCOL_VERSION,
				capabilities: CLIENT_CAPABILITIES,
				clientInfo: CLIENT_INFO,
			},
			{
				protocolVersion: LEGACY_PROTOCOL_VERSION,
				method: "initialize",
				timeoutMs,
			},
		);
		if (
			!initialized.protocolVersion ||
			initialized.protocolVersion >= MODERN_PROTOCOL_VERSION
		) {
			throw new OneSSHClientError("OneSSH 返回了不兼容的 MCP initialize 版本");
		}
		await this.notify(
			"notifications/initialized",
			{},
			{
				protocolVersion: initialized.protocolVersion,
				method: "notifications/initialized",
				timeoutMs,
			},
		);
		return {
			protocolVersion: initialized.protocolVersion,
			mode: "legacy",
			serverName: initialized.serverInfo?.name,
			serverVersion: initialized.serverInfo?.version,
			instructions: initialized.instructions,
		};
	}

	private withRequestMeta(
		params: Record<string, unknown>,
		connection: MCPConnectionInfo,
	): Record<string, unknown> {
		if (connection.mode !== "modern") return params;
		return { ...params, _meta: modernMeta(connection.protocolVersion) };
	}

	private async rpc<T>(
		method: string,
		params: Record<string, unknown>,
		options: RPCOptions,
	): Promise<T> {
		const id = this.nextRequestID++;
		const envelope = await this.postJSONRPC<T>(
			{ jsonrpc: "2.0", id, method, params },
			id,
			options,
		);
		if (envelope.error) {
			throw new OneSSHClientError(
				envelope.error.message || `OneSSH MCP ${method} 调用失败`,
				200,
				options.name,
				envelope.error.code,
			);
		}
		if (!("result" in envelope)) {
			throw new OneSSHClientError(
				`OneSSH MCP ${method} 响应缺少 result`,
				200,
				options.name,
			);
		}
		return envelope.result as T;
	}

	private async notify(
		method: string,
		params: Record<string, unknown>,
		options: RPCOptions,
	): Promise<void> {
		const pending = await this.post(
			{ jsonrpc: "2.0", method, params },
			options,
		);
		const response = pending.response;
		try {
			if (!response.ok) await throwHTTPError(response, method, options.name);
			if (
				response.status !== 202 &&
				response.status !== 204 &&
				response.status !== 200
			) {
				throw new OneSSHClientError(
					`OneSSH MCP ${method} 返回意外状态 ${response.status}`,
					response.status,
					options.name,
				);
			}
			await response.body?.cancel();
		} catch (error) {
			throw pending.mapError(error);
		} finally {
			pending.finish();
		}
	}

	private async postJSONRPC<T>(
		body: Record<string, unknown>,
		id: number,
		options: RPCOptions,
	): Promise<JSONRPCEnvelope<T>> {
		const pending = await this.post(body, options);
		const response = pending.response;
		try {
			if (!response.ok) {
				await throwHTTPError(response, options.method, options.name);
			}
			const text = await response.text();
			const envelopes = decodeRPCEnvelopes(
				text,
				response.headers.get("Content-Type"),
			);
			const envelope = envelopes.find((item) => item.id === id);
			if (!envelope) {
				throw new OneSSHClientError(
					`OneSSH MCP ${options.method} 未返回请求 ${id} 的响应`,
					response.status,
					options.name,
				);
			}
			return envelope as JSONRPCEnvelope<T>;
		} catch (error) {
			throw pending.mapError(error);
		} finally {
			pending.finish();
		}
	}

	private async post(
		body: Record<string, unknown>,
		options: RPCOptions,
	): Promise<ManagedResponse> {
		const token = resolveToken(this.config);
		if (!token) throw missingTokenError(this.config, options.name);
		const headers: Record<string, string> = {
			Accept: "application/json, text/event-stream",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"MCP-Protocol-Version": options.protocolVersion,
			"User-Agent": "pi-onessh/0.1.0",
		};
		if (this.sessionID) headers["Mcp-Session-Id"] = this.sessionID;
		if (options.protocolVersion >= MODERN_PROTOCOL_VERSION) {
			headers["Mcp-Method"] = options.method;
			if (options.name) headers["Mcp-Name"] = options.name;
		}
		const pending = await this.request(
			`${this.config.baseUrl}/mcp`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				cache: "no-store",
			},
			options.signal,
			options.timeoutMs,
		);
		const sessionID = pending.response.headers.get("Mcp-Session-Id");
		if (sessionID) {
			if (this.sessionID && this.sessionID !== sessionID) {
				await pending.response.body?.cancel();
				pending.finish();
				throw new OneSSHClientError(
					"OneSSH MCP 返回了不一致的 session ID",
					pending.response.status,
					options.name,
				);
			}
			this.sessionID = sessionID;
		}
		return pending;
	}

	private async request(
		url: string,
		init: RequestInit,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<ManagedResponse> {
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const timer = setTimeout(
			() => controller.abort(new Error(`OneSSH 请求超过 ${timeoutMs} ms`)),
			timeoutMs,
		);
		const finish = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const mapError = (error: unknown): OneSSHClientError => {
			if (error instanceof OneSSHClientError) return error;
			if (signal?.aborted) return new OneSSHClientError("OneSSH 调用已取消");
			if (controller.signal.aborted) {
				return new OneSSHClientError(`OneSSH 请求超时（${timeoutMs} ms）`);
			}
			return new OneSSHClientError(
				`无法连接 OneSSH：${(error as Error).message}`,
			);
		};
		try {
			const response = await this.fetchImpl(url, {
				...init,
				signal: controller.signal,
			});
			return { response, finish, mapError };
		} catch (error) {
			finish();
			throw mapError(error);
		}
	}
}

function modernMeta(
	protocolVersion = MODERN_PROTOCOL_VERSION,
): Record<string, unknown> {
	return {
		[META_PROTOCOL_VERSION]: protocolVersion,
		[META_CLIENT_INFO]: CLIENT_INFO,
		[META_CLIENT_CAPABILITIES]: CLIENT_CAPABILITIES,
	};
}

function asImplementation(value: unknown): Implementation | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Implementation)
		: undefined;
}

function canFallbackToLegacy(error: unknown): boolean {
	return (
		error instanceof OneSSHClientError &&
		(error.rpcCode !== undefined ||
			error.status === 400 ||
			error.status === 404 ||
			error.status === 405)
	);
}

function missingTokenError(
	config: OneSSHConfig,
	tool?: string,
): OneSSHClientError {
	const source =
		config.auth.type === "env" ? `环境变量 ${config.auth.env}` : "配置文件令牌";
	return new OneSSHClientError(
		`OneSSH 未配置有效令牌：${source} 为空`,
		undefined,
		tool,
	);
}

function toolErrorMessage(content: MCPContent[]): string {
	const messages = content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text?.trim())
		.filter((item): item is string => Boolean(item));
	return messages.length > 0 ? messages.join("\n") : "OneSSH 工具调用失败";
}

function outputFromResult(
	result: CallToolResult,
	content: MCPContent[],
): unknown {
	if (result.structuredContent !== undefined) return result.structuredContent;
	for (const item of content) {
		if (item.type !== "text" || !item.text) continue;
		try {
			return JSON.parse(item.text) as unknown;
		} catch {
			// Continue until a structured fallback block is found.
		}
	}
	return {};
}

async function throwHTTPError(
	response: Response,
	method: string,
	tool?: string,
): Promise<never> {
	const text = await response.text();
	let message: string | undefined;
	let rpcCode: number | undefined;
	try {
		const parsed = JSON.parse(text) as JSONRPCEnvelope & ErrorResponse;
		if (parsed.error && typeof parsed.error === "object") {
			message = parsed.error.message;
			rpcCode = parsed.error.code;
		} else if (typeof parsed.error === "string") {
			message = parsed.error;
		}
	} catch {
		message = text.trim().slice(0, 240) || undefined;
	}
	throw new OneSSHClientError(
		message || `OneSSH MCP ${method} 调用失败（HTTP ${response.status}）`,
		response.status,
		tool,
		rpcCode,
	);
}

function decodeRPCEnvelopes(
	text: string,
	contentType: string | null,
): JSONRPCEnvelope[] {
	const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
	let values: unknown[];
	if (mediaType === "text/event-stream") values = decodeSSEData(text);
	else {
		try {
			const parsed = JSON.parse(text) as unknown;
			values = Array.isArray(parsed) ? parsed : [parsed];
		} catch {
			const preview = text.trim().slice(0, 240);
			throw new OneSSHClientError(
				`OneSSH MCP 返回了无效 JSON${preview ? `：${preview}` : ""}`,
			);
		}
	}
	return values.filter(isRPCEnvelope);
}

function decodeSSEData(text: string): unknown[] {
	const values: unknown[] = [];
	const blocks = text.replace(/\r\n?/g, "\n").split(/\n\n+/);
	for (const block of blocks) {
		const data = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (!data || data === "[DONE]") continue;
		try {
			values.push(JSON.parse(data) as unknown);
		} catch {
			throw new OneSSHClientError(
				`OneSSH MCP 返回了无效 SSE data：${data.slice(0, 240)}`,
			);
		}
	}
	return values;
}

function isRPCEnvelope(value: unknown): value is JSONRPCEnvelope {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function waitForSignal<T>(
	promise: Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return await promise;
	if (signal.aborted) throw new OneSSHClientError("OneSSH 调用已取消");
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(new OneSSHClientError("OneSSH 调用已取消"));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

async function readJSON<T>(response: Response): Promise<T | undefined> {
	const text = await response.text();
	if (!text.trim()) return undefined;
	try {
		return JSON.parse(text) as T;
	} catch {
		if (!response.ok) return undefined;
		const preview = text.trim().slice(0, 240);
		throw new OneSSHClientError(
			`OneSSH 返回了无效 JSON（HTTP ${response.status}）${preview ? `：${preview}` : ""}`,
			response.status,
		);
	}
}
