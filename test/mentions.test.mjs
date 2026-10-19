// Mentions: finding the mention at the caret, the files offered, the link
// put in, the linked files found when sending and what goes to the model.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, transport, response, text, vaultApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
});

const M = api.mentions;

// Small images decode to their size and are sent unchanged.
globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });

// A vault with these files (path -> content), as far as mentions use it.
function mentionVault(contents) {
  const files = new Map(Object.entries(contents));
  const fileAt = path => {
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    return {
      path, name,
      basename: name.replace(/\.[^.]+$/, ''),
      extension: name.slice(name.lastIndexOf('.') + 1),
      parent: { path: path.slice(0, Math.max(slash, 0)), isRoot: () => slash === -1 },
      stat: { mtime: [...files.keys()].indexOf(path) },
    };
  };
  const byPath = new Map();
  const cached = path => { if (!byPath.has(path)) byPath.set(path, fileAt(path)); return byPath.get(path); };
  return {
    vault: {
      getFiles: () => [...files.keys()].map(cached),
      getFileByPath: path => files.has(path) ? cached(path) : null,
      cachedRead: async file => files.get(file.path),
      readBinary: async file => new TextEncoder().encode(files.get(file.path)).buffer,
    },
    workspace: { getLastOpenFiles: () => ['Work/Plan.md'], getActiveFile: () => null },
    metadataCache: {
      fileToLinktext: (file, _source, omitMd) => (file.path.startsWith('Work/') || file.path.startsWith('Pics/') ? file.name : file.path).replace(omitMd ? /\.md$/ : /$^/, ''),
      // As Obsidian: a name without folder and extension finds the note.
      getFirstLinkpathDest: linkpath => [...files.keys()].map(cached).find(f => f.path === linkpath || f.path === `${linkpath}.md` || f.name === linkpath || f.basename === linkpath) ?? null,
    },
  };
}

test('mentionAt: @ at the start or after a space, [[ until it is closed, only on the line of the caret', () => {
  assert.deepEqual(M.mentionAt('@pla', 4), { start: 0, query: 'pla' });
  assert.deepEqual(M.mentionAt('see @Project pl', 15), { start: 4, query: 'Project pl' });
  assert.deepEqual(M.mentionAt('see [[Proj', 10), { start: 4, query: 'Proj' });
  assert.equal(M.mentionAt('mail me@example.com', 19), null);
  assert.equal(M.mentionAt('see [[Plan]] now', 16), null);
  assert.equal(M.mentionAt('@plan\nnext line', 15), null);
  assert.deepEqual(M.mentionAt('first\n@ne', 9), { start: 6, query: 'ne' });
  // Only up to the caret.
  assert.deepEqual(M.mentionAt('@plan rest', 3), { start: 0, query: 'pl' });
});

test('mentionCandidates: recent files first for an empty query, else fuzzy by name before folder', () => {
  const app = mentionVault({ 'Inbox.md': '', 'Work/Plan.md': '', 'Work/Budget.md': '', 'Pics/plant.png': '', 'Planning/Notes.md': '' });
  assert.equal(M.mentionCandidates(app, '')[0].path, 'Work/Plan.md');
  assert.deepEqual(M.mentionCandidates(app, 'plan').map(f => f.path), ['Work/Plan.md', 'Pics/plant.png', 'Planning/Notes.md']);
  assert.deepEqual(M.mentionCandidates(app, 'zzz'), []);
});

test('insertMention: the typed mention becomes a link, a closing ]] the input added is taken in, the caret goes after it', () => {
  const app = mentionVault({ 'Work/Plan.md': '' });
  const file = app.vault.getFileByPath('Work/Plan.md');
  assert.deepEqual(M.insertMention(app, 'compare @pl with', { start: 8, query: 'pl' }, 11, file, ''), { text: 'compare [[Plan]] with', caret: 17 });
  assert.deepEqual(M.insertMention(app, 'see [[Pl]]', { start: 4, query: 'Pl' }, 8, file, ''), { text: 'see [[Plan]] ', caret: 13 });
});

test('mentionedFiles: each linked file once, with headings and aliases, unknown links left out', () => {
  const app = mentionVault({ 'Work/Plan.md': '', 'Pics/cat.png': '' });
  const found = M.mentionedFiles(app, 'see [[Plan]], [[Plan#Goals|goals]], [[cat.png]] and [[Missing]]', '');
  assert.deepEqual(found.map(f => f.path), ['Work/Plan.md', 'Pics/cat.png']);
});

test('mentionContext: note text (capped), canvas outline, images as images, PDF and Office as files, others by name', async () => {
  const long = 'x'.repeat(M.MENTION_CHARS + 5);
  const app = mentionVault({
    'Work/Plan.md': 'Goal: ship',
    'Long.md': long,
    'Todo.txt': 'buy milk',
    'Board.canvas': JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: 'Card', x: 0, y: 0, width: 10, height: 10 }], edges: [] }),
    'Pics/cat.png': 'PNG',
    'Data.xlsx': 'PK',
    'Song.mp3': '\u0000ID3',
  });
  const files = ['Work/Plan.md', 'Long.md', 'Todo.txt', 'Board.canvas', 'Pics/cat.png', 'Data.xlsx', 'Song.mp3'].map(p => app.vault.getFileByPath(p));
  const context = await M.mentionContext(app, files);
  assert.match(context.text, /^\[Files the user linked in this message, as they are now:\]\n<file path="Work\/Plan\.md">\nGoal: ship\n<\/file>/);
  assert.match(context.text, new RegExp(`cut after ${M.MENTION_CHARS} of ${long.length} characters; use read_document`));
  assert.match(context.text, /<file path="Todo\.txt">\nbuy milk\n<\/file>/);
  assert.match(context.text, /<file path="Board\.canvas">\n[\s\S]*Card[\s\S]*<\/file>/);
  assert.match(context.text, /<file path="Pics\/cat\.png">\(the image is attached\)<\/file>/);
  assert.match(context.text, /<file path="Data\.xlsx">\(the file is attached\)<\/file>/);
  assert.deepEqual(context.files.map(f => f.fileName), ['Data.xlsx']);
  assert.match(context.text, /<file path="Song\.mp3">\(not sent along: Song\.mp3 can't be sent/);
  assert.equal(context.images.length, 1);
  assert.equal(context.images[0].fileName, 'cat.png');
  assert.equal(await M.mentionContext(app, []), null);
});

test('mentionContext: all notes together stay within the total', async () => {
  const notes = Object.fromEntries([1, 2, 3, 4].map(n => [`N${n}.md`, String(n).repeat(M.MENTION_CHARS)]));
  const app = mentionVault(notes);
  const context = await M.mentionContext(app, Object.keys(notes).map(p => app.vault.getFileByPath(p)));
  const bodies = [...context.text.matchAll(/<file path="N\d\.md">\n([1-4]*)/g)].map(m => m[1].length);
  assert.deepEqual(bodies, [M.MENTION_CHARS, M.MENTION_CHARS, M.MENTION_CHARS, 0]);
  assert.equal(M.MENTION_TOTAL_CHARS, 3 * M.MENTION_CHARS);
  assert.match(context.text, /cut after 0 of 20000 characters/);
});

test('mentionContext stops before reading the next large document when metadata proves the encoded budget cannot fit', async () => {
  const app = mentionVault(Object.fromEntries(Array.from({ length: 10 }, (_, n) => [`D${n}.pdf`, ''])));
  const files = app.vault.getFiles();
  for (const file of files) file.stat.size = 10 * 1024 * 1024;
  const reads = [];
  app.vault.readBinary = async file => { reads.push(file.path); return new ArrayBuffer(file.stat.size); };
  await assert.rejects(M.mentionContext(app, files), /encoded attachment limit/);
  assert.deepEqual(reads, ['D0.pdf']);
});

test('mentionContext counts picked attachments before reading links and checks actual bytes when metadata understates size', async () => {
  const app = mentionVault({ 'D1.pdf': '', 'D2.pdf': '', 'D3.pdf': '' });
  const files = app.vault.getFiles();
  for (const file of files) file.stat.size = 9 * 1024 * 1024;
  let reads = 0;
  app.vault.readBinary = async () => { reads++; return new ArrayBuffer(9 * 1024 * 1024); };
  const picked = { id: 'picked', fileName: 'Picked.pdf', mediaType: 'application/pdf', data: 'A'.repeat(12 * 1024 * 1024), sizeBytes: 9 * 1024 * 1024 };
  await assert.rejects(M.mentionContext(app, files, { images: [], files: [picked] }), /encoded attachment limit/);
  assert.equal(reads, 0);
  for (const file of files) file.stat.size = 1;
  await assert.rejects(M.mentionContext(app, files), /encoded attachment limit/);
  assert.equal(reads, 2); // Stop immediately after actual data crosses the budget.
});

test('mentionContext counts picked images together with linked files', async () => {
  const app = mentionVault({ 'Large.pdf': '' });
  const file = app.vault.getFileByPath('Large.pdf');
  file.stat.size = 10 * 1024 * 1024;
  app.vault.readBinary = async () => { assert.fail('Must reject before reading the document'); };
  const images = Array.from({ length: 2 }, (_, i) => ({ id: `i${i}`, fileName: `${i}.png`, mediaType: 'image/png', data: 'A'.repeat(6 * 1024 * 1024), sizeBytes: 4.5 * 1024 * 1024 }));
  await assert.rejects(M.mentionContext(app, [file], { images, files: [] }), /encoded attachment limit/);
});

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  const chat = {
    shown: [],
    restoreDraft(text, selection, images, files) { chat.draft = { text, selection, images, files }; },
    addUserMessage(value, images = []) { chat.shown.push({ type: 'user', text: value, images }); },
    addAssistantMessage(value) { chat.shown.push({ type: 'assistant', text: value }); return chat.shown.length - 1; },
    updateAssistantMessage(id, value) { chat.shown[id].text = value; }, removeMessage(id) { chat.shown.splice(id, 1); },
    addToolCall() { return 0; }, updateToolResult() {},
    addError(value) { chat.shown.push({ type: 'error', text: value }); },
    showThinking() {}, hideThinking() {},
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, focus() {}, cancelAskUser() {}, setTitle() {},
  };
  return chat;
}

// A plugin with the chat view on `app` and a fake component.
function chatView(app) {
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  plugin.chatHistory = [];
  plugin.saveChatHistory = async () => {};
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { plugin, view, chat };
}

test('Sending a message with a link: the file goes to the model before the message, its image as an image; the chat shows the text only', async () => {
  const { app } = vaultApp();
  const vault = mentionVault({ 'Work/Plan.md': 'Goal: ship', 'Pics/cat.png': 'PNG' });
  Object.assign(app.vault, vault.vault);
  app.metadataCache = vault.metadataCache;
  const { plugin, view, chat } = chatView(app);
  const requests = transport(() => response('anthropic', [text('ok')]));
  await view.handleUserMessage('Compare [[Plan]] with [[cat.png]]', null);

  const sent = requests[0].messages.at(-1).content;
  const textBlock = sent.find(b => b.type === 'text').text;
  assert.match(textBlock, /<file path="Work\/Plan\.md">\nGoal: ship\n<\/file>[\s\S]*\n\nCompare \[\[Plan\]\] with \[\[cat\.png\]\]$/);
  assert.equal(sent.filter(b => b.type === 'image').length, 1);
  assert.deepEqual(chat.shown[0].images, []);
  assert.equal(plugin.chatHistory[0].text, 'Compare [[Plan]] with [[cat.png]]');
  assert.deepEqual(plugin.chatHistory[0].images, []);
});

test('Sending a message without a linked file: nothing is added', async () => {
  const { app } = vaultApp();
  app.metadataCache = { getFirstLinkpathDest: () => null };
  const { view } = chatView(app);
  const requests = transport(() => response('anthropic', [text('ok')]));
  await view.handleUserMessage('A question about [[Nowhere]]', null);
  const sent = requests[0].messages.at(-1).content;
  assert.equal(typeof sent, 'string');
  assert.doesNotMatch(sent, /Files the user linked/);
});

test('A linked note delivers its folder rules in the first user request before the file content', async () => {
  const { app } = vaultApp();
  const vault = mentionVault({ 'Work/AGENTS.md': 'Work summaries must be brief.', 'Work/Plan.md': 'Goal: ship' });
  Object.assign(app.vault, vault.vault);
  app.metadataCache = vault.metadataCache;
  const { view } = chatView(app);
  const requests = transport(() => response('anthropic', [text('ok')]));
  await view.handleUserMessage('Summarize [[Work/Plan.md]]', null);
  const sent = requests[0].messages.at(-1).content;
  assert.equal(typeof sent, 'string');
  assert.ok(sent.indexOf('Work summaries must be brief') < sent.indexOf('Goal: ship'));
  await view.handleUserMessage('Summarize [[Work/Plan.md]] again', null);
  assert.doesNotMatch(requests[1].messages.at(-1).content, /Work summaries must be brief/);
});

test('Rejected linked attachments restore the complete draft without a stranded user turn, then a smaller retry succeeds', async () => {
  const { app } = vaultApp();
  const vault = mentionVault({ 'Linked.pdf': '' });
  Object.assign(app.vault, vault.vault);
  app.metadataCache = vault.metadataCache;
  app.vault.getFileByPath('Linked.pdf').stat.size = 10 * 1024 * 1024;
  app.vault.readBinary = async () => { assert.fail('The picked file already leaves too little room'); };
  const { plugin, view, chat } = chatView(app);
  const requests = transport(() => response('anthropic', [text('ok')]));
  const file = { id: 'picked', fileName: 'Picked.pdf', mediaType: 'application/pdf', data: 'A'.repeat(12 * 1024 * 1024), sizeBytes: 9 * 1024 * 1024 };
  const images = [{ id: 'picked-image', fileName: 'Small.png', mediaType: 'image/png', data: 'eA==', sizeBytes: 1 }];
  const selection = { filePath: 'Untitled.md', text: 'Original' };
  await view.handleUserMessage('Compare [[Linked.pdf]]', selection, images, [file]);
  assert.deepEqual(chat.draft, { text: 'Compare [[Linked.pdf]]', selection, images, files: [file] });
  assert.equal(plugin.chatHistory.some(row => row.type === 'user'), false);
  assert.equal(chat.shown.some(row => row.type === 'user'), false);
  assert.equal(plugin.agent.isEmpty(), true);
  assert.equal(requests.length, 0);
  await view.handleUserMessage('Read only the picked document', selection, images, [file]);
  assert.equal(requests.length, 1);
  assert.equal(plugin.chatHistory.filter(row => row.type === 'user').length, 1);
});
