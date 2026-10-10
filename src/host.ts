// Host interfaces this extension is written against. Kept dependency-free so the plugin
// compiles against the documented OMP surface without importing host packages.

/** One argument-completion entry offered by the host. */
export interface ArgumentCompletion {
	value: string;
	label: string;
	description?: string;
	hint?: string;
}

/** UI notification surface. */
export interface NotifyUi {
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

/** One API-key credential stored in the host provider credential pool. */
export interface ApiKeyCredentialValue {
	type: "api_key";
	key: string;
	/** Plugin-synced keys carry `login` so the host ranks them above env-backed keys. */
	source?: "login";
}

/** One OAuth credential value; the pool carries it opaquely. */
export interface OAuthCredentialValue {
	type: "oauth";
	[key: string]: unknown;
}

/** Stored provider credential value: exactly what the host pool lists and accepts. */
export type CredentialValue = ApiKeyCredentialValue | OAuthCredentialValue;

/** One stored credential row as returned by the host credential pool. */
export interface StoredCredentialRow {
	id: number;
	provider: string;
	credential: CredentialValue;
}

/**
 * Bulk provider credential pool (OMP `authStorage.credentials`). `set` replaces every stored
 * row for the provider and resets host credential affinity; `list` rows come back in host id
 * order, not in the order `set` was called with.
 */
export interface CredentialPool {
	list(provider?: string): StoredCredentialRow[];
	set(provider: string, credentials: CredentialValue | CredentialValue[]): void | Promise<void>;
}

/** Host credential store: runtime-override removal plus the bulk credential pool. */
export interface RuntimeKeyStore {
	keys?: {
		removeRuntime(provider: string): void;
	};
	/** Bulk provider credential pool; absent on hosts too old to support it. */
	credentials?: CredentialPool;
}

/** Minimal host model registry: stored auth only. */
export interface ModelRegistryLike {
	authStorage?: RuntimeKeyStore;
}

/** Host events this extension subscribes to. */
export interface ExtensionEvents {
	session_start: { reason?: string };
	before_provider_request: { payload: unknown };
}

/** Per-event host context: UI, model registry and the active model. */
export interface ExtensionContext {
	ui: NotifyUi;
	modelRegistry: ModelRegistryLike;
	model?: { provider?: string };
}

/** Host extension API: event subscription and command registration. */
export interface RegisterCommandOptions {
	description?: string;
	getArgumentCompletions?: (argumentPrefix: string) => ArgumentCompletion[] | null;
	handler: (args: string, ctx: ExtensionContext) => unknown;
}

/** Host extension API: event subscription and command registration. */
export interface ExtensionAPI {
	on<E extends keyof ExtensionEvents>(event: E, handler: (event: ExtensionEvents[E], ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, options: RegisterCommandOptions): void;
}
