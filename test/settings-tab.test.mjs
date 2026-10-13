// The settings tab: redraws still pending when it is closed are skipped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, settingsApp } from './harness.mjs';

// A settings row whose text or dropdown control records its onChange handler.
function row() {
  const r = {};
  const control = {
    inputEl: {},
    setPlaceholder: () => control, setValue: () => control, addOption: () => control,
    onChange: handler => { r.change = handler; return control; },
  };
  r.setName = () => r;
  r.setDesc = () => r;
  r.addText = render => { render(control); return r; };
  r.addDropdown = render => { render(control); return r; };
  return r;
}

test('A closed settings tab is not redrawn by a pending refresh; shown again, it is', async () => {
  const previousWindow = globalThis.window;
  const timers = [];
  globalThis.window = { setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {} };
  try {
    for (const newObsidian of [false, true]) {
      globalThis.__supportsNewObsidian = newObsidian;
      const plugin = { settings: { ...settings('anthropic'), apiKey: '' }, async saveSettings() {}, reloadApiKeyForProvider() {} };
      const tab = new api.ChatSettingTab(settingsApp, plugin);
      let redraws = 0;
      tab.display = tab.update = () => { redraws++; };
      const apiKey = row();
      tab.renderApiKeySection({}, apiKey);
      const provider = row();
      tab.renderProvider(provider);

      // Typing a key and changing the provider schedule redraws (800 and 10 ms).
      await apiKey.change('fake-new-key');
      await provider.change('openai');
      assert.equal(timers.length, 2);
      tab.hide();
      timers.splice(0).forEach(fn => fn());
      assert.equal(redraws, 0);

      // Shown again (Obsidian 1.13+ asks for the definitions), it redraws.
      tab.getSettingDefinitions();
      await provider.change('anthropic');
      timers.splice(0).forEach(fn => fn());
      assert.equal(redraws, 1);
    }
  } finally {
    globalThis.window = previousWindow;
    globalThis.__supportsNewObsidian = false;
  }
});
