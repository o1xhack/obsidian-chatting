// chat-state.json holds each attached image once, in the API history; the
// visible history keeps the image's ID, name, type and size and is filled
// from the API history on load, or shows a chip with the name when the API
// history no longer holds it. Older saved chats are migrated once.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, response, transport, vaultApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
});

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    addUserMessage(value, images = [], turnId, selection) { chat.shown.push({ id: nextId++, type: 'user', text: value, images, turnId, selection }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId); if (index >= 0) chat.shown.splice(index); },
    addToolCall(name) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name }); return nextId++; },
    updateToolResult() {},
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {}, setInputEnabled() {}, setBusy() {}, foldTurn() {},
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {}, setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin that loads `saved` as its chat-state.json (none when undefined),
// records what it writes there, and has a chat view with a fake component.
async function setup(saved) {
  const { app } = vaultApp();
  const writes = [];
  app.vault.adapter = {
    append: async () => {},
    read: async path => { if (!saved || !path.endsWith('/chat-state.json')) throw new Error('ENOENT'); return JSON.stringify(saved); },
    exists: async () => !!saved,
    write: async (path, data) => { if (path.endsWith('/chat-state.json')) writes.push(JSON.parse(data)); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  view.chatContainer = fakeChat();
  return { plugin, view, writes };
}

const picture = (id, data) => ({ id, fileName: `${id}.png`, mediaType: 'image/png', data, sizeBytes: data.length });
const one = picture('one', `ONE${'x'.repeat(500)}`);
const two = picture('two', `TWO${'y'.repeat(500)}`);
const count = (haystack, needle) => haystack.split(needle).length - 1;
const answering = () => transport((body, index) => response('anthropic', [text(`A${index + 1}`)]));
// The image blocks of the Anthropic request's last user message.
const sentImages = body => body.messages.at(-1).content.filter?.(block => block.type === 'image') ?? [];
const userImages = plugin => plugin.chatHistory.filter(e => e.type === 'user').map(e => e.images ?? []);

test('The saved chat holds each image\'s data once, in the API history', async () => {
  const { plugin, view, writes } = await setup();
  answering();
  await view.handleUserMessage('Look at these', null, [one, two]);
  const saved = writes.at(-1);
  const json = JSON.stringify(saved);
  assert.equal(saved.version, api.chatState.CHAT_STATE_VERSION);
  assert.equal(typeof saved.savedAt, 'number');
  assert.equal(count(json, one.data), 1);
  assert.equal(count(json, two.data), 1);
  assert.deepEqual(saved.conversations[0].chatHistory.find(e => e.type === 'user').images, [
    { id: 'one', fileName: 'one.png', mediaType: 'image/png', sizeBytes: one.sizeBytes },
    { id: 'two', fileName: 'two.png', mediaType: 'image/png', sizeBytes: two.sizeBytes },
  ]);
  // In memory the view keeps showing the images.
  assert.equal(plugin.chatHistory[0].images[0].data, one.data);
});

test('After a reload the images are shown again and regenerate sends them', async () => {
  const first = await setup();
  answering();
  await first.view.handleUserMessage('Look at these', null, [one, two]);
  const { view, plugin } = await setup(first.writes.at(-1));
  assert.deepEqual(userImages(plugin)[0].map(image => image.data), [one.data, two.data]);

  const requests = answering();
  await view.regenerate();
  assert.deepEqual(sentImages(requests[0]).map(block => block.source.data), [one.data, two.data]);
});

test('An image the API history no longer holds shows as its name; its turn can\'t be edited', async () => {
  // The first turn was trimmed from the API history.
  const saved = {
    version: 2,
    chatHistory: [
      { type: 'user', text: 'Old picture', turnId: 't1', images: [{ id: 'one', fileName: 'one.png', mediaType: 'image/png', sizeBytes: 3 }] },
      { type: 'assistant', text: 'Old answer' },
      { type: 'user', text: 'Recent', turnId: 't2' },
      { type: 'assistant', text: 'New answer' },
    ],
    agentMessages: [{ role: 'user', content: 'ctx\n\nRecent', turnId: 't2' }, { role: 'assistant', content: [text('New answer')] }],
  };
  const { view, plugin } = await setup(saved);
  const [placeholder] = userImages(plugin)[0];
  assert.equal(placeholder.fileName, 'one.png');
  assert.equal(placeholder.data, '');

  // The model no longer has that turn: an edit does nothing, nothing is sent.
  const requests = answering();
  await view.editMessage('t1', 'Old picture, again');
  assert.equal(requests.length, 0);
  assert.equal(plugin.chatHistory.length, 4);
});

test('A chat saved without a version is migrated once: turn IDs, image data only in the API history', async () => {
  const legacy = {
    savedAt: 1,
    chatHistory: [
      { type: 'user', text: 'Trimmed', images: [two] }, { type: 'assistant', text: 'A0' },
      { type: 'user', text: 'With image', images: [one] }, { type: 'assistant', text: 'A1' },
    ],
    agentMessages: [
      { role: 'user', content: [{ type: 'image', image: one }, text('ctx\n\nWith image')] },
      { role: 'assistant', content: [text('A1')] },
    ],
  };
  const { plugin, writes } = await setup(legacy);
  const [trimmed, kept] = userImages(plugin);
  assert.equal(kept[0].data, one.data);
  // Only in the old visible history: shown this session, not saved again.
  assert.equal(trimmed[0].data, two.data);
  assert.deepEqual(plugin.chatHistory.filter(e => e.type === 'user').map(e => e.turnId), ['legacy-2', 'legacy-1']);
  assert.equal(plugin.agent.exportMessages()[0].turnId, 'legacy-1');

  await plugin.saveChatHistory();
  const json = JSON.stringify(writes.at(-1));
  assert.equal(writes.at(-1).version, api.chatState.CHAT_STATE_VERSION);
  assert.equal(count(json, one.data), 1);
  assert.equal(count(json, two.data), 0);
});

test('A chat in the current format is taken as it is; an unknown older version is no saved chat', () => {
  const chatHistory = [{ type: 'user', text: 'Q', images: [one] }];
  const current = { version: api.chatState.CHAT_STATE_VERSION, activeConversationId: 'c1', conversations: [{ id: 'c1', title: 'Q', customTitle: false, createdAt: 1, updatedAt: 1, chatHistory, agentMessages: [] }] };
  assert.deepEqual(api.chatState.migrateChatState(current).conversations[0].chatHistory, chatHistory);
  assert.equal(api.chatState.migrateChatState({ version: 0, chatHistory: [] }), null);
  assert.equal(api.chatState.migrateChatState([]), null);
});

test('A chat saved by a newer version is kept aside, not read or overwritten', async () => {
  const newer = { version: api.chatState.CHAT_STATE_VERSION + 1, savedAt: 1, conversations: [{ id: 'c1', chatHistory: [{ type: 'user', text: 'Later' }] }] };
  for (const keepFails of [false, true]) {
    globalThis.__notices = [];
    const { app } = vaultApp();
    const writes = [];
    app.vault.adapter = {
      read: async path => { if (!path.endsWith('/chat-state.json')) throw new Error('ENOENT'); return JSON.stringify(newer); },
      exists: async () => true,
      write: async (path, data) => { if (keepFails && !path.endsWith('/chat-state.json')) throw new Error('EACCES'); writes.push([path, JSON.parse(data)]); },
    };
    const plugin = new api.ChatPlugin();
    plugin.app = app;
    plugin.agent = new api.AgentLoop(app, settings('anthropic'));
    await plugin.loadChatHistory();
    assert.deepEqual(plugin.chatHistory, []);
    assert.equal(globalThis.__notices.length, 1);
    if (keepFails) {
      assert.match(globalThis.__notices[0], /newer version.*isn't saved until Obsidian restarts/);
    } else {
      assert.equal(writes.length, 1);
      assert.match(writes[0][0], /\/chat-state\.v\d+-\d+\.json$/);
      assert.ok(writes[0][0].includes(`.v${newer.version}-`));
      assert.deepEqual(writes[0][1], newer);
      assert.match(globalThis.__notices[0], /newer version.*chat-state\.v\d+-\d+\.json/);
    }
    // The empty chat is saved over it only after the copy was kept.
    writes.length = 0;
    plugin.chatHistory.push({ type: 'user', text: 'New' });
    await plugin.saveChatHistory();
    assert.equal(writes.some(([path]) => path.endsWith('/chat-state.json')), !keepFails);
  }
});
