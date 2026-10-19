// Saving the chat (chat-state.json, the index, and a file per chat):
// nothing is saved before the saved chat was read, every save writes two
// copies of each file and loading takes the newer whole one, an unreadable
// file is kept aside instead of overwritten, and saves never overlap.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, bundled, settings, vaultApp, chatFiles } from './harness.mjs';

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
// file), on an in-memory adapter like Obsidian's (`chatFiles`): write
// replaces a file's content, rename refuses an existing destination.
// `writes`: each saved state whole (the index with its chat files merged
// in). Records renames.
async function loadFrom(content, { renameFails = false, next, legacy } = {}) {
  const { adapter, writes, whole } = chatFiles();
  const files = adapter.stored;
  if (content !== undefined) files.set(STATE, content);
  if (next !== undefined) files.set(NEXT, next);
  if (legacy !== undefined) files.set(LEGACY, legacy);
  const renames = [];
  const rename = adapter.rename;
  adapter.rename = async (from, to) => {
    if (renameFails) throw new Error('EBUSY');
    await rename(from, to);
    renames.push([from, to]);
  };
  const plugin = pluginOn(adapter);
  await plugin.loadChatHistory();
  return { plugin, files, writes, renames, whole };
}

const texts = plugin => plugin.chatHistory.map(entry => entry.text);
// The texts of the (only) conversation in a saved state, whole.
const savedTexts = state => state.conversations[0].chatHistory.map(entry => entry.text);
// The texts in conversation `id`'s chat file.
const fileTexts = (files, id) => JSON.parse(files.get(`${DIR}/chats/${id}.json`)).conversation.chatHistory.map(entry => entry.text);

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

test('A save writes a changed chat\'s file twice (its .next.json copy first), then the index twice; nothing is deleted or renamed', async () => {
  const { plugin, files, renames } = await loadFrom(savedState('Old'));
  const order = [];
  const write = plugin.app.vault.adapter.write;
  plugin.app.vault.adapter.write = async (path, data) => { order.push(path); await write(path, data); };
  plugin.chatHistory.push({ type: 'user', text: 'New' });
  await plugin.saveChatHistory();
  const id = plugin.activeConversationId;
  assert.deepEqual(order, [`${DIR}/chats/${id}.next.json`, `${DIR}/chats/${id}.json`, NEXT, STATE]);
  assert.equal(files.get(NEXT), files.get(STATE));
  assert.equal(files.get(`${DIR}/chats/${id}.next.json`), files.get(`${DIR}/chats/${id}.json`));
  assert.deepEqual(fileTexts(files, id), ['Old', 'New']);
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
  const pending = [];
  let active = 0, maxActive = 0;
  const { adapter, writes } = chatFiles();
  const write = adapter.write;
  // Everything before chat-state.json goes through at once; chat-state.json waits.
  adapter.write = (path, data) => {
    if (path !== STATE) return write(path, data);
    active++;
    maxActive = Math.max(maxActive, active);
    return write(path, data).then(() => new Promise(resolve => pending.push(() => { active--; resolve(); })));
  };
  const plugin = pluginOn(adapter);
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
  const { adapter, whole } = chatFiles();
  const files = adapter.stored;
  files.set(STATE, savedState('Changed on 0.4.0'));
  files.set(NEXT, savedState('Stale copy', 2000));
  adapter.stat = async path => ({ type: 'file', mtime: path === STATE ? mainMtime : 3000, ctime: 1, size: 1 });
  const plugin = pluginOn(adapter);
  await plugin.loadChatHistory();
  assert.deepEqual(texts(plugin), ['Changed on 0.4.0']);
  await plugin.saveChatHistory();
  assert.equal(files.get(NEXT), files.get(STATE));
  assert.deepEqual(savedTexts(whole()), ['Changed on 0.4.0']);
 }
});

test('A reloaded instance waits for the prior instance queued unload save before reading history', async () => {
  const pending = [];
  const { adapter, whole } = chatFiles();
  const write = adapter.write;
  // chat-state.json waits; the chat files and the copy go through at once.
  adapter.write = (path, data) => path !== STATE ? write(path, data) :
    new Promise(resolve => pending.push(() => { void write(path, data).then(resolve); }));
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
  assert.deepEqual(whole().conversations[0].chatHistory, []);
});

test('A late turn finally callback from an unloaded plugin cannot overwrite the replacement instance', async () => {
  const { plugin: old, files, whole } = await loadFrom(savedState('Old'));
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
  assert.deepEqual(whole().conversations[0].chatHistory, next.chatHistory);
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
    { type: 'user', text: 'x', selection: { filePath: 42, text: 'x' } },
    { type: 'user', text: 'x', selection: 'bad' },
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

test('Duplicate conversation IDs and malformed file or changes entries recover the valid copy', async () => {
  const record = { id: 'one', chatHistory: [{ type: 'user', text: 'Question' }], agentMessages: [] };
  const envelope = conversations => JSON.stringify({ version: 3, savedAt: 2000, activeConversationId: 'one', conversations });
  const bad = [
    [record, record],
    [{ ...record, id: '' }],
    [{ ...record, chatHistory: [{ type: 'user', text: 'Bad file', attachedFiles: [null] }] }],
    [{ ...record, chatHistory: [{ type: 'changes', turnId: 'turn', files: [42] }] }],
    [{ ...record, agentMessages: [{ role: 'user', content: [{ type: 'file', file: { data: 42 } }] }] }],
    [{ ...record, agentMessages: [{ role: 'user', content: [{ type: 'tool_result', files: [null] }] }] }],
  ];
  for (const conversations of bad) {
    const { plugin } = await loadFrom(envelope(conversations), { next: savedState('Recovered', 1000) });
    assert.deepEqual(texts(plugin), ['Recovered']);
  }
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

test('Malformed API images cannot replace validated UI attachments during v2 restore', async () => {
  const image = { id: 'one', fileName: 'one.png', mediaType: 'image/png', data: 'AA==', sizeBytes: 1 };
  for (const block of [
    { type: 'image', image: { id: 'one', data: 42 } },
    { type: 'image', image: null },
    { type: 'tool_result', tool_use_id: 't', images: [{ ...image, data: 42 }] },
  ]) {
    const content = JSON.stringify({ version: 2, savedAt: 2000,
      chatHistory: [{ type: 'user', text: 'Look', images: [{ id: 'one', fileName: 'one.png', mediaType: 'image/png', sizeBytes: 1 }] }],
      agentMessages: [{ role: 'user', content: [block] }] });
    const { plugin } = await loadFrom(content, { next: savedState('Recovered', 1000) });
    assert.deepEqual(texts(plugin), ['Recovered']);
  }
});

// The index (version 4) of one chat `c1`, and that chat's file with one user message `text`.
const index = (savedAt, entry = {}) => JSON.stringify({ version: 4, savedAt, activeConversationId: 'c1', conversations: [{ id: 'c1', title: 'Chat', customTitle: false, createdAt: 1, updatedAt: 1, ...entry }] });
const chatFile = (text, savedAt) => JSON.stringify({
  version: 4, savedAt,
  conversation: { id: 'c1', title: text, customTitle: false, createdAt: 1, updatedAt: 1, chatHistory: [{ type: 'user', text, turnId: 't1' }], agentMessages: [] },
});

test('A chat file and its copy load like chat-state.json: the newer whole one', async () => {
  const load = async (main, copy) => {
    const { adapter } = chatFiles();
    adapter.stored.set(STATE, index(1));
    if (main !== undefined) adapter.stored.set(`${DIR}/chats/c1.json`, main);
    if (copy !== undefined) adapter.stored.set(`${DIR}/chats/c1.next.json`, copy);
    const plugin = pluginOn(adapter);
    await plugin.loadChatHistory();
    return plugin;
  };
  assert.deepEqual(texts(await load(chatFile('Old', 1000), chatFile('New', 2000))), ['New']);
  assert.deepEqual(texts(await load(chatFile('Main', 3000), chatFile('Copy', 2000))), ['Main']);
  // Cut off while the file was written: the copy is whole.
  assert.deepEqual(texts(await load('', chatFile('Kept', 1000))), ['Kept']);
  assert.deepEqual(texts(await load(undefined, chatFile('Kept', 1000))), ['Kept']);
  assert.deepEqual(globalThis.__notices, []);
});

test('The index is checked like a whole saved chat: a malformed entry recovers the readable copy', async () => {
  for (const entry of [{ title: 42 }, { customTitle: 'yes' }, { size: -1 }, { updatedAt: 'now' }, { metadataSavedAt: 'bad' }]) {
    const { adapter } = chatFiles();
    adapter.stored.set(STATE, index(2000, entry));
    adapter.stored.set(NEXT, index(1000));
    adapter.stored.set(`${DIR}/chats/c1.json`, chatFile('Recovered', 1000));
    const plugin = pluginOn(adapter);
    await plugin.loadChatHistory();
    assert.deepEqual(texts(plugin), ['Recovered']);
    // The readable index holds the title (a rename may have changed only it).
    assert.equal(plugin.activeConversation.title, 'Chat');
  }
  // Without a readable copy it is kept aside like any unreadable file.
  const { renames } = await loadFrom(index(1, { id: 7 }));
  assert.equal(renames.length, 1);
  // An ID that can't name a file is refused the same way.
  const unsafe = await loadFrom(index(1, { id: '../evil' }));
  assert.equal(unsafe.renames.length, 1);
});

test('An index kept aside as unreadable: the chat files there come back in the list', async () => {
  const { adapter } = chatFiles();
  adapter.stored.set(STATE, '{"version": 4, "conv');
  adapter.stored.set(`${DIR}/chats/c1.json`, chatFile('Still here', 1000));
  const plugin = pluginOn(adapter);
  await plugin.loadChatHistory();
  assert.equal(globalThis.__notices.length, 1);
  assert.ok([...adapter.stored.keys()].some(path => /chat-state\.corrupt-\d+\.json$/.test(path)));
  assert.deepEqual(plugin.listConversations().map(c => c.title), ['Still here']);
  assert.deepEqual(texts(plugin), []);
});

test('Migration refuses to overwrite legacy history when its backup cannot be written', async () => {
  const { adapter } = chatFiles();
  const original = savedState('Keep original', 1000);
  adapter.stored.set(STATE, original);
  const write = adapter.write;
  adapter.write = async (path, data) => {
    if (/chat-state\.v\d+-/.test(path)) throw new Error('disk full');
    return write(path, data);
  };
  const plugin = pluginOn(adapter);
  await plugin.loadChatHistory();
  await plugin.saveChatHistory();
  assert.equal(adapter.stored.get(STATE), original);
  assert.equal(plugin.chatHistoryLoaded, false);
  await assert.rejects(plugin.checkpointChatHistory(), /storage isn't ready/);
});

test('Downgrade migration preserves both raw chat copies, and aborts on any backup failure', async () => {
  for (const fail of [false, true]) {
    const { adapter } = chatFiles();
    const original = JSON.stringify({ version: 3, savedAt: 2000, activeConversationId: 'c1', conversations: [JSON.parse(chatFile('Legacy edit', 1)).conversation] });
    adapter.stored.set(STATE, original);
    adapter.stored.set(`${DIR}/chats/c1.json`, '{truncated');
    const next = chatFile('Newer complete copy', 1000);
    adapter.stored.set(`${DIR}/chats/c1.next.json`, next);
    const write = adapter.write;
    adapter.write = async (path, data) => {
      if (fail && /c1\.next\.v4-/.test(path)) throw new Error('disk full');
      return write(path, data);
    };
    const plugin = pluginOn(adapter);
    await plugin.loadChatHistory();
    await plugin.saveChatHistory();
    if (fail) {
      assert.equal(adapter.stored.get(STATE), original);
      assert.equal(adapter.stored.get(`${DIR}/chats/c1.next.json`), next);
    } else {
      const backups = [...adapter.stored.entries()].filter(([path]) => /c1(?:\.next)?\.v4-/.test(path));
      assert.equal(backups.length, 2);
      assert.ok(backups.some(([, data]) => data === '{truncated'));
      assert.ok(backups.some(([, data]) => data === next));
    }
  }
});

test('Either future-format chat copy is preserved regardless of its timestamp', async () => {
  for (const futureMain of [false, true]) {
    const { adapter } = chatFiles();
    adapter.stored.set(STATE, index(1));
    const future = JSON.stringify({ version: 999, savedAt: 1, secretFutureData: 'keep' });
    adapter.stored.set(`${DIR}/chats/c1.json`, futureMain ? future : chatFile('Older format', 9999));
    adapter.stored.set(`${DIR}/chats/c1.next.json`, futureMain ? chatFile('Older format', 9999) : future);
    const plugin = pluginOn(adapter);
    await plugin.loadChatHistory();
    await plugin.saveChatHistory();
    assert.equal(adapter.stored.get(`${DIR}/chats/c1${futureMain ? '' : '.next'}.json`), future);
    assert.ok(!plugin.conversations.some(c => c.id === 'c1'));
  }
});

test('A lone next copy recovers an unlisted conversation after an interrupted first save', async () => {
  const { adapter } = chatFiles();
  adapter.stored.set(`${DIR}/chats/c1.next.json`, chatFile('Recover next only', 1000));
  const plugin = pluginOn(adapter);
  await plugin.loadChatHistory();
  assert.ok(plugin.listConversations().some(c => c.id === 'c1'));
});

test('A deletion interrupted after its next tombstone cannot resurrect the old primary', async () => {
  const { adapter } = chatFiles();
  adapter.stored.set(STATE, index(1000));
  adapter.stored.set(`${DIR}/chats/c1.json`, chatFile('Deleted', 1000));
  adapter.stored.set(`${DIR}/chats/c1.next.json`, JSON.stringify({ version: 4, savedAt: 2000, deleted: true }));
  const plugin = pluginOn(adapter);
  await plugin.loadChatHistory();
  assert.ok(!plugin.conversations.some(c => c.id === 'c1'));
});

test('A remote checkpoint reports failed writes, and recovers after storage works again', async () => {
  const { adapter } = chatFiles();
  const plugin = pluginOn(adapter);
  await plugin.loadChatHistory();
  plugin.chatHistory.push({ type: 'user', text: 'before remote request', turnId: 't1' });
  const write = adapter.write;
  adapter.write = async () => { throw new Error('disk full'); };
  await assert.rejects(plugin.checkpointChatHistory(), /Couldn't save/);
  adapter.write = write;
  await plugin.checkpointChatHistory();
  assert.equal(JSON.parse(adapter.stored.get(STATE)).version, 4);
});

for (const unread of [false, true]) test(`A newer chat-file title survives a stale index${unread ? ' carried through unrelated saves before opening' : ''}`, async () => {
  const { adapter } = chatFiles();
  const newFile = JSON.parse(chatFile('Edited first question', 2000));
  Object.assign(newFile.conversation, { automaticTitle: 'Edited first question', titleSourceTurnId: 't1' });
  const oldEntry = { id: 'c1', title: 'Old first question', automaticTitle: 'Old first question', titleSourceTurnId: 'old-turn', customTitle: false, createdAt: 1, updatedAt: 1 };
  const other = JSON.parse(chatFile('Other chat', 1000));other.conversation.id = 'c2';
  adapter.stored.set(STATE, JSON.stringify({ version: 4, savedAt: 1000, activeConversationId: unread ? 'c2' : 'c1', conversations: [oldEntry, { ...oldEntry, id: 'c2', title: 'Other chat', titleSourceTurnId: 't1' }] }));
  adapter.stored.set(`${DIR}/chats/c1.json`, JSON.stringify(newFile));
  adapter.stored.set(`${DIR}/chats/c2.json`, JSON.stringify(other));
  let plugin = pluginOn(adapter);
  await plugin.loadChatHistory();
  if (unread) {
    await plugin.saveChatHistory();
    assert.equal(JSON.parse(adapter.stored.get(STATE)).conversations.find(c => c.id === 'c1').metadataSavedAt, 1000);
    plugin = pluginOn(adapter);await plugin.loadChatHistory();
    await plugin.openConversation('c1');
  }
  assert.equal(plugin.activeConversation.title, 'Edited first question');
  assert.equal(plugin.activeConversation.titleSourceTurnId, 't1');
  await plugin.saveChatHistory();
  const again = pluginOn(adapter);await again.loadChatHistory();
  assert.equal(again.activeConversation.title, 'Edited first question');
  assert.equal(again.activeConversation.titleSourceTurnId, 't1');
});

test('A later custom rename wins a newer chat file without restoring stale automatic-title provenance', async () => {
  const { adapter } = chatFiles();
  const first = JSON.parse(chatFile('Edited question', 2000));
  Object.assign(first.conversation, { automaticTitle: 'Edited question', titleSourceTurnId: 't1' });
  const old = { id: 'c1', title: 'Old question', automaticTitle: 'Old question', titleSourceTurnId: 'missing-old-turn', customTitle: false, createdAt: 1, updatedAt: 1 };
  adapter.stored.set(STATE, JSON.stringify({ version: 4, savedAt: 1000, activeConversationId: 'c2', conversations: [old, { ...old, id: 'c2' }] }));
  adapter.stored.set(`${DIR}/chats/c1.json`, JSON.stringify(first));
  const second = JSON.parse(chatFile('Other', 1000));second.conversation.id = 'c2';adapter.stored.set(`${DIR}/chats/c2.json`, JSON.stringify(second));
  const plugin = pluginOn(adapter);await plugin.loadChatHistory();
  await plugin.renameConversation('c1', 'My name');
  await plugin.openConversation('c1');
  assert.equal(plugin.activeConversation.title, 'My name');
  assert.equal(plugin.activeConversation.automaticTitle, 'Edited question');
  assert.equal(plugin.activeConversation.titleSourceTurnId, 't1');
  await plugin.renameConversation('c1', '');
  assert.equal(plugin.activeConversation.title, 'Edited question');
  await plugin.saveChatHistory();
  const again = pluginOn(adapter);await again.loadChatHistory();
  assert.equal(again.activeConversation.title, 'Edited question');
  assert.equal(again.activeConversation.titleSourceTurnId, 't1');
});
