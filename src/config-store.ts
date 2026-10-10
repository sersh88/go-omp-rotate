import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const CONFIG_PATH_ENV = "GO_OMP_ROTATE_CONFIG";

const CONFIG_FILE_MODE = 0o600;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 10;

export interface KeyEntry {
	name: string;
	key: string;
}

/** Pool-only config: the key list is the source of truth for the OMP credential pool. */
export interface Config {
	keys: KeyEntry[];
}

export class ConfigLoadError extends Error {
	readonly path: string;

	constructor(path: string, reason: string) {
		super(`Invalid config at ${path}: ${reason}`);
		this.name = "ConfigLoadError";
		this.path = path;
	}
}

export function createEmptyConfig(): Config {
	return { keys: [] };
}

export function getDefaultConfigPath(): string {
	return join(homedir(), ".omp", "agent", "go-omp-rotate.json");
}

export function getLegacyConfigPath(): string {
	return join(homedir(), ".pi", "agent", "opencode-keys.json");
}

export function getConfigPath(): string {
	return process.env[CONFIG_PATH_ENV] ?? getDefaultConfigPath();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKeys(value: unknown, path: string): KeyEntry[] {
	if (!Array.isArray(value)) throw new ConfigLoadError(path, `"keys" must be an array`);
	return value.map((entry, index) => {
		if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.key !== "string" || entry.key.length === 0) {
			throw new ConfigLoadError(path, `"keys[${index}]" must be {name,key}`);
		}
		return { name: entry.name, key: entry.key };
	});
}

/**
 * Parse keys-only config. Retired rotation/pool-mode fields (activeKeyIndex,
 * cooldowns, quotaBlockedUntil, cooldownMinutes, watchdog*, lastRequestAt,
 * nativePool) are ignored so old files keep loading; first write normalizes
 * the file to keys-only (after a pre-upgrade backup, see index.ts).
 */
function parseConfig(value: unknown, path: string): Config {
	if (!isRecord(value)) throw new ConfigLoadError(path, "root must be an object");
	return { keys: parseKeys(value.keys, path) };
}

function readConfigUnlocked(path: string): Config {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return createEmptyConfig();
		throw new ConfigLoadError(path, `cannot read: ${(error as Error).message}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new ConfigLoadError(path, `invalid JSON: ${(error as Error).message}`);
	}
	return parseConfig(parsed, path);
}

function sleepSync(milliseconds: number): void {
	const end = Date.now() + milliseconds;
	while (Date.now() < end) { /* spin briefly; lock waits are short */ }
}

function acquireLock(path: string): string {
	const lockPath = `${path}.lock`;
	const start = Date.now();
	for (;;) {
		try {
			const fd = openSync(lockPath, "wx", CONFIG_FILE_MODE);
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return lockPath;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
		}
		try {
			const age = Date.now() - statSync(lockPath).mtimeMs;
			if (age > LOCK_STALE_MS) rmSync(lockPath, { force: true });
		} catch { /* lock vanished between check and read */ }
		if (Date.now() - start > LOCK_TIMEOUT_MS) {
			throw new ConfigLoadError(path, "config is locked by another process");
		}
		sleepSync(LOCK_RETRY_MS);
	}
}

function withLock<T>(path: string, operation: () => T): T {
	const lockPath = acquireLock(path);
	try {
		return operation();
	} finally {
		rmSync(lockPath, { force: true });
	}
}

function writeConfigUnlocked(path: string, config: Config): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.tmp.${process.pid}`;
	const fd = openSync(tmpPath, "w", CONFIG_FILE_MODE);
	try {
		writeSync(fd, JSON.stringify(config, null, 2));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(tmpPath, CONFIG_FILE_MODE);
	renameSync(tmpPath, path);
	chmodSync(path, CONFIG_FILE_MODE);
}

/** Copy legacy into target when target is absent. Callers decide whether that is allowed. */
export function migrateLegacyConfig(targetPath: string, legacyPath = getLegacyConfigPath()): boolean {
	if (existsSync(targetPath)) return false;
	if (!existsSync(legacyPath)) return false;
	try {
		const legacy = parseConfig(JSON.parse(readFileSync(legacyPath, "utf8")), legacyPath);
		writeConfigUnlocked(targetPath, legacy);
		return true;
	} catch {
		return false;
	}
}

export function loadConfig(path = getConfigPath()): Config {
	return withLock(path, () => {
		if (path === getDefaultConfigPath()) migrateLegacyConfig(path);
		return readConfigUnlocked(path);
	});
}

export function updateConfig<T>(mutator: (config: Config) => T, path = getConfigPath()): { config: Config; result: T } {
	return withLock(path, () => {
		if (path === getDefaultConfigPath()) migrateLegacyConfig(path);
		const config = readConfigUnlocked(path);
		const result = mutator(config);
		writeConfigUnlocked(path, config);
		return { config, result };
	});
}

export function writeConfig(config: Config, path = getConfigPath()): void {
	withLock(path, () => writeConfigUnlocked(path, config));
}
