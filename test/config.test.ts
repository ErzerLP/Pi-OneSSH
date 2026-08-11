import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	DEFAULT_CONFIG,
	clearConfig,
	configPath,
	configurePiPaths,
	loadConfig,
	normalizeBaseUrl,
	resolveToken,
	saveConfig,
	type OneSSHConfig,
} from "../extensions/onessh/config.js";

const oldToken = process.env.TEST_ONESSH_TOKEN;
afterEach(() => {
	if (oldToken === undefined) delete process.env.TEST_ONESSH_TOKEN;
	else process.env.TEST_ONESSH_TOKEN = oldToken;
});

describe("OneSSH configuration", () => {
	it("normalizes origins and rejects paths or credentials", () => {
		assert.equal(
			normalizeBaseUrl("HTTPS://SSH.Example.com:443/"),
			"https://ssh.example.com",
		);
		assert.throws(() => normalizeBaseUrl("ssh://example.com"), /http/);
		assert.throws(() => normalizeBaseUrl("https://user@example.com"), /账号/);
		assert.throws(
			() => normalizeBaseUrl("https://example.com/api"),
			/不能带路径/,
		);
	});

	it("keeps global origin and credential indivisible from project overrides", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-onessh-config-"));
		const cwd = join(root, "project");
		configurePiPaths(join(root, "agent"), ".pi");
		const globalConfig: OneSSHConfig = {
			...DEFAULT_CONFIG,
			baseUrl: "https://trusted.example.com",
			auth: { type: "token", token: "osh_global_secret" },
			initialGroups: ["core"],
		};
		await saveConfig("global", cwd, globalConfig);

		const maliciousProjectDraft: OneSSHConfig = {
			...globalConfig,
			baseUrl: "https://attacker.example.com",
			auth: { type: "token", token: "osh_should_not_be_written" },
			defaultHost: "prod",
			session: "project-session",
			initialGroups: ["core", "memory"],
		};
		await saveConfig("project", cwd, maliciousProjectDraft);

		const projectRaw = await readFile(configPath("project", cwd), "utf8");
		assert.equal(projectRaw.includes("attacker.example.com"), false);
		assert.equal(projectRaw.includes("osh_should_not_be_written"), false);
		const loaded = await loadConfig(cwd, true);
		assert.equal(loaded.config.baseUrl, "https://trusted.example.com");
		assert.deepEqual(loaded.config.auth, {
			type: "token",
			token: "osh_global_secret",
		});
		assert.equal(loaded.config.defaultHost, "prod");
		assert.equal(loaded.config.session, "project-session");
		assert.deepEqual(loaded.config.initialGroups, ["core", "memory"]);

		if (process.platform !== "win32") {
			assert.equal((await stat(configPath("global", cwd))).mode & 0o777, 0o600);
		}
		await clearConfig("project", cwd);
		assert.equal((await loadConfig(cwd, true)).projectLoaded, false);
	});

	it("resolves environment credentials without persisting their value", () => {
		process.env.TEST_ONESSH_TOKEN = "osh_from_env";
		const config: OneSSHConfig = {
			...DEFAULT_CONFIG,
			auth: { type: "env", env: "TEST_ONESSH_TOKEN" },
		};
		assert.equal(resolveToken(config), "osh_from_env");
		delete process.env.TEST_ONESSH_TOKEN;
		assert.equal(resolveToken(config), undefined);
	});
});
