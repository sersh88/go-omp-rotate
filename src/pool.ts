// Host credential-pool helpers plus the outgoing-payload compatibility projection.
// The plugin never selects keys: OMP owns selection, retries and quota handling.

import { type Config } from "./config-store.ts";
import { PROVIDER } from "./constants.ts";
import { isRecord } from "./guards.ts";
import type { CredentialPool, CredentialValue, RuntimeKeyStore, StoredCredentialRow } from "./host.ts";

// Key equality detects credential changes, but persisted history has no issuer
// provenance (including after reload). Never replay signed reasoning on this
// route, even before this process observes its first request.
const droppedReasoningDetail = Symbol("dropped-caller-bound-reasoning");

// Strip signatures and encrypted entries while preserving element identity and position.
function projectReasoningDetails(details: unknown[]): unknown[] {
	// map/filter, never flatMap: entries that are not plain reasoning detail
	// objects (nested arrays, numbers, booleans, ...) must pass through as the
	// same element in the same position, with their original shape intact.
	return details
		.map((detail) => {
			if (!isRecord(detail)) return detail;
			if (detail.type === "reasoning.encrypted") return droppedReasoningDetail;
			const { signature: _signature, ...unsigned } = detail;
			return unsigned;
		})
		.filter((detail) => detail !== droppedReasoningDetail);
}

/**
 * Anthropic serializes signed thinking as `thinking` blocks and opaque redacted
 * reasoning as `redacted_thinking`. Emit the SDK's own unsigned shape instead: a
 * plain text block. Drop entries emptied by that projection, and report an
 * assistant message for omission only when the projection emptied it.
 */
function projectAssistantContent(content: unknown[]): unknown[] | undefined {
	let projected = false;
	const result: unknown[] = [];
	for (const block of content) {
		if (!isRecord(block)) {
			result.push(block);
			continue;
		}
		if (block.type === "thinking") {
			projected = true;
			const thinking = typeof block.thinking === "string" ? block.thinking : "";
			if (block.redacted !== true && thinking.trim().length > 0) result.push({ type: "text", text: thinking });
			continue;
		}
		if (block.type === "redacted_thinking") {
			projected = true;
			continue;
		}
		result.push(block);
	}
	if (!projected) return content;
	return result.length === 0 ? undefined : result;
}

/** Project an outgoing payload so no signed or caller-bound reasoning is replayed on this route. */
export function sanitizeReasoningPayload(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const request: Record<string, unknown> = { ...payload };
	if (Array.isArray(request.messages)) {
		const messages: unknown[] = [];
		for (const message of request.messages) {
			if (!isRecord(message) || message.role !== "assistant") {
				messages.push(message);
				continue;
			}
			let projected = message;
			if (Array.isArray(message.content)) {
				const content = projectAssistantContent(message.content);
				if (content === undefined) continue;
				if (content !== message.content) projected = { ...projected, content };
			}
			if (Array.isArray(message.reasoning_details)) {
				const { reasoning_details: _details, ...visible } = projected;
				const reasoning_details = projectReasoningDetails(message.reasoning_details);
				// Strip the key entirely when nothing remains to send: an empty array is an
				// unvalidated request shape, and this sanitiser exists to emit only shapes the
				// provider accepts. Non-detail entries above keep identity/position/shape.
				projected = reasoning_details.length === 0 ? visible : { ...visible, reasoning_details };
			}
			messages.push(projected);
		}
		request.messages = messages;
	}
	if (Array.isArray(request.input)) {
		request.input = request.input.filter((item: unknown) =>
			!isRecord(item) || item.type !== "reasoning");
	}
	return request;
}

/** Host bulk credential pool, when the registry exposes OMP's credentials API. */
export function getCredentialPool(modelRegistry: { authStorage?: RuntimeKeyStore }): CredentialPool | undefined {
	const pool = modelRegistry.authStorage?.credentials;
	if (!pool || typeof pool.list !== "function" || typeof pool.set !== "function") return undefined;
	return pool;
}

/** Configured keys as pool credentials, in config order. */
export function desiredPoolCredentials(config: Config): CredentialValue[] {
	return config.keys.map((entry) => ({ type: "api_key", key: entry.key, source: "login" }));
}

// Canonical JSON with object keys sorted, so structural equality ignores key order.
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, item]) => item !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

/**
 * True when the stored pool already holds exactly the desired credential values. Row order is
 * not significant: the host lists rows by id rather than by `set` order, so an order-sensitive
 * check would re-`set` (and reset host affinity) on every process start.
 */
export function credentialPoolMatches(rows: readonly StoredCredentialRow[], desired: readonly CredentialValue[]): boolean {
	if (rows.length !== desired.length) return false;
	const current = rows.map((row) => canonicalJson(row.credential)).sort();
	const wanted = desired.map((credential) => canonicalJson(credential)).sort();
	return current.every((value, index) => value === wanted[index]);
}

/**
 * Drop the plugin's own stale runtime override for the managed provider. A pinned key would
 * shadow the pool in this process. Returns false when the removal threw; when the host has
 * no removal API there is nothing to clear and the result is true.
 */
export function removeRuntimeOverride(modelRegistry: { authStorage?: RuntimeKeyStore }): boolean {
	const keys = modelRegistry.authStorage?.keys;
	if (!keys || typeof keys.removeRuntime !== "function") return true;
	try {
		keys.removeRuntime(PROVIDER);
		return true;
	} catch {
		return false;
	}
}
