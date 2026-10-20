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
  /** Anthropic thinking mode; disabled is explicit negative metadata, undefined is unknown. */
  thinkingType?: "adaptive" | "enabled" | "disabled";
  /**
   * Tokens a request may hold (the context window for the input): Anthropic
   * `max_input_tokens`, ChatGPT `context_window` (times its effective
   * percent), OpenAI from the model's documentation page.
   */
  contextWindow?: number;
  /** Most tokens of one answer. */
  maxOutputTokens?: number;
  /** ChatGPT: where Codex compacts (`auto_compact_token_limit`). */
  autoCompactTokens?: number;
  /** Anthropic: threshold compaction (`capabilities.context_management.compact_20260112`). */
  compaction?: boolean;
  /** Prices from the provider's documentation (none: unknown, or no per-token cost). */
  pricing?: ModelPricing;
  /** OpenAI: when the documentation page was last read (ms). */
  detailsCheckedAt?: number;
}

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  /** Input read from the prompt cache. */
  cachedInput?: number;
  /** Input written to the prompt cache (Anthropic: 5-minute writes). */
  cacheWrite?: number;
  output: number;
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

/** A positive finite number, else undefined. */
function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function savedPricing(value: unknown): ModelPricing | undefined {
  if (!record(value)) return undefined;
  const input = positive(value.input);
  const output = positive(value.output);
  if (input === undefined || output === undefined) return undefined;
  const cachedInput = positive(value.cachedInput);
  const cacheWrite = positive(value.cacheWrite);
  return { input, output, ...(cachedInput !== undefined ? { cachedInput } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
}

/** Only the fields that are set, so a model without them looks as before. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

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
          thinkingType: m.thinkingType === "adaptive" || m.thinkingType === "enabled" || m.thinkingType === "disabled" ? m.thinkingType : undefined,
          ...defined({
            contextWindow: positive(m.contextWindow),
            maxOutputTokens: positive(m.maxOutputTokens),
            autoCompactTokens: positive(m.autoCompactTokens),
            compaction: typeof m.compaction === "boolean" ? m.compaction : undefined,
            pricing: savedPricing(m.pricing),
            detailsCheckedAt: positive(m.detailsCheckedAt),
          }) }));
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
/** Read the cached/fallback version immediately; refresh metadata without delaying voice. */
export function codexClientVersion(state: CatalogState | undefined): string {
  if (state) void updateClientVersion(state, false).catch(() => undefined);
  return clientVersion;
}
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

/** Read `capabilities.thinking.types`, `capabilities.effort` and threshold compaction of Anthropic `/v1/models`. */
function anthropicCapabilities(capabilities: unknown): Pick<ModelOption, "thinkingType" | "reasoningEfforts" | "compaction"> {
  if (!record(capabilities)) return {};
  const management = capabilities.context_management;
  const compaction = record(management) ? record(management.compact_20260112) && management.compact_20260112.supported === true : undefined;
  const types = record(capabilities.thinking) && record(capabilities.thinking.types) ? capabilities.thinking.types : {};
  const supported = (value: unknown) => record(value) && value.supported === true;
  const thinkingType = supported(types.adaptive) ? "adaptive" : supported(types.enabled) ? "enabled" :
    record(capabilities.thinking) && capabilities.thinking.supported === false ? "disabled" : undefined;
  const effort = capabilities.effort;
  // Levels in the API's key order (lightest first); "supported" is the flag for effort as a whole.
  const reasoningEfforts = record(effort) && effort.supported === true
    ? Object.entries(effort).filter(([key, value]) => key !== "supported" && supported(value)).map(([key]) => key) : undefined;
  return { thinkingType, reasoningEfforts, ...(compaction !== undefined ? { compaction } : {}) };
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

/** As Codex: the usable window is `context_window` times `effective_context_window_percent`. */
function chatgptWindow(window: unknown, percent: unknown): number | undefined {
  const tokens = positive(window);
  const share = positive(percent);
  return tokens && share ? Math.floor(tokens * Math.min(share, 100) / 100) : tokens;
}

// ─── Limits and prices from the providers' documentation ───────────────────
// OpenAI's `/v1/models` has neither, Anthropic's has no prices. Their
// documentation pages are Markdown (`.md`) and give both; read once a day.

const ANTHROPIC_PRICES = "https://platform.claude.com/docs/en/about-claude/pricing.md";
const OPENAI_MODEL_DOCS = "https://developers.openai.com/api/docs/models/";

/** A token count written "1,050,000". */
function count(text: string | undefined): number | undefined {
  return text ? positive(Number(text.replace(/,/g, ""))) : undefined;
}

/** "$2.5", "$0.25 / MTok" → 2.5, 0.25. */
function dollars(cell: string | undefined): number | undefined {
  const match = cell ? /\$\s*([\d.]+)/.exec(cell) : null;
  return match ? positive(Number(match[1])) : undefined;
}

/**
 * Anthropic's model prices by display name, from the pricing page's model
 * table: base input, 5-minute cache writes, cache hits, output.
 */
export async function anthropicPrices(): Promise<Map<string, ModelPricing>> {
  const response = await requestUrl({ url: ANTHROPIC_PRICES, method: "GET", throw: false });
  const prices = new Map<string, ModelPricing>();
  if (response.status !== 200 || typeof response.text !== "string") return prices;
  const lines = response.text.split("\n");
  const header = lines.findIndex((line) => /^\|\s*Model\s*\|.*Base input tokens/i.test(line));
  if (header === -1) return prices;
  const columns = lines[header].split("|").map((cell) => cell.trim().toLowerCase());
  const at = (name: RegExp) => columns.findIndex((cell) => name.test(cell));
  const [inputAt, writeAt, hitAt, outputAt] = [at(/^base input/), at(/^5m cache writes/), at(/^cache hits/), at(/^output/)];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    // "Claude Opus 4.1 ([retired, …](…))" → "Claude Opus 4.1"
    const name = cells[1]?.replace(/\s*\(.*$/, "").trim();
    const input = dollars(cells[inputAt]);
    const output = dollars(cells[outputAt]);
    if (!name || input === undefined || output === undefined) continue;
    const cachedInput = dollars(cells[hitAt]);
    const cacheWrite = dollars(cells[writeAt]);
    prices.set(name, { input, output, ...(cachedInput !== undefined ? { cachedInput } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) });
  }
  return prices;
}

/** What an OpenAI model's documentation page says about its limits and prices. */
export function parseOpenAIModelDocs(text: string): Pick<ModelOption, "contextWindow" | "maxOutputTokens" | "pricing"> {
  const window = count(/^- ([\d,]+) context window/m.exec(text)?.[1]);
  const maxInput = count(/^- Maximum input tokens: ([\d,]+)/m.exec(text)?.[1]);
  const maxOutputTokens = count(/^- ([\d,]+) max output tokens/m.exec(text)?.[1]);
  // The input may fill the window less the answer.
  const contextWindow = maxInput ?? (window && maxOutputTokens && window > maxOutputTokens ? window - maxOutputTokens : window);
  // The "Text tokens" table: | Input | $2.5 | 1M tokens |
  const pricingAt = text.indexOf("## Pricing");
  const row = (name: string) => dollars(new RegExp(`^\\|\\s*${name}\\s*\\|([^|]*)\\|`, "mi").exec(text.slice(pricingAt))?.[1]);
  const input = pricingAt >= 0 ? row("Input") : undefined;
  const output = pricingAt >= 0 ? row("Output") : undefined;
  const cachedInput = input !== undefined ? row("Cached input") : undefined;
  const cacheWrite = input !== undefined ? row("Cache writes") : undefined;
  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(input !== undefined && output !== undefined
      ? { pricing: { input, output, ...(cachedInput !== undefined ? { cachedInput } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) } }
      : {}),
  };
}

/**
 * OpenAI (API key): the selected model's limits and prices, read from its
 * documentation page into its catalog entry, at most once a day (also when
 * the page can't be read). A dated snapshot reads its model's page. True
 * when the entry changed.
 */
export async function loadModelDetails(state: CatalogState | undefined, provider: Provider, apiKey: string, model: string): Promise<boolean> {
  if (provider !== "openai" || !apiKey || !state) return false;
  const entry = cachedCatalog(state, provider, await catalogIdentity(provider, apiKey));
  const option = entry?.models.find((item) => item.value === model);
  if (!option || (option.detailsCheckedAt && Date.now() - option.detailsCheckedAt < CATALOG_TTL)) return false;
  option.detailsCheckedAt = Date.now();
  const page = model.replace(OPENAI_SNAPSHOT, "");
  try {
    const response = await requestUrl({ url: `${OPENAI_MODEL_DOCS}${encodeURIComponent(page)}.md`, method: "GET", throw: false });
    if (response.status === 200 && typeof response.text === "string") Object.assign(option, parseOpenAIModelDocs(response.text));
  } catch {
    // Unknown limits: no ring, no compaction point.
  }
  return true;
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
          supportsParallelTools: typeof m.supports_parallel_tool_calls === "boolean" ? m.supports_parallel_tool_calls : undefined,
          // Codex's model info gives its window and where Codex compacts; read when present.
          ...defined({
            contextWindow: chatgptWindow(m.context_window, m.effective_context_window_percent),
            autoCompactTokens: positive(m.auto_compact_token_limit),
          }) }));
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
        // Prices from Anthropic's pricing page, by the display name the list gives (none if it can't be read).
        const prices = await anthropicPrices().catch(() => new Map<string, ModelPricing>());
        models = records.filter(m => typeof m.id === "string" && m.type === "model").map(m => {
          const label = typeof m.display_name === "string" ? m.display_name : m.id as string;
          return { value: m.id as string, label, ...anthropicCapabilities(m.capabilities),
            ...defined({ contextWindow: positive(m.max_input_tokens), maxOutputTokens: positive(m.max_tokens), pricing: prices.get(label) }) };
        });
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
