// Single canonical object guard for this package.
// Do not redefine it at call sites; import from here.
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
