// The chat view and the plugin's chat commands with a fake Svelte component:
// the API history cap, what the chat history saves, Stop and Clear, a
// streamed answer, Copy transcript, and commands waiting for the view.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, image, response, transport, vaultApp, callbacks, streamEvents, sseText } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
});

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    askUser: null,
    addUserMessage(value, images = [], turnId) { chat.shown.push({ id: nextId++, type: 'user', text: value, images, turnId }); },
    cutMessages(turnId) { const at = chat.shown.findIndex(row => row.turnId === turnId); if (at !== -1) chat.shown.splice(at); },
    restoreDraft(text, selection, images, files) { chat.draft = { text, selection, images, files }; },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {},
    showAskUser(question) { chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {},
    setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin that loads `saved` as its chat-state.json (none when undefined),
// records its writes, and has a chat view with a fake component.
async function chatSetup(provider, saved) {
  const { app } = vaultApp();
  const writes = [];
  app.vault.adapter = {
    append: async () => {},
    read: async () => { if (!saved) throw new Error('ENOENT'); return JSON.stringify(saved); },
    // exists() and the path check are for the chat saving fix (PR #10),
    // which checks for the file before reading and writes a copy next to it.
    exists: async () => !!saved,
    write: async (path, data) => { if (path.endsWith('/chat-state.json')) writes.push(JSON.parse(data)); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings(provider));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { app, plugin, view, chat, writes };
}

// Waits until `condition()` holds (the view sends and saves without
// awaiting); fails after about a second.
async function until(condition) {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), 'timed out');
}

const answering = provider => transport((body, index) => response(provider, [text(`A${index + 1}`)]));

test('The API history keeps up to 80 messages when saved and loaded, with its images; past 80 a turn cuts it to 60', async () => {
  const { plugin, view, writes } = await chatSetup('anthropic');
  const requests = answering('anthropic');
  const messages = [];
  for (let i = 0; i < 35; i++) {
    const content = i === 0 ? [{ type: 'image', image: { ...image, id: 'old-image' } }, text(`Q${i}`)] : `Q${i}`;
    messages.push({ role: 'user', content }, { role: 'assistant', content: [text(`A${i}`)] });
  }
  plugin.agent.importMessages(messages);
  assert.equal(plugin.agent.exportMessages().length, 70);

  await view.handleUserMessage('Next', null);
  assert.equal(requests[0].messages.length, 71);

  // Saved and loaded again: the oldest turn and its image are still there.
  await until(() => writes.length === 1);
  const restored = await chatSetup('anthropic', JSON.parse(JSON.stringify(writes[0])));
  const history = restored.plugin.agent.exportMessages();
  assert.equal(history.length, 72);
  assert.equal(history[0].content[0].image.data, image.data);

  // Up to 80 messages, nothing is cut.
  for (let i = 0; i < 4; i++) await restored.view.handleUserMessage(`More ${i}`, null);
  assert.equal(requests.at(-1).messages.length, 79);
  assert.equal(restored.plugin.agent.exportMessages().length, 80);
  // Past 80, whole turns are cut from the start, down to 60 messages.
  await restored.view.handleUserMessage('More 4', null);
  assert.equal(requests.at(-1).messages.length, 61);
  const cut = restored.plugin.agent.exportMessages();
  assert.equal(cut.length, 62);
  assert.equal(cut[0].content, 'Q10');
});

test('OpenAI keeps chaining once the history is past 80 messages: it is cut every few turns, not on each', async () => {
  const agent = new api.AgentLoop(vaultApp().app, settings('openai'));
  const messages = [];
  for (let i = 0; i < 40; i++) messages.push({ role: 'user', content: `Q${i}` }, { role: 'assistant', content: [text(`A${i}`)] });
  agent.importMessages(messages);
  const requests = transport((body, index) => response('openai', [text(`A${index}`)], 'end_turn', index));
  for (let i = 0; i < 3; i++) await agent.run(`More ${i}`, callbacks());
  // The first turn cuts the history to 60 (a new array: sent in full); the
  // next turns add to the same array and chain to the previous response.
  assert.equal(requests[0].previous_response_id, undefined);
  assert.equal(requests[1].previous_response_id, 'resp_0');
  assert.equal(requests[2].previous_response_id, 'resp_1');
  assert.equal(requests[2].input.length, 1);
});

test('Tool cards keep their (capped) input across a reload', async () => {
  const { plugin, view, writes } = await chatSetup('anthropic');
  const keys = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`k${i}`, i]));
  const note = `${'x'.repeat(299)}\u{1F600}${'y'.repeat(700)}`;
  const input = { path: 'Untitled.md', note, lines: Array.from({ length: 15 }, (_, i) => i), nested: { list: ['a'] }, keys };
  transport((body, index) => index === 0
    ? response('anthropic', [call('r', 'read_file', input)], 'tool_use')
    : response('anthropic', [text('Read it')]));
  await view.handleUserMessage('Read the note', null);
  const card = plugin.chatHistory.find(e => e.type === 'tool-result');
  assert.equal(card.toolInput.path, 'Untitled.md');
  // Cut before the emoji, not through it.
  assert.equal(card.toolInput.note, `${'x'.repeat(299)}... (1001 characters)`);
  assert.deepEqual(card.toolInput.lines, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, '... (5 more)']);
  assert.deepEqual(card.toolInput.nested, { list: ['a'] });
  assert.equal(Object.keys(card.toolInput.keys).length, 21);
  assert.equal(card.toolInput.keys.k19, 19);
  assert.equal(card.toolInput.keys['...'], '(5 more)');
  // The API history keeps the full input.
  assert.equal(plugin.agent.exportMessages()[1].content[0].input.note, note);

  await until(() => writes.length === 1);
  const restored = await chatSetup('anthropic', JSON.parse(JSON.stringify(writes[0])));
  assert.deepEqual(restored.plugin.chatHistory.find(e => e.type === 'tool-result').toolInput, card.toolInput);
});

test('An ask_user question and its answer stay in the chat history across a reload', async () => {
  const { plugin, view, chat, writes } = await chatSetup('anthropic');
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { question: 'Which note?' })], 'tool_use')
    : response('anthropic', [text(`A${index + 1}`)]));
  const asking = view.handleUserMessage('Q1', null);
  await until(() => chat.askUser);
  chat.addUserMessage('The plan');
  chat.askUser('The plan');
  await asking;
  assert.equal(requests.length, 2);
  const shown = [['user', 'Q1'], ['assistant', 'Which note?'], ['user', 'The plan'], ['assistant', 'A2']];
  assert.deepEqual(chat.shown.map(m => [m.type, m.text]), shown);
  assert.deepEqual(plugin.chatHistory.map(e => [e.type, e.text]), shown);

  await until(() => writes.length === 1);
  const restored = await chatSetup('anthropic', JSON.parse(JSON.stringify(writes[0])));
  assert.deepEqual(restored.plugin.chatHistory.map(e => [e.type, e.text]), shown);
});

for (const action of ['Stop', 'Clear']) {
  test(`${action} while ask_user waits drops the question: the next message starts a new turn`, async () => {
    const { plugin, view, chat } = await chatSetup('anthropic');
    const requests = transport((body, index) => index === 0
      ? response('anthropic', [call('ask', 'ask_user', { question: 'Which note?' })], 'tool_use')
      : response('anthropic', [text('A2')]));
    const asking = view.handleUserMessage('Q1', null);
    await until(() => chat.askUser);

    if (action === 'Stop') view.handleStop(); else view.clearConversation();
    // No answer is pending, so typed text is sent as a new message.
    assert.equal(chat.askUser, null);
    await asking;
    assert.equal(view.running, false);
    await view.handleUserMessage('Q2', null);
    assert.equal(requests.length, 2);
    const sent = JSON.stringify(requests[1].messages);
    assert.equal(sent.includes('Q1'), action === 'Stop');
    // A stopped call keeps its cancelled result, so the history stays valid.
    assert.equal(sent.includes('Tool execution cancelled before completion.'), action === 'Stop');
    assert.deepEqual(plugin.chatHistory.map(e => [e.type, e.text]), [
      ...(action === 'Stop' ? [['user', 'Q1'], ['assistant', 'Which note?']] : []),
      ['user', 'Q2'], ['assistant', 'A2'],
    ]);
  });
}

test('A streamed answer grows in one message; Stop keeps what arrived, in the chat and its history', async () => {
  api.resetStreamTransport();
  const { plugin, view, chat } = await chatSetup('anthropic');
  const events = streamEvents('anthropic', [text('Partial answer')]);
  const open = events.slice(0, events.findIndex(event => event.type === 'content_block_stop'));
  // The answer's first text arrives, then the stream stays open.
  globalThis.__fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sseText(open))); } }), { status: 200 });
  try {
    const turn = view.handleUserMessage('Q', null);
    await until(() => chat.shown.some(m => m.type === 'assistant' && m.text === 'Partial answer'));
    view.handleStop();
    await turn;
    const shown = [['user', 'Q'], ['assistant', 'Partial answer']];
    assert.deepEqual(chat.shown.map(m => [m.type, m.text]), shown);
    // Text on screen: no "Stopped." row.
    assert.deepEqual(plugin.chatHistory.map(e => [e.type, e.text]), shown);
  } finally {
    delete globalThis.__fetch;
  }
});

test('Regenerate, then Stop while the new answer streams: the streamed text stays, the old answer does not come back', async () => {
  api.resetStreamTransport();
  const { plugin, view, chat } = await chatSetup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Q', null);
  // The first answer came through requestUrl (fetch looked blocked): fetch again now.
  api.resetStreamTransport();
  const events = streamEvents('anthropic', [text('New partial')]);
  const open = events.slice(0, events.findIndex(event => event.type === 'content_block_stop'));
  globalThis.__fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sseText(open))); } }), { status: 200 });
  try {
    const turn = view.regenerate();
    await until(() => chat.shown.some(m => m.type === 'assistant' && m.text === 'New partial'));
    view.handleStop();
    await turn;
    assert.deepEqual(plugin.chatHistory.map(e => [e.type, e.text]), [['user', 'Q'], ['assistant', 'New partial']]);
  } finally {
    delete globalThis.__fetch;
  }
});

test('Copy transcript: refused while the conversation is empty, else its Markdown, also with the chat panel closed', async () => {
  const { plugin, view } = await chatSetup('anthropic');
  answering('anthropic');
  // No chat view open.
  plugin.app.workspace.getLeavesOfType = () => [];
  const copied = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async value => { copied.push(value); } } } });
  try {
    plugin.shareTranscript();
    assert.deepEqual(globalThis.__notices, ['Conversation is empty.']);
    assert.deepEqual(copied, []);
    await view.handleUserMessage('Question', null);
    plugin.shareTranscript();
    await until(() => globalThis.__notices.at(-1) === 'Transcript copied to clipboard.');
    assert.match(copied[0], /## Conversation\n\n### User\n\n[\s\S]*Question\n\n### Assistant\n\nA1/);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator;
  }
});

test('Commands act on the chat view as soon as its UI is mounted, not after a fixed delay', async () => {
  const { plugin, view, chat, app } = await chatSetup('anthropic');
  plugin.isProviderConfigured = () => true;
  const revealed = [];
  app.workspace.getLeavesOfType = () => [{ view }];
  app.workspace.revealLeaf = async leaf => { revealed.push(leaf); };
  const selected = [];
  chat.setSelection = selection => selected.push(selection);

  const opening = plugin.openChatWithSelection({ text: 'Words', filePath: 'Plan.md' });
  await until(() => revealed.length === 1);
  // Revealed, but the UI isn't mounted yet: the command waits.
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(selected, []);
  view.markReady();
  await opening;
  assert.deepEqual(selected, [{ text: 'Words', filePath: 'Plan.md' }]);

  const requests = answering('anthropic');
  await plugin.openChatWithMessage('Tell me about Plan.md');
  await until(() => !view.running);
  assert.equal(requests.length, 1);
  assert.equal(chat.shown[0].text, 'Tell me about Plan.md');
});

test('A view whose UI fails to mount is still ready, so commands waiting for it go on; sending only shows a notice', async () => {
  const { plugin } = await chatSetup('anthropic');
  const view = new api.ObsidianChatView({}, plugin);
  view.mountChat = () => { throw new Error('mount failed'); };
  await assert.rejects(view.onOpen(), /mount failed/);
  let timer;
  const ready = await Promise.race([view.ready.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
  clearTimeout(timer);
  assert.equal(ready, true);
  // Without the UI, sending does nothing (and leaves the view usable).
  const requests = answering('anthropic');
  await view.handleUserMessage('Hello', null);
  assert.equal(view.running, false);
  assert.equal(requests.length, 0);
  assert.deepEqual(globalThis.__notices, ["The chat panel couldn't be shown, so the message wasn't sent."]);
});

// Passes before this change too: it guards the refactor that made Clear
// stop the turn through AgentLoop.clear() alone.
test('Clear stops a running turn on its own; the stopped turn adds nothing', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  let answer;
  const requests = transport(() => new Promise(resolve => { answer = resolve; }));
  const running = view.handleUserMessage('Q1', null);
  await until(() => answer);
  view.clearConversation();
  answer(response('anthropic', [call('r', 'read_file', { path: 'Untitled.md' })], 'tool_use'));
  await running;
  assert.equal(requests.length, 1);
  assert.equal(plugin.agent.isEmpty(), true);
  assert.deepEqual(plugin.chatHistory, []);
  assert.deepEqual(chat.shown, []);
});


for (const action of ['Stop', 'Clear']) {
  test(`${action}: an old request completing does not unlock a newer running turn`, async () => {
    const { view, chat } = await chatSetup('anthropic');
    const pending = [];
    chat.setInputEnabled = enabled => { chat.enabled = enabled; };
    transport(() => new Promise(resolve => pending.push(resolve)));
    const old = view.handleUserMessage('Old', null);
    await until(() => pending.length === 1);
    if (action === 'Stop') view.handleStop(); else view.clearConversation();
    const next = view.handleUserMessage('Next', null);
    await until(() => pending.length === 2);
    pending[0](response('anthropic', [text('late old answer')]));
    await old;
    assert.equal(view.running, true);
    assert.equal(chat.enabled, false);
    pending[1](response('anthropic', [text('new answer')]));
    await next;
    assert.equal(view.running, false);
    assert.equal(chat.enabled, true);
  });
}

test('Closing the view releases a pending ask_user turn', async () => {
  const { view, chat } = await chatSetup('anthropic');
  transport(() => response('anthropic', [call('ask', 'ask_user', { question: 'Which?' })], 'tool_use'));
  const asking = view.handleUserMessage('Ask', null);
  await until(() => chat.askUser);
  await view.onClose();
  assert.equal(chat.askUser, null);
  await asking;
  assert.equal(view.running, false);
});

test('An over-budget attachment turn preserves pending undo notes and leaves the view usable', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  plugin.activeConversation.notes = ['The user undid the previous edit.'];
  const file = { id: 'big', fileName: 'Big.pdf', mediaType: 'application/pdf', data: 'A'.repeat(12 * 1024 * 1024), sizeBytes: 9 * 1024 * 1024 };
  const requests = answering('anthropic');
  await view.handleUserMessage('Read these', null, [], [file, { ...file, id: 'big2' }]);
  assert.equal(requests.length, 0);
  assert.equal(view.running, false);
  assert.equal(plugin.agent.isEmpty(), true);
  assert.deepEqual(plugin.activeConversation.notes, ['The user undid the previous edit.']);
  assert.match(chat.shown.at(-1).text, /20 MB encoded attachment limit/);
  await view.handleUserMessage('Try a smaller message', null);
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /The user undid the previous edit/);
});

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: final request-size rejection rolls back both histories and restores the unsent draft`, async () => {
    api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
    const { plugin, view, chat } = await chatSetup(provider);
    const file = { id: 'pdf', fileName: 'TenMiB.pdf', mediaType: 'application/pdf', sizeBytes: 10 * 1024 * 1024, data: 'A'.repeat(4 * Math.ceil(10 * 1024 * 1024 / 3)) };
    plugin.agent.importMessages([
      { role: 'user', turnId: 'old1', content: [{ type: 'file', file }, text('Old one')] },
      { role: 'assistant', content: [text('Read one')] },
      { role: 'user', turnId: 'old2', content: [{ type: 'file', file: { ...file, id: 'old2-pdf' } }, text('Old two')] },
      { role: 'assistant', content: [text('Read two')] },
    ]);
    plugin.chatHistory.push({ type: 'user', text: 'Old one', turnId: 'old1' }, { type: 'assistant', text: 'Read one' }, { type: 'user', text: 'Old two', turnId: 'old2' }, { type: 'assistant', text: 'Read two' });
    plugin.activeConversation.notes = ['The user undid an earlier edit.'];
    const requests = answering(provider);
    const current = { ...file, id: 'new-pdf' };
    const selection = { filePath: 'Untitled.md', text: 'Original' };
    await view.handleUserMessage('Too large with history', selection, [], [current]);
    assert.equal(requests.length, 0);
    assert.equal(plugin.agent.exportMessages().length, 4);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user').length, 2);
    assert.equal(chat.shown.some(row => row.type === 'user' && row.text === 'Too large with history'), false);
    assert.equal(chat.draft.text, 'Too large with history');
    assert.equal(chat.draft.files[0], current);
    assert.equal(chat.draft.selection, selection);
    assert.deepEqual(plugin.activeConversation.notes, ['The user undid an earlier edit.']);
    assert.match(chat.shown.at(-1).text, /30 MB chat limit/);
    assert.equal(view.running, false);
    await view.handleUserMessage('A small retry without new files', null);
    assert.equal(requests.length, 1);
    assert.equal(plugin.agent.exportMessages().filter(row => row.role === 'user').length, 3);
    assert.equal(plugin.activeConversation.notes, undefined);
  });
}


for (const action of ['Stop', 'Clear', 'Stop and new send']) {
  test(`${action} during linked preflight handles the draft immediately and ignores stale completion`, async () => {
    const { app, plugin, view, chat } = await chatSetup('anthropic');
    let release;
    let reading = false;
    const file = { path: 'Hold.md', extension: 'md' };
    app.metadataCache = { getFirstLinkpathDest: () => file };
    const originalRead = app.vault.cachedRead;
    app.vault.cachedRead = async item => {
      if (item.path !== file.path) return originalRead(item);
      reading = true;
      return new Promise(resolve => { release = resolve; });
    };
    const requests = answering('anthropic');
    const selection = null;
    const images = [{ ...image }];
    const files = [{ id: 'text', fileName: 'File.txt', mediaType: 'text/plain', sizeBytes: 4, data: '', text: 'Data' }];
    plugin.activeConversation.notes = ['Pending undo note'];
    const pending = view.handleUserMessage('Read [[Hold]]', selection, images, files);
    await until(() => reading);
    if (action === 'Clear') {
      view.clearConversation();
      assert.equal(chat.draft, undefined);
    } else {
      view.handleStop();
      assert.deepEqual(chat.draft, { text: 'Read [[Hold]]', selection, images, files });
      assert.deepEqual(plugin.activeConversation.notes, ['Pending undo note']);
      if (action === 'Stop and new send') {
        chat.draft = { text: 'New draft' };
        await view.handleUserMessage('Next question', null);
        assert.match(JSON.stringify(requests[0]), /Pending undo note/);
      }
    }
    release('Loaded later');
    await pending;
    assert.equal(requests.length, action === 'Stop and new send' ? 1 : 0);
    if (action === 'Stop and new send') {
      assert.deepEqual(chat.draft, { text: 'New draft' });
      assert.equal(plugin.activeConversation.notes, undefined, 'late cancellation cannot reintroduce consumed notes');
    }
    if (action === 'Clear') assert.equal(plugin.activeConversation.notes, undefined);
    assert.equal(plugin.chatHistory.some(row => row.type === 'user' && row.text === 'Read [[Hold]]'), false);
  });
}
