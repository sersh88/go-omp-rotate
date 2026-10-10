import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
	CONFIG_PATH_ENV,
	getConfigPath,
	getDefaultConfigPath,
	loadConfig,
	migrateLegacyConfig,
	updateConfig,
} from "../src/config-store.ts";
import {
	createOpencodeGoPoolExtension,
	type CredentialValue,
	type ExtensionAPI,
	type ExtensionContext,
	type StoredCredentialRow,
} from "../src/index.ts";
import { sanitizeReasoningPayload } from "../src/pool.ts";

const previousConfigPath = process.env[CONFIG_PATH_ENV];

afterEach(() => {
	if (previousConfigPath === undefined) delete process.env[CONFIG_PATH_ENV];
	else process.env[CONFIG_PATH_ENV] = previousConfigPath;
});

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "go-omp-pool-"));
}

function writeKeysConfig(configPath: string, keys: Array<{ name: string; key: string }>, extra: Record<string, unknown> = {}): void {
	writeFileSync(configPath, JSON.stringify({ keys, ...extra }));
}

function credentialRow(id: number, credential: CredentialValue): StoredCredentialRow {
	return { id, provider: "opencode-go", credential };
}

interface FakeCredentialPool {
	rows: StoredCredentialRow[];
	readonly listCalls: string[];
	readonly setCalls: Array<{ provider: string; credentials: CredentialValue[] }>;
	failNextSet: boolean;
	failList: boolean;
	list(provider?: string): StoredCredentialRow[];
	set(provider: string, credentials: CredentialValue | CredentialValue[]): void;
}

function createFakeCredentialPool(initial: StoredCredentialRow[] = []): FakeCredentialPool {
	let nextId = initial.length;
	const pool: FakeCredentialPool = {
		rows: [...initial],
		listCalls: [],
		setCalls: [],
		failNextSet: false,
		failList: false,
		list(provider) {
			pool.listCalls.push(provider ?? "*");
			if (pool.failList) throw new Error("pool read failed");
			return pool.rows.filter((row) => provider === undefined || row.provider === provider);
		},
		set(provider, credentials) {
			if (pool.failNextSet) {
				pool.failNextSet = false;
				throw new Error("pool write failed");
			}
			const values = Array.isArray(credentials) ? credentials : [credentials];
			pool.setCalls.push({ provider, credentials: values });
			// Mirror the host store: an existing api_key row with the same key keeps its id.
			pool.rows = values.map((value) => {
				const reusable = value.type === "api_key"
					? pool.rows.find((row) => row.credential.type === "api_key" && row.credential.key === value.key)
					: undefined;
				return { id: reusable?.id ?? ++nextId, provider, credential: value };
			});
		},
	};
	return pool;
}

interface Harness {
	fire(event: string, payload: unknown): Promise<unknown>;
	command(args: string): Promise<unknown>;
	readonly notices: string[];
	readonly removedRuntimeProviders: string[];
	readonly pool: FakeCredentialPool | null;
	readonly completions: ((prefix: string) => Array<{ value: string; label: string }> | null) | undefined;
}

function createHarness(pool: FakeCredentialPool | null | undefined = undefined, failRemoveRuntime = false): Harness {
	const credentialPool = pool === undefined ? createFakeCredentialPool() : pool;
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionContext) => unknown) | undefined;
	let completions: ((prefix: string) => Array<{ value: string; label: string }> | null) | undefined;
	const removedRuntimeProviders: string[] = [];
	const notices: string[] = [];
	const host: ExtensionAPI = {
		on(event, handler) {
			handlers.set(event, handler as (event: unknown, ctx: ExtensionContext) => unknown);
		},
		registerCommand(_name, options) {
			command = options.handler;
			completions = options.getArgumentCompletions ?? undefined;
		},
	};
	createOpencodeGoPoolExtension()(host);
	const ctx: ExtensionContext = {
		ui: {
			notify(message) {
				notices.push(message);
			},
		},
		model: { provider: "opencode-go" },
		modelRegistry: {
			authStorage: {
				keys: {
					removeRuntime(provider) {
						if (failRemoveRuntime) throw new Error("remove failed");
						removedRuntimeProviders.push(provider);
					},
				},
				credentials: credentialPool ?? undefined,
			},
		},
	};
	return {
		async fire(event, payload) {
			const handler = handlers.get(event);
			if (!handler) throw new Error(`${event} was not registered`);
			return await handler(payload, ctx);
		},
		async command(args) {
			if (!command) throw new Error("the /opencode command was not registered");
			return await command(args, ctx);
		},
		notices,
		removedRuntimeProviders,
		pool: credentialPool,
		completions,
	};
}

// ---------------------------------------------------------------------------
// Config paths
// ---------------------------------------------------------------------------

test("default config lives in the omp agent dir", () => {
	delete process.env[CONFIG_PATH_ENV];
	expect(getConfigPath()).toBe(getDefaultConfigPath());
	expect(getDefaultConfigPath().endsWith("/.omp/agent/go-omp-rotate.json")).toBe(true);
});

test("explicit path does not import the pi config", () => {
	const dir = tempDir();
	const target = join(dir, "fresh.json");
	delete process.env[CONFIG_PATH_ENV];
	try {
		updateConfig(() => true, target);
		expect(loadConfig(target).keys.length).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy import copies names once and does not overwrite", () => {
	const dir = tempDir();
	const legacy = join(dir, "legacy.json");
	const target = join(dir, "next.json");
	writeFileSync(legacy, JSON.stringify({ keys: [{ name: "personal", key: "sk-fixture" }] }));
	try {
		expect(migrateLegacyConfig(target, legacy)).toBe(true);
		const loaded = loadConfig(target);
		expect(loaded.keys.map((entry) => entry.name)).toEqual(["personal"]);
		expect(loaded.keys[0]?.key).toBe("sk-fixture");
		writeFileSync(legacy, JSON.stringify({ keys: [{ name: "other", key: "sk-other" }] }));
		expect(migrateLegacyConfig(target, legacy)).toBe(false);
		expect(loadConfig(target).keys.map((entry) => entry.name)).toEqual(["personal"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("retired rotation fields are ignored on read", () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			keys: [{ name: "a", key: "sk-fixture-a" }],
			activeKeyIndex: 5,
			cooldownMinutes: 5,
			watchdogEnabled: false,
			watchdogIdleMs: 1,
			lastRequestAt: 123,
			cooldowns: { 0: 1 },
			quotaBlockedUntil: { 0: 2 },
			nativePool: { phase: "enabled", originalCredentials: [] },
		}),
	);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const loaded = loadConfig(configPath);
		expect(loaded).toEqual({ keys: [{ name: "a", key: "sk-fixture-a" }] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("malformed config fails closed", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		for (const body of [
			"{not json",
			JSON.stringify({ keys: "nope" }),
			JSON.stringify({ keys: [{ name: "a" }] }),
		]) {
			writeFileSync(configPath, body);
			const harness = createHarness();
			await harness.fire("session_start", {});
			expect(harness.notices.at(-1)).toContain("No configuration was changed");
			expect(harness.pool?.setCalls.length).toBe(0);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Startup sync
// ---------------------------------------------------------------------------

test("session start syncs configured keys into the pool", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [
		{ name: "a", key: "sk-fixture-a" },
		{ name: "b", key: "sk-fixture-b" },
	]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool([credentialRow(1, { type: "api_key", key: "sk-host-original" })]);
		const harness = createHarness(pool);
		await harness.fire("session_start", {});
		expect(pool.setCalls).toEqual([
			{
				provider: "opencode-go",
				credentials: [
					{ type: "api_key", key: "sk-fixture-a", source: "login" },
					{ type: "api_key", key: "sk-fixture-b", source: "login" },
				],
			},
		]);
		expect(harness.removedRuntimeProviders).toEqual(["opencode-go"]);
		expect(harness.notices.at(-1)).toContain("pool synchronized");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a matching pool is not rewritten", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [
		{ name: "a", key: "sk-fixture-a" },
		{ name: "b", key: "sk-fixture-b" },
	]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool([
			credentialRow(10, { type: "api_key", key: "sk-fixture-a", source: "login" }),
			credentialRow(11, { type: "api_key", key: "sk-fixture-b", source: "login" }),
		]);
		const harness = createHarness(pool);
		await harness.fire("session_start", {});
		expect(pool.setCalls.length).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a shuffled but matching row order does not rewrite the pool", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [
		{ name: "a", key: "sk-fixture-a" },
		{ name: "b", key: "sk-fixture-b" },
	]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool([
			credentialRow(20, { type: "api_key", key: "sk-fixture-b", source: "login" }),
			credentialRow(10, { type: "api_key", key: "sk-fixture-a", source: "login" }),
		]);
		const harness = createHarness(pool);
		await harness.fire("session_start", {});
		expect(pool.setCalls.length).toBe(0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("empty config leaves the host pool untouched", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, []);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool([credentialRow(1, { type: "api_key", key: "sk-host-original" })]);
		const harness = createHarness(pool);
		await harness.fire("session_start", {});
		expect(pool.setCalls.length).toBe(0);
		expect(pool.rows.length).toBe(1);
		expect(harness.removedRuntimeProviders).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("missing credentials API is a visible error, not a silent no-op", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [{ name: "a", key: "sk-fixture-a" }]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const harness = createHarness(null);
		await harness.fire("session_start", {});
		expect(harness.notices.some((message) => message.includes("credentials API"))).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed pool write is reported and retried on reload", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [{ name: "a", key: "sk-fixture-a" }]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool();
		pool.failNextSet = true;
		const harness = createHarness(pool);
		await harness.fire("session_start", {});
		expect(pool.setCalls.length).toBe(0);
		expect(harness.notices.some((message) => message.includes("cannot update"))).toBe(true);
		await harness.fire("session_start", {});
		expect(pool.setCalls.length).toBe(1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a failed runtime-override removal warns instead of claiming success", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [{ name: "a", key: "sk-fixture-a" }]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool([credentialRow(1, { type: "api_key", key: "sk-host-original" })]);
		const harness = createHarness(pool, true);
		await harness.fire("session_start", {});
		expect(pool.setCalls.length).toBe(1);
		expect(harness.notices.some((message) => message.includes("runtime override"))).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

test("status lists keys and pool state without key material", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [
		{ name: "a", key: "sk-fixture-a" },
		{ name: "b", key: "sk-fixture-b" },
	]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool();
		const harness = createHarness(pool);
		await harness.command("status");
		const notice = harness.notices.at(-1) ?? "";
		expect(notice).toContain("1. a");
		expect(notice).toContain("2. b");
		expect(notice).not.toContain("sk-fixture-a");
		expect(notice).not.toContain("sk-fixture-b");
		expect(pool.setCalls.length).toBe(0);
		await harness.command("");
		expect(harness.notices.at(-1)).toContain("1. a");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("add persists and syncs", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [{ name: "a", key: "sk-fixture-a" }]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool([credentialRow(1, { type: "api_key", key: "sk-fixture-a", source: "login" })]);
		const harness = createHarness(pool);
		await harness.command("add b sk-fixture-b");
		expect(loadConfig(configPath).keys.map((entry) => entry.name)).toEqual(["a", "b"]);
		expect(pool.setCalls.length).toBe(1);
		expect(harness.notices.some((message) => message.includes('Added "b"'))).toBe(true);
		await harness.command("add");
		expect(harness.notices.at(-1)).toContain("Usage: /opencode add");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("rm removes and syncs; the last key cannot be removed", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [
		{ name: "a", key: "sk-fixture-a" },
		{ name: "b", key: "sk-fixture-b" },
	]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const pool = createFakeCredentialPool();
		const harness = createHarness(pool);
		await harness.fire("session_start", {});
		const synced = pool.setCalls.length;
		await harness.command("rm 1");
		expect(loadConfig(configPath).keys.map((entry) => entry.name)).toEqual(["b"]);
		expect(pool.setCalls.length).toBe(synced + 1);
		expect(harness.notices.some((message) => message.includes('Removed "a"'))).toBe(true);
		await harness.command("rm 1");
		expect(loadConfig(configPath).keys.length).toBe(1);
		expect(harness.notices.at(-1)).toContain("last configured key");
		await harness.command("rm 9");
		expect(harness.notices.at(-1)).toContain("Invalid index");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("unknown commands show usage and completions list the three commands", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [{ name: "a", key: "sk-fixture-a" }]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const harness = createHarness();
		await harness.command("frobnicate");
		expect(harness.notices.at(-1)).toContain("Usage: /opencode [status|add");
		const listed = harness.completions?.("")?.map((item) => item.value);
		expect(listed).toEqual(["status", "add", "rm"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only startup and sanitizer hooks are registered", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [{ name: "a", key: "sk-fixture-a" }]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const seen: string[] = [];
		const host: ExtensionAPI = {
			on(event) {
				seen.push(event);
			},
			registerCommand() {},
		};
		createOpencodeGoPoolExtension()(host);
		expect(seen.sort()).toEqual(["before_provider_request", "session_start"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Sanitizer (narrow compatibility hook, provider-scoped)
// ---------------------------------------------------------------------------

test("sanitizer strips signed reasoning on opencode-go requests only", async () => {
	const dir = tempDir();
	const configPath = join(dir, "keys.json");
	writeKeysConfig(configPath, [{ name: "a", key: "sk-fixture-a" }]);
	process.env[CONFIG_PATH_ENV] = configPath;
	try {
		const harness = createHarness();
		const payload = {
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "plan", signature: "sig" }],
					reasoning_details: [{ type: "reasoning.encrypted", data: "x" }],
				},
			],
		};
		const result = await harness.fire("before_provider_request", { payload }) as unknown;
		expect(JSON.stringify(result)).not.toContain("sig");
		expect(JSON.stringify(result)).not.toContain("reasoning.encrypted");
		// Other providers pass through untouched.
		const other = { messages: [{ role: "assistant", content: "hi" }] };
		const passthrough = await harness.fire("before_provider_request", { payload: other });
		expect(passthrough).not.toBe(other);
		expect(passthrough).toEqual(other);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sanitizeReasoningPayload projects thinking and drops redacted blocks", () => {
	const payload = {
		messages: [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "  idea  ", signature: "s" },
					{ type: "redacted_thinking" },
					{ type: "text", text: "done" },
				],
			},
		],
		input: [{ type: "reasoning" }, { type: "text" }],
	};
	const result = sanitizeReasoningPayload(payload) as {
		messages: Array<{ content?: unknown[] }>;
		input: unknown[];
	};
	expect(result.messages[1]?.content).toEqual([
		{ type: "text", text: "  idea  " },
		{ type: "text", text: "done" },
	]);
	expect(result.input).toEqual([{ type: "text" }]);
	// Input payload is not mutated.
	expect((payload.messages[1] as { content: unknown[] }).content.length).toBe(3);
});
