// Undo per answer: the tools record their vault changes in a ChangeLog,
// undo takes them back (last first), and files changed since are found;
// the chat view shows the row, undoes it (asking first when files changed
// since), keeps it within its conversation, and tells the model with the
// next turn.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, response, transport } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
});

/** A vault of text files and folders, with Obsidian's file classes. */
function fakeVault(initial) {
  const files = new Map(Object.entries(initial));
  const folders = new Set();
  const parents = path => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));
  for (const path of files.keys()) parents(path).forEach(folder => folders.add(folder));
  const fileAt = path => files.has(path) ? Object.assign(new api.TFile(path), { extension: path.split('.').pop() }) : null;
  const folderAt = path => folders.has(path)
    ? new api.TFolder(path, [...files.keys(), ...folders].filter(p => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/')).map(p => fileAt(p) ?? folderAt(p)))
    : null;
  const vault = {
    getName: () => 'Test',
    getMarkdownFiles: () => [...files.keys()].filter(p => p.endsWith('.md')).map(fileAt),
    getFileByPath: fileAt,
    getFolderByPath: folderAt,
    getAbstractFileByPath: path => fileAt(path) ?? folderAt(path),
    cachedRead: async file => files.get(file.path),
    read: async file => files.get(file.path),
    readBinary: async file => new TextEncoder().encode(files.get(file.path)).buffer,
    process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
    modify: async (file, content) => { files.set(file.path, content); },
    create: async (path, content) => { assert.ok(!files.has(path), path); files.set(path, content); return fileAt(path); },
    createBinary: async (path, data) => { assert.ok(!files.has(path), path); files.set(path, new TextDecoder().decode(data)); return fileAt(path); },
    // As Obsidian: the missing folders on the way are created too.
    createFolder: async path => { parents(`${path}/x`).forEach(folder => folders.add(folder)); },
  };
  const move = (from, to) => {
    for (const [path, content] of [...files]) {
      if (path === from || path.startsWith(`${from}/`)) { files.delete(path); files.set(to + path.slice(from.length), content); }
    }
    for (const folder of [...folders]) {
      if (folder === from || folder.startsWith(`${from}/`)) { folders.delete(folder); folders.add(to + folder.slice(from.length)); }
    }
  };
  const fileManager = {
    renameFile: async (item, to) => move(item.path, to),
    trashFile: async item => {
      for (const path of [...files.keys()]) if (path === item.path || path.startsWith(`${item.path}/`)) files.delete(path);
      for (const folder of [...folders]) if (folder === item.path || folder.startsWith(`${item.path}/`)) folders.delete(folder);
    },
    processFrontMatter: async (file, fn) => {
      const frontmatter = {};
      fn(frontmatter);
      files.set(file.path, `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n${files.get(file.path)}`);
    },
  };
  const app = { vault, fileManager, workspace: { getActiveFile: () => null, getLeavesOfType: () => [] } };
  return { app, files, folders };
}

const run = (app, changes, name, input) => api.executeTool(app, name, input, async () => 'yes', undefined, changes);

test('Undo takes an answer\'s edits, new files and folders, renames and deletes back, last first', async () => {
  const { app, files, folders } = fakeVault({
    'Plan.md': 'Old plan',
    'Notes/A.md': 'Note A',
    'Old/One.md': 'One',
    'Old/Deep/Two.md': 'Two',
    'Board.canvas': '{"nodes":[],"edges":[]}',
  });
  const changes = new api.ChangeLog();
  for (const [name, input] of [
    ['edit_document', { path: 'Plan.md', operation: 'find_replace', find: 'Old', content: 'New' }],
    ['create_file', { path: 'Fresh/Ideas/Idea.md', content: 'Idea' }],
    ['rename_file', { path: 'Notes/A.md', new_path: 'Archive/A.md' }],
    ['edit_document', { path: 'Archive/A.md', operation: 'insert', position: 'end', content: 'more' }],
    ['set_properties', { path: 'Plan.md', properties: { status: 'done' } }],
    ['edit_canvas', { path: 'Board.canvas', operations: [{ op: 'add_node', type: 'text', text: 'Card' }] }],
    ['delete_file', { path: 'Old' }],
  ]) {
    const result = await run(app, changes, name, input);
    assert.equal(result.isError, false, `${name}: ${result.result}`);
  }
  // Failed and unchanged steps record nothing.
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'find_replace', find: 'missing', content: 'x' });
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'find_replace', find: 'New', content: 'New' });
  await run(app, changes, 'create_file', { path: 'Plan.md', content: 'again' });

  assert.deepEqual(changes.files(), ['Plan.md', 'Fresh/Ideas/Idea.md', 'Archive/A.md', 'Board.canvas', 'Old/One.md', 'Old/Deep/Two.md']);
  assert.deepEqual(await changes.conflicts(app), []);

  assert.deepEqual(await changes.undo(app), []);
  assert.deepEqual(Object.fromEntries([...files].sort()), {
    'Board.canvas': '{"nodes":[],"edges":[]}',
    'Notes/A.md': 'Note A',
    'Old/Deep/Two.md': 'Two',
    'Old/One.md': 'One',
    'Plan.md': 'Old plan',
  });
  assert.ok(folders.has('Old/Deep'));
  // Folders the answer created for its files are gone again; ones that were there stay.
  assert.equal(folders.has('Fresh'), false);
  assert.equal(folders.has('Fresh/Ideas'), false);
  assert.equal(folders.has('Archive'), false);
  assert.ok(folders.has('Notes'));
});

test('A created folder that holds other files by now stays', async () => {
  const { app, files, folders } = fakeVault({});
  const changes = new api.ChangeLog();
  await run(app, changes, 'create_file', { path: 'Trip/Plan.md', content: 'Plan' });
  files.set('Trip/Mine.md', 'The user\'s note');
  assert.deepEqual(await changes.undo(app), []);
  assert.equal(files.has('Trip/Plan.md'), false);
  assert.ok(folders.has('Trip'));
});

test('Files changed after the answer are named before undoing', async () => {
  const { app, files } = fakeVault({ 'Plan.md': 'Plan', 'Other.md': 'Other' });
  const changes = new api.ChangeLog();
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'AI plan' });
  await run(app, changes, 'edit_document', { path: 'Other.md', operation: 'replace_all', content: 'AI other' });
  await run(app, changes, 'create_file', { path: 'New.md', content: 'New' });
  await run(app, changes, 'rename_file', { path: 'New.md', new_path: 'Moved.md' });

  files.set('Plan.md', 'AI plan, then the user');
  files.delete('Moved.md');
  assert.deepEqual((await changes.conflicts(app)).sort(), ['Moved.md', 'Plan.md']);
});

test('What can\'t be undone is reported; the rest is undone', async () => {
  const { app, files } = fakeVault({ 'Plan.md': 'Plan', 'A.md': 'A' });
  const changes = new api.ChangeLog();
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'AI plan' });
  await run(app, changes, 'rename_file', { path: 'A.md', new_path: 'B.md' });
  files.delete('B.md');
  assert.deepEqual(await changes.undo(app), ['B.md: not found']);
  assert.equal(files.get('Plan.md'), 'Plan');
});

// ─── The chat view: the changes row, undo, the note for the model ─────────

// The confirm dialog records itself instead of opening (the test decides).
const modals = [];
api.UndoConfirmModal.prototype.open = function () { this.contentEl = { empty() {} }; modals.push(this); };
api.UndoConfirmModal.prototype.close = function () { this.onClose(); };

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    addUserMessage(value, images = [], turnId) { chat.shown.push({ id: nextId++, type: 'user', text: value, turnId }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId); if (index >= 0) chat.shown.splice(index); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    addChanges(turnId, files, state) { chat.shown.push({ id: nextId++, type: 'changes', turnId, files, changesState: state }); },
    setChangesUndone(turnId) { const row = chat.shown.find(m => m.type === 'changes' && m.turnId === turnId); if (row) row.changesState = 'undone'; },
    showThinking() {}, hideThinking() {}, cancelAskUser() {},
    setInputEnabled() {}, setBusy() {}, folded: [], foldTurn(turnId) { chat.folded.push(turnId); }, updateConversations() {}, setContinue() {}, setQueued() {}, clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {},
    setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin with a vault holding Plan.md, that loads `saved` as its
// chat-state.json (none when undefined) and records its writes, and a chat
// view with a fake component.
async function chatSetup(saved) {
  const { app, files } = fakeVault({ 'Plan.md': 'My plan' });
  const writes = [];
  app.vault.configDir = '.obsidian';
  app.vault.adapter = {
    append: async () => {},
    read: async (path) => { if (!saved || !path.endsWith('/chat-state.json')) throw new Error('ENOENT'); return JSON.stringify(saved); },
    exists: async (path) => !!saved && path.endsWith('/chat-state.json'),
    write: async (path, data) => { if (path.endsWith('/chat-state.json')) writes.push(JSON.parse(data)); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...plugin.settings, followEdits: false };
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { app, files, plugin, view, chat, writes };
}

/** A model that rewrites Plan.md when asked to, and answers plainly otherwise. */
function editingModel() {
  return transport((body, index) => {
    const last = body.messages.at(-1);
    const asked = typeof last.content === 'string' && last.content.endsWith('Rewrite my plan');
    if (asked) return response('anthropic', [call(`e${index}`, 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'AI plan' })], 'tool_use');
    return response('anthropic', [text(`A${index}`)], 'end_turn', index);
  });
}

/** The text of a request's last message (the user turn). */
const sentText = body => JSON.stringify(body.messages.at(-1).content);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// The changes row of the latest turn that has one.
const changesRow = (plugin) => plugin.chatHistory.findLast((e) => e.type === 'changes');

test('An answer that changed files ends in a row with undo; undo restores them and tells the model with the next turn only', async () => {
  const { plugin, view, chat, files } = await chatSetup();
  const requests = editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  assert.equal(files.get('Plan.md'), 'AI plan');

  // The row comes right after the turn's last tool step, before the answer that reports the change.
  assert.deepEqual(plugin.chatHistory.map((e) => e.type), ['user', 'tool-result', 'changes', 'assistant']);
  const row = changesRow(plugin);
  assert.deepEqual(row, { type: 'changes', turnId: plugin.chatHistory[0].turnId, files: ['Plan.md'] });
  assert.deepEqual(chat.shown.at(-1), { id: chat.shown.at(-1).id, type: 'changes', turnId: row.turnId, files: ['Plan.md'], changesState: 'undoable' });

  await view.undoChanges(row.turnId);
  assert.equal(files.get('Plan.md'), 'My plan');
  assert.equal(row.undone, true);
  assert.equal(chat.shown.at(-1).changesState, 'undone');
  assert.equal(modals.length, 0);
  // Undone once only.
  files.set('Plan.md', 'The user wrote this');
  await view.undoChanges(row.turnId);
  assert.equal(files.get('Plan.md'), 'The user wrote this');

  await view.handleUserMessage('What now?', null);
  assert.match(sentText(requests.at(-1)), /\[Context: .*The user undid the changes one of your earlier answers in this chat made to Plan\.md: they are back as they were before that answer\. \]/);
  // Only with that turn; a turn without changes gets no row.
  await view.handleUserMessage('And now?', null);
  assert.doesNotMatch(sentText(requests.at(-1)), /undid/);
  assert.equal(plugin.chatHistory.filter(e => e.type === 'changes').length, 1);
  // The system prompt stays the same.
  assert.equal(requests[0].system[0].text, requests.at(-1).system[0].text);
});

test('Undo after a later change asks first; Cancel keeps everything', async () => {
  const { plugin, view, files } = await chatSetup();
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  const { turnId } = changesRow(plugin);
  files.set('Plan.md', 'AI plan, edited by the user');

  const cancelled = view.undoChanges(turnId);
  await tick();
  const modal = modals.at(-1);
  assert.deepEqual(modal.changed, ['Plan.md']);
  modal.decide(false);
  await cancelled;
  assert.equal(files.get('Plan.md'), 'AI plan, edited by the user');
  assert.notEqual(changesRow(plugin).undone, true);
  assert.equal(plugin.activeConversation.notes, undefined);

  const confirmed = view.undoChanges(turnId);
  await tick();
  modals.at(-1).decide(true);
  await confirmed;
  assert.equal(files.get('Plan.md'), 'My plan');
});

test('The row and a pending note are saved; after a restart the row shows without undo and the note still goes along', async () => {
  const { view, plugin, files, writes } = await chatSetup();
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  files.set('Plan.md', 'User plan');
  await view.handleUserMessage('Rewrite my plan', null);
  await view.undoChanges(changesRow(plugin).turnId);
  await tick();
  const saved = JSON.parse(JSON.stringify(writes.at(-1)));
  assert.equal(saved.version, 3);
  const [conversation] = saved.conversations;
  assert.deepEqual(conversation.chatHistory.filter(e => e.type === 'changes').map(e => e.undone ?? false), [false, true]);
  assert.equal(conversation.notes.length, 1);

  const restored = await chatSetup(saved);
  restored.view.renderHistory();
  assert.deepEqual(restored.chat.shown.filter(m => m.type === 'changes').map(m => m.changesState), ['kept', 'undone']);
  // Nothing to undo after the restart.
  await restored.view.undoChanges(restored.plugin.chatHistory.find(e => e.type === 'changes').turnId);
  assert.equal(restored.files.get('Plan.md'), 'My plan');
  const requests = editingModel();
  await restored.view.handleUserMessage('What now?', null);
  assert.match(sentText(requests[0]), /The user undid the changes/);
});

test('Undo stays within its conversation: another chat can\'t undo the row, the note goes to the row\'s chat', async () => {
  const { plugin, view, chat, files } = await chatSetup();
  const requests = editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  const first = plugin.activeConversation;
  const { turnId } = changesRow(first);

  view.newChat();
  await view.handleUserMessage('Hello', null);
  const second = plugin.activeConversation;
  assert.notEqual(second, first);
  await view.undoChanges(turnId);
  assert.equal(files.get('Plan.md'), 'AI plan');

  view.openConversation(first.id);
  assert.equal(chat.shown.find(m => m.type === 'changes').changesState, 'undoable');
  await view.undoChanges(turnId);
  assert.equal(files.get('Plan.md'), 'My plan');
  assert.equal(first.notes.length, 1);
  assert.equal(second.notes, undefined);

  view.openConversation(second.id);
  await view.handleUserMessage('Next', null);
  assert.doesNotMatch(sentText(requests.at(-1)), /undid/);
});

test('Clear drops a pending note; a stopped turn\'s row goes before the next turn', async () => {
  const { plugin, view, files } = await chatSetup();
  const requests = editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  await view.undoChanges(changesRow(plugin).turnId);
  view.clearConversation();
  assert.equal(plugin.activeConversation.notes, undefined);
  await view.handleUserMessage('Hi', null);
  assert.doesNotMatch(sentText(requests.at(-1)), /undid/);

  // The answer is held until Stop, then sending again starts a new turn
  // while the stopped one ends.
  view.clearConversation();
  files.set('Plan.md', 'My plan');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  transport(async (body, index) => {
    const last = body.messages.at(-1);
    if (typeof last.content === 'string' && last.content.endsWith('Rewrite my plan')) {
      return response('anthropic', [call('e', 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'AI plan' })], 'tool_use');
    }
    if (index === 1) await held;
    return response('anthropic', [text(`A${index}`)], 'end_turn', index);
  });
  const stopped = view.handleUserMessage('Rewrite my plan', null);
  while (files.get('Plan.md') !== 'AI plan') await tick();
  view.handleStop();
  const next = view.handleUserMessage('Something else', null);
  release();
  await stopped;
  await next;
  assert.deepEqual(plugin.chatHistory.map(e => e.type === 'user' ? e.text : e.type), ['Rewrite my plan', 'tool-result', 'changes', 'Something else', 'assistant']);
});

test('A finished turn folds its steps: when it ends, and every finished turn again after a redraw', async () => {
  const { plugin, view, chat } = await chatSetup();
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  const turnId = plugin.chatHistory[0].turnId;
  assert.deepEqual(chat.folded, [turnId]);
  chat.folded = [];
  view.renderHistory();
  assert.deepEqual(chat.folded, [turnId]);
});
