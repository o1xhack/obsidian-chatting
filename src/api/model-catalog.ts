import { sha256 } from "@noble/hashes/sha2.js";
import { requestUrl } from "obsidian";
import type { Provider } from "../types";
import type { ChatGPTOAuthService } from "../auth/chatgptOAuth";

export interface ModelOption {
  value: string;
  label: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsReasoningSummary?: boolean;
  supportsParallelTools?: boolean;
}
export interface CatalogEntry {
  identity: string;
  provider: Provider;
  fetchedAt: number;
  models: ModelOption[];
}
export interface CatalogState {
  entries: CatalogEntry[];
  clientVersion?: { value: string; checkedAt: number };
}
export const CATALOG_TTL = 24 * 60 * 60 * 1000;
const RETRY_DELAY = 5 * 60 * 1000;
const FALLBACK_CLIENT_VERSION = "0.160.0";
let clientVersion = FALLBACK_CLIENT_VERSION;
const activeModels = new Map<Provider, ModelOption[]>();
const pending = new Map<string, Promise<ModelOption[]>>();
const failedAt = new Map<string, number>();
let versionRequest: Promise<string> | undefined;
let versionAttempt = 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Validate untrusted persisted data; never persist credentials. */
export function normalizeCatalogState(value: unknown): CatalogState {
  const state: CatalogState = { entries: [] };
  if (!record(value)) return state;
  if (Array.isArray(value.entries)) {
    for (const entry of value.entries.slice(-3)) {
      if (!record(entry) || !["anthropic", "openai", "chatgpt-oauth"].includes(String(entry.provider)) ||
          typeof entry.identity !== "string" || !/^[a-f0-9]{64}$/.test(entry.identity) ||
          typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt) || !Array.isArray(entry.models)) continue;
      const models = entry.models.filter(record).filter(m => typeof m.value === "string" && typeof m.label === "string")
        .map(m => ({ value: m.value as string, label: m.label as string,
          reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.filter((e): e is string => typeof e === "string") : undefined,
          defaultReasoningEffort: typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : undefined,
          supportsReasoningSummary: typeof m.supportsReasoningSummary === "boolean" ? m.supportsReasoningSummary : undefined,
          supportsParallelTools: typeof m.supportsParallelTools === "boolean" ? m.supportsParallelTools : undefined }));
      state.entries.push({ identity: entry.identity, provider: entry.provider as Provider, fetchedAt: entry.fetchedAt, models });
    }
  }
  if (record(value.clientVersion) && typeof value.clientVersion.value === "string" &&
      /^\d+\.\d+\.\d+$/.test(value.clientVersion.value) && typeof value.clientVersion.checkedAt === "number") {
    state.clientVersion = { value: value.clientVersion.value, checkedAt: value.clientVersion.checkedAt };
    clientVersion = state.clientVersion.value;
  }
  return state;
}
export function getCatalogModels(provider: Provider): ModelOption[] | undefined { return activeModels.get(provider); }
export function clearCatalogModels(provider: Provider): void { activeModels.delete(provider); }
export function getCodexClientVersion(): string { return clientVersion; }
export function migrateOAuthModel(slug: string): string {
  return slug ? slug.replace(/^gpt-(\d+)-(\d{1,2})(?=-|$)/, "gpt-$1.$2") : "gpt-5.5";
}
export function supportsReasoning(model: string): boolean {
  const major = model.match(/^gpt-(\d+)/)?.[1];
  return /^o\d/.test(model) || (!!major && Number(major) >= 5) || /codex/i.test(model);
}
export function oauthParallelTools(model: string): boolean {
  return activeModels.get("chatgpt-oauth")?.find(m => m.value === model)?.supportsParallelTools !== false;
}
export function oauthReasoning(model: string): Record<string, string> | undefined {
  const option = activeModels.get("chatgpt-oauth")?.find(m => m.value === model);
  if (option?.reasoningEfforts) {
    const efforts = option.reasoningEfforts;
    if (!efforts.length) return undefined;
    const effort = option.defaultReasoningEffort && efforts.includes(option.defaultReasoningEffort)
      ? option.defaultReasoningEffort : efforts.includes("medium") ? "medium" : efforts[0];
    return option.supportsReasoningSummary === false ? { effort } : { effort, summary: "auto" };
  }
  return supportsReasoning(model) ? { effort: "medium", summary: "auto" } : undefined;
}
export async function catalogIdentity(provider: Provider, secretIdentity: string): Promise<string> {
  // Pure JS hashing also works in mobile WebViews without SubtleCrypto.
  const digest = sha256(new TextEncoder().encode(`${provider}:${secretIdentity}`));
  return Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
}
export function cachedCatalog(state: CatalogState, provider: Provider, identity: string): CatalogEntry | undefined {
  const entry = state.entries.find(e => e.provider === provider && e.identity === identity);
  if (entry) activeModels.set(provider, entry.models);
  else activeModels.delete(provider);
  return entry;
}
async function jsonRequest(url: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await requestUrl({ url, method: "GET", headers, throw: false });
  if (response.status < 200 || response.status >= 300) throw new Error(`Model catalog request failed (HTTP ${response.status})`);
  const json: unknown = response.json;
  if (!record(json)) throw new Error("Invalid model catalog response");
  return json;
}
async function updateClientVersion(state: CatalogState, force: boolean): Promise<string> {
  if (state.clientVersion) clientVersion = state.clientVersion.value;
  if (!force && state.clientVersion && Date.now() - state.clientVersion.checkedAt < CATALOG_TTL) return clientVersion;
  if (versionRequest) return versionRequest;
  if (!force && Date.now() - versionAttempt < RETRY_DELAY) return clientVersion;
  versionAttempt = Date.now();
  versionRequest = (async () => {
    try {
      const release = await jsonRequest("https://api.github.com/repos/openai/codex/releases/latest", { Accept: "application/vnd.github+json" });
      const version = typeof release.tag_name === "string" ? release.tag_name.match(/^rust-v(\d+\.\d+\.\d+)$/)?.[1] : undefined;
      if (!version || release.prerelease === true || release.draft === true) throw new Error("Invalid stable Codex release");
      clientVersion = version;
      state.clientVersion = { value: version, checkedAt: Date.now() };
    } catch { /* Keep last official stable version when GitHub is unavailable. */ }
    return clientVersion;
  })().finally(() => { versionRequest = undefined; });
  return versionRequest;
}

/** Dedupe requests; failures retain the last good entry and use a short retry backoff. */
export async function refreshCatalog(state: CatalogState, provider: Provider, identity: string,
  apiKey: string, oauth: ChatGPTOAuthService, force = false): Promise<ModelOption[]> {
  const entry = cachedCatalog(state, provider, identity);
  if (!force && entry && Date.now() - entry.fetchedAt >= 0 && Date.now() - entry.fetchedAt < CATALOG_TTL) return entry.models;
  if (pending.has(identity)) return pending.get(identity)!;
  if (!force && Date.now() - (failedAt.get(identity) ?? 0) < RETRY_DELAY) return entry?.models ?? [];
  const promise = (async () => {
    let models: ModelOption[];
    if (provider === "chatgpt-oauth") {
      const credential = await oauth.getUsableCredential();
      if (!credential) throw new Error("Connect ChatGPT first");
      if (await catalogIdentity(provider, credential.accountId || credential.accessToken) !== identity) {
        throw new Error("ChatGPT account changed while loading models; retry for the current account");
      }
      const version = await updateClientVersion(state, force);
      const headers: Record<string, string> = { Authorization: `Bearer ${credential.accessToken}`, originator: "opencode", "User-Agent": `chatting-with-ai/${version}`, version };
      if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
      const json = await jsonRequest(`https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`, headers);
      if (!Array.isArray(json.models)) throw new Error("Invalid Codex model catalog");
      models = json.models.filter(record).filter(m => m.visibility === "list" && typeof m.slug === "string")
        .map(m => ({ value: m.slug as string, label: typeof m.display_name === "string" ? m.display_name : m.slug as string,
          reasoningEfforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.filter(record).map(e => e.effort).filter((e): e is string => typeof e === "string") : undefined,
          defaultReasoningEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : undefined,
          supportsReasoningSummary: typeof m.supports_reasoning_summaries === "boolean" ? m.supports_reasoning_summaries : undefined,
          supportsParallelTools: typeof m.supports_parallel_tool_calls === "boolean" ? m.supports_parallel_tool_calls : undefined }));
    } else {
      const records: Record<string, unknown>[] = [];
      let cursor = "";
      const seen = new Set<string>();
      do {
        const url = provider === "anthropic" ? `https://api.anthropic.com/v1/models?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ""}` : "https://api.openai.com/v1/models";
        const headers: Record<string, string> = provider === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { Authorization: `Bearer ${apiKey}` };
        const json = await jsonRequest(url, headers);
        if (!Array.isArray(json.data)) throw new Error("Invalid model catalog");
        records.push(...json.data.filter(record));
        if (provider === "anthropic" && json.has_more === true && (typeof json.last_id !== "string" || !json.last_id)) throw new Error("Missing model catalog pagination cursor");
        cursor = provider === "anthropic" && json.has_more === true && typeof json.last_id === "string" ? json.last_id : "";
        if (cursor && seen.has(cursor)) throw new Error("Model catalog pagination did not advance");
        seen.add(cursor);
        if (seen.size > 100) throw new Error("Model catalog pagination limit exceeded");
      } while (cursor);
      models = records.filter(m => typeof m.id === "string").filter(m => provider === "anthropic" ? m.type === "model" :
        /^(gpt-|o\d|chatgpt-|codex-)/.test(String(m.id)) && !/realtime|audio|transcri|search|image|embedding/.test(String(m.id)))
        .map(m => ({ value: m.id as string, label: typeof m.display_name === "string" ? m.display_name : m.id as string }));
    }
    models = [...new Map(models.map(m => [m.value, m])).values()];
    if (!models.length) throw new Error("No compatible models returned; keeping the previous list");
    state.entries = state.entries.filter(e => e.provider !== provider);
    state.entries.push({ provider, identity, fetchedAt: Date.now(), models });
    activeModels.set(provider, models);
    failedAt.delete(identity);
    return models;
  })().catch(error => { failedAt.set(identity, Date.now()); throw error; }).finally(() => pending.delete(identity));
  pending.set(identity, promise);
  return promise;
}
