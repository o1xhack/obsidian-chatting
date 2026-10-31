// Undo per answer: the tools record their vault changes in a ChangeLog,
// undo takes them back (last first), and files changed since are found;
// the chat view shows the row, undoes it (asking first when files changed
// since), keeps it within its conversation, and tells the model with the
// next turn.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, response, transport, chatFiles } from './harness.mjs';

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
    modifyBinary: async (file, data) => { files.set(file.path, new TextDecoder().decode(data)); },
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

for (const external of [false, true]) for (const operation of ['edit', 'delete']) test(`Folder rename preserves undo continuity (${operation}, external=${external})`, async () => {
  const { app, files } = fakeVault({ 'Drafts/A.md': 'Original' });
  const changes = new api.ChangeLog();
  await run(app, changes, 'edit_document', { path: 'Drafts/A.md', operation: 'replace_all', content: 'First' });
  await run(app, changes, 'rename_file', { path: 'Drafts', new_path: 'Archive' });
  if (external) files.set('Archive/A.md', 'First\nManual addition');
  if (operation === 'edit') await run(app, changes, 'edit_document', { path: 'Archive/A.md', operation: 'find_replace', find: 'First', content: 'Second' });
  else await run(app, changes, 'delete_file', { path: 'Archive/A.md' });
  assert.equal(changes.canUndo(), !external);
  if (external) {
    const kept = [...files];
    assert.match((await changes.undo(app))[0], /Intervening/);
    assert.deepEqual([...files], kept);
  } else {
    assert.deepEqual(await changes.conflicts(app), []);
    assert.deepEqual(await changes.undo(app), []);
    assert.equal(files.get('Drafts/A.md'), 'Original');
  }
});

test('Reusing a descendant path after a folder rename is still wholly undoable', async () => {
  const { app, files } = fakeVault({ 'Drafts/A.md': 'Original' });
  const changes = new api.ChangeLog();
  await run(app, changes, 'edit_document', { path: 'Drafts/A.md', operation: 'replace_all', content: 'First' });
  await run(app, changes, 'rename_file', { path: 'Drafts', new_path: 'Archive' });
  await run(app, changes, 'create_file', { path: 'Drafts/A.md', content: 'New draft' });
  assert.equal(changes.canUndo(), true);
  assert.deepEqual(await changes.conflicts(app), []);
  assert.deepEqual(await changes.undo(app), []);
  assert.equal(files.get('Drafts/A.md'), 'Original');
});

for (const operation of ['edit', 'delete', 'rename-delete', 'recreate']) test(`Undo keeps intervening changes before ${operation}`, async () => {
  const { app, files } = fakeVault({ 'Plan.md': 'Original' });
  const changes = new api.ChangeLog();
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'First AI edit' });
  files.set('Plan.md', 'First AI edit\nManual addition');
  if (operation === 'edit') {
    await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'find_replace', find: 'First', content: 'Second' });
  } else if (operation === 'recreate') {
    files.delete('Plan.md');
    await run(app, changes, 'create_file', { path: 'Plan.md', content: 'Recreated' });
  } else {
    const path = operation === 'rename-delete' ? 'Moved.md' : 'Plan.md';
    if (path !== 'Plan.md') await run(app, changes, 'rename_file', { path: 'Plan.md', new_path: path });
    await run(app, changes, 'delete_file', { path });
  }
  assert.equal(changes.canUndo(), false);
  const beforeUndo = [...files];
  assert.match((await changes.undo(app))[0], /Intervening/);
  assert.deepEqual([...files], beforeUndo);
});

test('A failed trash operation does not leave a phantom deletion to undo', async () => {
  const { app, files } = fakeVault({ 'Plan.md': 'Keep me' });
  const changes = new api.ChangeLog();
  app.fileManager.trashFile = async () => { throw new Error('trash unavailable'); };
  const result = await run(app, changes, 'delete_file', { path: 'Plan.md' });
  assert.equal(result.isError, true);
  assert.equal(changes.isEmpty(), true);
  assert.equal(files.get('Plan.md'), 'Keep me');
});

test('A deletion too large to snapshot is refused before allocating the binary', async () => {
  const { app, files } = fakeVault({ 'Large.pdf': 'Keep' });
  const fileAt = app.vault.getAbstractFileByPath;
  app.vault.getAbstractFileByPath = path => Object.assign(fileAt(path), { stat: { size: 33 * 1024 * 1024 } });
  app.vault.readBinary = async () => assert.fail('must check the snapshot budget first');
  const changes = new api.ChangeLog();
  const result = await run(app, changes, 'delete_file', { path: 'Large.pdf' });
  assert.equal(result.isError, true);
  assert.match(result.result, /undo snapshot limit/);
  assert.equal(files.get('Large.pdf'), 'Keep');
});

test('Undo of a deleted file restores the original bytes after a conflicting replacement is confirmed', async () => {
  const { app, files } = fakeVault({ 'A.md': 'Original' });
  const changes = new api.ChangeLog();
  await run(app, changes, 'delete_file', { path: 'A.md' });
  files.set('A.md', 'Replacement');
  assert.deepEqual(await changes.conflicts(app), ['A.md']);
  assert.deepEqual(await changes.undo(app), []);
  assert.equal(files.get('A.md'), 'Original');
});

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

test('An undo failure stops before older dependent changes and remains retryable', async () => {
  const { app, files } = fakeVault({ 'Plan.md': 'Plan', 'A.md': 'A' });
  const changes = new api.ChangeLog();
  await run(app, changes, 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'AI plan' });
  await run(app, changes, 'rename_file', { path: 'A.md', new_path: 'B.md' });
  files.delete('B.md');
  assert.deepEqual(await changes.undo(app), ['B.md: not found']);
  assert.equal(files.get('Plan.md'), 'AI plan');
  files.set('B.md', 'A');
  assert.deepEqual(await changes.undo(app), []);
  assert.equal(files.get('Plan.md'), 'Plan');
  assert.equal(files.get('A.md'), 'A');
  files.set('Plan.md', 'New user edit');
  assert.deepEqual(await changes.undo(app), []);
  assert.equal(files.get('Plan.md'), 'New user edit');
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
    setChangesKept(turnId) { const row = chat.shown.find(m => (m.type === 'changes' || m.type === 'steps') && m.turnId === turnId); if (row) row.changesState = 'kept'; },
    setChangesUndone(turnId) { const row = chat.shown.find(m => m.type === 'changes' && m.turnId === turnId); if (row) row.changesState = 'undone'; },
    showThinking() {}, hideThinking() {}, cancelAskUser() {},
    restoreDraft(text, selection, images, files) { chat.draft = { text, selection, images, files }; },
    setComposerLocked(value) { chat.composerLocked = value; },
    setInputEnabled() {}, setBusy(value) { chat.busy = value; }, folded: [], foldTurn(turnId) { chat.folded.push(turnId); }, updateConversations() {}, setContinue() {}, setQueued() {}, clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {},
    setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin with a vault holding Plan.md, that loads `saved` as its
// chat-state.json (none when undefined) and records its writes, and a chat
// view with a fake component.
async function chatSetup(saved) {
  const { app, files } = fakeVault({ 'Plan.md': 'My plan' });
  const { adapter, writes } = chatFiles(saved);
  app.vault.configDir = '.obsidian';
  app.vault.adapter = adapter;
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

test('An empty restored file list cannot enable partial Undo after continuing', async () => {
  const { plugin, view, app, writes } = await chatSetup();
  await app.vault.createFolder('Empty');
  plugin.agent = new api.AgentLoop(app, { ...settings('anthropic'), maxIterations: 1 });
  transport(() => response('anthropic', [call('delete-empty', 'delete_file', { path: 'Empty' })], 'tool_use'));
  await view.handleUserMessage('Delete the folder then edit the plan', null);
  assert.deepEqual(changesRow(plugin).files, []);
  await plugin.saveChatHistory();
  const restored = await chatSetup(JSON.parse(JSON.stringify(writes.at(-1))));
  transport((_body, index) => index === 0
    ? response('anthropic', [call('edit-plan', 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'Continued' })], 'tool_use')
    : response('anthropic', [text('Done')]));
  await restored.view.continueTurn();
  const row = changesRow(restored.plugin);
  assert.equal(restored.plugin.changeLogs.get(row).canUndo(), false);
  await restored.view.undoChanges(row.turnId);
  assert.equal(restored.files.get('Plan.md'), 'Continued');
});

test('Intervening manual edits during a pause make the combined answer wholly kept', async () => {
  const { plugin, view, files } = await chatSetup();
  plugin.agent = new api.AgentLoop(plugin.app, { ...settings('anthropic'), maxIterations: 1 });
  transport((_body, index) => index < 2
    ? response('anthropic', [call(`edit-${index}`, 'edit_document', { path: 'Plan.md', operation: 'find_replace', find: index === 0 ? 'My' : 'First', content: index === 0 ? 'First' : 'Second' })], 'tool_use')
    : response('anthropic', [text('Done')]));
  await view.handleUserMessage('Edit twice', null);
  files.set('Plan.md', files.get('Plan.md') + '\nManual addition');
  await view.continueTurn();
  await view.continueTurn();
  const row = changesRow(plugin);
  assert.equal(plugin.changeLogs.get(row).canUndo(), false);
  await view.undoChanges(row.turnId);
  assert.equal(files.get('Plan.md'), 'Second plan\nManual addition');
});

test('Continue cannot race an undo with a pending vault write', async () => {
  const { plugin, view, files, app } = await chatSetup();
  plugin.agent = new api.AgentLoop(plugin.app, { ...settings('anthropic'), maxIterations: 1 });
  const requests = editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  let finishWrite;
  const modify = app.vault.modify;
  app.vault.modify = (file, content) => new Promise(resolve => { finishWrite = async () => { await modify(file, content); resolve(); }; });
  const undo = view.undoChanges(changesRow(plugin).turnId);
  while (!finishWrite) await tick();
  await view.continueTurn();
  const count = requests.length;
  await finishWrite();
  await undo;
  assert.equal(count, 1);
  assert.equal(files.get('Plan.md'), 'My plan');
  assert.equal(plugin.activeConversation.pendingTurn, undefined);
});

test('Edits across repeated step-limit pauses share one complete undo log', async () => {
  const { plugin, view, files } = await chatSetup();
  plugin.agent = new api.AgentLoop(plugin.app, { ...settings('anthropic'), maxIterations: 1 });
  const requests = transport((_body, index) => index < 2
    ? response('anthropic', [call(`edit-${index}`, 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: `Edit ${index}` })], 'tool_use')
    : response('anthropic', [text('Done')]));
  await view.handleUserMessage('Edit twice', null);
  const turnId = plugin.activeConversation.pendingTurn.turnId;
  await view.continueTurn();
  await view.continueTurn();
  const rows = plugin.chatHistory.filter(row => row.type === 'changes');
  assert.equal(rows.length, 1);
  assert.equal(requests.length, 3);
  assert.equal(files.get('Plan.md'), 'Edit 1');
  assert.deepEqual(await plugin.changeLogs.get(rows[0]).conflicts(plugin.app), []);
  await view.undoChanges(turnId);
  assert.equal(files.get('Plan.md'), 'My plan');
});

test('Undoing a paused answer dismisses Continue so stale edit receipts cannot be resumed', async () => {
  const { plugin, view, files } = await chatSetup();
  plugin.agent = new api.AgentLoop(plugin.app, { ...settings('anthropic'), maxIterations: 1 });
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  const turnId = plugin.activeConversation.pendingTurn.turnId;
  await view.undoChanges(turnId);
  assert.equal(files.get('Plan.md'), 'My plan');
  assert.equal(plugin.activeConversation.pendingTurn, undefined);
});

test('Continuing after a reload keeps the full changed-file list without offering partial undo', async () => {
  const { plugin, view, writes } = await chatSetup();
  plugin.agent = new api.AgentLoop(plugin.app, { ...settings('anthropic'), maxIterations: 1 });
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  await plugin.saveChatHistory();
  const restored = await chatSetup(JSON.parse(JSON.stringify(writes.at(-1))));
  restored.files.set('Plan.md', 'AI plan');
  transport((_body, index) => index === 0
    ? response('anthropic', [call('again', 'edit_document', { path: 'Plan.md', operation: 'replace_all', content: 'Final plan' })], 'tool_use')
    : response('anthropic', [text('Done')]));
  await restored.view.continueTurn();
  const rows = restored.plugin.chatHistory.filter(row => row.type === 'changes');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].files, ['Plan.md']);
  assert.equal(restored.plugin.changeLogs.get(rows[0]).canUndo(), false);
});

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

test('A failed undo remains available, reports partial failure to the model, and can be retried', async () => {
  const { plugin, view, files, app } = await chatSetup();
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  const row = changesRow(plugin);
  const modify = app.vault.modify;
  app.vault.modify = async () => { throw new Error('temporarily locked'); };
  await view.undoChanges(row.turnId);
  assert.equal(row.undone, undefined);
  assert.equal(plugin.changeLogs.has(row), true);
  assert.equal(files.get('Plan.md'), 'AI plan');
  assert.match(plugin.activeConversation.notes.at(-1), /stopped before completion/);
  app.vault.modify = modify;
  await view.undoChanges(row.turnId);
  assert.equal(row.undone, true);
  assert.equal(files.get('Plan.md'), 'My plan');
});

test('Undo confirmation holds off new turns, clearing, and conversation switching', async () => {
  const { plugin, view, files } = await chatSetup();
  const requests = editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  const original = plugin.activeConversation;
  const row = changesRow(plugin);
  files.set('Plan.md', 'User edit');
  const pending = view.undoChanges(row.turnId);
  await tick();
  const count = requests.length;
  view.newChat();
  view.clearConversation();
  await view.handleUserMessage('Do something else', null);
  assert.equal(plugin.activeConversation, original);
  assert.equal(changesRow(plugin), row);
  assert.equal(requests.length, count);
  modals.at(-1).decide(false);
  await pending;
  view.newChat();
  assert.notEqual(plugin.activeConversation, original);
});

test('The row and a pending note are saved; after a restart the row shows without undo and the note still goes along', async () => {
  const { view, plugin, files, writes } = await chatSetup();
  editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  files.set('Plan.md', 'User plan');
  await view.handleUserMessage('Rewrite my plan', null);
  await view.undoChanges(changesRow(plugin).turnId);
  await plugin.saveChatHistory();
  const saved = JSON.parse(JSON.stringify(writes.at(-1)));
  assert.equal(saved.version, api.chatState.CHAT_STATE_VERSION);
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

  await view.openConversation(first.id);
  assert.equal(chat.shown.find(m => m.type === 'changes').changesState, 'undoable');
  await view.undoChanges(turnId);
  assert.equal(files.get('Plan.md'), 'My plan');
  assert.equal(first.notes.length, 1);
  assert.equal(second.notes, undefined);

  await view.openConversation(second.id);
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

test('Repeated adjacent edits coalesce to the first snapshot and final text within the budget', async () => {
  const original = 'a'.repeat(2 * 1024 * 1024);
  const { app, files } = fakeVault({ 'Large.md': original });
  const changes = new api.ChangeLog();
  let before = original;
  for (let i = 0; i < 30; i++) {
    const after = original + String(i);
    changes.edited('Large.md', before, after);
    before = after;
  }
  files.set('Large.md', before);
  assert.equal(changes.canUndo(), true);
  assert.ok(changes.snapshotBytes < 9 * 1024 * 1024);
  assert.deepEqual(await changes.undo(app), []);
  assert.equal(files.get('Large.md'), original);
  assert.equal(changes.snapshotBytes, 0);
});

test('An answer exceeding its aggregate snapshot budget keeps all files without offering partial undo', async () => {
  const changes = new api.ChangeLog();
  const big = 'a'.repeat(5 * 1024 * 1024);
  changes.edited('A.md', big, big + 'x');
  changes.edited('B.md', big, big + 'y');
  assert.equal(changes.canUndo(), false);
  assert.equal(changes.snapshotBytes, 0);
  assert.equal(changes.steps.length, 0);
  changes.renamed('A.md', 'Renamed.md');
  changes.created('C.md', 'Created');
  assert.deepEqual(changes.files(), ['Renamed.md', 'B.md', 'C.md']);
  const { app, files } = fakeVault({ 'Renamed.md': 'Kept', 'B.md': 'Kept', 'C.md': 'Created' });
  assert.match((await changes.undo(app))[0], /expired/);
  assert.equal(files.get('Renamed.md'), 'Kept');
  assert.equal(changes.isEmpty(), false);
});

test('Retained answers share a global budget and evict whole oldest logs', () => {
  const big = 'a'.repeat(6 * 1024 * 1024);
  const logs = Array.from({ length: 3 }, () => new api.ChangeLog());
  for (const [i, log] of logs.entries()) log.edited(`${i}.md`, big, big + i);
  assert.equal(logs[0].canUndo(), false);
  assert.equal(logs[1].canUndo(), true);
  assert.equal(logs[2].canUndo(), true);
  assert.ok(logs.reduce((sum, log) => sum + log.snapshotBytes, 0) <= 64 * 1024 * 1024);
});

test('An oversized edit succeeds but its UI row and tool result explicitly report unavailable undo', async () => {
  const { plugin, view, chat, files } = await chatSetup();
  files.set('Plan.md', 'x'.repeat(9 * 1024 * 1024));
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('edit', 'edit_document', { path: 'Plan.md', operation: 'insert', position: 'end', content: 'done' })], 'tool_use')
    : response('anthropic', [text('Done')], 'end_turn', index));
  await view.handleUserMessage('Append done', null);
  const row = changesRow(plugin);
  assert.equal(plugin.changeLogs.get(row).canUndo(), false);
  assert.equal(chat.shown.find(item => item.type === 'changes').changesState, 'kept');
  assert.match(JSON.stringify(requests[1]), /undo is unavailable for the entire answer/);
  assert.ok(globalThis.__notices.some(value => /memory budget/.test(value)));
  const current = files.get('Plan.md');
  await view.undoChanges(row.turnId);
  assert.equal(files.get('Plan.md'), current);
  assert.equal(row.undone, undefined);
});

test('A pending undo locks sending without clearing the composer and restores a raced submission', async () => {
  const { plugin, view, files, chat, app } = await chatSetup();
  const requests = editingModel();
  await view.handleUserMessage('Rewrite my plan', null);
  const row = changesRow(plugin);
  const read = app.vault.cachedRead;
  let release;
  app.vault.cachedRead = async file => new Promise(resolve => { release = () => resolve(read(file)); });
  const pending = view.undoChanges(row.turnId);
  await tick();
  assert.equal(chat.composerLocked, true);
  assert.equal(chat.busy, true);
  const selection = { filePath: 'Plan.md', text: 'Draft selection' };
  const images = [{ id: 'image', data: 'YQ==' }];
  const attachments = [{ id: 'file', text: 'Draft file' }];
  await view.handleUserMessage('Keep my draft', selection, images, attachments);
  assert.deepEqual(chat.draft, { text: 'Keep my draft', selection, images, files: attachments });
  assert.equal(requests.length, 2);
  release();
  await pending;
  assert.equal(chat.composerLocked, false);
  assert.equal(chat.busy, false);
  assert.equal(files.get('Plan.md'), 'My plan');
  assert.equal(chat.draft.text, 'Keep my draft');
});
