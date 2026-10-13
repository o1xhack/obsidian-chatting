// Saving the chat (chat-state.json): nothing is saved before the saved chat
// was read, every save writes two copies and loading takes the newer whole
// one, an unreadable file is kept aside instead of overwritten, and saves
// never overlap.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, bundled, settings, vaultApp } from './harness.mjs';

beforeEach(() => {
  globalThis.__notices = [];
});

const DIR = '.obsidian/plugins/chatting-with-ai';
const STATE = `${DIR}/chat-state.json`;
const NEXT = `${DIR}/chat-state.next.json`;
const LEGACY = '.obsidian/plugins/obsidian-chatting/chat-state.json';
const tick = () => new Promise(resolve => setTimeout(resolve, 2));

// A saved chat with one user message `text`.
const savedState = (text, savedAt) => JSON.stringify({
  ...(savedAt === undefined ? {} : { savedAt }),
  chatHistory: [{ type: 'user', text }],
  agentMessages: [{ role: 'user', content: text }],
});

function pluginOn(adapter) {
  const { app } = vaultApp();
  app.vault.adapter = adapter;
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  return plugin;
}

// A plugin that loaded from chat-state.json holding `content` (undefined: no
// file), on an in-memory adapter like Obsidian's: write replaces a file's
// content, rename refuses an existing destination. Records writes and renames.
async function loadFrom(content, { renameFails = false, next, legacy } = {}) {
  const files = new Map();
  if (content !== undefined) files.set(STATE, content);
  if (next !== undefined) files.set(NEXT, next);
  if (legacy !== undefined) files.set(LEGACY, legacy);
  const writes = [], renames = [];
  const plugin = pluginOn({
    read: async (path) => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path); },
    exists: async (path) => files.has(path),
    write: async (path, data) => { if (path === STATE) writes.push(JSON.parse(data)); files.set(path, data); },
    rename: async (from, to) => {
      if (renameFails) throw new Error('EBUSY');
      if (files.has(to)) throw new Error('Destination file already exists!');
      renames.push([from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
  });
  await plugin.loadChatHistory();
  return { plugin, files, writes, renames };
}

const texts = plugin => plugin.chatHistory.map(entry => entry.text);
// The texts of the (only) conversation in a written chat-state.json.
const savedTexts = state => state.conversations[0].chatHistory.map(entry => entry.text);

test('Nothing is saved before the saved chat has been read', async () => {
  const writes = [];
  let finishRead;
  const plugin = pluginOn({
    read: path => path === STATE ? new Promise(resolve => { finishRead = resolve; }) : Promise.reject(new Error('ENOENT')),
    exists: async () => true,
    write: async (path, data) => { if (path === STATE) writes.push(JSON.parse(data)); },
  });
  const loading = plugin.loadChatHistory();
  // Obsidian unloads the plugin while it is still starting.
  plugin.onunload();
  await plugin.saveChatHistory();
  assert.deepEqual(writes, []);

  finishRead(savedState('Saved before'));
  await loading;
  assert.deepEqual(texts(plugin), ['Saved before']);
  await plugin.saveChatHistory();
  // This instance has been unloaded; late callbacks must remain unable
  // to save after a replacement plugin has started.
  assert.equal(writes.length, 0);
});

test('A save writes the state twice: chat-state.next.json, then chat-state.json; nothing is deleted or renamed', async () => {
  const { plugin, files, renames } = await loadFrom(savedState('Old'));
  const order = [];
  const write = plugin.app.vault.adapter.write;
  plugin.app.vault.adapter.write = async (path, data) => { order.push(path); await write(path, data); };
  plugin.chatHistory.push({ type: 'user', text: 'New' });
  await plugin.saveChatHistory();
  assert.deepEqual(order, [NEXT, STATE]);
  assert.equal(files.get(NEXT), files.get(STATE));
  assert.deepEqual(savedTexts(JSON.parse(files.get(STATE))), ['Old', 'New']);
  assert.deepEqual(renames, []);
});

test('Both copies whole: the newer one loads (ended between the two writes, or chat-state.json could not be written)', async () => {
  const newerCopy = await loadFrom(savedState('Old', 1000), { next: savedState('New', 2000) });
  assert.deepEqual(texts(newerCopy.plugin), ['New']);
  const newerMain = await loadFrom(savedState('Main', 3000), { next: savedState('Copy', 2000) });
  assert.deepEqual(texts(newerMain.plugin), ['Main']);
  // Saved before savedAt existed: chat-state.json wins.
  const older = await loadFrom(savedState('Main'), { next: savedState('Copy') });
  assert.deepEqual(texts(older.plugin), ['Main']);
  // A save records when it was written.
  await newerCopy.plugin.saveChatHistory();
  assert.ok(JSON.parse(newerCopy.files.get(STATE)).savedAt > 2000);
});

test('Obsidian ended in the middle of a save (reload, quit): the chat loads from the whole copy', async () => {
  // Cut off while chat-state.json was written (emptied, or never there).
  for (const content of [undefined, '', '{"chatHistory": [{"ty']) {
    const { plugin, renames } = await loadFrom(content, { next: savedState('Kept') });
    assert.deepEqual(texts(plugin), ['Kept']);
    assert.deepEqual(renames, []);
  }
  // Cut off while the copy was written: chat-state.json is still whole.
  const { plugin } = await loadFrom(savedState('Old'), { next: '' });
  assert.deepEqual(texts(plugin), ['Old']);
  assert.deepEqual(globalThis.__notices, []);
});

test('An unreadable chat-state.json is kept aside before starting fresh, with one notice', async () => {
  for (const content of ['{"chatHistory": [', '[]', 'null']) {
    globalThis.__notices = [];
    const { plugin, writes, renames } = await loadFrom(content);
    assert.equal(renames.length, 1);
    assert.equal(renames[0][0], STATE);
    assert.match(renames[0][1], /^\.obsidian\/plugins\/chatting-with-ai\/chat-state\.corrupt-\d+\.json$/);
    assert.equal(globalThis.__notices.length, 1);
    assert.match(globalThis.__notices[0], /couldn't be read.*chat-state\.corrupt-\d+\.json/);
    // The fresh chat is saved to a new file; the old one is safe.
    await plugin.saveChatHistory();
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].conversations[0].chatHistory, []);
  }
});

test('An unreadable chat-state.json that cannot be moved aside is never overwritten', async () => {
  const { plugin, writes } = await loadFrom('not json', { renameFails: true });
  assert.equal(globalThis.__notices.length, 1);
  assert.match(globalThis.__notices[0], /isn't saved until Obsidian restarts/);
  plugin.chatHistory.push({ type: 'user', text: 'New' });
  await plugin.saveChatHistory();
  assert.deepEqual(writes, []);
});

test('No chat-state.json yet: the legacy file loads; else a first run starts silently and saves', async () => {
  const legacy = await loadFrom(undefined, { legacy: savedState('From the old plugin folder') });
  assert.deepEqual(texts(legacy.plugin), ['From the old plugin folder']);

  const { plugin, writes, renames } = await loadFrom(undefined);
  assert.deepEqual(texts(plugin), []);
  assert.deepEqual(renames, []);
  assert.deepEqual(globalThis.__notices, []);
  await plugin.saveChatHistory();
  assert.equal(writes.length, 1);
});

test('Saves never overlap: calls during a write share one next write with the latest state', async () => {
  const writes = [], pending = [];
  let active = 0, maxActive = 0;
  const plugin = pluginOn({
    read: async () => { throw new Error('ENOENT'); },
    exists: async () => false,
    write: (path, data) => {
      // The copy written first goes through at once; chat-state.json waits.
      if (path !== STATE) return Promise.resolve();
      active++;
      maxActive = Math.max(maxActive, active);
      writes.push(JSON.parse(data));
      return new Promise(resolve => pending.push(() => { active--; resolve(); }));
    },
  });
  await plugin.loadChatHistory();

  const first = plugin.saveChatHistory();
  while (writes.length < 1) await tick();
  plugin.chatHistory.push({ type: 'user', text: 'One' });
  const second = plugin.saveChatHistory();
  plugin.chatHistory.push({ type: 'user', text: 'Two' });
  const third = plugin.saveChatHistory();
  assert.equal(second, third);
  assert.equal(writes.length, 1);

  pending.shift()();
  await first;
  while (writes.length < 2) await tick();
  assert.deepEqual(savedTexts(writes[1]), ['One', 'Two']);
  pending.shift()();
  await third;
  assert.equal(writes.length, 2);
  assert.equal(maxActive, 1);
});

test('A JSON object with missing or invalid history is kept aside, not accepted as an empty chat', async () => {
  for (const content of ['{}', '{"chatHistory":null}', '{"agentMessages":"bad"}', '{"chatHistory":[],"savedAt":"bad"}']) {
    globalThis.__notices = [];
    const { renames } = await loadFrom(content);
    assert.equal(renames.length, 1);
  }
});

test('An unreadable lone copy is kept aside; a failed backup blocks saving', async () => {
  const kept = await loadFrom(undefined, { next: 'truncated' });
  assert.equal(kept.renames[0]?.[0], NEXT);
  const blocked = await loadFrom(undefined, { next: 'truncated', renameFails: true });
  await blocked.plugin.saveChatHistory();
  assert.equal(blocked.files.get(NEXT), 'truncated');
  assert.equal(blocked.writes.length, 0);
});

test('Malformed history entries recover from the good copy instead of crashing plugin startup', async () => {
  for (const malformed of [
    { chatHistory: [null] },
    { chatHistory: [{ type: 'user', text: 42 }] },
    { agentMessages: [null] },
    { agentMessages: [{ role: 'user', content: null }] },
    { agentMessages: [{ role: 'user', content: [null] }] },
  ]) {
    const { plugin } = await loadFrom(JSON.stringify(malformed), { next: savedState('Recovered') });
    assert.deepEqual(texts(plugin), ['Recovered']);
  }
});

test('Serialized saves have strictly increasing timestamps even in the same millisecond or after a clock rollback', async () => {
  const { plugin, files } = await loadFrom(savedState('Old', 2000));
  const now = Date.now;
  try {
    Date.now = () => 1000;
    await plugin.saveChatHistory();
    const first = JSON.parse(files.get(STATE)).savedAt;
    await plugin.saveChatHistory();
    const second = JSON.parse(files.get(STATE)).savedAt;
    assert.ok(first > 2000);
    assert.ok(second > first);
  } finally {
    Date.now = now;
  }
});

test('After a downgrade, a newer or tied main mtime beats the stale timestamped copy', async () => {
 for (const mainMtime of [3000, 4000]) {
  const files = new Map([[STATE, savedState('Changed on 0.4.0')], [NEXT, savedState('Stale copy', 2000)]]);
  const plugin = pluginOn({
    read: async path => files.get(path),
    exists: async path => files.has(path),
    stat: async path => ({ type: 'file', mtime: path === STATE ? mainMtime : 3000, ctime: 1, size: 1 }),
    write: async (path, data) => files.set(path, data),
  });
  await plugin.loadChatHistory();
  assert.deepEqual(texts(plugin), ['Changed on 0.4.0']);
  await plugin.saveChatHistory();
  assert.deepEqual(savedTexts(JSON.parse(files.get(NEXT))), ['Changed on 0.4.0']);
 }
});

test('A reloaded instance waits for the prior instance queued unload save before reading history', async () => {
  const files = new Map();
  const pending = [];
  const adapter = {
    read: async path => { if (!files.has(path)) throw Error('ENOENT'); return files.get(path); },
    exists: async path => files.has(path),
    write: (path, data) => path === NEXT ? Promise.resolve(files.set(path, data)) :
      new Promise(resolve => pending.push(() => { files.set(path, data); resolve(); })),
  };
  const old = pluginOn(adapter);
  await old.loadChatHistory();
  old.chatHistory = [{type: 'user', text: 'Old'}];
  const first = old.saveChatHistory();
  while (pending.length === 0) await tick();
  old.chatHistory = [];
  old.agent.clear();
  old.onunload();
  // Obsidian reuses its App when it unloads/re-enables a plugin bundle.
  // Load a second bundle, as Obsidian does during plugin reload; a
  // module-local queue would not be shared with this instance.
  const fresh = await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(bundled.outputFiles[0].text)}#reloaded`);
  const next = new fresh.ChatPlugin();
  next.app = old.app;
  next.agent = new fresh.AgentLoop(old.app, settings('anthropic'));
  let loaded = false;
  const loading = next.loadChatHistory().then(() => { loaded = true; });
  await tick();
  assert.equal(loaded, false);
  pending.shift()();
  await first;
  while (pending.length === 0) await tick();
  assert.equal(loaded, false);
  pending.shift()();
  await loading;
  assert.deepEqual(next.chatHistory, []);
  assert.deepEqual(JSON.parse(files.get(STATE)).conversations[0].chatHistory, []);
});

test('A late turn finally callback from an unloaded plugin cannot overwrite the replacement instance', async () => {
  const { plugin: old, files } = await loadFrom(savedState('Old'));
  old.onunload();
  const next = new api.ChatPlugin();
  next.app = old.app;
  next.agent = new api.AgentLoop(old.app, settings('anthropic'));
  await next.loadChatHistory();
  next.chatHistory = [{ type: 'user', text: 'Fresh turn in replacement' }];
  await next.saveChatHistory();
  // A provider promise settles after unload and the old view's finally
  // block asks its plugin to save again.
  old.chatHistory.push({ type: 'assistant', text: 'Stale callback' });
  await old.saveChatHistory();
  assert.deepEqual(JSON.parse(files.get(STATE)).conversations[0].chatHistory, next.chatHistory);
  assert.equal(files.get(STATE), files.get(NEXT));
});


test('Malformed nested UI history fields recover the readable backup before view replay', async () => {
  const image = { id: 'image-1', fileName: 'test.png', mediaType: 'image/png', data: 'AA==', sizeBytes: 1 };
  for (const entry of [
    { type: 'user', text: 'x', images: {} },
    { type: 'user', text: 'x', images: [null] },
    { type: 'user', text: 'x', images: [{ ...image, data: 42 }] },
    { type: 'user', text: 'x', images: [image, image] },
    { type: 'assistant' },
    { type: 'tool-result' },
    { type: 'tool-result', toolName: 'read_file' },
    { type: 'tool-result', toolResult: { result: 'ok', isError: false } },
    { type: 'tool-result', toolName: '', toolResult: { result: 'ok', isError: false } },
    { type: 'tool-result', toolName: 42, toolResult: { result: 'ok', isError: false } },
    { type: 'tool-result', toolName: 'read_file', toolInput: [], toolResult: { result: 'ok', isError: false } },
    { type: 'tool-result', toolName: 'read_file', toolResult: { result: {}, isError: false } },
    { type: 'tool-result', toolName: 'read_file', toolResult: { result: 'ok', isError: 'false' } },
  ]) {
    const { plugin } = await loadFrom(JSON.stringify({ chatHistory: [entry], savedAt: 2000 }), { next: savedState('Recovered', 1000) });
    assert.deepEqual(texts(plugin), ['Recovered']);
  }
});

test('Version 3: a malformed entry in any conversation recovers the readable copy; images may come without data', async () => {
  const conversation = (id, chatHistory) => ({ id, title: id, customTitle: false, createdAt: 1, updatedAt: 1, chatHistory, agentMessages: [] });
  const v3 = (savedAt, chatHistory) => JSON.stringify({
    version: 3, savedAt, activeConversationId: 'a',
    conversations: [conversation('a', [{ type: 'user', text: 'First' }]), conversation('b', chatHistory)],
  });
  const image = { id: 'image-1', fileName: 'test.png', mediaType: 'image/png', sizeBytes: 1 };
  // Saved from version 2 on: the image's data is only in the API history.
  const ok = await loadFrom(v3(2000, [{ type: 'user', text: 'With image', images: [image] }]));
  assert.deepEqual(texts(ok.plugin), ['First']);
  assert.deepEqual(ok.renames, []);
  // A broken entry in the other conversation: the readable copy wins.
  const { plugin } = await loadFrom(v3(2000, [{ type: 'assistant' }]), { next: v3(1000, [{ type: 'assistant', text: 'Recovered' }]) });
  assert.deepEqual(plugin.conversations.map(c => c.id), ['a', 'b']);
  assert.equal(plugin.conversations[1].chatHistory[0].text, 'Recovered');
});

test('Valid image attachments and tool result history remain intact on restore', async () => {
  const chatHistory = [
    { type: 'user', text: 'Image question', images: [{ id: 'image-1', fileName: 'test.png', mediaType: 'image/png', data: 'AA==', sizeBytes: 1 }] },
    { type: 'tool-result', toolName: 'read_file', toolInput: { path: 'Test.md' }, toolResult: { result: 'Contents', isError: false } },
    { type: 'assistant', text: 'Answer' },
  ];
  const { plugin } = await loadFrom(JSON.stringify({ chatHistory }));
  // A chat saved before turn IDs gets them on load (edit and regenerate).
  assert.deepEqual(plugin.chatHistory.map(({ turnId: _turnId, ...entry }) => entry), chatHistory);
});
