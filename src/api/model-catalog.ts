import { sha256 } from "@noble/hashes/sha2.js";
import { requestUrl } from "obsidian";
import type { Provider } from "../types";
import { DEFAULT_PROVIDER_MODELS } from "../types";
import type { ChatGPTOAuthService } from "../auth/chatgptOAuth";

export interface ModelOption {
  value: string;
  label: string;
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  supportsReasoningSummary?: boolean;
  supportsParallelTools?: boolean;
  /** Anthropic thinking mode the model supports (`capabilities.thinking.types`). */
  thinkingType?: "adaptive" | "enabled";
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
        .map((m): ModelOption => ({ value: m.value as string, label: m.label as string,
          reasoningEfforts: Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts.filter((e): e is string => typeof e === "string") : undefined,
          defaultReasoningEffort: typeof m.defaultReasoningEffort === "string" ? m.defaultReasoningEffort : undefined,
          supportsReasoningSummary: typeof m.supportsReasoningSummary === "boolean" ? m.supportsReasoningSummary : undefined,
          supportsParallelTools: typeof m.supportsParallelTools === "boolean" ? m.supportsParallelTools : undefined,
          thinkingType: m.thinkingType === "adaptive" || m.thinkingType === "enabled" ? m.thinkingType : undefined }));
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
  return slug ? slug.replace(/^gpt-(\d+)-(\d{1,2})(?=-|$)/, "gpt-$1.$2") : DEFAULT_PROVIDER_MODELS["chatgpt-oauth"];
}
export function supportsReasoning(model: string): boolean {
  const major = model.match(/^gpt-(\d+)/)?.[1];
  return /^o\d/.test(model) || (!!major && Number(major) >= 5) || /codex/i.test(model);
}
/** The active catalog's entry for a model, if the provider's list has it. */
export function catalogModel(provider: Provider, model: string): ModelOption | undefined {
  return activeModels.get(provider)?.find(m => m.value === model);
}
export function oauthParallelTools(model: string): boolean {
  return catalogModel("chatgpt-oauth", model)?.supportsParallelTools !== false;
}
/** The thinking level picked in settings if the model offers it; otherwise undefined (the default). */
export function resolveThinkingLevel(option: ModelOption | undefined, level: string): string | undefined {
  return level && option?.reasoningEfforts?.includes(level) ? level : undefined;
}
/** The model's default level, if the catalog names one it offers. */
export function catalogDefaultLevel(option: ModelOption | undefined): string | undefined {
  const level = option?.defaultReasoningEffort;
  return level && option.reasoningEfforts?.includes(level) ? level : undefined;
}
/** Header text for the thinking level, or undefined when the model offers no levels. */
export function thinkingLevelLabel(option: ModelOption | undefined, level: string): string | undefined {
  if (!option?.reasoningEfforts?.length) return undefined;
  const fallback = catalogDefaultLevel(option);
  return resolveThinkingLevel(option, level) ?? (fallback ? `${fallback} (default)` : "default");
}
/**
 * Codex reasoning: the level picked in settings if the catalog lists it for
 * the model, else the catalog's default. Models without catalog data keep
 * the rule by model name.
 */
export function oauthReasoning(model: string, level: string): Record<string, string> | undefined {
  const option = catalogModel("chatgpt-oauth", model);
  if (option?.reasoningEfforts) {
    const efforts = option.reasoningEfforts;
    if (!efforts.length) return undefined;
    const effort = resolveThinkingLevel(option, level) ?? catalogDefaultLevel(option) ??
      (efforts.includes("medium") ? "medium" : efforts[0]);
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

/** Read `capabilities.thinking.types` and `capabilities.effort` of Anthropic `/v1/models`. */
function anthropicCapabilities(capabilities: unknown): Pick<ModelOption, "thinkingType" | "reasoningEfforts"> {
  if (!record(capabilities)) return {};
  const types = record(capabilities.thinking) && record(capabilities.thinking.types) ? capabilities.thinking.types : {};
  const supported = (value: unknown) => record(value) && value.supported === true;
  const thinkingType = supported(types.adaptive) ? "adaptive" : supported(types.enabled) ? "enabled" : undefined;
  const effort = capabilities.effort;
  // Levels in the API's key order (lightest first); "supported" is the flag for effort as a whole.
  const reasoningEfforts = record(effort) && effort.supported === true
    ? Object.entries(effort).filter(([key, value]) => key !== "supported" && supported(value)).map(([key]) => key) : undefined;
  return { thinkingType, reasoningEfforts };
}

/** OpenAI families that answer chats, and those that don't (speech, images, search, completions-only, voice). */
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-|codex-)/;
const OPENAI_NOT_CHAT = /realtime|audio|transcri|tts|search|image|embedding|instruct|gpt-live/;
/** A dated snapshot of a model: `gpt-4o-2024-08-06`, `gpt-4-0613`. */
const OPENAI_SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;

/**
 * OpenAI's `/v1/models` gives only IDs and creation dates, in no order:
 * chat models, newest first (`created`), without a dated snapshot when its
 * model is listed too (`gpt-5.4-2026-03-05` beside `gpt-5.4`).
 */
function openaiChatModels(records: Record<string, unknown>[]): ModelOption[] {
  const chat = records.filter(m => typeof m.id === "string" && OPENAI_CHAT.test(m.id) && !OPENAI_NOT_CHAT.test(m.id));
  const ids = new Set(chat.map(m => m.id as string));
  const created = (m: Record<string, unknown>) => typeof m.created === "number" ? m.created : 0;
  return chat
    .filter(m => { const alias = (m.id as string).replace(OPENAI_SNAPSHOT, ""); return alias === m.id || !ids.has(alias); })
    .sort((a, b) => created(b) - created(a) || (a.id as string).localeCompare(b.id as string))
    .map(m => ({ value: m.id as string, label: m.id as string }));
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
      if (provider === "openai") {
        models = openaiChatModels(records);
      } else {
        models = records.filter(m => typeof m.id === "string" && m.type === "model")
          .map(m => ({ value: m.id as string, label: typeof m.display_name === "string" ? m.display_name : m.id as string,
            ...anthropicCapabilities(m.capabilities) }));
      }
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
