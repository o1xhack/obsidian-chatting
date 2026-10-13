/**
 * Reading untrusted JSON (API answers) without casts. Shared by the API
 * modules.
 */

/** A JSON object; arrays and null are not. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` if it is a JSON object, else an empty one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The string found by following `path` through nested objects, if any. */
export function getNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

/**
 * A `requestUrl()` response's JSON, or undefined when the body isn't JSON:
 * the `json` getter throws then (on iOS also for empty bodies).
 */
export function readJson(response: { json: unknown }): unknown {
  try {
    return response.json;
  } catch {
    return undefined;
  }
}
