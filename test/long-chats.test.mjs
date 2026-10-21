// Long chats: the compaction point setting (in both settings paths), turns
// before the last compaction locked, and the chat showing its last turns and
// loading the earlier ones. Saving per chat is in conversations.test.mjs.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, sse, streamEvents, text, transport, withCatalog, settings, settingsApp, vaultApp, callbacks, chatFiles } from './harness.mjs';

test('A voice page boundary includes its context but keeps unrelated earlier replies on the previous page', () => {
  const history = [
    { type: 'user', text: 'Earlier', turnId: 'old' }, { type: 'assistant', text: 'Which?' },
    { type: 'user', text: 'An unrelated ask_user reply' },
    { type: 'user', text: 'Voice context', voiceContextFor: 'voice' },
    { type: 'user', text: 'Do it', turnId: 'voice', voiceContext: [] }, { type: 'assistant', text: 'Done' },
    { type: 'user', text: 'Latest', turnId: 'latest' }, { type: 'assistant', text: 'Answer' },
  ];
  assert.equal(api.pageStart(history, history.length, 2), 3);
  assert.equal(api.pageStart(history, 3, 2), 0);
});

test('Paging a long chat keeps voice context with its boundary turn without duplicating it on load earlier', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  const history = [];
  for (let i = 0; i < 25; i++) {
    if (i === 5) history.push({ type: 'user', text: 'Context A', voiceContextFor: 't5' }, { type: 'user', text: 'Context B', voiceContextFor: 't5' });
    history.push({ type: 'user', text: `Q${i}`, turnId: `t${i}` }, { type: 'assistant', text: `A${i}` });
  }
  plugin.chatHistory = history; view.renderHistory();
  assert.deepEqual(chat.shown.slice(0, 3).map(row => row.text), ['Context A', 'Context B', 'Q5']);
  assert.equal(chat.shown.filter(row => row.type === 'user' && row.turnId).length, 20);
  view.loadEarlier();
  assert.deepEqual(chat.shown.map(row => row.text), history.map(row => row.text));
  assert.equal(chat.shown.filter(row => row.text === 'Context A').length, 1);
  assert.equal(chat.hasEarlier, false);
});

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  globalThis.__notices = [];
});

const { compactThreshold, MIN_COMPACT_TOKENS } = api.compaction;
const model = (window, extra = {}) => ({ value: 'm', label: 'M', contextWindow: window, ...extra });

// An element: children, classes, CSS properties and event listeners recorded.
function element(props = {}) {
  const el = {
    ...props, children: [], classes: [], cssProps: {}, listeners: {},
    addClass(cls) { el.classes.push(cls); },
    setCssProps(values) { Object.assign(el.cssProps, values); },
    addEventListener(type, listener) { el.listeners[type] = listener; },
    createDiv(options = {}) { const child = element(options); el.children.push(child); return child; },
    createSpan(options = {}) { return el.createDiv(options); },
  };
  return el;
}

// A settings row: its name and description, the control element and the text field.
function row() {
  const r = { controlEl: element(), setName(name) { r.name = name; return r; }, setDesc(desc) { r.desc = desc; return r; } };
  r.addText = fn => {
    const t = { inputEl: element(), setPlaceholder(p) { t.placeholder = p; return t; }, setValue(v) { t.value = v; return t; }, getValue() { return t.value ?? ''; } };
    r.field = t;
    fn(t);
    return r;
  };
  return r;
}

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [], folded: [], hasEarlier: false,
    addUserMessage(value, images = [], turnId) { chat.shown.push({ id: nextId++, type: 'user', text: value, turnId }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId); if (index >= 0) chat.shown.splice(index); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value, errorKind) { chat.shown.push({ id: nextId++, type: 'error', text: value, errorKind }); },
    showThinking() {}, hideThinking() {}, showAskUser: () => new Promise(() => {}), cancelAskUser() {},
    setInputEnabled() {}, setBusy() {}, updateConversations() {}, setContinue() {}, setQueued() {},
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {}, setSelection() {}, getSelection: () => null,
    foldTurn(turnId) { chat.folded.push(turnId); },
    editable: () => true, setEditable(check) { chat.editable = check; },
    setHasEarlier(value) { chat.hasEarlier = value; },
    prependMessages(fill) { const shown = chat.shown; chat.shown = []; fill(); chat.shown = [...chat.shown, ...shown]; },
  };
  return chat;
}

// A plugin without saved chats, and a chat view with a fake component.
async function chatSetup(provider) {
  const { app } = vaultApp();
  app.vault.adapter = chatFiles().adapter;
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...plugin.settings, ...settings(provider) };
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { plugin, view, chat };
}

test('The compaction point: the default, a share of the window, 50k at least, a token number without a window', () => {
  // Default: 80 % (ChatGPT: its catalog's point; Anthropic: 50k at least).
  assert.equal(compactThreshold('openai', model(400000)), 320000);
  assert.equal(compactThreshold('chatgpt-oauth', model(380000, { autoCompactTokens: 300000 })), 300000);
  assert.equal(compactThreshold('anthropic', model(50000)), 50000);
  // A share of the window, kept across models.
  assert.equal(compactThreshold('openai', model(400000), { compactPercent: 25 }), 100000);
  assert.equal(compactThreshold('openai', model(1000000), { compactPercent: 25 }), 250000);
  assert.equal(compactThreshold('chatgpt-oauth', model(380000, { autoCompactTokens: 300000 }), { compactPercent: 100 }), 380000);
  // Not below 50k, or the default where that is lower.
  assert.equal(compactThreshold('openai', model(128000), { compactPercent: 1 }), MIN_COMPACT_TOKENS);
  assert.equal(compactThreshold('openai', model(40000), { compactPercent: 1 }), 32000);
  // Unknown window: the token number, else nothing.
  assert.equal(compactThreshold('openai', undefined, { compactPercent: 30, compactTokens: 90000 }), 90000);
  assert.equal(compactThreshold('openai', model(undefined), { compactTokens: 90000 }), 90000);
  assert.equal(compactThreshold('openai', undefined), undefined);
  // Anthropic's trigger is never below its minimum.
  assert.equal(compactThreshold('anthropic', undefined, { compactTokens: 20000 }), 50000);
});

test('Token numbers as typed: plain, grouped, k and M', () => {
  assert.equal(api.parseTokens('160000'), 160000);
  assert.equal(api.parseTokens(' 160 000 '), 160000);
  assert.equal(api.parseTokens('160,000'), 160000);
  assert.equal(api.parseTokens('160k'), 160000);
  assert.equal(api.parseTokens('1.2M'), 1200000);
  assert.equal(api.parseTokens(''), null);
  assert.equal(api.parseTokens('lots'), null);
  assert.equal(api.parseTokens('0'), null);
});

test('Settings load: the compaction point is kept when valid, else the default', async () => {
  const load = async (data) => {
    const plugin = new api.ChatPlugin();
    plugin.app = { secretStorage: { getSecret: () => '' } };
    plugin.loadData = async () => data;
    await plugin.loadSettings();
    return [plugin.settings.compactPercent, plugin.settings.compactTokens];
  };
  assert.deepEqual(await load(null), [null, null]);
  assert.deepEqual(await load({ compactPercent: 40, compactTokens: 90000.7 }), [40, 90000]);
  assert.deepEqual(await load({ compactPercent: 250 }), [100, null]);
  assert.deepEqual(await load({ compactPercent: -5, compactTokens: 'many' }), [null, null]);
});

test('The setting: a slider from 50k to 100 % with its marks, the point in tokens next to it; requests use it', async () => {
  const loopSettings = await withCatalog('openai', [{ value: 'gpt-5.5', label: 'gpt-5.5', contextWindow: 400000, detailsCheckedAt: Date.now() }]);
  // The model list as the settings tab reads it.
  api.cachedCatalog(loopSettings.modelCatalog, 'openai', await api.catalogIdentity('openai', 'fake-test-key'));
  const plugin = new api.ChatPlugin();
  plugin.settings = { ...plugin.settings, ...loopSettings };
  let saves = 0;
  plugin.saveSettings = async () => { saves++; };
  const tab = new api.ChatSettingTab(settingsApp, plugin);
  const render = () => {
    const r = row();
    tab.getSettingDefinitions().find(d => d.heading === 'Chats').items.find(d => d.name === 'Compaction point').render(r);
    return r;
  };
  let r = render();
  assert.equal(r.name, 'Compaction point');
  const box = r.controlEl.children[0];
  const slider = box.slider;
  // 50k of 400k is 12.5 %: the slider starts at 13.
  assert.deepEqual(slider.limits, [13, 100, 1]);
  assert.equal(slider.value, 80);
  // The default above the slider, start and end below it.
  const [above, below] = box.children;
  assert.deepEqual(above.children.map(mark => mark.text), ['Default: 80 % · 320k']);
  assert.deepEqual(below.children.map(mark => mark.text), ['50k', '100 % · 400k']);
  assert.equal(above.children[0].cssProps['--ochatting-mark-at'], `${(80 - 13) / 87 * 100}%`);
  const field = r.field;
  assert.equal(field.value, '320000');
  assert.match(r.desc, /Now 320k of 400k tokens \(80 %, the default\)/);

  await slider.change(25);
  assert.equal(plugin.settings.compactPercent, 25);
  assert.equal(field.value, '100000');
  assert.match(r.desc, /Now 100k of 400k tokens \(25 %\)/);
  // Back on the mark: the default again.
  await slider.change(80);
  assert.equal(plugin.settings.compactPercent, null);
  // The field: a token number moves the slider.
  field.value = '200k';
  await field.inputEl.listeners.change();
  assert.equal(plugin.settings.compactPercent, 50);
  assert.equal(slider.value, 50);
  assert.equal(saves, 3);

  const requests = transport(() => sse(streamEvents('openai', [text('ok')])));
  await new api.AgentLoop(vaultApp().app, plugin.settings).run('Q', callbacks());
  assert.deepEqual(requests[0].context_management, [{ type: 'compaction', compact_threshold: 200000 }]);

  // A model whose window is unknown: no slider, the field sets tokens.
  plugin.settings.model = 'custom-model';
  r = render();
  assert.equal(r.controlEl.children.length, 0);
  assert.match(r.desc, /context size is unknown/);
  r.field.value = '90 000';
  await r.field.inputEl.listeners.change();
  assert.equal(plugin.settings.compactTokens, 90000);
  assert.equal(plugin.settings.compactPercent, 50);
});

test('Settings: the Chats group in both settings paths; Saved chats counts the chats and their size', async () => {
  const plugin = new api.ChatPlugin();
  plugin.settings = { ...plugin.settings, ...settings('anthropic') };
  plugin.conversations = [
    { ...api.chatState.newConversation(1), size: 1536 },
    { ...api.chatState.newConversation(2), size: 512 },
    api.chatState.newConversation(3),
  ];
  const tab = new api.ChatSettingTab(settingsApp, plugin);
  // Obsidian 1.13+: a group of its own.
  const group = tab.getSettingDefinitions().find(d => d.heading === 'Chats');
  assert.equal(group.type, 'group');
  assert.deepEqual(group.items.map(d => d.name), ['Compaction point', 'Saved chats']);
  const saved = row();
  group.items[1].render(saved);
  assert.equal(saved.name, 'Saved chats');
  assert.match(saved.desc, /^2 chats, 2(\.0)? KB, in the plugin's chats folder\. A chat over 5 MB shows its size in the chat list/);

  // Older Obsidian: display() draws the heading and both rows (the other rows are left out here).
  const drawn = [];
  const ignore = () => {};
  Object.assign(tab, { containerEl: { empty: ignore }, renderProvider: ignore, renderApiKeySection: ignore, renderModelSection: ignore,
    renderWebSearch: ignore, renderEnterSends: ignore, renderFollowEdits: ignore, renderInstructions: ignore, renderSkills: ignore, renderMaxIterations: ignore,
    renderVoice: ignore, renderMcpServers: ignore, renderDebugLog: ignore, loadCatalog: async () => {},
    renderCompactionPoint: setting => drawn.push(['point', setting]), renderSavedChats: setting => drawn.push(['saved', setting]) });
  tab.display();
  assert.deepEqual(drawn.map(([what]) => what), ['point', 'saved']);
});

/** An Anthropic answer that compacted first: its compaction block, then the text. */
function compactedAnthropicAnswer(summary, answer) {
  const events = streamEvents('anthropic', [text(answer)]);
  for (const event of events) if (typeof event.index === 'number') event.index += 1;
  events.splice(1, 0,
    { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'compaction_delta', content: summary } },
    { type: 'content_block_stop', index: 0 });
  return sse(events);
}

test('After a compaction the turns before it lose their pencil and Regenerate; editing them does nothing', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  Object.assign(plugin.settings, await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, compaction: true }]));
  const requests = transport((body, index) => index === 1 ? compactedAnthropicAnswer('Earlier', 'A2') : sse(streamEvents('anthropic', [text(`A${index + 1}`)])));
  for (const question of ['Q1', 'Q2', 'Q3']) await view.handleUserMessage(question, null);
  const [t1, t2, t3] = plugin.chatHistory.filter(e => e.type === 'user').map(e => e.turnId);
  // Q2's request compacted: Q1 and Q2 are in the summary.
  assert.deepEqual([t1, t2, t3].map(id => chat.editable(id)), [false, false, true]);
  view.renderHistory();
  assert.deepEqual([t1, t2, t3].map(id => chat.editable(id)), [false, false, true]);
  await view.editMessage(t1, 'Q1 edited');
  assert.equal(requests.length, 3);
  assert.deepEqual(plugin.chatHistory.filter(e => e.type === 'user').map(e => e.text), ['Q1', 'Q2', 'Q3']);
  // The turn after it still can.
  await view.editMessage(t3, 'Q3 edited');
  assert.equal(requests.length, 4);
});

test('A long chat shows its last 20 turns; scrolled near the top, the 20 before them come in above', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  for (let i = 0; i < 45; i++) {
    plugin.chatHistory.push(
      { type: 'user', text: `Q${i}`, turnId: `t${i}` },
      { type: 'tool-result', toolName: 'read_file', toolInput: { path: `N${i}.md` }, toolResult: { result: 'x', isError: false } },
      { type: 'assistant', text: `A${i}` },
    );
  }
  const questions = () => chat.shown.filter(m => m.type === 'user').map(m => m.text);
  view.renderHistory();
  assert.deepEqual(questions(), Array.from({ length: 20 }, (_, i) => `Q${i + 25}`));
  assert.equal(chat.hasEarlier, true);
  assert.deepEqual(chat.folded, Array.from({ length: 20 }, (_, i) => `t${i + 25}`));

  chat.folded = [];
  view.loadEarlier();
  assert.deepEqual(questions(), Array.from({ length: 40 }, (_, i) => `Q${i + 5}`));
  assert.equal(chat.hasEarlier, true);
  assert.deepEqual(chat.folded, Array.from({ length: 20 }, (_, i) => `t${i + 5}`));
  view.loadEarlier();
  assert.deepEqual(questions(), Array.from({ length: 45 }, (_, i) => `Q${i}`));
  assert.equal(chat.hasEarlier, false);
  view.loadEarlier();
  assert.equal(questions().length, 45);

  // Shown anew (a new turn, a switch): the last 20 again.
  view.renderHistory();
  assert.equal(questions().length, 20);
});

test('Where a page of turns starts', () => {
  const entries = (...types) => types.map((type, index) => ({ type, ...(type === "user" ? { turnId: `t${index}` } : {}) }));
  const history = entries('error', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant');
  assert.equal(api.pageStart(history, history.length, 2), 3);
  assert.equal(api.pageStart(history, 3, 2), 0);
  assert.equal(api.pageStart(history, history.length, 3), 0);
  assert.equal(api.pageStart([], 0), 0);
  assert.equal(api.PAGE_TURNS, 20);
});

test('Paging counts complete turn starts rather than ask_user answers or steering rows', async () => {
  const history = Array.from({ length: 60 }, (_, i) => [
    { type: 'user', text: `Original question ${i}`, turnId: `t${i}` },
    { type: 'assistant', text: 'A clarifying question' },
    { type: 'user', text: `ask_user answer ${i}` },
    { type: 'user', text: `steering ${i}` },
    { type: 'assistant', text: `Final answer ${i}` },
  ]).flat();
  assert.equal(api.pageStart(history, history.length), 40 * 5);
  assert.equal(api.pageStart(history, 40 * 5), 20 * 5);
  assert.equal(api.pageStart(history, 20 * 5), 0);
  const { plugin, view, chat } = await chatSetup('anthropic');
  plugin.chatHistory = history;
  view.showConversation();
  assert.equal(chat.shown.filter(row => row.type === 'user' && row.turnId).length, 20);
  assert.equal(chat.shown.find(row => row.type === 'user').text, 'Original question 40');
  assert.ok(chat.shown.some(row => row.text === 'ask_user answer 40'));
  assert.ok(chat.shown.some(row => row.text === 'Final answer 59'));
  view.loadEarlier();
  assert.equal(chat.shown.find(row => row.type === 'user').text, 'Original question 20');
  assert.equal(chat.shown.filter(row => row.type === 'user' && row.turnId).length, 40);
});
