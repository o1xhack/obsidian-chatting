// Shared test harness: bundles the real plugin modules with a fake Obsidian
// API and transport. Test files import what they need from here.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
// Electron exposes require; the ESM test runner supplies the same desktop loader.
globalThis.require = createRequire(import.meta.url);

// Bundle the actual production adapters/loop; only transport and the vault are fake.
export const bundled = await build({
  stdin: { contents: `
    export { ChatSettingTab, parseTokens } from './src/settings';
    export * from './src/api/model-catalog';
    export { sendMessage } from './src/api/client';
    export { AgentLoop, RESUME } from './src/agent/loop';
    export { withoutLargeToolText, withoutLargeVisibleToolText, MAX_TOOL_TEXT_CHARS, fromLastCompaction, editableTurn, cutBeforeTurn } from './src/agent/history';
    export * as compaction from './src/agent/compaction';
    export { pageStart, PAGE_TURNS } from './src/ui/chat-view';

    export { sendAnthropicMessage } from './src/api/anthropic';
    export { sendOpenAIMessage, clearOpenAIState } from './src/api/openai';
    export { sendChatGPTOAuthMessage, setChatGPTOAuthService } from './src/api/chatgpt-oauth';
    export { buildResponsesInput, fromResponsesOutput } from './src/api/responses-format';
    export { default as ChatPlugin } from './src/main';
    export { executeTool } from './src/tools/executor';
    export { TOOL_DEFINITIONS } from './src/tools/registry';
    export { ObsidianChatView } from './src/ui/chat-view';
    export { ChatGPTOAuthService } from './src/auth/chatgptOAuth';
    export { startBrowserLogin } from './src/auth/chatgptBrowserLogin';
    export { ChatGPTOAuthStore } from './src/auth/chatgptOAuthStore';
    export { ChatGPTDeviceLoginModal } from './src/settings';
    export { selectionScope } from './src/main';
    export { normalizeMathMarkdown } from './src/ui/math-markdown';
    export * as toolLabels from './src/ui/tool-label';
    export { WEB_PAGE_CHARS } from './src/tools/web-page';
    export * as debug from './src/debug';
    export { screenAwake } from './src/platform/screen-awake';
    export * as lifecycle from './src/platform/lifecycle';
    export { Platform } from 'obsidian';
    export { isSendKey } from './src/ui/send-key';
    export * as imagePreview from './src/tools/image-preview';
    export * as canvasRender from './src/tools/canvas-render';
    export { withoutOldToolImages } from './src/agent/history';
    export * as chatState from './src/chat-state';
    export * as instructions from './src/agent/instructions';
    export * as showInView from './src/ui/show-in-view';
    export * as mentions from './src/ui/mentions';
    export { TFile, TFolder } from 'obsidian';
    export { ChangeLog } from './src/tools/undo';
    export { UndoConfirmModal } from './src/ui/undo-confirm';
    export { foldPlan } from './src/ui/fold-turn';
    export * as files from './src/files/attachments';
    export * as skills from './src/agent/skills';
    export * as attachmentHistory from './src/attachment-history';
    export { AttachmentPreparation } from './src/ui/attachment-preparation';
    export { buildSystemPrompt } from './src/agent/system-prompt';
    export { streamSSE, createSSEParser, resetStreamTransport } from './src/api/stream';
    export * as usage from './src/agent/usage';
    export * as summary from './src/agent/summary';
    export { ProviderError } from './src/api/errors';
    export * as voiceProtocol from './src/voice/protocol';
    export * as voiceSession from './src/voice/session';
    export * as voiceController from './src/voice/controller';
    export * as codexVoice from './src/voice/codex';
    export { DEFAULT_SETTINGS } from './src/types';
    export { checkLiveVoice, checkMicrophone } from './src/diagnostics/capability-check';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'obsidian-test-transport', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
    // The Svelte UI isn't bundled: chat view tests give the view a fake component.
    build.onResolve({ filter: /^svelte$|\.svelte$/ }, () => ({ path: 'svelte', namespace: 'test-svelte' }));
    build.onLoad({ filter: /.*/, namespace: 'test-svelte' }, () => ({ contents: 'export const mount = () => ({}); export const unmount = () => {}; export default {};', loader: 'js' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      export class App {}
      export class Plugin {}
      export class ItemView {}
      export class Scope { constructor(parent) { this.parent = parent; this.keys = []; } register(modifiers, key, func) { this.keys.push({ modifiers, key, func }); } }
      export class Menu {}
      export const MarkdownRenderer = { render: async () => {} };
      export class Modal {}
      export class PluginSettingTab { constructor(app) { this.app = app; } containerEl = { addClass() {} }; hide() {} }
      // Rows display() makes; their name, description and heading are recorded.
      export class Setting {
        setName(name) { this.name = name; return this; }
        setDesc(desc) { this.desc = desc; return this; }
        setHeading() { this.heading = true; return this; }
      }
      // A slider, found on the element it was added to (\`slider\`).
      export class SliderComponent {
        constructor(containerEl) { containerEl.slider = this; }
        setLimits(min, max, step) { this.limits = [min, max, step]; return this; }
        setValue(value) { this.value = value; return this; }
        onChange(fn) { this.change = fn; return this; }
      }
      export const requireApiVersion = () => globalThis.__supportsNewObsidian === true;
      export const apiVersion = '1.13.1';
      export class Notice { constructor(message) { (globalThis.__notices ??= []).push(message); } }
      export class TAbstractFile {}
      export class TFile { constructor(path) { this.path = path; this.extension = 'md'; } }
      export class TFolder extends TAbstractFile { constructor(path, children = []) { super(); this.path = path; this.name = path.split('/').pop(); this.children = children; } }
      export const normalizePath = path => path;
      // As Obsidian: body tags, then the frontmatter's tags (a list or a comma/space separated text), each with '#'.
      export const getAllTags = cache => {
        const fm = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
        const listed = Array.isArray(fm) ? fm : typeof fm === 'string' ? fm.split(/[,\\s]+/) : [];
        return [...(cache.tags ?? []).map(t => t.tag), ...listed.filter(Boolean).map(t => t.startsWith('#') ? t : '#' + t)];
      };
      export const getLinkpath = link => link.split('#')[0];
      export const parseFrontMatterAliases = fm => { const a = fm?.aliases ?? fm?.alias; return a == null ? null : (Array.isArray(a) ? a : [a]).map(String); };
      export const requestUrl = request => globalThis.__providerRequest(request);
      // Obsidian's rule: a "---" line at the start up to the next "---" line.
      export function getFrontMatterInfo(content) {
        const none = { exists: false, frontmatter: '', from: 0, to: 0, contentStart: 0 };
        const open = /^---\\r?\\n/.exec(content);
        if (!open) return none;
        const close = /---(\\r?\\n|$)/g;
        close.lastIndex = open[0].length;
        let match = close.exec(content);
        while (match && content[match.index - 1] !== '\\n') match = close.exec(content);
        if (!match) return none;
        return { exists: true, frontmatter: content.slice(open[0].length, match.index), from: open[0].length, to: match.index, contentStart: close.lastIndex };
      }
      // A desktop unless a test sets globalThis.__isPhone. Streaming takes
      // the mobile path (fetch) unless a test sets globalThis.__isDesktopApp.
      // Tests of the mobile apps' stall watch set isMobileApp.
      export const Platform = { get isDesktop() { return globalThis.__isMobile !== true; }, get isPhone() { return globalThis.__isPhone === true; }, get isDesktopApp() { return globalThis.__isDesktopApp === true; }, isMobileApp: false };
      // Tags dropped, paragraphs kept: enough to see which content got through.
      export const htmlToMarkdown = node => (typeof node === 'string' ? node : node.innerHTML).replace(/<\\/p>/g, '\\n\\n').replace(/<[^>]+>/g, '').trim();
      export const arrayBufferToBase64 = buffer => Buffer.from(buffer).toString('base64');
      // Letters in order, any case; fewer gaps score higher (like Obsidian's, roughly).
      export const prepareFuzzySearch = query => text => {
        let at = -1, gaps = 0;
        for (const ch of query.toLowerCase()) {
          const next = text.toLowerCase().indexOf(ch, at + 1);
          if (next === -1) return null;
          if (at !== -1 && next !== at + 1) gaps++;
          at = next;
        }
        return { score: -gaps, matches: [] };
      };
    `, loader: 'js' }));
  } }],
});
export const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
export const settings = provider => ({ provider, model: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.5', apiKey: 'fake-test-key', maxIterations: 20, enableWebSearch: true });
// `settings(provider)` with a saved model list of these models for the test account.
export async function withCatalog(provider, models, extra = {}) {
  const identity = await api.catalogIdentity(provider, provider === 'chatgpt-oauth' ? 'fake-account' : 'fake-test-key');
  return { ...settings(provider), modelCatalog: { entries: [{ provider, identity, fetchedAt: Date.now(), models }] }, ...extra };
}
export const image = { id: 'image', fileName: 'test.png', mediaType: 'image/png', data: 'fake-base64', sizeBytes: 1 };
export const text = value => ({ type: 'text', text: value });
export const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const result = (id, content, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
export const assistant = response => ({ role: 'assistant', content: response.content, replay: response.replay });
export const responseMessage = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value, annotations: [] }] });
export const nativeCall = (id, name, input) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) });
// A provider's streamed answer for these blocks, through requestUrl() (the
// fake fetch below fails, so adapters fall back to it).
export function response(provider, blocks, stop = 'end_turn', index = 0) {
  return sse(streamEvents(provider, blocks, stop, index));
}
// The non-streamed Responses API object for these blocks.
export function responsesData(blocks, stop = 'end_turn', index = 0) {
  const output = blocks.map(block => block.type === 'text' ? responseMessage(block.text) : block.type === 'tool_use' ? nativeCall(block.id, block.name, block.input) : block);
  return { id: `resp_${index}`, output, status: stop === 'max_tokens' ? 'incomplete' : 'completed' };
}
const halves = value => [value.slice(0, Math.ceil(value.length / 2)), value.slice(Math.ceil(value.length / 2))].filter(Boolean);
// The SSE events a provider streams for these blocks (Anthropic Messages or Responses API).
export function streamEvents(provider, blocks, stop = 'end_turn', index = 0) {
  if (provider === 'anthropic') {
    const events = [{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
    blocks.forEach((block, index) => {
      const { text, thinking, signature, input, citations, ...rest } = block;
      const delta = value => events.push({ type: 'content_block_delta', index, delta: value });
      if (block.type === 'text') {
        events.push({ type: 'content_block_start', index, content_block: { ...rest, text: '' } });
        for (const citation of citations ?? []) delta({ type: 'citations_delta', citation });
        for (const part of halves(text)) delta({ type: 'text_delta', text: part });
      } else if (block.type === 'thinking') {
        events.push({ type: 'content_block_start', index, content_block: { ...rest, thinking: '', signature: '' } });
        for (const part of halves(thinking)) delta({ type: 'thinking_delta', thinking: part });
        delta({ type: 'signature_delta', signature });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        events.push({ type: 'content_block_start', index, content_block: { ...rest, input: {} } });
        for (const part of halves(JSON.stringify(input))) delta({ type: 'input_json_delta', partial_json: part });
      } else {
        events.push({ type: 'content_block_start', index, content_block: block });
      }
      events.push({ type: 'content_block_stop', index });
    });
    events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
    return events;
  }
  const data = responsesData(blocks, stop, index);
  const events = [{ type: 'response.created', response: { id: data.id, status: 'in_progress', output: [] } }];
  data.output.forEach((item, output_index) => {
    for (const part of item.type === 'message' ? item.content : []) {
      if (part.type === 'output_text') for (const delta of halves(part.text)) events.push({ type: 'response.output_text.delta', output_index, delta });
    }
    events.push({ type: 'response.output_item.done', item, output_index });
  });
  // The ChatGPT route (store: false) sends the final response without output.
  events.push({ type: stop === 'max_tokens' ? 'response.incomplete' : 'response.completed', response: provider === 'openai' ? data : { ...data, output: [] } });
  return events;
}
export const sseText = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
export function sse(events) {
  return { status: 200, text: sseText(events), get json() { throw new SyntaxError('iOS lazy JSON getter'); } };
}
// Obsidian's window. stream.ts calls window.fetch, which fails like a CORS
// block unless a test sets __fetch. Local addresses keep Node's fetch: the
// browser sign-in tests call their own callback server.
globalThis.window ??= globalThis;
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (globalThis.__fetch) return globalThis.__fetch(url, init);
  if (/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(url))) return nodeFetch(url, init);
  // MCP tests use a reachable streaming transport: a pre-response failure
  // is deliberately unsafe to fall back/repeat when remote tools are enabled.
  const body = init?.body ? JSON.parse(init.body) : {};
  if (body.mcp_servers?.length || body.tools?.some(tool => tool.type === 'mcp')) {
    const result = await globalThis.__providerRequest({ url, ...init });
    return new Response(result.text ?? JSON.stringify(result.json), { status: result.status, headers: result.headers });
  }
  throw new TypeError('Failed to fetch');
};
export function transport(handler) {
  const requests = [];
  globalThis.__providerRequest = async request => {
    const body = JSON.parse(request.body);
    requests.push(body);
    const result = await handler(body, requests.length - 1, request);
    // Legacy fixtures describe a complete Responses packet. Put that packet
    // on the wire as SSE now that requests ask for streams.
    if (body.stream && result.status === 200 && result.text === undefined && result.json?.output) {
      return sse([{ type: `response.${result.json.status ?? 'completed'}`, response: result.json }]);
    }
    return result;
  };
  return requests;
}
/** The plugin folder of the test vault. */
export const PLUGIN_DIR = '.obsidian/plugins/chatting-with-ai';

/**
 * An in-memory adapter for the saved chats: files by path (`stored`). `saved`
 * is what `chat-state.json` holds at the start: an older whole state, or a
 * whole version 4 state from `writes` (split into the index and a file per
 * conversation). Each write of `chat-state.json` adds the whole saved state
 * to `writes`: the index with each conversation's chat file merged in.
 */
export function chatFiles(saved) {
  const stored = new Map();
  const dir = PLUGIN_DIR;
  if (saved?.version >= 4) {
    for (const { size: _size, ...conversation } of saved.conversations) {
      stored.set(`${dir}/chats/${conversation.id}.json`, JSON.stringify({ version: saved.version, savedAt: saved.savedAt ?? 0, conversation }));
    }
    const conversations = saved.conversations.map(({ id, title, automaticTitle, titleSourceTurnId, customTitle, createdAt, updatedAt, size }) => ({ id, title, ...(automaticTitle !== undefined ? { automaticTitle } : {}), ...(titleSourceTurnId !== undefined ? { titleSourceTurnId } : {}), customTitle, createdAt, updatedAt, ...(size !== undefined ? { size } : {}) }));
    stored.set(`${dir}/chat-state.json`, JSON.stringify({ ...saved, conversations }));
  } else if (saved) {
    stored.set(`${dir}/chat-state.json`, JSON.stringify(saved));
  }
  const writes = [];
  const chatFile = (id) => { const text = stored.get(`${dir}/chats/${id}.json`); return text ? JSON.parse(text) : undefined; };
  const whole = (index) => ({
    ...index,
    conversations: index.conversations.map((entry) => ({ ...entry, ...chatFile(entry.id)?.conversation })),
  });
  const adapter = {
    stored,
    append: async () => {},
    read: async (path) => { if (!stored.has(path)) throw new Error('ENOENT'); return stored.get(path); },
    exists: async (path) => stored.has(path) || [...stored.keys()].some((file) => file.startsWith(`${path}/`)),
    mkdir: async () => {},
    list: async (path) => ({ files: [...stored.keys()].filter((file) => file.startsWith(`${path}/`)), folders: [] }),
    remove: async (path) => { stored.delete(path); },
    rename: async (from, to) => {
      if (stored.has(to)) throw new Error('Destination file already exists!');
      stored.set(to, stored.get(from));
      stored.delete(from);
    },
    write: async (path, data) => {
      stored.set(path, data);
      if (path === `${dir}/chat-state.json`) writes.push(whole(JSON.parse(data)));
    },
  };
  return { adapter, writes, whole: () => whole(JSON.parse(stored.get(`${dir}/chat-state.json`))) };
}

export function vaultApp() {
  const files = new Map([['Cases/Case Template.md', '# Template\n日本語本文'], ['Untitled.md', 'Original']]);
  const app = {
    workspace: { getActiveFile: () => ({ path: 'Untitled.md' }), getLeavesOfType: () => [] },
    vault: {
      configDir: '.obsidian', adapter: { append: async () => {} },
      getName: () => 'Test vault',
      getMarkdownFiles: () => [...files.keys()].map(path => ({ path })),
      getFileByPath: path => files.has(path) ? { path, extension: path.slice(path.lastIndexOf('.') + 1) } : null,
      getFolderByPath: () => ({}),
      cachedRead: async file => files.get(file.path),
      create: async (path, content) => { assert.ok(!files.has(path)); files.set(path, content); return { path }; },
      process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
      modify: async (file, content) => { files.set(file.path, content); },
    },
  };
  return { app, files };
}
export function callbacks(extra = {}) {
  const errors = [], texts = [], executed = [];
  return { errors, texts, executed, onThinking() {}, onToolCall(name) { executed.push(name); }, onToolResult() {}, onResponse(value) { texts.push(value); }, onAskUser: async () => 'yes', onError(error) { errors.push(error); }, ...extra };
}

/** An app for the settings tab: a vault without files (no skills, no AGENTS.md). */
export const settingsApp = { vault: { getFolderByPath: () => null, getFileByPath: () => null } };
