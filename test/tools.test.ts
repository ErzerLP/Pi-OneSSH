import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../extensions/onessh/config.js";
import { TOOL_NAMES, TOOL_SPECS } from "../extensions/onessh/schemas.js";
import {
	LOADER_TOOL_NAME,
	applyConfiguredTools,
	registerOneSSHTools,
} from "../extensions/onessh/tools.js";

const expectedRemoteNames = [
	"hosts_list",
	"exec",
	"session_env",
	"exec_many",
	"output_read",
	"job_start",
	"job_list",
	"job_status",
	"job_logs",
	"job_kill",
	"file_read",
	"file_write",
	"file_edit",
	"file_list",
	"file_transfer",
	"image_view",
	"grep",
	"find",
	"memory_remember",
	"memory_recall",
	"memory_list",
	"memory_update",
	"memory_forget",
	"memory_stats",
	"memory_sleep",
	"host_status",
	"hosts_manage_list",
	"host_create",
	"host_update",
	"host_test",
	"host_reset_fingerprint",
	"host_delete",
].sort();

describe("OneSSH tool catalog", () => {
	it("contains exactly the 32 production tools with collision-safe names", () => {
		assert.equal(TOOL_SPECS.length, 32);
		assert.deepEqual(
			TOOL_SPECS.map((tool) => tool.remoteName).sort(),
			expectedRemoteNames,
		);
		assert.equal(TOOL_NAMES.size, 32);
		assert.equal(
			TOOL_SPECS.every((tool) => tool.name === `onessh_${tool.remoteName}`),
			true,
		);
		assert.equal(TOOL_NAMES.has("grep"), false);
		assert.equal(TOOL_NAMES.has("find"), false);
		assert.equal(
			TOOL_SPECS.every(
				(tool) => (tool.parameters as { type?: string }).type === "object",
			),
			true,
		);
	});

	it("preserves unrelated tools while applying configured initial groups", () => {
		let active = ["read", "another_extension", "onessh_job_start"];
		const pi = {
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => {
				active = names;
			},
		} as unknown as ExtensionAPI;
		applyConfiguredTools(
			pi,
			{ ...DEFAULT_CONFIG, initialGroups: ["core", "search"] },
			true,
		);
		assert.equal(active.includes("read"), true);
		assert.equal(active.includes("another_extension"), true);
		assert.equal(active.includes(LOADER_TOOL_NAME), true);
		assert.equal(active.includes("onessh_hosts_list"), true);
		assert.equal(active.includes("onessh_grep"), true);
		assert.equal(active.includes("onessh_job_start"), false);
	});

	it("registers one additive loader plus all MCP tools", async () => {
		const definitions = new Map<string, any>();
		let active = ["read", LOADER_TOOL_NAME];
		const pi = {
			registerTool: (definition: { name: string }) =>
				definitions.set(definition.name, definition),
			getActiveTools: () => [...active],
			setActiveTools: (names: string[]) => {
				active = names;
			},
		} as unknown as ExtensionAPI;
		registerOneSSHTools(pi, () => undefined);
		assert.equal(definitions.size, 33);
		const loader = definitions.get(LOADER_TOOL_NAME);
		await loader.execute("call", { groups: ["jobs"] });
		assert.equal(active.includes("read"), true);
		assert.equal(active.includes("onessh_job_start"), true);
		assert.equal(active.includes("onessh_job_kill"), true);
	});

	it("drops the MCP JSON fallback in favor of compact structured output", async () => {
		const definitions = new Map<string, any>();
		const pi = {
			registerTool: (definition: { name: string }) =>
				definitions.set(definition.name, definition),
			getActiveTools: () => ["read"],
			setActiveTools: () => undefined,
		} as unknown as ExtensionAPI;
		const runtime = {
			config: DEFAULT_CONFIG,
			client: {
				call: async () => ({
					output: {
						hosts: [
							{
								name: "prod",
								username: "deploy",
								addr: "10.0.0.8",
								online: true,
							},
						],
					},
					content: [
						{
							type: "text",
							text: '{"hosts":[{"name":"prod"}]}',
						},
					],
				}),
			},
		};
		registerOneSSHTools(pi, () => runtime as never);
		const result = await definitions
			.get("onessh_hosts_list")
			.execute("call", {}, undefined, undefined);
		assert.equal(result.content.length, 1);
		assert.equal(result.content[0].text, "online\tprod\tdeploy@10.0.0.8");
		assert.equal(result.details.transport, "mcp-lite");
	});
});
