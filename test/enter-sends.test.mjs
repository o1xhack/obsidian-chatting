// The "Enter sends message" setting: on by default, kept in data.json, passed
// to the chat; the input and the edit box of a sent message follow it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, vaultApp, settingsApp } from './harness.mjs';

// A settings row that records its name and toggle.
function row() {
  const r = { setName(name) { r.name = name; return r; }, setDesc() { return r; } };
  r.addToggle = fn => { const t = { setValue(v) { r.value = v; return t; }, onChange(f) { r.change = f; return t; } }; fn(t); return r; };
  return r;
}

async function loaded(saved) {
  const plugin = new api.ChatPlugin();
  plugin.loadData = async () => ({ ...settings('openai'), ...saved });
  plugin.loadApiKey = () => '';
  await plugin.loadSettings();
  return plugin;
}

test('Enter sends by default; turned off it stays off after a restart', async () => {
  assert.equal((await loaded({})).settings.enterSends, true);
  assert.equal((await loaded({ enterSends: false })).settings.enterSends, false);
  assert.equal((await loaded({ enterSends: 'no' })).settings.enterSends, true);
});

test('Settings: the row works in both settings paths and saves the toggle', async () => {
  const plugin = { settings: settings('openai'), saves: 0, async saveSettings() { plugin.saves++; } };
  plugin.settings.enterSends = true;
  const tab = new api.ChatSettingTab(settingsApp, plugin);
  // Obsidian 1.13+: a definition of its own.
  const r = row();
  tab.getSettingDefinitions().find(d => d.name === 'Enter sends message').render(r);
  assert.equal(r.name, 'Enter sends message');
  assert.equal(r.value, true);
  await r.change(false);
  assert.equal(plugin.settings.enterSends, false);
  assert.equal(plugin.saves, 1);

  // Older Obsidian: display() draws it (the other rows are left out here).
  const drawn = [];
  const ignore = () => {};
  Object.assign(tab, { containerEl: { empty: ignore }, renderProvider: ignore, renderApiKeySection: ignore, renderModelSection: ignore,
    renderWebSearch: ignore, renderFollowEdits: ignore, renderInstructions: ignore, renderSkills: ignore, renderMaxIterations: ignore, renderChats: ignore, renderMcpServers: ignore, renderVoice: ignore, renderDebugLog: ignore, loadCatalog: async () => {}, renderEnterSends: setting => drawn.push(setting) });
  tab.display();
  assert.equal(drawn.length, 1);
});

test("Ctrl/Cmd+Enter, which Obsidian keeps as a hotkey, reaches the chat through the view's scope", async () => {
  const plugin = await loaded({ enterSends: false });
  const view = new api.ObsidianChatView({}, plugin);
  const input = {};
  const sent = [];
  view.chatContainer = { sendFromKeyboard(target) { if (target !== input) return false; sent.push(target); return true; } };
  const modEnter = view.scope.keys.find(k => k.key === 'Enter' && k.modifiers.join() === 'Mod');
  // In the chat input: sent, and Obsidian's own hotkey is kept from running.
  assert.equal(modEnter.func({ target: input }), false);
  assert.deepEqual(sent, [input]);
  // Anywhere else: left to Obsidian.
  assert.equal(modEnter.func({ target: {} }), true);
  assert.equal(sent.length, 1);
});

test('The chat view passes the setting to the chat, also when settings are saved', async () => {
  const plugin = await loaded({});
  const view = new api.ObsidianChatView({}, plugin);
  const chat = { setEnterSends(value) { chat.enterSends = value; }, setFollowEdits() {}, setModel() {}, setVoiceAvailable() {} };
  view.chatContainer = chat;
  plugin.settings.enterSends = false;
  view.updateEnterSends();
  assert.equal(chat.enterSends, false);

  // Saving the settings updates the open chat view.
  const { app } = vaultApp();
  plugin.app = { ...app, workspace: { getLeavesOfType: () => [{ view }] } };
  plugin.saveData = async () => {};
  plugin.settings.enterSends = true;
  await plugin.saveSettings();
  assert.equal(chat.enterSends, true);
});

test('Which keys send a message or save an edit, with the setting on and off', () => {
  const key = (extra = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...extra });
  // On: Enter sends, Shift+Enter is a new line.
  assert.equal(api.isSendKey(key(), true), true);
  assert.equal(api.isSendKey(key({ shiftKey: true }), true), false);
  // Off: Enter is a new line, Ctrl/Cmd+Enter sends.
  assert.equal(api.isSendKey(key(), false), false);
  assert.equal(api.isSendKey(key({ ctrlKey: true }), false), true);
  assert.equal(api.isSendKey(key({ metaKey: true }), false), true);
  // Never while an IME composes, and only Enter.
  assert.equal(api.isSendKey(key({ isComposing: true }), true), false);
  assert.equal(api.isSendKey(key({ key: 'a' }), true), false);
});
