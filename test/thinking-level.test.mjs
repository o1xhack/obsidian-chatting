// Thinking from the model catalog: what the provider lists for a model, and
// the previous rules for models the catalog has no data on.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, response, settings, text, transport, settingsApp } from './harness.mjs';

beforeEach(() => {
  for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) api.clearCatalogModels(provider);
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

// Settings whose saved catalog belongs to the fake credentials of the harness.
async function withCatalog(provider, models, extra = {}) {
  const identity = await api.catalogIdentity(provider, provider === 'chatgpt-oauth' ? 'fake-account' : 'fake-test-key');
  return { ...settings(provider), modelCatalog: { entries: [{ provider, identity, fetchedAt: Date.now(), models }] }, ...extra };
}
const readTool = [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }];

test('Anthropic catalog: the thinking mode comes from /v1/models capabilities and is saved with the list', async () => {
  const identity = await api.catalogIdentity('anthropic', 'capabilities');
  globalThis.__providerRequest = async () => ({ status: 200, json: { has_more: false, data: [
    { type: 'model', id: 'claude-a', capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: true } } } } },
    { type: 'model', id: 'claude-b', capabilities: { thinking: { supported: true, types: { adaptive: { supported: false }, enabled: { supported: true } } } } },
    { type: 'model', id: 'claude-c', capabilities: { thinking: { supported: false, types: {} } } },
    { type: 'model', id: 'claude-d' },
  ] } });
  const state = { entries: [] };
  const models = await api.refreshCatalog(state, 'anthropic', identity, 'capabilities', {}, true);
  assert.deepEqual(models.map(m => m.thinkingType), ['adaptive', 'enabled', 'disabled', undefined]);
  const restored = api.normalizeCatalogState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.entries[0].models.map(m => m.thinkingType), ['adaptive', 'enabled', 'disabled', undefined]);
});

const anthropicModels = [
  { value: 'claude-future-adaptive', label: 'Adaptive', thinkingType: 'adaptive' },
  { value: 'claude-future-budget', label: 'Budget', thinkingType: 'enabled' },
  { value: 'claude-future-plain', label: 'Plain' },
  // The catalog wins over the name rule (which would say adaptive).
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7', thinkingType: 'enabled' },
];
for (const [model, thinking] of [
  ['claude-future-adaptive', { type: 'adaptive' }],
  ['claude-future-budget', { type: 'enabled', budget_tokens: 8192 }],
  ['claude-future-plain', undefined],
  ['claude-opus-4-7', { type: 'enabled', budget_tokens: 8192 }],
  // Not in the catalog: the rule by model name, as before.
  ['claude-sonnet-4-6', { type: 'adaptive' }],
  ['claude-opus-4-5', { type: 'enabled', budget_tokens: 8192 }],
  ['claude-haiku-4-5-20251001', undefined],
]) {
  test(`Anthropic: ${model} thinks as the catalog says, else by its name`, async () => {
    const requests = transport(() => response('anthropic', [text('Hello')]));
    await api.sendAnthropicMessage(await withCatalog('anthropic', anthropicModels, { model, enableWebSearch: false }), [{ role: 'user', content: 'Hello' }], readTool, 'System');
    assert.deepEqual(requests[0].thinking, thinking);
  });
}

test('Anthropic: a list saved before the capabilities were read keeps the rule by model name', async () => {
  const requests = transport(() => response('anthropic', [text('Hello')]));
  const config = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }], { enableWebSearch: false });
  await api.sendAnthropicMessage({ ...config, modelCatalog: api.normalizeCatalogState(config.modelCatalog) }, [{ role: 'user', content: 'Hello' }], readTool, 'System');
  assert.deepEqual(requests[0].thinking, { type: 'adaptive' });
});

test('Anthropic catalog: the effort levels come from /v1/models capabilities, in the API order', async () => {
  const identity = await api.catalogIdentity('anthropic', 'effort');
  globalThis.__providerRequest = async () => ({ status: 200, json: { has_more: false, data: [
    { type: 'model', id: 'claude-a', capabilities: { effort: { supported: true, low: { supported: true }, medium: { supported: false }, high: { supported: true }, max: { supported: true } } } },
    { type: 'model', id: 'claude-b', capabilities: { effort: { supported: false, low: { supported: true } } } },
    { type: 'model', id: 'claude-c' },
  ] } });
  const state = { entries: [] };
  const models = await api.refreshCatalog(state, 'anthropic', identity, 'effort', {}, true);
  assert.deepEqual(models.map(m => m.reasoningEfforts), [['low', 'high', 'max'], undefined, undefined]);
  const restored = api.normalizeCatalogState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(restored.entries[0].models[0].reasoningEfforts, ['low', 'high', 'max']);
});

const levelModels = [
  { value: 'claude-future-adaptive', label: 'Adaptive', thinkingType: 'adaptive', reasoningEfforts: ['low', 'high', 'max'] },
  { value: 'claude-future-budget', label: 'Budget', thinkingType: 'enabled' },
];
for (const [model, level, effort] of [
  ['claude-future-adaptive', '', undefined],
  ['claude-future-adaptive', 'max', 'max'],
  // Not offered by this model: its default.
  ['claude-future-adaptive', 'xhigh', undefined],
  ['claude-future-budget', 'high', undefined],
  // No catalog data: no effort, thinking by name as before.
  ['claude-sonnet-4-6', 'high', undefined],
]) {
  test(`Anthropic: ${model} with level "${level}" sends effort ${effort}`, async () => {
    const requests = transport(() => response('anthropic', [text('Hello')]));
    await api.sendAnthropicMessage(await withCatalog('anthropic', levelModels, { model, thinkingLevel: level, enableWebSearch: false }), [{ role: 'user', content: 'Hello' }], readTool, 'System');
    assert.deepEqual(requests[0].output_config, effort && { effort });
    assert.ok(requests[0].thinking);
  });
}

const gpt = (extra = {}) => [{ value: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'low', ...extra }];
for (const [name, level, models, reasoning] of [
  ['a listed level', 'high', gpt(), { effort: 'high', summary: 'auto' }],
  ['a level the model does not list: the catalog default', 'ultra', gpt(), { effort: 'low', summary: 'auto' }],
  ['Default: the catalog default', '', gpt(), { effort: 'low', summary: 'auto' }],
  ['Default without a catalog default: medium, as before', '', gpt({ defaultReasoningEffort: undefined }), { effort: 'medium', summary: 'auto' }],
  ['no summaries in the catalog', 'high', gpt({ supportsReasoningSummary: false }), { effort: 'high' }],
  ['a model without levels', 'high', [{ value: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: [] }], undefined],
  // No catalog data: the rule by model name, as before.
  ['no catalog data', 'high', [], { effort: 'medium', summary: 'auto' }],
]) {
  test(`ChatGPT: ${name}`, async () => {
    const requests = transport(() => response('chatgpt-oauth', [text('OK')]));
    await api.sendChatGPTOAuthMessage(await withCatalog('chatgpt-oauth', models, { thinkingLevel: level }), [{ role: 'user', content: 'test' }], [], 'test');
    assert.deepEqual(requests[0].reasoning, reasoning);
    assert.deepEqual(requests[0].include, reasoning && ['reasoning.encrypted_content']);
  });
}

test('OpenAI (API key): its model list has no levels, so requests keep the reasoning they had', async () => {
  const requests = transport(() => response('openai', [text('OK')]));
  await api.sendOpenAIMessage(await withCatalog('openai', [{ value: 'gpt-5.5', label: 'gpt-5.5' }], { thinkingLevel: 'high' }), [{ role: 'user', content: 'test' }], [], 'test');
  assert.deepEqual(requests[0].reasoning, { effort: 'medium' });
  assert.deepEqual(requests[0].include, ['reasoning.encrypted_content']);
});

// A settings row as Obsidian hands it to a definition's render(); records its dropdown.
function row() {
  const r = { options: [] };
  const dropdown = { addOption(value, label) { r.options.push([value, label]); return dropdown; }, setValue(value) { r.value = value; return dropdown; }, onChange(fn) { r.change = fn; return dropdown; } };
  r.setName = name => { r.name = name; return r; };
  r.setDesc = desc => { r.desc = desc; return r; };
  r.addDropdown = fn => { fn(dropdown); return r; };
  return r;
}
const settingModels = [
  { value: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: ['low', 'medium', 'xhigh'], defaultReasoningEffort: 'medium' },
  { value: 'claude-x', label: 'Claude X', reasoningEfforts: ['high', 'max'] },
  { value: 'gpt-4o', label: 'GPT-4o' },
];

test('Settings: the thinking level offers the catalog levels of the selected model and hides without them', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout(fn) { fn(); }, clearTimeout() {} };
  try {
    const saved = [];
    const plugin = { settings: { ...settings('chatgpt-oauth'), thinkingLevel: 'xhigh' }, async saveSettings() { saved.push(plugin.settings.thinkingLevel); }, reloadApiKeyForProvider() {}, chatgptOAuth: { getCredential: () => null } };
    const tab = new api.ChatSettingTab(settingsApp, plugin);
    let refreshes = 0;
    tab.display = () => { refreshes++; };
    const definitions = tab.getSettingDefinitions();
    const thinking = definitions.find(d => d.name === 'Thinking level');
    assert.equal(thinking.visible(), false);
    tab.catalogModels = settingModels;
    assert.equal(thinking.visible(), true);

    let r = row();
    thinking.render(r);
    assert.equal(r.name, 'Thinking level');
    assert.deepEqual(r.options, [['', 'Default (medium)'], ['low', 'low'], ['medium', 'medium'], ['xhigh', 'xhigh']]);
    assert.equal(r.value, 'xhigh');
    await r.change('low');
    assert.deepEqual(saved, ['low']);

    // Another model: a saved level it doesn't offer stays saved and is marked.
    const model = row();
    definitions.find(d => d.name === 'Model').render(Object.assign(model, { settingEl: { parentElement: {} }, addButton() { return model; } }));
    refreshes = 0;
    await model.change('claude-x');
    assert.equal(refreshes, 1);
    r = row();
    thinking.render(r);
    assert.deepEqual(r.options, [['', 'Default'], ['high', 'high'], ['max', 'max'], ['low', 'low (not available)']]);
    assert.equal(r.value, 'low');
    assert.equal(plugin.settings.thinkingLevel, 'low');

    // No levels, or not in the list: the row is hidden.
    await model.change('gpt-4o');
    assert.equal(thinking.visible(), false);
    plugin.settings.model = 'custom-id';
    assert.equal(thinking.visible(), false);

    // Each provider names its own levels: a new provider starts at Default.
    const provider = row();
    definitions.find(d => d.name === 'Provider').render(provider);
    await provider.change('anthropic');
    assert.equal(plugin.settings.thinkingLevel, '');
  } finally {
    globalThis.window = previousWindow;
  }
});

test('Settings before Obsidian 1.13: display() shows the thinking level only when the model has levels', () => {
  const plugin = { settings: { ...settings('chatgpt-oauth'), thinkingLevel: '' } };
  const tab = new api.ChatSettingTab({}, plugin);
  // Only the wiring of display() is under test here; the row has its own test.
  const shown = [];
  const ignore = () => {};
  Object.assign(tab, { containerEl: { empty: ignore }, renderProvider: ignore, renderChatGPTOAuthSection: ignore, renderModelSection: ignore,
    renderWebSearch: ignore, renderEnterSends: ignore, renderFollowEdits: ignore, renderInstructions: ignore, renderSkills: ignore, renderMaxIterations: ignore, renderChats: ignore, renderMcpServers: ignore, renderDebugLog: ignore, loadCatalog: async () => {}, renderThinkingLevel: setting => shown.push(setting) });
  tab.display();
  assert.equal(shown.length, 0);
  tab.catalogModels = settingModels;
  tab.display();
  assert.equal(shown.length, 1);
});

test('Chat header: the effective thinking level next to the model name', async () => {
  const identity = await api.catalogIdentity('chatgpt-oauth', 'header');
  api.cachedCatalog({ entries: [{ provider: 'chatgpt-oauth', identity, fetchedAt: Date.now(), models: settingModels }] }, 'chatgpt-oauth', identity);
  const plugin = new api.ChatPlugin();
  plugin.settings = { ...settings('chatgpt-oauth'), thinkingLevel: 'xhigh' };
  assert.equal(plugin.modelHeaderLabel(), 'GPT-5.5 · xhigh');
  plugin.settings.thinkingLevel = '';
  assert.equal(plugin.modelHeaderLabel(), 'GPT-5.5 · medium (default)');
  plugin.settings.thinkingLevel = 'max';
  assert.equal(plugin.modelHeaderLabel(), 'GPT-5.5 · medium (default)');
  plugin.settings.model = 'claude-x';
  assert.equal(plugin.modelHeaderLabel(), 'Claude X · max');
  plugin.settings.thinkingLevel = '';
  assert.equal(plugin.modelHeaderLabel(), 'Claude X · default');
  plugin.settings.model = 'gpt-4o';
  assert.equal(plugin.modelHeaderLabel(), 'GPT-4o');
  plugin.settings.model = 'custom-id';
  assert.equal(plugin.modelHeaderLabel(), 'custom-id');
});

test('Settings load: the thinking level from data.json is a string, else Default', async () => {
  for (const [saved, loaded] of [['high', 'high'], [undefined, ''], [3, ''], [null, '']]) {
    const plugin = new api.ChatPlugin();
    plugin.app = { secretStorage: { getSecret: () => '' } };
    plugin.loadData = async () => ({ thinkingLevel: saved });
    await plugin.loadSettings();
    assert.equal(plugin.settings.thinkingLevel, loaded, String(saved));
  }
});

test('Settings: the connection Test asks with the lightest listed level; the setting stays as it is', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout() {}, clearTimeout() {} };
  try {
    const plugin = { settings: await withCatalog('chatgpt-oauth', gpt({ defaultReasoningEffort: 'medium' }), { thinkingLevel: 'high', enableWebSearch: true }), async saveSettings() {}, reloadApiKeyForProvider() {} };
    plugin.chatgptOAuth = { getCredential: () => ({ accessToken: 'fake-token', accountId: 'fake-account', expiresAt: Date.now() + 60000 }) };
    api.cachedCatalog(plugin.settings.modelCatalog, 'chatgpt-oauth', plugin.settings.modelCatalog.entries[0].identity);
    const tab = new api.ChatSettingTab({}, plugin);
    const buttons = [];
    const r = { setName: () => r, setDesc: () => r, addButton(fn) { const b = { setButtonText: () => b, setDisabled: () => b, setDestructive: () => b, setWarning: () => b, onClick(f) { b.click = f; return b; } }; buttons.push(b); fn(b); return r; } };
    tab.renderChatGPTOAuthSection({ createDiv: () => ({ createSpan() {}, createEl() {} }) }, Object.assign(r, { settingEl: { before() {} } }));
    const requests = transport(() => response('chatgpt-oauth', [text('Hello')]));
    await buttons[1].click();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reasoning.effort, 'low');
    assert.equal(plugin.settings.thinkingLevel, 'high');
  } finally {
    globalThis.window = previousWindow;
  }
});


test('Anthropic explicit unsupported thinking overrides a thinking-capable model name after reload', async () => {
  const identity = await api.catalogIdentity('anthropic', 'fake-test-key');
  globalThis.__providerRequest = async () => ({ status: 200, json: { data: [
    { type: 'model', id: 'claude-opus-4-7', capabilities: { thinking: { supported: false } } },
  ] } });
  const state = { entries: [] };
  await api.refreshCatalog(state, 'anthropic', identity, 'fake-test-key', {}, true);
  const modelCatalog = api.normalizeCatalogState(JSON.parse(JSON.stringify(state)));
  const requests = transport(() => response('anthropic', [text('ok')]));
  await api.sendAnthropicMessage({ ...settings('anthropic'), model: 'claude-opus-4-7', modelCatalog },
    [{ role: 'user', content: 'hello' }], [], 'system');
  assert.equal(requests[0].thinking, undefined);
});
