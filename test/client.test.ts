import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	OneSSHClient,
	OneSSHClientError,
} from "../extensions/onessh/client.js";
import {
	DEFAULT_CONFIG,
	type OneSSHConfig,
} from "../extensions/onessh/config.js";

const MODERN_VERSION = "2026-07-28";
const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";

const config = (overrides: Partial<OneSSHConfig> = {}): OneSSHConfig => ({
	...DEFAULT_CONFIG,
	auth: { type: "token", token: "osh_test" },
	...overrides,
});

const rpcResponse = (id: number, result: unknown, status = 200) =>
	new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const rpcError = (id: number, code: number, message: string) =>
	new Response(
		JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);

const discoveryResult = {
	supportedVersions: [MODERN_VERSION, "2025-11-25"],
	capabilities: { tools: {} },
	instructions: "Use hosts_list first.",
	_meta: {
		"io.modelcontextprotocol/serverInfo": {
			name: "OneSSH",
			version: "0.1.8",
		},
	},
};

const parseRequest = (init?: RequestInit) => {
	assert.equal(init?.method, "POST");
	const body = String(init?.body);
	try {
		return JSON.parse(body) as {
			id?: number;
			method: string;
			params: Record<string, any>;
		};
	} catch (error) {
		assert.fail(
			`invalid JSON-RPC request ${body}: ${(error as Error).message}`,
		);
	}
};

const headersOf = (init?: RequestInit) =>
	init?.headers as Record<string, string>;

describe("OneSSH lightweight MCP client", () => {
	it("negotiates once, sends modern MCP metadata, and decodes SSE tool output", async () => {
		const methods: string[] = [];
		const fetchMock = async (input: string | URL, init?: RequestInit) => {
			assert.equal(String(input), "https://ssh.example.com/mcp");
			const request = parseRequest(init);
			const headers = headersOf(init);
			methods.push(request.method);
			assert.equal(headers.Authorization, "Bearer osh_test");
			assert.equal(headers["MCP-Protocol-Version"], MODERN_VERSION);
			assert.equal(headers["Mcp-Method"], request.method);

			if (request.method === "server/discover") {
				assert.equal(
					request.params._meta[META_PROTOCOL_VERSION],
					MODERN_VERSION,
				);
				return rpcResponse(request.id!, discoveryResult);
			}
			assert.equal(headers["Mcp-Name"], "hosts_list");
			assert.equal(request.params.name, "hosts_list");
			assert.equal(request.params._meta[META_PROTOCOL_VERSION], MODERN_VERSION);
			const response = {
				jsonrpc: "2.0",
				id: request.id,
				result: {
					content: [{ type: "text", text: '{"hosts":[{"name":"prod"}]}' }],
					structuredContent: { hosts: [{ name: "prod" }] },
				},
			};
			return new Response(
				`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n` +
					`event: message\ndata: ${JSON.stringify(response)}\n\n`,
				{ headers: { "Content-Type": "text/event-stream; charset=utf-8" } },
			);
		};
		const client = new OneSSHClient(
			config({ baseUrl: "https://ssh.example.com" }),
			fetchMock,
		);

		const first = await client.call<{ hosts: Array<{ name: string }> }>(
			"hosts_list",
			{},
		);
		const second = await client.call<{ hosts: Array<{ name: string }> }>(
			"hosts_list",
			{},
		);
		assert.deepEqual(first.output, { hosts: [{ name: "prod" }] });
		assert.deepEqual(second.output, first.output);
		assert.deepEqual(methods, ["server/discover", "tools/call", "tools/call"]);
	});

	it("shares one lazy negotiation across concurrent first calls", async () => {
		let discovers = 0;
		const fetchMock = async (_input: string | URL, init?: RequestInit) => {
			const request = parseRequest(init);
			if (request.method === "server/discover") {
				discovers++;
				await new Promise((resolve) => setTimeout(resolve, 5));
				return rpcResponse(request.id!, discoveryResult);
			}
			return rpcResponse(request.id!, {
				content: [],
				structuredContent: { ok: true },
			});
		};
		const client = new OneSSHClient(config(), fetchMock);
		await Promise.all([
			client.call("hosts_list", {}),
			client.call("memory_stats", {}),
		]);
		assert.equal(discovers, 1);
	});

	it("falls back to the legacy initialize handshake", async () => {
		const methods: string[] = [];
		const fetchMock = async (_input: string | URL, init?: RequestInit) => {
			const request = parseRequest(init);
			methods.push(request.method);
			if (request.method === "server/discover") {
				return rpcError(request.id!, -32601, "method not found");
			}
			if (request.method === "initialize") {
				assert.equal(headersOf(init)["Mcp-Method"], undefined);
				return rpcResponse(request.id!, {
					protocolVersion: "2025-11-25",
					serverInfo: { name: "OneSSH", version: "0.1.7" },
				});
			}
			if (request.method === "notifications/initialized") {
				return new Response(null, { status: 202 });
			}
			return rpcResponse(request.id!, {
				content: [{ type: "text", text: '{"hosts":[]}' }],
				structuredContent: { hosts: [] },
			});
		};
		const client = new OneSSHClient(config(), fetchMock);
		const response = await client.call("hosts_list", {});
		assert.deepEqual(response.output, { hosts: [] });
		assert.deepEqual(methods, [
			"server/discover",
			"initialize",
			"notifications/initialized",
			"tools/call",
		]);
	});

	it("lists the server catalog only when explicitly requested", async () => {
		const methods: string[] = [];
		const fetchMock = async (_input: string | URL, init?: RequestInit) => {
			const request = parseRequest(init);
			methods.push(request.method);
			if (request.method === "server/discover")
				return rpcResponse(request.id!, discoveryResult);
			if (!request.params.cursor) {
				return rpcResponse(request.id!, {
					tools: [{ name: "hosts_list" }],
					nextCursor: "page-2",
				});
			}
			return rpcResponse(request.id!, { tools: [{ name: "exec" }] });
		};
		const client = new OneSSHClient(config(), fetchMock);
		const catalog = await client.listTools();
		assert.deepEqual(catalog.toolNames, ["hosts_list", "exec"]);
		assert.equal(catalog.connection.mode, "modern");
		assert.deepEqual(methods, ["server/discover", "tools/list", "tools/list"]);
	});

	it("maps MCP tool errors without exposing the token", async () => {
		const fetchMock = async (_input: string | URL, init?: RequestInit) => {
			const request = parseRequest(init);
			if (request.method === "server/discover")
				return rpcResponse(request.id!, discoveryResult);
			return rpcResponse(request.id!, {
				content: [{ type: "text", text: "host not authorized: prod" }],
				isError: true,
			});
		};
		const client = new OneSSHClient(config(), fetchMock);
		await assert.rejects(
			client.call("exec", { host: "prod", command: "true" }),
			(error: OneSSHClientError) => {
				assert.equal(error.message, "host not authorized: prod");
				assert.equal(error.tool, "exec");
				assert.equal(error.message.includes("osh_test"), false);
				return true;
			},
		);
	});

	it("fails before network access when the configured environment token is empty", async () => {
		delete process.env.MISSING_ONESSH_TOKEN;
		let called = false;
		const client = new OneSSHClient(
			config({ auth: { type: "env", env: "MISSING_ONESSH_TOKEN" } }),
			async () => {
				called = true;
				return rpcResponse(1, discoveryResult);
			},
		);
		await assert.rejects(client.call("hosts_list", {}), OneSSHClientError);
		assert.equal(called, false);
	});

	it("propagates cancellation after SSE response headers arrive", async () => {
		let markBodyStarted: (() => void) | undefined;
		const bodyStarted = new Promise<void>((resolve) => {
			markBodyStarted = resolve;
		});
		const fetchMock = async (_input: string | URL, init?: RequestInit) => {
			const request = parseRequest(init);
			if (request.method === "server/discover") {
				return rpcResponse(request.id!, discoveryResult);
			}
			const stream = new ReadableStream({
				start(controller) {
					markBodyStarted?.();
					init?.signal?.addEventListener(
						"abort",
						() => controller.error(init.signal?.reason),
						{ once: true },
					);
				},
			});
			return new Response(stream, {
				headers: { "Content-Type": "text/event-stream" },
			});
		};
		const client = new OneSSHClient(config(), fetchMock);
		await client.connect();
		const controller = new AbortController();
		const call = client.call("hosts_list", {}, controller.signal);
		await bodyStarted;
		controller.abort();
		await assert.rejects(call, /已取消/);
	});

	it("cancels negotiation at the configured deadline", async () => {
		const fetchMock = (_input: string | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(init.signal?.reason),
					{ once: true },
				);
			});
		const client = new OneSSHClient(config({ timeoutMs: 5 }), fetchMock);
		await assert.rejects(client.call("hosts_list", {}), /请求超时/);
	});
});
