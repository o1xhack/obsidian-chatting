// Shared test harness: bundles the real plugin modules with a fake Obsidian
// API and transport. Test files import what they need from here.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Bundle the actual production adapters/loop; only transport and the vault are fake.
export const bundled = await build({
  stdin: { contents: `
    export { ChatSettingTab } from './src/settings';
    export * from './src/api/model-catalog';
    export { sendMessage } from './src/api/client';
    export { AgentLoop } from './src/agent/loop';
    export { trimHistory } from './src/agent/history';
    export { sendAnthropicMessage } from './src/api/anthropic';
    export { sendOpenAIMessage, clearOpenAIState } from './src/api/openai';
    export { sendChatGPTOAuthMessage, setChatGPTOAuthService } from './src/api/chatgpt-oauth';
    export { buildResponsesInput, fromResponsesOutput } from './src/api/responses-format';
    export { default as ChatPlugin } from './src/main';
    export { executeTool } from './src/tools/executor';
    export { TOOL_DEFINITIONS } from './src/tools/registry';
    export { ObsidianChatView } from './src/ui/chat-view';
    export { ChatGPTOAuthService } from './src/auth/chatgptOAuth';
    export { ChatGPTOAuthStore } from './src/auth/chatgptOAuthStore';
    export { ChatGPTDeviceLoginModal } from './src/settings';
    export { selectionScope } from './src/main';
    export { normalizeMathMarkdown } from './src/ui/math-markdown';
    export * as toolLabels from './src/ui/tool-label';
    export { WEB_PAGE_CHARS } from './src/tools/web-page';
    export * as debug from './src/debug';
    export { screenAwake } from './src/platform/screen-awake';
    export { isSendKey } from './src/ui/send-key';
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
    export { buildSystemPrompt } from './src/agent/system-prompt';
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
      export class Setting {}
      export const requireApiVersion = () => globalThis.__supportsNewObsidian === true;
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
      // A desktop unless a test sets globalThis.__isPhone.
      export const Platform = { get isPhone() { return globalThis.__isPhone === true; } };
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
export const image = { id: 'image', fileName: 'test.png', mediaType: 'image/png', data: 'fake-base64', sizeBytes: 1 };
export const text = value => ({ type: 'text', text: value });
export const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
export const result = (id, content, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
export const assistant = response => ({ role: 'assistant', content: response.content, replay: response.replay });
export const responseMessage = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value, annotations: [] }] });
export const nativeCall = (id, name, input) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) });
export function response(provider, blocks, stop = 'end_turn', index = 0) {
  if (provider === 'anthropic') return { status: 200, json: { content: blocks, stop_reason: stop } };
  const output = blocks.map(block => block.type === 'text' ? responseMessage(block.text) : block.type === 'tool_use' ? nativeCall(block.id, block.name, block.input) : block);
  const data = { id: `resp_${index}`, output, status: stop === 'max_tokens' ? 'incomplete' : 'completed' };
  if (provider === 'openai') return { status: 200, json: data };
  const events = output.map((item, output_index) => ({ type: 'response.output_item.done', item, output_index }));
  events.push({ type: stop === 'max_tokens' ? 'response.incomplete' : 'response.completed', response: { ...data, output: [] } });
  return sse(events);
}
export function sse(events) {
  const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return { status: 200, text: body, get json() { throw new SyntaxError('iOS lazy JSON getter'); } };
}
export function transport(handler) {
  const requests = [];
  globalThis.__providerRequest = async request => {
    const body = JSON.parse(request.body);
    requests.push(body);
    return handler(body, requests.length - 1, request);
  };
  return requests;
}
export function vaultApp() {
  const files = new Map([['Cases/Case Template.md', '# Template\n日本語本文'], ['Untitled.md', 'Original']]);
  const app = {
    workspace: { getActiveFile: () => ({ path: 'Untitled.md' }) },
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
