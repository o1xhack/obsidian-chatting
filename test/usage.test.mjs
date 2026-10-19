// Usage and cost: each provider's token counts, windows and prices from the
// model lists and documentation pages, the cost estimate, and the context
// ring of the open conversation (saved with it, reset by Clear).
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, sse, streamEvents, text, transport, withCatalog, settings, callbacks, vaultApp, chatFiles } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
  globalThis.__notices = [];
});

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    addUserMessage(value) { chat.shown.push({ id: nextId++, type: 'user', text: value }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    addToolCall() { return nextId++; }, updateToolResult() {},
    addError(value, errorKind) { chat.shown.push({ id: nextId++, type: 'error', text: value, errorKind }); },
    showThinking() {}, hideThinking() {}, showAskUser: () => new Promise(() => {}), cancelAskUser() {},
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, updateConversations() {}, setContinue() {}, setQueued() {},
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {}, setSelection() {}, getSelection: () => null,
    usage: null, setUsage(value) { chat.usage = value; },
  };
  return chat;
}

// A plugin that loads `saved` as its chat-state.json (none when undefined),
// records its writes, and has a chat view with a fake component.
async function chatSetup(provider, saved) {
  const { app } = vaultApp();
  const { adapter, writes } = chatFiles(saved);
  app.vault.adapter = adapter;
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...plugin.settings, ...settings(provider) };
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { plugin, view, chat, writes };
}

/** An Anthropic answer with this usage (start and final counts). */
function anthropicAnswer(answer, startUsage, finalUsage) {
  const events = streamEvents('anthropic', [text(answer)]);
  events[0].message.usage = startUsage;
  events.at(-2).usage = finalUsage;
  return sse(events);
}

/** A Responses API answer with this usage. */
function responsesAnswer(provider, answer, usage, index = 0) {
  const events = streamEvents(provider, [text(answer)], 'end_turn', index);
  events.at(-1).response.usage = usage;
  return sse(events);
}

test('Anthropic usage: the context is uncached plus cache reads and writes; a compaction pass is counted apart', async () => {
  const usages = [];
  transport(() => anthropicAnswer('ok',
    { input_tokens: 100, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400, output_tokens: 1 },
    { output_tokens: 50, iterations: [{ type: 'compaction', input_tokens: 180000, output_tokens: 3500 }, { type: 'message', input_tokens: 9500, output_tokens: 50 }] }));
  await new api.AgentLoop(vaultApp().app, settings('anthropic')).run('Hi', callbacks({ onUsage: (usage, request) => usages.push([usage, request]) }));
  assert.deepEqual(usages, [[
    { inputTokens: 9500, outputTokens: 50, cachedInputTokens: 9000, cacheWriteTokens: 400, compactionInputTokens: 180000, compactionOutputTokens: 3500 },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', turnStart: true },
  ]]);
});

test('OpenAI and ChatGPT usage: input tokens include the cached ones', async () => {
  for (const provider of ['openai', 'chatgpt-oauth']) {
    const usages = [];
    transport(() => responsesAnswer(provider, 'ok', { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 30 }));
    await new api.AgentLoop(vaultApp().app, settings(provider)).run('Hi', callbacks({ onUsage: usage => usages.push(usage) }));
    assert.deepEqual(usages, [{ inputTokens: 2000, outputTokens: 30, cachedInputTokens: 1500 }], provider);
  }
});

test('Cost: uncached, cache reads and writes, output and compaction at their prices; none without prices', () => {
  const U = api.usage;
  const pricing = { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 };
  const cost = U.requestCost({ inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 800_000, cacheWriteTokens: 100_000, compactionInputTokens: 10_000, compactionOutputTokens: 1000 }, pricing);
  // 100k × 3 + 800k × 0.3 + 100k × 3.75 + 100k × 15 + 10k × 3 + 1k × 15, per million.
  assert.equal(cost.toFixed(4), ((0.3 + 0.24 + 0.375 + 1.5 + 0.03 + 0.015)).toFixed(4));
  assert.equal(U.requestCost({ inputTokens: 10, outputTokens: 1 }, undefined), undefined);

  let usage = U.addRequest(undefined, { inputTokens: 1000, outputTokens: 100 }, { model: 'm', provider: 'openai', pricing: { input: 1, output: 10 }, turnStart: true });
  usage = U.addRequest(usage, { inputTokens: 1200, outputTokens: 50 }, { model: 'm', provider: 'openai', pricing: { input: 1, output: 10 }, turnStart: false });
  assert.equal(usage.contextTokens, 1250);
  assert.deepEqual([usage.inputTokens, usage.outputTokens], [2200, 150]);
  assert.equal(usage.lastTurnCostUsd.toFixed(6), ((1000 + 1000 + 1200 + 500) / 1e6).toFixed(6));
  usage = U.addRequest(usage, { inputTokens: 1300, outputTokens: 10 }, { model: 'x', provider: 'openai', turnStart: true });
  assert.equal(usage.unpricedRequests, 1);
  assert.equal(usage.lastTurnCostUsd, undefined);
  assert.equal(U.formatCost(0.004), '<$0.01');
  assert.equal(U.formatCost(1.234), '$1.23');
  assert.deepEqual([U.formatTokens(950), U.formatTokens(45210), U.formatTokens(1_050_000)], ['950', '45.2k', '1.1M']);
});

const OPENAI_DOCS = `# GPT-5.4

## Model details

- Default snapshot: \`gpt-5.4-2026-03-05\`
- 1,050,000 context window
- 128,000 max output tokens

## Pricing

### Text tokens

| Metric | Price | Unit |
| --- | ---: | --- |
| Input | $2.5 | 1M tokens |
| Cached input | $0.25 | 1M tokens |
| Output | $15 | 1M tokens |

## Quick comparison

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GPT-5.2 | $1.75 | $0.175 | $14 |
`;

test('OpenAI documentation page: window less the answer (or the stated maximum input), prices from the text tokens table', () => {
  assert.deepEqual(api.parseOpenAIModelDocs(OPENAI_DOCS), { contextWindow: 922000, maxOutputTokens: 128000, pricing: { input: 2.5, cachedInput: 0.25, output: 15 } });
  assert.equal(api.parseOpenAIModelDocs(`- 1,050,000 context window\n- Maximum input tokens: 900,000\n`).contextWindow, 900000);
  assert.deepEqual(api.parseOpenAIModelDocs('# Nothing here'), {});
});

test('OpenAI: the selected model\'s page is read after its first answer (a snapshot reads its model\'s page), once a day', async () => {
  const fetched = [];
  const loopSettings = await withCatalog('openai', [{ value: 'gpt-5.4-2026-03-05', label: 'gpt-5.4-2026-03-05' }], { model: 'gpt-5.4-2026-03-05' });
  transport((body, index) => responsesAnswer('openai', 'ok', { input_tokens: 10, output_tokens: 1 }, index));
  const provider = globalThis.__providerRequest;
  globalThis.__providerRequest = async request => {
    if (!request.url.startsWith('https://developers.openai.com/')) return provider(request);
    fetched.push(request.url);
    return { status: 200, text: OPENAI_DOCS, headers: {} };
  };
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  await agent.run('Hi', callbacks());
  await agent.run('Again', callbacks());
  assert.deepEqual(fetched, ['https://developers.openai.com/api/docs/models/gpt-5.4.md']);
  assert.equal(api.catalogModel('openai', 'gpt-5.4-2026-03-05').contextWindow, 922000);
});

test('OpenAI: a documentation page that doesn\'t answer doesn\'t hold up the turn; once read, the view saves it', async () => {
  const loopSettings = await withCatalog('openai', [{ value: 'gpt-5.5', label: 'gpt-5.5' }], { model: 'gpt-5.5' });
  transport((body, index) => responsesAnswer('openai', 'ok', { input_tokens: 10, output_tokens: 1 }, index));
  const provider = globalThis.__providerRequest;
  let answerPage;
  globalThis.__providerRequest = async request => {
    if (!request.url.startsWith('https://developers.openai.com/')) return provider(request);
    return new Promise(resolve => { answerPage = () => resolve({ status: 200, text: OPENAI_DOCS, headers: {} }); });
  };
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  let details = 0;
  const cb = callbacks({ onModelDetails() { details++; } });
  await agent.run('Hi', cb);
  assert.deepEqual(cb.texts, ['ok']);
  assert.equal(details, 0);
  answerPage();
  for (let i = 0; i < 20 && !details; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(details, 1);
});

test('Anthropic catalog: window, answer limit and compaction from /v1/models, prices from the pricing page by display name', async () => {
  const pricingPage = [
    '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
    '| :-- | :-- | :-- | :-- | :-- | :-- |',
    '| Claude Sonnet 4.6 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.30 / MTok | $15 / MTok |',
    '| Claude Opus 4.1 ([retired](https://x)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |',
    '',
  ].join('\n');
  globalThis.__providerRequest = async request => request.url.startsWith('https://platform.claude.com/')
    ? { status: 200, text: pricingPage }
    : { status: 200, json: { data: [
      { id: 'claude-sonnet-4-6', type: 'model', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1000000, max_tokens: 64000,
        capabilities: { context_management: { compact_20260112: { supported: true }, supported: true } } },
      { id: 'claude-x', type: 'model', display_name: 'Claude X', max_input_tokens: 200000, capabilities: { context_management: { compact_20260112: null, supported: false } } },
    ], has_more: false } };
  const identity = await api.catalogIdentity('anthropic', 'fake-test-key');
  const models = await api.refreshCatalog({ entries: [] }, 'anthropic', identity, 'fake-test-key', {}, true);
  assert.deepEqual(models.map(({ value, contextWindow, maxOutputTokens, compaction, pricing }) => ({ value, contextWindow, maxOutputTokens, compaction, pricing })), [
    { value: 'claude-sonnet-4-6', contextWindow: 1000000, maxOutputTokens: 64000, compaction: true, pricing: { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 } },
    { value: 'claude-x', contextWindow: 200000, maxOutputTokens: undefined, compaction: false, pricing: undefined },
  ]);
  // Kept in data.json, checked when loaded.
  const saved = api.normalizeCatalogState(JSON.parse(JSON.stringify({ entries: [{ provider: 'anthropic', identity, fetchedAt: 1, models }] })));
  assert.deepEqual(saved.entries[0].models[0].pricing, { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 });
  assert.equal(saved.entries[0].models[0].contextWindow, 1000000);
  assert.equal(saved.entries[0].models[0].compaction, true);
});

test('Codex model list: the window as Codex uses it (context_window times its effective percent) and its compaction point', async () => {
  globalThis.__providerRequest = async request => request.url.startsWith('https://api.github.com/')
    ? { status: 200, json: { tag_name: 'rust-v0.161.0', prerelease: false, draft: false } }
    : { status: 200, json: { models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', context_window: 400000, effective_context_window_percent: 95, auto_compact_token_limit: 300000 },
      { slug: 'gpt-old', display_name: 'GPT old', visibility: 'list' },
    ] } };
  const oauth = { getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) };
  const identity = await api.catalogIdentity('chatgpt-oauth', 'fake-account');
  const models = await api.refreshCatalog({ entries: [] }, 'chatgpt-oauth', identity, '', oauth, true);
  assert.equal(models[0].contextWindow, 380000);
  assert.equal(models[0].autoCompactTokens, 300000);
  // A model without them has neither field.
  assert.equal('contextWindow' in models[1], false);
});

test('The ring: context against the selected model\'s window, compaction point, tokens used, cost; saved with the chat, gone after Clear', async () => {
  const { plugin, view, chat, writes } = await chatSetup('anthropic');
  plugin.settings.modelCatalog = (await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, pricing: { input: 3, output: 15 } }])).modelCatalog;
  transport(() => anthropicAnswer('ok', { input_tokens: 40000, output_tokens: 1 }, { output_tokens: 1000 }));
  await view.handleUserMessage('Hi', null);
  const cost = (40000 * 3 + 1000 * 15) / 1e6;
  assert.deepEqual(chat.usage, { contextTokens: 41000, inputTokens: 40000, outputTokens: 1000, contextWindow: 200000, compactAt: 160000, costUsd: cost, lastTurnCostUsd: cost, partialCost: false, plan: false });

  // Saved as an optional field of the conversation, in its chat file.
  await plugin.saveChatHistory();
  const saved = writes.at(-1);
  assert.equal(saved.version, api.chatState.CHAT_STATE_VERSION);
  assert.equal(saved.conversations[0].usage.contextTokens, 41000);
  const restored = await chatSetup('anthropic', saved);
  restored.view.renderHistory();
  assert.equal(restored.chat.usage.contextTokens, 41000);
  assert.equal(restored.chat.usage.inputTokens, 40000);

  view.clearConversation();
  assert.equal(chat.usage, null);
  assert.equal(plugin.activeConversation.usage, undefined);
});

test('A saved usage record is checked field by field; a broken one is dropped', () => {
  const { migrateChatState } = api.chatState;
  const conversation = (usage) => ({ id: 'c1', title: 'x', createdAt: 1, updatedAt: 1, chatHistory: [], agentMessages: [], usage });
  const state = usage => migrateChatState({ version: 3, activeConversationId: 'c1', conversations: [conversation(usage)] }).conversations[0];
  assert.deepEqual(state({ contextTokens: 10, costUsd: 0.5, model: 'm', provider: 'openai' }).usage,
    { contextTokens: 10, costUsd: 0.5, model: 'm', provider: 'openai', inputTokens: 0, outputTokens: 0, unpricedRequests: 0 });
  assert.equal(state({ contextTokens: -1, costUsd: 0, model: 'm', provider: 'openai' }).usage, undefined);
  assert.equal(state('much').usage, undefined);
});

test('The ChatGPT plan has no per-token cost', async () => {
  const { plugin, view, chat } = await chatSetup('chatgpt-oauth');
  plugin.settings.modelCatalog = (await withCatalog('chatgpt-oauth', [{ value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 380000, autoCompactTokens: 300000 }])).modelCatalog;
  transport(() => responsesAnswer('chatgpt-oauth', 'ok', { input_tokens: 5000, output_tokens: 100 }));
  await view.handleUserMessage('Hi', null);
  assert.deepEqual(chat.usage, { contextTokens: 5100, inputTokens: 5000, outputTokens: 100, contextWindow: 380000, compactAt: 300000, partialCost: true, plan: true });
});
