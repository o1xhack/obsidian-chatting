// Typing while an answer runs: the message is added to the running turn
// (taken in after the current step), or runs next if the turn has no step
// left; Stop and Clear drop it. Works without streaming: steps are
// separate requests. Through the real plugin and chat view with a fake
// Svelte component.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, result, response, transport, vaultApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    queued: [],
    askUser: null,
    addUserMessage(value, images = [], turnId) { chat.shown.push({ id: nextId++, type: 'user', text: value, turnId }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {},
    showAskUser(question) { chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, updateConversations() {}, setContinue() {}, clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {},
    setSelection() {}, getSelection: () => null, setQueued(texts) { chat.queued = texts; },
  };
  return chat;
}

async function chatSetup(provider) {
  const { app } = vaultApp();
  app.vault.adapter = { append: async () => {}, read: async () => { throw new Error('ENOENT'); }, exists: async () => false, write: async () => {} };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings(provider));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { plugin, view, chat };
}

test('Sent while a tool step runs: queued, then taken in with the next step, in the same turn', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  let releaseFirst;
  const requests = transport((body, index) => index === 0
    ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
    : response('anthropic', [text('Added both.')]));
  const turn = view.handleUserMessage('Add a Notes section', null);
  while (!releaseFirst) await tick();

  await view.handleUserMessage('Also add notes-notes', null);
  assert.deepEqual(chat.queued, ['Also add notes-notes']);
  releaseFirst();
  await turn;

  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /\[The user added while you were working:\] Also add notes-notes/);
  assert.deepEqual(chat.queued, []);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Add a Notes section', true], ['Also add notes-notes', false]]);
  assert.deepEqual(chat.shown.filter((m) => m.type === 'user').map((m) => m.text), ['Add a Notes section', 'Also add notes-notes']);
  assert.equal(plugin.chatHistory.at(-1).text, 'Added both.');
});

test('Sent during a turn without another step: runs as the next turn once the answer is in', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  let releaseFirst;
  const requests = transport((body, index) => index === 0
    ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [text('First.')])); })
    : response('anthropic', [text('Second.')]));
  const turn = view.handleUserMessage('First', null);
  while (!releaseFirst) await tick();
  await view.handleUserMessage('Second', null);
  releaseFirst();
  await turn;
  while (requests.length < 2 || view.running) await tick();

  assert.deepEqual(chat.queued, []);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]), [['First', true], ['Second', true]]);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'assistant').map((e) => e.text), ['First.', 'Second.']);
});

test('Clear during a turn drops what was added: no queued chips, nothing runs in the cleared chat', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  let releaseFirst;
  const requests = transport((body, index) => index === 0
    ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [text('First.')])); })
    : response('anthropic', [text('Should not run.')]));
  const turn = view.handleUserMessage('First', null);
  while (!releaseFirst) await tick();
  await view.handleUserMessage('Also this', null);
  view.clearConversation();
  assert.deepEqual(chat.queued, []);
  releaseFirst();
  await turn;
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 1);
  assert.deepEqual(plugin.chatHistory, []);
});

test('Stop drops what was added; nothing runs afterwards', async () => {
  const { view, chat } = await chatSetup('anthropic');
  let started = false;
  const requests = transport(() => { started = true; return new Promise(() => {}); });
  void view.handleUserMessage('First', null);
  while (!started) await tick();
  await view.handleUserMessage('Also this', null);
  assert.deepEqual(chat.queued, ['Also this']);
  view.handleStop();
  await tick();
  assert.deepEqual(chat.queued, []);
  assert.equal(requests.length, 1);
});

test('Typed in the last step allowed: not shown as taken in, it runs as the next turn', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  plugin.agent.settings.maxIterations = 1;
  let releaseFirst;
  const requests = transport((body, index) => index === 0
    ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
    : response('anthropic', [text('Extra done.')]));
  const turn = view.handleUserMessage('Read it', null);
  while (!releaseFirst) await tick();
  await view.handleUserMessage('Also extra', null);
  releaseFirst();
  await turn;
  while (requests.length < 2 || view.running) await tick();
  // The second request is its own turn, not an addition to the first.
  assert.doesNotMatch(JSON.stringify(requests[0]), /The user added while you were working/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]), [['Read it', true], ['Also extra', true]]);
  assert.equal(plugin.chatHistory.at(-1).text, 'Extra done.');
});

test('Typed while a message is checked, then that message is refused: both go back to the input, nothing runs', async () => {
  const { view, chat, plugin } = await chatSetup('anthropic');
  chat.restoreDraft = (value) => { chat.draft = value; };
  const requests = transport(() => response('anthropic', [text('Should not run.')]));
  const huge = { id: 'big', fileName: 'big.png', mediaType: 'image/png', sizeBytes: 22 * 1024 * 1024, data: 'A'.repeat(30 * 1024 * 1024) };
  const turn = view.handleUserMessage('Look at this', null, [huge]);
  await view.handleUserMessage('and compare with last week', null);
  await turn;
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(requests.length, 0);
  assert.equal(chat.draft, 'Look at this\n\nand compare with last week');
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user'), []);
});

test('Cutting the API history never starts at tool results that carry an added message', () => {
  const messages = [
    { role: 'user', content: 'Q1', turnId: 't1' },
    { role: 'assistant', content: [call('r1', 'read_file', { path: 'Untitled.md' })] },
    // Even with a turn ID, tool results with an added message start no turn.
    { role: 'user', content: [result('r1', 'Original'), text('[The user added while you were working:] Also this')], turnId: 'added' },
    { role: 'assistant', content: [text('A1')] },
    { role: 'user', content: 'Q2', turnId: 't2' },
    { role: 'assistant', content: [text('A2')] },
  ];
  // The cut can't fall inside turn 1: that message can't be edited, and cutting there keeps the history.
  assert.equal(api.editableTurn(messages, 'added'), false);
  assert.equal(api.cutBeforeTurn(messages, 'added'), messages);
  assert.equal(api.cutBeforeTurn(messages, 't2').length, 4);
});
