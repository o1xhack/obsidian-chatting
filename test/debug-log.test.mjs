// The "Debug log" setting switches logging at runtime; "Copy debug log" gets it off a phone.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, settings, text, call, response, transport, callbacks, vaultApp } from './harness.mjs';

const LOG = '.obsidian/plugins/chatting-with-ai/debug.log';
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function pluginWith(saved) {
  const files = new Map();
  const adapter = {
    append: async (path, text) => { files.set(path, (files.get(path) ?? '') + text); },
    exists: async (path) => files.has(path),
    read: async (path) => files.get(path),
    remove: async (path) => { files.delete(path); },
  };
  const { app } = vaultApp();
  app.vault.adapter = adapter;
  app.workspace.getLeavesOfType = () => [];
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.loadApiKey = () => '';
  plugin.loadData = async () => ({ ...settings('openai'), ...saved });
  plugin.saveData = async () => {};
  return { plugin, files };
}

// A settings row that records its name, toggle and buttons.
function row() {
  const r = { buttons: {}, setName(name) { r.name = name; return r; }, setDesc() { return r; } };
  r.addToggle = fn => { const t = { setValue(v) { r.value = v; return t; }, onChange(f) { r.change = f; return t; } }; fn(t); return r; };
  r.addButton = fn => { const b = { setButtonText(label) { b.label = label; return b; }, onClick(f) { r.buttons[b.label] = f; return b; } }; fn(b); return r; };
  return r;
}

let copied;
beforeEach(() => {
  globalThis.__notices = [];
  copied = null;
  // Newer Node versions define a read-only `navigator`; replace it the way a browser test would.
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { copied = text; } } },
    configurable: true,
    writable: true,
  });
});
afterEach(() => api.debug.setDebugLogging(false));

test('Off by default: nothing is written, and Copy says how to turn it on', async () => {
  const { plugin, files } = pluginWith({});
  await plugin.loadSettings();
  assert.equal(plugin.settings.debugLog, false);
  api.debug.debugLog(plugin.app, 'TEST', { a: 1 });
  await tick();
  assert.equal(files.has(LOG), false);
  await plugin.copyDebugLog();
  assert.equal(copied, null);
  assert.match(globalThis.__notices.at(-1), /Turn on Debug log in settings first/);
});

test('On (from data.json): entries are written, Copy puts the log on the clipboard, Clear removes it', async () => {
  const { plugin, files } = pluginWith({ debugLog: true });
  await plugin.loadSettings();
  api.debug.debugLog(plugin.app, 'TEST', { a: 1 });
  await tick();
  assert.match(files.get(LOG), /--- TEST \[/);
  await plugin.copyDebugLog();
  assert.equal(copied, files.get(LOG));
  assert.match(globalThis.__notices.at(-1), /Debug log copied/);

  await api.debug.clearDebugLog(plugin.app);
  assert.equal(files.has(LOG), false);

  // Turning it off in settings stops the writing.
  plugin.settings.debugLog = false;
  await plugin.saveSettings();
  api.debug.debugLog(plugin.app, 'TEST', { a: 2 });
  await tick();
  assert.equal(files.has(LOG), false);
});

test("A turn's log has the request as sent, the answers with their tool calls, the tool results and errors, never the key", async () => {
  const { plugin, files } = pluginWith({ debugLog: true });
  await plugin.loadSettings();
  const turnSettings = settings('anthropic');
  const loop = new api.AgentLoop(plugin.app, turnSettings);
  transport((body, index) => index === 0
    ? response('anthropic', [call('t1', 'get_current_datetime', {})], 'tool_use')
    : response('anthropic', [text('Hello')]));
  await loop.run('Hi there', callbacks());
  transport(() => ({ status: 500, json: { error: { message: 'Server down' } } }));
  await loop.run('Again', callbacks());
  await tick();
  const log = files.get(LOG);
  assert.match(log, /USER_MESSAGE/);
  assert.match(log, /Hi there/);
  // The message as the model got it, with the context lines.
  assert.match(log, /"sent": "\[Context:/);
  assert.match(log, /API_RESPONSE/);
  assert.match(log, /"name": "get_current_datetime"/);
  assert.match(log, /TOOL_CALL/);
  assert.match(log, /"text": "Hello"/);
  assert.match(log, /API_ERROR/);
  assert.ok(!log.includes(turnSettings.apiKey));
});

test('Settings: the row works in both settings paths; Copy and Clear', async () => {
  const { plugin, files } = pluginWith({ debugLog: true });
  await plugin.loadSettings();
  plugin.saves = 0;
  plugin.saveSettings = async () => { plugin.saves++; };
  const tab = new api.ChatSettingTab(plugin.app, plugin);
  // Obsidian 1.13+: a definition of its own.
  const r = row();
  tab.getSettingDefinitions().find(d => d.name === 'Debug log').render(r);
  assert.equal(r.name, 'Debug log');
  assert.equal(r.value, true);
  api.debug.debugLog(plugin.app, 'TEST', { a: 1 });
  await tick();
  await r.buttons.Copy();
  await tick();
  assert.equal(copied, files.get(LOG));
  await r.buttons.Clear();
  assert.equal(files.has(LOG), false);
  assert.match(globalThis.__notices.at(-1), /Debug log cleared/);
  await r.change(false);
  assert.equal(plugin.settings.debugLog, false);
  assert.equal(plugin.saves, 1);

  // Older Obsidian: display() draws it (the other rows are left out here).
  const drawn = [];
  const ignore = () => {};
  Object.assign(tab, { containerEl: { empty: ignore }, renderProvider: ignore, renderApiKeySection: ignore, renderModelSection: ignore,
    renderWebSearch: ignore, renderEnterSends: ignore, renderFollowEdits: ignore, renderInstructions: ignore, renderSkills: ignore, renderMaxIterations: ignore, renderChats: ignore, renderMcpServers: ignore, renderVoice: ignore, loadCatalog: async () => {}, renderDebugLog: setting => drawn.push(setting) });
  tab.display();
  assert.equal(drawn.length, 1);
});

test('Copy and Clear wait for pending log writes, and a failed write does not poison later writes', async () => {
  const { plugin, files } = pluginWith({ debugLog: true });
  await plugin.loadSettings();
  let finish;
  plugin.app.vault.adapter.append = (path, entry) => new Promise(resolve => {
    finish = () => { files.set(path, (files.get(path) ?? '') + entry); resolve(); };
  });
  api.debug.debugLog(plugin.app, 'PENDING', {});
  await tick();
  let cleared = false;
  const clearing = api.debug.clearDebugLog(plugin.app).then(() => { cleared = true; });
  await tick();
  assert.equal(cleared, false);
  finish();
  await clearing;
  assert.equal(files.has(LOG), false);
  plugin.app.vault.adapter.append = async () => { throw new Error('disk full'); };
  api.debug.debugLog(plugin.app, 'FAILED', {});
  await api.debug.readDebugLog(plugin.app);
  plugin.app.vault.adapter.append = async (path, entry) => { files.set(path, entry); };
  api.debug.debugLog(plugin.app, 'RECOVERED', {});
  assert.match(await api.debug.readDebugLog(plugin.app), /RECOVERED/);
});
