/**
 * OpenCode Go credential-pool extension. The configured key list is the source of truth for
 * the OMP `opencode-go` credential pool; OMP owns selection, retries, affinity and quota
 * handling. The plugin only synchronizes the pool on session start and after `add`/`rm`,
 * plus a provider-scoped outgoing-payload compatibility projection (see pool.ts).
 */

import {
	ConfigLoadError,
	createEmptyConfig,
	loadConfig,
	updateConfig,
	type Config,
} from "./config-store.ts";
import { PROVIDER } from "./constants.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	StoredCredentialRow,
} from "./host.ts";
import {
	credentialPoolMatches,
	desiredPoolCredentials,
	getCredentialPool,
	removeRuntimeOverride,
	sanitizeReasoningPayload,
} from "./pool.ts";

export type {
	CredentialPool,
	CredentialValue,
	ExtensionAPI,
	ExtensionContext,
	StoredCredentialRow,
} from "./host.ts";

/**
 * Build one extension registration: synchronize the OMP credential pool with the configured
 * keys and expose the `/opencode` command. No request-time key selection, timers, usage
 * requests or retries live here.
 */
export function createOpencodeGoPoolExtension() {
	return function opencodeGoPoolExtension(pi: ExtensionAPI) {
		let config = createEmptyConfig();
		let configError: string | undefined;

		function formatConfigError(error: unknown): string {
			if (error instanceof ConfigLoadError) return error.message;
			if (error instanceof Error) return error.message;
			return "Unknown configuration error";
		}

		function refreshConfig(): boolean {
			try {
				config = loadConfig();
				configError = undefined;
				return true;
			} catch (error) {
				configError = formatConfigError(error);
				return false;
			}
		}

		function mutateSharedConfig<T>(mutator: (freshConfig: Config) => T): T | undefined {
			try {
				const updated = updateConfig(mutator);
				config = updated.config;
				configError = undefined;
				return updated.result;
			} catch (error) {
				configError = formatConfigError(error);
				return undefined;
			}
		}

		function ensureConfig(ctx: Pick<ExtensionContext, "ui">): boolean {
			if (refreshConfig()) return true;
			ctx.ui.notify(`OpenCode: ${configError}. No configuration was changed.`, "error");
			return false;
		}

		function describeHostError(error: unknown): string {
			return error instanceof Error ? error.message : "unknown error";
		}

		type PoolSync = "noop-empty" | "unchanged" | "synced" | "unsupported" | "error";

		/**
		 * Reconcile the host pool with the configured keys. Empty config is an explicit
		 * no-op: the host pool is left untouched. Returns the outcome for status text and
		 * command reporting; errors are reported through the UI.
		 */
		async function syncPool(ctx: Pick<ExtensionContext, "ui" | "modelRegistry">): Promise<PoolSync> {
			if (config.keys.length === 0) return "noop-empty";
			const pool = getCredentialPool(ctx.modelRegistry);
			if (!pool) {
				ctx.ui.notify("OpenCode: this host does not expose the OMP credentials API; the pool was not synchronized.", "error");
				return "unsupported";
			}
			const desired = desiredPoolCredentials(config);
			let current: StoredCredentialRow[];
			try {
				current = pool.list(PROVIDER);
			} catch (error) {
				ctx.ui.notify(`OpenCode: cannot read the OMP credential pool: ${describeHostError(error)}`, "error");
				return "error";
			}
			if (credentialPoolMatches(current, desired)) {
				if (!removeRuntimeOverride(ctx.modelRegistry)) {
					ctx.ui.notify("OpenCode: the pool matches, but a stale runtime override could not be removed and may shadow it.", "warning");
				}
				return "unchanged";
			}
			try {
				await pool.set(PROVIDER, desired);
			} catch (error) {
				ctx.ui.notify(`OpenCode: cannot update the OMP credential pool: ${describeHostError(error)}`, "error");
				return "error";
			}
			if (!removeRuntimeOverride(ctx.modelRegistry)) {
				ctx.ui.notify("OpenCode: the pool was updated, but a stale runtime override could not be removed and may shadow it.", "warning");
			}
			return "synced";
		}

		async function reconcileOnStart(ctx: ExtensionContext): Promise<void> {
			if (!ensureConfig(ctx)) return;
			const result = await syncPool(ctx);
			if (result === "synced") {
				ctx.ui.notify(`OpenCode: pool synchronized — ${config.keys.length} keys in the OMP credential pool.`, "info");
			} else if (result === "error" || result === "unsupported") {
				ctx.ui.notify("OpenCode: pool synchronization failed; retry with /reload after fixing the problem.", "warning");
			}
		}

		function poolStatusText(hostCount: number | undefined): string {
			if (configError) return `OpenCode: ${configError}.`;
			if (config.keys.length === 0) {
				return "Pool: unmanaged — no keys configured. The host pool is left untouched; add the first key with /opencode add <name> <key>.";
			}
			const names = config.keys.map((entry, index) => `${index + 1}. ${entry.name}`).join("\n");
			const host = hostCount === undefined ? "host pool: unreadable" : `host pool: ${hostCount} credentials`;
			return `Pool: ${config.keys.length} configured keys (${host}). OMP selects credentials; retries and quota handling are the host's.\n${names}`;
		}

		function readHostCount(ctx: Pick<ExtensionContext, "modelRegistry">): number | undefined {
			const pool = getCredentialPool(ctx.modelRegistry);
			if (!pool) return undefined;
			try {
				return pool.list(PROVIDER).length;
			} catch {
				return undefined;
			}
		}

		pi.on("session_start", async (_event, ctx) => {
			await reconcileOnStart(ctx);
		});

		pi.on("before_provider_request", async (event, ctx) => {
			if (ctx.model?.provider !== PROVIDER) return event.payload;
			return sanitizeReasoningPayload(event.payload);
		});

		pi.registerCommand("opencode", {
			description: "Manage OpenCode Go keys in the OMP credential pool",
			getArgumentCompletions: (argumentPrefix: string) => {
				const commands = [
					{ value: "status", label: "status", description: "Show keys and pool state" },
					{ value: "add", label: "add", description: "Add a key: /opencode add <name> <key>", hint: "<name> <key>" },
					{ value: "rm", label: "rm", description: "Remove a key: /opencode rm <n>", hint: "<n>" },
				];
				const prefix = argumentPrefix.trim().toLowerCase();
				const matches = commands.filter((command) => command.value.startsWith(prefix));
				return matches.length > 0 ? matches : null;
			},
			handler: async (args, ctx) => {
				if (!ensureConfig(ctx)) return;
				const parts = args.trim().split(/\s+/).filter((part) => part.length > 0);
				const subcommand = (parts[0] ?? "status").toLowerCase();

				if (subcommand === "status" || subcommand === "state" || subcommand === "") {
					ctx.ui.notify(poolStatusText(readHostCount(ctx)), "info");
					return;
				}

				if (subcommand === "add") {
					const name = parts[1];
					const key = parts[2];
					if (!name || !key || parts.length !== 3) {
						ctx.ui.notify("Usage: /opencode add <name> <key>", "warning");
						return;
					}
					const count = mutateSharedConfig((freshConfig) => {
						freshConfig.keys.push({ name, key });
						return freshConfig.keys.length;
					});
					if (count === undefined) {
						if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
						return;
					}
					ctx.ui.notify(`Added "${name}" (${count} keys)`, "info");
					const result = await syncPool(ctx);
					if (result === "synced" || result === "unchanged") {
						ctx.ui.notify(`OpenCode: pool synchronized — ${count} keys in the OMP credential pool.`, "info");
					} else if (result === "noop-empty") {
						ctx.ui.notify("OpenCode: configuration saved; the host pool was left untouched.", "info");
					} else {
						ctx.ui.notify("OpenCode: configuration saved; pool synchronization failed. Retry with /reload.", "warning");
					}
					return;
				}

				if (subcommand === "remove" || subcommand === "rm") {
					const indexArg = parseInt(parts[1] ?? "", 10);
					const result = mutateSharedConfig((freshConfig) => {
						if (!Number.isInteger(indexArg) || indexArg < 1 || indexArg > freshConfig.keys.length) {
							return { error: `Invalid index. Use 1-${freshConfig.keys.length}.` };
						}
						if (freshConfig.keys.length <= 1) {
							return { error: "Cannot remove the last configured key; the pool needs at least one." };
						}
						const removed = freshConfig.keys.splice(indexArg - 1, 1)[0];
						return { removedName: removed.name, count: freshConfig.keys.length };
					});
					if (!result) {
						if (configError) ctx.ui.notify(`OpenCode: ${configError}.`, "error");
						return;
					}
					if ("error" in result && typeof result.error === "string") {
						ctx.ui.notify(result.error, "warning");
						return;
					}
					if (!("removedName" in result)) return;
					ctx.ui.notify(`Removed "${result.removedName}" (${result.count} left)`, "info");
					const syncResult = await syncPool(ctx);
					if (syncResult === "synced" || syncResult === "unchanged") {
						ctx.ui.notify(`OpenCode: pool synchronized — ${result.count} keys in the OMP credential pool.`, "info");
					} else {
						ctx.ui.notify("OpenCode: configuration saved; pool synchronization failed. Retry with /reload.", "warning");
					}
					return;
				}

				ctx.ui.notify("Usage: /opencode [status|add <name> <key>|rm <n>]", "info");
			},
		});
	};
}

const extension = createOpencodeGoPoolExtension();
export default extension;
