// Following the AI's edits: the editing tools report what changed, the
// chat shows it in the main area (one reused tab, Obsidian's search-match
// state for scrolling and highlighting, canvas cards centered), the follow
// tab closes with the plugin, and the setting switches it; open_document
// shows a spot when the user asks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, vaultApp, transport, response, text, call, settingsApp } from './harness.mjs';

const { changedRange, visibleRange, showInView, viewportFor, closeFollowTab, closeLeftoverFollowTab } = api.showInView;

// Obsidian's window: the waits for an open note or canvas to take in a change.
globalThis.window = { setTimeout: (fn) => setTimeout(fn, 0) };

/** A workspace with main-area tabs that records what they open. */
function workspace(app, files) {
  const leaves = [];
  const newLeaf = () => {
    const leaf = {
      view: { file: null }, states: [], opened: [],
      async openFile(file, state) { leaf.view = { file }; leaf.opened.push({ path: file.path, state }); },
      setEphemeralState(state) { leaf.states.push(state); },
    };
    leaves.push(leaf);
    return leaf;
  };
  app.vault.getFileByPath = (path) => files.has(path) ? { path, extension: path.split('.').pop() } : null;
  app.vault.cachedRead = async (file) => files.get(file.path);
  const revealed = [];
  app.workspace = {
    ...app.workspace,
    iterateRootLeaves: (fn) => leaves.forEach(fn),
    getLeaf: () => newLeaf(),
    revealLeaf: async (leaf) => { revealed.push(leaf); },
  };
  return { leaves, newLeaf, revealed };
}

test('changedRange: the changed middle in the new text; visibleRange: a deletion shows its line', () => {
  assert.deepEqual(changedRange('a b c', 'a XY c'), { from: 2, to: 4 });
  assert.deepEqual(changedRange('same', 'same'), null);
  assert.deepEqual(changedRange('abc', 'abcdef'), { from: 3, to: 6 });
  // A deletion is an empty range (here after the shared "one\nt").
  assert.deepEqual(changedRange('one\ntwo\nthree', 'one\nthree'), { from: 5, to: 5 });
  assert.deepEqual(visibleRange('one\nthree', 4, 4), [4, 9]);
  assert.deepEqual(visibleRange('one\nthree', 0, 3), [0, 3]);
});

test('The editing tools report the changed range or canvas cards; nothing on an error', async () => {
  const { app, files } = vaultApp();
  files.set('Note.md', '# Plan\n- one\n- two\n');
  const run = (name, input, scope) => api.executeTool(app, name, input, async () => 'yes', scope);
  const edited = await run('edit_document', { path: 'Note.md', operation: 'find_replace', find: '- two', content: '- two\n- three' });
  assert.deepEqual(edited.focus, { path: 'Note.md', from: 19, to: 27 });
  assert.equal(files.get('Note.md').slice(19, 27), '- three\n');
  const failed = await run('edit_document', { path: 'Note.md', operation: 'find_replace', find: 'missing', content: 'x' });
  assert.equal(failed.focus, undefined);

  // Inside a selection scope too.
  const scoped = await run('edit_document', { path: 'Note.md', operation: 'find_replace', find: 'one', content: 'first' }, { filePath: 'Note.md', text: '- one', from: 7 });
  assert.equal(scoped.isError, false, scoped.result);
  assert.deepEqual(scoped.focus, { path: 'Note.md', from: 9, to: 14 });

  const created = await run('create_file', { path: 'New.md', content: 'Hello' });
  assert.deepEqual(created.focus, { path: 'New.md', from: 0, to: 5 });

  const canvas = { nodes: [{ id: 'a1', type: 'text', text: 'Old', x: 0, y: 0, width: 200, height: 60 }, { id: 'b2', type: 'text', text: 'Keep', x: 0, y: 100, width: 200, height: 60 }], edges: [] };
  files.set('Map.canvas', JSON.stringify(canvas));
  const result = await run('edit_canvas', { path: 'Map.canvas', operations: [{ op: 'update_node', id: 'a1', text: 'New' }] });
  assert.equal(result.isError, false, result.result);
  assert.deepEqual(result.focus, { path: 'Map.canvas', nodes: ['a1'] });
});

test('showInView: one reused tab with the search-match state; a note already open is shown where it is', async () => {
  const files = new Map([['A.md', 'alpha beta'], ['B.md', 'gamma'], ['C.canvas', '{}']]);
  const app = { vault: {}, workspace: {} };
  const { leaves, newLeaf, revealed } = workspace(app, files);

  await showInView(app, { path: 'A.md', from: 6, to: 10 });
  assert.equal(leaves.length, 1);
  assert.deepEqual(leaves[0].opened[0], { path: 'A.md', state: { active: false, eState: { match: { content: 'alpha beta', matches: [[6, 10]] } } } });
  assert.equal(revealed.length, 1);

  // Another note: the same follow tab.
  await showInView(app, { path: 'B.md', from: 0, to: 5 });
  assert.equal(leaves.length, 1);
  assert.equal(leaves[0].opened[1].path, 'B.md');

  // A note the user has open in their own tab: shown there, no new tab.
  const own = newLeaf();
  own.view = { file: { path: 'A.md' } };
  await showInView(app, { path: 'A.md', from: 0, to: 5 });
  assert.deepEqual(own.states, [{ match: { content: 'alpha beta', matches: [[0, 5]] } }]);
  assert.equal(leaves.length, 2);

  // A canvas card: Obsidian's canvas match selects it and pans to it.
  await showInView(app, { path: 'C.canvas', nodes: ['n1'] });
  assert.deepEqual(leaves[0].opened.at(-1).state.eState, { match: { nodeId: 'n1', content: '', matches: [] } });
  assert.equal(await showInView(app, { path: 'Missing.md' }), false);
});

test('Canvas: the view centers the cards and zooms out only when they do not fit, never in', () => {
  const box = { minX: 100, minY: 0, maxX: 300, maxY: 100 };
  // Fits at 100 % (zoom 0): centered, zoom kept.
  assert.deepEqual(viewportFor(box, 800, 600, 0), { x: 200, y: 50, zoom: 0 });
  // Already zoomed out further: stays (no zooming in).
  assert.deepEqual(viewportFor(box, 800, 600, -2), { x: 200, y: 50, zoom: -2 });
  // Too wide for 400 px at 100 %: zooms out to fit with a 10 % margin.
  const wide = viewportFor({ minX: 0, minY: 0, maxX: 2000, maxY: 100 }, 400, 600, 0);
  assert.equal(wide.x, 1000);
  assert.ok(Math.abs(wide.zoom - Math.log2(400 / 2200)) < 1e-9);
});

test('Canvas: all changed cards are selected and centered (the canvas view API is checked first)', async () => {
  const files = new Map([['Map.canvas', '{}']]);
  const app = { vault: {}, workspace: {} };
  const { leaves } = workspace(app, files);
  const card = (minX, minY) => ({ getBBox: () => ({ minX, minY, maxX: minX + 200, maxY: minY + 100 }) });
  const cards = new Map([['a', card(0, 0)], ['b', card(400, 300)], ['c', card(900, 900)]]);
  const canvas = { nodes: cards, selection: new Set(), updateSelection(fn) { fn(); }, canvasRect: { width: 1200, height: 900 },
    tx: 0, ty: 0, tZoom: 0, zoomCenter: 'x', markViewportChanged() { canvas.changed = true; } };
  await showInView(app, { path: 'Map.canvas', nodes: ['a', 'b'] });
  // The tab got the canvas; give its view the canvas and show again.
  leaves[0].view.canvas = canvas;
  await showInView(app, { path: 'Map.canvas', nodes: ['a', 'b'] });
  assert.deepEqual([...canvas.selection], [cards.get('a'), cards.get('b')]);
  assert.deepEqual([canvas.tx, canvas.ty, canvas.tZoom, canvas.zoomCenter, canvas.changed], [300, 200, 0, null, true]);

  // Without the internal canvas API nothing breaks: the match state alone is used.
  leaves[0].view.canvas = { nodes: 'not a map' };
  assert.equal(await showInView(app, { path: 'Map.canvas', nodes: ['a'] }), true);
});

test('The follow tab closes with the plugin, and one left from the last session at the next start', async () => {
  const files = new Map([['A.md', 'alpha']]);
  const app = { vault: {}, workspace: {} };
  const { leaves } = workspace(app, files);
  const storage = new Map();
  app.saveLocalStorage = (key, value) => (value === null ? storage.delete(key) : storage.set(key, value));
  app.loadLocalStorage = (key) => storage.get(key) ?? null;
  app.workspace.getLeafById = (id) => leaves.find((leaf) => leaf.id === id) ?? null;
  const detached = [];
  const withIds = () => leaves.forEach((leaf, i) => { leaf.id ??= `leaf-${i}`; leaf.detach = () => { detached.push(leaf.id); leaves.splice(leaves.indexOf(leaf), 1); }; });

  // Closing Obsidian: the open follow tab goes.
  const origGetLeaf = app.workspace.getLeaf;
  app.workspace.getLeaf = () => { const leaf = origGetLeaf(); withIds(); return leaf; };
  await showInView(app, { path: 'A.md', from: 0, to: 5 });
  assert.equal(storage.get('chatting-with-ai-follow-tab'), 'leaf-0');
  closeFollowTab(app);
  assert.deepEqual(detached, ['leaf-0']);
  // The ID stays: the layout may have been saved with the tab.
  assert.equal(storage.get('chatting-with-ai-follow-tab'), 'leaf-0');

  // Next start: the tab came back with the layout, known only by its saved ID.
  const left = origGetLeaf();
  left.id = 'leaf-0';
  left.detach = () => { detached.push('restored'); leaves.splice(leaves.indexOf(left), 1); };
  closeLeftoverFollowTab(app);
  assert.deepEqual(detached, ['leaf-0', 'restored']);
  assert.equal(storage.size, 0);
  // Nothing saved: nothing closes.
  closeLeftoverFollowTab(app);
  assert.equal(detached.length, 2);
});

test('open_document shows the text the user asked for (and brings it forward), or the top when not found', async () => {
  const files = new Map([['Trip.md', '# Lisbon\n## Packing\n- shoes'], ['Map.canvas', '{}']]);
  const app = { vault: {}, workspace: {} };
  const { leaves, revealed } = workspace(app, files);
  const run = (input) => api.executeTool(app, 'open_document', input, async () => 'yes');
  assert.equal((await run({ path: 'Trip.md', text: '## packing' })).result, 'Showed Trip.md at the text.');
  assert.deepEqual(leaves[0].opened[0].state.eState.match.matches, [[9, 19]]);
  assert.equal(revealed.length, 1);
  assert.match((await run({ path: 'Trip.md', text: 'nowhere' })).result, /wasn't found/);
  // A canvas card, in the same tab: no new tab for each request.
  assert.equal((await run({ path: 'Map.canvas', node_id: 'n1' })).result, 'Showed Map.canvas at card n1.');
  assert.equal(leaves.length, 1);
  assert.deepEqual(leaves[0].opened.at(-1).state.eState, { match: { nodeId: 'n1', content: '', matches: [] } });
});

/** A chat view with a fake component (as in message-actions.test.mjs). */
function chatView(followEdits) {
  const { app, files } = vaultApp();
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...settings('anthropic'), followEdits };
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  plugin.chatHistory = [];
  plugin.saveChatHistory = async () => {};
  const view = new api.ObsidianChatView({}, plugin);
  let nextId = 0;
  view.chatContainer = {
    addUserMessage() {}, addAssistantMessage: () => nextId++, updateAssistantMessage() {}, removeMessage() {}, addError() {}, showThinking() {}, hideThinking() {},
    addToolCall: () => nextId++, updateToolResult() {}, setInputEnabled() {}, setBusy() {}, foldTurn() {}, focus() {}, setTitle() {}, addChanges() {},
  };
  return { app, files, plugin, view };
}

test('The chat follows an edit when the setting is on, not when it is off; the saved card has no range', async () => {
  for (const followEdits of [true, false]) {
    const { view, plugin, app, files } = chatView(followEdits);
    const { leaves } = workspace(app, files);
    transport((body, index) => index === 0
      ? response('anthropic', [call('e1', 'edit_document', { path: 'Untitled.md', operation: 'find_replace', find: 'Original', content: 'Changed' })], 'tool_use')
      : response('anthropic', [text('Done.')]));
    await view.handleUserMessage('Change it', null);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(files.get('Untitled.md'), 'Changed');
    assert.equal(leaves.length, followEdits ? 1 : 0, `followEdits ${followEdits}`);
    if (followEdits) assert.deepEqual(leaves[0].opened[0].state.eState.match.matches, [[0, 7]]);
    const card = plugin.chatHistory.find((e) => e.type === 'tool-result');
    assert.equal('focus' in card.toolResult, false);
  }
});

test('The setting: on by default, kept in data.json, in both settings paths; the eye button switches it', async () => {
  const loaded = async (saved) => {
    const plugin = new api.ChatPlugin();
    plugin.loadData = async () => ({ ...settings('openai'), ...saved });
    plugin.loadApiKey = () => '';
    await plugin.loadSettings();
    return plugin;
  };
  assert.equal((await loaded({})).settings.followEdits, true);
  assert.equal((await loaded({ followEdits: false })).settings.followEdits, false);
  assert.equal((await loaded({ followEdits: 'no' })).settings.followEdits, true);

  // A settings row that records its toggle.
  const row = () => {
    const r = { setName() { return r; }, setDesc() { return r; } };
    r.addToggle = fn => { const t = { setValue(v) { r.value = v; return t; }, onChange(f) { r.change = f; return t; } }; fn(t); return r; };
    return r;
  };
  const plugin = { settings: { ...settings('openai'), followEdits: true }, saves: 0, async saveSettings() { plugin.saves++; } };
  const tab = new api.ChatSettingTab(settingsApp, plugin);
  // Obsidian 1.13+: a definition of its own.
  const r = row();
  tab.getSettingDefinitions().find(d => d.name === "Follow the AI's edits").render(r);
  assert.equal(r.value, true);
  await r.change(false);
  assert.equal(plugin.settings.followEdits, false);
  assert.equal(plugin.saves, 1);
  // Older Obsidian: display() draws it (the other rows are left out here).
  const drawn = [];
  const ignore = () => {};
  Object.assign(tab, { containerEl: { empty: ignore }, renderProvider: ignore, renderApiKeySection: ignore, renderModelSection: ignore,
    renderWebSearch: ignore, renderEnterSends: ignore, renderInstructions: ignore, renderSkills: ignore, renderMaxIterations: ignore, renderMcpServers: ignore, renderDebugLog: ignore, loadCatalog: async () => {}, renderFollowEdits: setting => drawn.push(setting) });
  tab.display();
  assert.equal(drawn.length, 1);

  // The eye button: switches the setting and saves it; the button shows it.
  const { app } = vaultApp();
  const chatPlugin = await loaded({});
  const view = new api.ObsidianChatView({}, chatPlugin);
  const chat = { setEnterSends() {}, setFollowEdits(value) { chat.followEdits = value; }, setModel() {} };
  view.chatContainer = chat;
  chatPlugin.app = { ...app, workspace: { getLeavesOfType: () => [{ view }] } };
  const saved = [];
  chatPlugin.saveData = async (data) => { saved.push(data.followEdits); };
  await view.toggleFollow();
  assert.deepEqual([chatPlugin.settings.followEdits, saved, chat.followEdits], [false, [false], false]);
});
