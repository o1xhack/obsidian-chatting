// Named conversations: the saved chats (version 4: the index in
// chat-state.json and a file per chat) and the one-time migrations to it,
// restoring the active conversation, titles, what each chat file keeps,
// chats read when opened, unlisted files added back and deleted ones gone;
// new chat, switching, renaming and deleting through the
// chat view, and that histories and OpenAI chaining stay within their
// conversation; a turn that goes on in the background (its question waits
// for the return, notices, deleting the chat stops it); the commands that
// start a new chat. Through the real plugin and chat view with a fake
// Svelte component.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, response, transport, vaultApp, chatFiles, PLUGIN_DIR as DIR } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
});

const { CHAT_STATE_VERSION, migrateChatState, conversationTitle, NEW_CHAT_TITLE } = api.chatState;

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    askUser: null,
    busy: false,
    addUserMessage(value, images = [], turnId) { chat.shown.push({ id: nextId++, type: 'user', text: value, images, turnId }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId); if (index >= 0) chat.shown.splice(index); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {},
    showAskUser(question) { if (question !== undefined) chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy(value) { chat.busy = value; }, foldTurn() {}, updateConversations() {}, setContinue() {}, setQueued() {},
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {},
    title: null, setTitle(value) { chat.title = value; },
    setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin that loads `saved` as its saved chats (none when undefined; a
// whole version 4 state is split into the index and its chat files),
// records the saved states whole, and has a chat view with a fake component.
async function setup(provider, saved) {
  const { app } = vaultApp();
  const { adapter, writes } = chatFiles(saved);
  app.vault.adapter = adapter;
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  // New conversations' agent loops use the plugin's settings.
  plugin.settings = { ...plugin.settings, ...settings(provider) };
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { app, plugin, view, chat, writes, files: adapter.stored };
}

// Answers each request with "A<n>" (n counts requests).
const answering = provider => transport((body, index) => response(provider, [text(`A${index + 1}`)], 'end_turn', index));
// Anthropic request: the user turns' texts, without the context prefix.
const userTurns = body => body.messages.filter(m => m.role === 'user' && (typeof m.content === 'string' || m.content.some(b => b.type === 'text')))
  .map(m => (typeof m.content === 'string' ? m.content : m.content.find(b => b.type === 'text').text).split('\n').at(-1));
const texts = entries => entries.map(e => e.text);
// OpenAI request: the texts of its input items, without the context prefix.
const inputTexts = body => body.input.flatMap(item => item.content ?? []).map(part => part.text.split('\n').at(-1));
const titles = plugin => plugin.listConversations().map(c => c.title);
// The list is ordered by last use, in ms: lets the next turn start later.
const tick = () => new Promise(resolve => setTimeout(resolve, 2));
// A saved conversation with one question and its answer.
const record = (id, question, updatedAt, extra = {}) => ({
  id, title: question, customTitle: false, createdAt: 1, updatedAt,
  chatHistory: [{ type: 'user', text: question, turnId: `${id}-t` }, { type: 'assistant', text: `${question} answer` }],
  agentMessages: [{ role: 'user', content: `ctx\n\n${question}`, turnId: `${id}-t` }, { role: 'assistant', content: [text(`${question} answer`)] }],
  ...extra,
});
const version3 = (activeConversationId, conversations) => ({ version: 3, savedAt: 1, activeConversationId, conversations });

for (const existing of [false, true]) {
test(`Switching during a mention read cannot start the old turn in the new conversation (existing history: ${existing})`, async () => {
  const { app, plugin, view } = await setup('anthropic', existing ? version3('old', [record('old', 'Earlier topic', 1)]) : undefined);
  const file = { path: 'Hold.md', extension: 'md' };
  let release;
  let entered;
  const reading = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  app.metadataCache = { getFirstLinkpathDest: () => file };
  const originalRead = app.vault.cachedRead;
  app.vault.cachedRead = async item => {
    if (item.path !== 'Hold.md') return originalRead(item);
    entered();
    await held;
    return 'Mention contents';
  };
  const requests = answering('anthropic');
  const first = plugin.activeConversation;
  const pending = view.handleUserMessage('Read [[Hold]]', null);
  await reading;
  view.newChat();
  const second = plugin.activeConversation;
  // An empty chat can be reused because preflight hasn't created a turn;
  // an existing conversation must still switch to a separate empty chat.
  if (existing) assert.notEqual(first, second);
  else assert.equal(first, second);
  release();
  await pending;
  assert.equal(requests.length, 0);
  assert.equal(first.chatHistory.some(row => row.text === 'Read [[Hold]]'), false);
  assert.deepEqual(second.agentMessages, []);
  await view.handleUserMessage('New topic', null);
  assert.deepEqual(userTurns(requests[0]), ['New topic']);
});
}

test('A version 1 or 2 chat becomes the first, active conversation, once', async () => {
  const chatHistory = [{ type: 'user', text: 'Old question', turnId: 't1' }, { type: 'assistant', text: 'Old answer' }];
  const agentMessages = [{ role: 'user', content: 'ctx\n\nOld question', turnId: 't1' }, { role: 'assistant', content: [text('Old answer')] }];
  for (const saved of [{ chatHistory, agentMessages }, { version: 2, savedAt: 5, chatHistory, agentMessages }]) {
    const state = migrateChatState(JSON.parse(JSON.stringify(saved)));
    assert.equal(state.conversations.length, 1);
    const [conversation] = state.conversations;
    assert.equal(state.activeConversationId, conversation.id);
    assert.equal(conversation.title, 'Old question');
    assert.equal(conversation.customTitle, false);
    assert.deepEqual(texts(conversation.chatHistory), ['Old question', 'Old answer']);
    assert.equal(conversation.agentMessages.length, 2);
  }

  const { plugin, view, writes } = await setup('anthropic', { version: 2, chatHistory, agentMessages });
  assert.deepEqual(texts(plugin.chatHistory), ['Old question', 'Old answer']);
  const requests = answering('anthropic');
  await view.handleUserMessage('Next', null);
  assert.deepEqual(userTurns(requests[0]), ['Old question', 'Next']);
  const saved = writes.at(-1);
  assert.equal(saved.version, CHAT_STATE_VERSION);
  assert.equal(saved.version, 4);
  assert.equal(saved.conversations.length, 1);
  assert.equal(saved.activeConversationId, plugin.activeConversationId);
  assert.equal('chatHistory' in saved, false);
  assert.equal('agentMessages' in saved, false);
  // The index isn't migrated again: the same conversation, the same ID, waiting for its file.
  assert.deepEqual(migrateChatState(saved).conversations.map(c => [c.id, c.unloaded]), [[saved.activeConversationId, true]]);
});

test('The active conversation is restored on load, with its own API history; the others are kept as they were', async () => {
  const saved = version3('b', [record('a', 'Topic A', 2), record('b', 'Topic B', 1)]);
  const { plugin, view, writes } = await setup('anthropic', saved);
  assert.equal(plugin.activeConversationId, 'b');
  assert.deepEqual(texts(plugin.chatHistory), ['Topic B', 'Topic B answer']);

  const requests = answering('anthropic');
  await view.handleUserMessage('Back to B', null);
  assert.deepEqual(userTurns(requests[0]), ['Topic B', 'Back to B']);
  await plugin.saveChatHistory();
  const written = writes.at(-1);
  assert.equal(written.activeConversationId, 'b');
  assert.deepEqual(written.conversations.map(c => c.id), ['a', 'b']);
  const { size, metadataSavedAt, ...a } = written.conversations[0];
  assert.deepEqual(a, { ...saved.conversations[0], automaticTitle: 'Topic A', titleSourceTurnId: 'a-t' });
  assert.ok(size > 0);
  assert.deepEqual(texts(written.conversations[1].chatHistory), ['Topic B', 'Topic B answer', 'Back to B', 'A1']);
  assert.equal(written.conversations[1].agentMessages.length, 4);
});

test('Loading: an unknown active ID opens the most recent conversation; entries without an ID are dropped; none leaves one empty conversation', () => {
  const state = migrateChatState(version3('gone', [record('old', 'Old', 1), { title: 'No ID' }, record('new', 'New', 9), 'junk']));
  assert.deepEqual(state.conversations.map(c => c.id), ['old', 'new']);
  assert.equal(state.activeConversationId, 'new');

  const empty = migrateChatState({ version: 3, conversations: [] });
  assert.equal(empty.conversations.length, 1);
  assert.equal(empty.activeConversationId, empty.conversations[0].id);
  assert.equal(empty.conversations[0].title, NEW_CHAT_TITLE);
  assert.deepEqual(empty.conversations[0].chatHistory, []);
});

test('Titles: first user message, one line, at most 40 characters; a renamed title stays', () => {
  const long = 'Please   summarise\nthe meeting notes from yesterday and list every open action item';
  assert.equal(conversationTitle([{ type: 'user', text: long }]), 'Please summarise the meeting notes from…');
  assert.equal(conversationTitle([{ type: 'user', text: long }]).length, 40);
  assert.equal(conversationTitle([{ type: 'user', text: '', images: [{ fileName: 'photo.jpg' }] }]), 'photo.jpg');
  assert.equal(conversationTitle([{ type: 'assistant', text: 'Hi' }]), NEW_CHAT_TITLE);
  assert.equal(conversationTitle([]), NEW_CHAT_TITLE);

  // Saved titles survive history caps; a custom name remains distinct.
  const state = migrateChatState(version3('a', [
    record('a', 'Question', 1, { title: 'Stale title' }),
    record('b', 'Question', 2, { title: 'My name', customTitle: true }),
  ]));
  assert.deepEqual(state.conversations.map(c => [c.title, c.customTitle]), [['Stale title', false], ['My name', true]]);
});

test('Each conversation is saved whole: every visible entry, the API history from its last compaction on; empty ones only while active', async () => {
  const { plugin, view, writes } = await setup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Current', null);
  const big = api.chatState.newConversation(1);
  for (let i = 0; i < 60; i++) {
    big.chatHistory.push({ type: 'user', text: `Q${i}`, turnId: `t${i}` }, { type: 'assistant', text: `A${i}` });
    big.agentMessages.push({ role: 'user', content: `Q${i}`, turnId: `t${i}` }, { role: 'assistant', content: [text(`A${i}`)] });
  }
  plugin.conversations.push(big, api.chatState.newConversation(2));
  await plugin.saveChatHistory();
  const saved = () => writes.at(-1).conversations.find(c => c.id === big.id);
  assert.equal(writes.at(-1).conversations.length, 2);
  assert.equal(saved().chatHistory.length, 120);
  assert.equal(saved().agentMessages.length, 120);

  // A compaction with a readable summary: what it covers isn't kept.
  big.agentMessages[101].compaction = { summary: 'Earlier' };
  await plugin.saveChatHistory();
  assert.equal(saved().agentMessages.length, 19);
  assert.equal(saved().agentMessages[0].compaction.summary, 'Earlier');
  assert.equal(saved().chatHistory.length, 120);
  // An encrypted one (no summary) keeps what it covers, from the compaction before it on.
  big.agentMessages[111].compaction = {};
  await plugin.saveChatHistory();
  assert.equal(saved().agentMessages.length, 19);
  assert.equal(saved().agentMessages[0].compaction.summary, 'Earlier');
  // In memory nothing is cut.
  assert.equal(big.agentMessages.length, 120);

  // A fresh start: the active conversation is saved even while empty.
  const fresh = await setup('anthropic');
  await fresh.plugin.saveChatHistory();
  assert.equal(fresh.writes[0].conversations.length, 1);
  assert.equal(fresh.writes[0].activeConversationId, fresh.plugin.activeConversationId);
});

test('Each conversation\'s images come back from its own API history', async () => {
  const picture = id => ({ id, fileName: `${id}.png`, mediaType: 'image/png', data: `${id}-data`, sizeBytes: 7 });
  const withImage = (id, updatedAt) => {
    const image = picture(`${id}-image`);
    const { data: _data, ...saved } = image;
    return record(id, `Look ${id}`, updatedAt, {
      chatHistory: [{ type: 'user', text: `Look ${id}`, turnId: `${id}-t`, images: [saved] }],
      agentMessages: [{ role: 'user', content: [{ type: 'image', image }, text(`ctx\n\nLook ${id}`)], turnId: `${id}-t` }],
    });
  };
  const { plugin } = await setup('anthropic', version3('a', [withImage('a', 1), withImage('b', 2)]));
  assert.deepEqual(plugin.conversations.map(c => c.chatHistory[0].images[0].data), ['a-image-data', 'b-image-data']);
});

test('New chat, switch, rename and delete', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('First topic', null);
  const first = plugin.activeConversationId;
  assert.equal(chat.title, 'First topic');

  view.newChat();
  const second = plugin.activeConversationId;
  assert.notEqual(second, first);
  assert.deepEqual(chat.shown, []);
  assert.equal(chat.title, NEW_CHAT_TITLE);
  // An empty new chat isn't listed, and New chat again keeps it.
  assert.deepEqual(titles(plugin), ['First topic']);
  view.newChat();
  assert.equal(plugin.activeConversationId, second);

  await tick();
  await view.handleUserMessage('Second topic', null);
  assert.deepEqual(titles(plugin), ['Second topic', 'First topic']);
  assert.deepEqual(plugin.listConversations().map(c => c.active), [true, false]);

  await view.openConversation(first);
  assert.equal(plugin.activeConversationId, first);
  assert.deepEqual(texts(chat.shown), ['First topic', 'A1']);
  assert.equal(chat.title, 'First topic');
  assert.deepEqual(texts(plugin.chatHistory), ['First topic', 'A1']);

  // Rename: kept over later turns; an empty name goes back to the automatic title.
  await view.renameConversation(first, '  My   own name ');
  assert.equal(chat.title, 'My own name');
  await tick();
  await view.handleUserMessage('More', null);
  assert.deepEqual(titles(plugin), ['My own name', 'Second topic']);
  await view.renameConversation(first, '   ');
  assert.deepEqual(titles(plugin), ['First topic', 'Second topic']);
  assert.equal(chat.title, 'First topic');

  // Deleting another conversation leaves the current one alone.
  await view.deleteConversation(second);
  assert.equal(plugin.activeConversationId, first);
  assert.deepEqual(titles(plugin), ['First topic']);
  assert.deepEqual(texts(chat.shown), ['First topic', 'A1', 'More', 'A3']);
});

test('Deleting the current conversation opens the most recent other; deleting the last leaves an empty new one', async () => {
  const { plugin, view, chat, writes } = await setup('anthropic');
  const requests = answering('anthropic');
  await view.handleUserMessage('Older', null);
  const older = plugin.activeConversationId;
  view.newChat();
  await tick();
  await view.handleUserMessage('Newer', null);
  view.newChat();
  await tick();
  await view.handleUserMessage('Newest', null);

  await view.deleteConversation(plugin.activeConversationId);
  assert.deepEqual(texts(chat.shown), ['Newer', 'A2']);
  assert.deepEqual(titles(plugin), ['Newer', 'Older']);
  await view.deleteConversation(plugin.activeConversationId);
  assert.equal(plugin.activeConversationId, older);
  assert.deepEqual(texts(chat.shown), ['Older', 'A1']);

  await view.deleteConversation(older);
  assert.deepEqual(chat.shown, []);
  assert.equal(chat.title, NEW_CHAT_TITLE);
  assert.deepEqual(titles(plugin), []);
  assert.equal(plugin.conversations.length, 1);
  await plugin.saveChatHistory();
  const saved = writes.at(-1);
  assert.equal(saved.conversations.length, 1);
  assert.deepEqual(saved.conversations[0].chatHistory, []);
  assert.equal(saved.activeConversationId, plugin.activeConversationId);

  // The empty conversation works like a fresh chat.
  await view.handleUserMessage('Fresh', null);
  assert.deepEqual(userTurns(requests.at(-1)), ['Fresh']);
});

test('The conversation open last is the one restored after a reload, with its own API history', async () => {
  const first = await setup('anthropic');
  answering('anthropic');
  await first.view.handleUserMessage('Topic A', null);
  const a = first.plugin.activeConversationId;
  first.view.newChat();
  await tick();
  await first.view.handleUserMessage('Topic B', null);
  await first.view.openConversation(a);
  await first.plugin.saveChatHistory();

  const { plugin, view, chat } = await setup('anthropic', first.writes.at(-1));
  assert.equal(plugin.activeConversationId, a);
  view.renderHistory();
  assert.deepEqual(texts(chat.shown), ['Topic A', 'A1']);
  assert.deepEqual(titles(plugin), ['Topic B', 'Topic A']);
  const requests = answering('anthropic');
  await view.handleUserMessage('Back to A', null);
  assert.deepEqual(userTurns(requests[0]), ['Topic A', 'Back to A']);
});

test('Editing the first message updates the automatic title; a rename stays across a reload; Clear goes back to New chat', async () => {
  const { plugin, view, chat, writes } = await setup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Original question', null);
  await view.handleUserMessage('Follow-up', null);
  await view.editMessage(plugin.chatHistory[0].turnId, 'Edited question');
  assert.equal(plugin.activeConversation.title, 'Edited question');
  assert.equal(chat.title, 'Edited question');

  await view.renameConversation(plugin.activeConversationId, 'Named');
  await plugin.saveChatHistory();
  const restored = await setup('anthropic', writes.at(-1));
  assert.equal(restored.plugin.activeConversation.title, 'Named');
  assert.equal(restored.plugin.activeConversation.customTitle, true);

  await view.renameConversation(plugin.activeConversationId, '');
  view.clearConversation();
  assert.equal(chat.title, NEW_CHAT_TITLE);
  assert.deepEqual(titles(plugin), []);
});

test('OpenAI: histories and response chaining stay within their conversation', async () => {
  const { plugin, view } = await setup('openai');
  const requests = answering('openai');
  await view.handleUserMessage('Q1', null);
  await view.handleUserMessage('Q2', null);
  assert.equal(requests[1].previous_response_id, 'resp_0');
  const a = plugin.activeConversationId;

  view.newChat();
  await view.handleUserMessage('B1', null);
  assert.equal(requests[2].previous_response_id, undefined);
  assert.deepEqual(inputTexts(requests[2]), ['B1']);
  await view.handleUserMessage('B2', null);
  assert.equal(requests[3].previous_response_id, 'resp_2');
  const b = plugin.activeConversationId;

  await view.openConversation(a);
  await view.handleUserMessage('Q3', null);
  assert.equal(requests[4].previous_response_id, undefined);
  assert.deepEqual(inputTexts(requests[4]), ['Q1', 'A1', 'Q2', 'A2', 'Q3']);
  await view.handleUserMessage('Q4', null);
  assert.equal(requests[5].previous_response_id, 'resp_4');

  // Back and forth: the first request after each switch replays only that conversation.
  for (const [id, question, expected] of [[b, 'B3', ['B1', 'A3', 'B2', 'A4', 'B3']], [a, 'Q5', ['Q1', 'A1', 'Q2', 'A2', 'Q3', 'A5', 'Q4', 'A6', 'Q5']]]) {
    await view.openConversation(id);
    await view.handleUserMessage(question, null);
    assert.equal(requests.at(-1).previous_response_id, undefined);
    assert.deepEqual(inputTexts(requests.at(-1)), expected);
  }
});

test('OpenAI: after a restart the open conversation replays in full once, then chains again', async () => {
  const first = await setup('openai');
  answering('openai');
  await first.view.handleUserMessage('Q1', null);
  first.view.newChat();
  await first.view.handleUserMessage('Other', null);
  // The view saves after a turn without waiting; this save comes after it.
  await first.plugin.saveChatHistory();
  const restored = await setup('openai', first.writes.at(-1));
  const requests = answering('openai');
  await restored.view.handleUserMessage('After restart', null);
  assert.equal(requests[0].previous_response_id, undefined);
  assert.deepEqual(inputTexts(requests[0]), ['Other', 'A2', 'After restart']);
  await restored.view.handleUserMessage('Next', null);
  assert.equal(requests[1].previous_response_id, 'resp_0');
});

for (const action of ['New chat', 'Switching']) {
  test(`${action}: the turn goes on; its question waits for the return and is answered there`, async () => {
    const { plugin, view, chat } = await setup('anthropic');
    answering('anthropic');
    await view.handleUserMessage('Other topic', null);
    const other = plugin.activeConversationId;
    view.newChat();
    await tick();

    const requests = transport((body, index) => index === 0
      ? response('anthropic', [call('ask', 'ask_user', { question: 'Which note?' })], 'tool_use')
      : response('anthropic', [text(`B${index + 1}`)], 'end_turn', index));
    const asking = view.handleUserMessage('Waiting question', null);
    while (!chat.askUser) await tick();
    const waiting = plugin.activeConversationId;

    if (action === 'New chat') view.newChat(); else await view.openConversation(other);
    assert.equal(view.running, false);
    assert.equal(chat.busy, false);
    // The input no longer answers the other chat's question.
    assert.equal(chat.askUser, null);
    assert.equal(requests.length, 1);

    // The next message starts its own turn in the conversation shown now.
    await view.handleUserMessage('Next', null);
    assert.equal(requests.length, 2);
    assert.equal(userTurns(requests[1]).at(-1), 'Next');
    assert.equal(JSON.stringify(requests[1].messages).includes('Waiting question'), false);
    const shownNow = plugin.activeConversationId;

    // Back: the turn still runs, its question is shown once and the input answers it.
    await view.openConversation(waiting);
    assert.equal(view.running, true);
    assert.equal(chat.busy, true);
    assert.deepEqual(texts(chat.shown), ['Waiting question', 'Which note?']);
    assert.ok(chat.askUser);
    chat.addUserMessage('Plan');
    chat.askUser('Plan');
    await asking;
    assert.equal(view.running, false);
    assert.deepEqual(texts(plugin.chatHistory), ['Waiting question', 'Which note?', 'Plan', 'B3']);
    assert.ok(JSON.stringify(requests[2].messages).includes('Plan'));

    await view.openConversation(shownNow);
    assert.deepEqual(texts(plugin.chatHistory).slice(-2), ['Next', 'B2']);
  });
}

test('A turn goes on in the background: the chat shown stays as it is, the list says Answering, the end lands in its chat with a notice', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  transport(async (body, index) => {
    if (index === 0) {
      await gate;
      return response('anthropic', [text('Long answer')]);
    }
    return response('anthropic', [text(`B${index}`)], 'end_turn', index);
  });
  let listUpdates = 0;
  chat.updateConversations = () => { listUpdates++; };
  const running = view.handleUserMessage('Write a lot', null);
  await tick();
  const a = plugin.activeConversationId;
  assert.equal(listUpdates, 1);

  view.newChat();
  await view.handleUserMessage('Quick one', null);
  assert.deepEqual(texts(chat.shown), ['Quick one', 'B1']);
  assert.deepEqual(view.turns.has(a), true);

  finish();
  await running;
  // Not shown here; it is in its own chat, and a notice says so.
  assert.equal(globalThis.__notices.at(-1), 'Answer ready in "Write a lot".');
  assert.equal(view.turns.has(a), false);
  assert.deepEqual(texts(chat.shown), ['Quick one', 'B1']);
  await view.openConversation(a);
  assert.deepEqual(texts(chat.shown), ['Write a lot', 'Long answer']);
  assert.equal(view.running, false);
});

test('A question asked in the background says so in a notice', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  let release;
  transport((body, index) => index === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('ask', 'ask_user', { question: 'Which note?' })], 'tool_use')); })
    : response('anthropic', [text('A2')], 'end_turn', index));
  const asking = view.handleUserMessage('Ask me', null);
  while (!release) await tick();
  const a = plugin.activeConversationId;
  view.newChat();
  release();
  while (!globalThis.__notices.length) await tick();
  assert.deepEqual(globalThis.__notices, ['"Ask me" has a question for you.']);
  assert.equal(chat.askUser, null);
  await view.openConversation(a);
  chat.askUser('Plan');
  await asking;
  assert.deepEqual(texts(plugin.chatHistory), ['Ask me', 'Which note?', 'Plan', 'A2']);
});

for (const shown of [true, false]) {
  test(`Deleting a chat stops its turn (${shown ? 'shown' : 'in the background'}); nothing of it lands anywhere`, async () => {
    const { plugin, view, chat } = await setup('anthropic');
    answering('anthropic');
    await view.handleUserMessage('Other topic', null);
    view.newChat();
    await tick();

    let answer;
    const requests = transport(() => new Promise(resolve => { answer = resolve; }));
    const running = view.handleUserMessage('Slow question', null);
    while (!answer) await tick();
    const slow = plugin.activeConversationId;
    if (!shown) view.newChat();
    await view.deleteConversation(slow);
    assert.equal(view.running, false);
    assert.equal(view.turns.size, 0);
    answer(response('anthropic', [text('Late answer')]));
    await running;
    assert.equal(requests.length, 1);
    assert.equal(plugin.conversations.some(c => c.id === slow), false);
    assert.equal(JSON.stringify(plugin.conversations).includes('Late answer'), false);
    assert.equal(globalThis.__notices.some(n => n.startsWith('Answer ready')), false);
  });
}

test('Typed into a turn after its last step while it runs in the background: runs when its chat is shown again', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  let release;
  const requests = transport((body, index) => index === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('First.')])); })
    : response('anthropic', [text(`A${index + 1}`)], 'end_turn', index));
  const first = view.handleUserMessage('First', null);
  while (!release) await tick();
  await view.handleUserMessage('Also this', null);
  const a = plugin.activeConversationId;
  view.newChat();
  release();
  await first;
  assert.equal(requests.length, 1);
  // Saved with its chat, not only in the view, until the chat is shown.
  assert.deepEqual(plugin.conversations.find(c => c.id === a).pendingMessages, ['Also this']);
  await view.openConversation(a);
  while (view.running || requests.length < 2) await tick();
  assert.deepEqual(userTurns(requests[1]).at(-1), 'Also this');
  assert.deepEqual(texts(plugin.chatHistory), ['First', 'First.', 'Also this', 'A2']);
});

test('Switching during an edit not yet answered: the original turn comes back, the edit and what was typed go back to the input, after the new chat is shown', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  // The draft lives in the input: rendering a conversation clears what it holds besides the text.
  chat.restoreDraft = (text, selection, images, files) => { chat.draft = { text, images, files }; };
  chat.clearMessages = () => { chat.shown = []; chat.draft = undefined; };
  let hold = false;
  const requests = transport((body, index) => hold ? new Promise(() => {}) : response('anthropic', [text(`A${index + 1}`)], 'end_turn', index));
  await view.handleUserMessage('Q1', null);
  const a = plugin.activeConversationId;
  hold = true;
  const edit = view.editMessage(plugin.chatHistory[0].turnId, 'Q1 edited carefully');
  while (requests.length < 2) await tick();
  await view.handleUserMessage('queued follow-up', null);
  view.newChat();
  await edit;
  assert.notEqual(plugin.activeConversationId, a);
  assert.deepEqual(chat.draft?.text, 'Q1 edited carefully\n\nqueued follow-up');
  assert.deepEqual(texts(plugin.conversations.find(c => c.id === a).chatHistory), ['Q1', 'A1']);
});

test('Renaming a chat not read yet keeps the new name when it is opened', async () => {
  const first = await setup('anthropic');
  answering('anthropic');
  await first.view.handleUserMessage('First chat', null);
  const a = first.plugin.activeConversationId;
  first.view.newChat();
  await first.view.handleUserMessage('Second chat', null);
  await first.plugin.saveChatHistory();
  // After a restart only the open chat is read; the other is renamed unread.
  const { plugin, view } = await setup('anthropic', first.writes.at(-1));
  assert.ok(plugin.conversations.find(c => c.id === a).unloaded);
  await view.renameConversation(a, 'My name');
  await view.openConversation(a);
  assert.equal(plugin.activeConversation.title, 'My name');
  assert.equal(plugin.activeConversation.customTitle, true);
});

test('Deleting a chat not read yet: a failed save keeps the deletion for the next one, and the chat stays gone', async () => {
  const first = await setup('anthropic');
  answering('anthropic');
  await first.view.handleUserMessage('Old chat', null);
  const a = first.plugin.activeConversationId;
  first.view.newChat();
  await first.view.handleUserMessage('Current chat', null);
  await first.plugin.saveChatHistory();
  const { plugin, view, files } = await setup('anthropic', first.writes.at(-1));
  const adapter = plugin.app.vault.adapter;
  const write = adapter.write;
  let failing = true;
  adapter.write = async (path, data) => {
    if (failing && path.includes(`chats/${a}`)) throw new Error('The file is locked');
    return write(path, data);
  };
  await view.deleteConversation(a);
  await plugin.saveChatHistory();
  failing = false;
  await plugin.saveChatHistory();
  assert.ok(![...files.keys()].some(path => path.endsWith(`chats/${a}.json`) && files.get(path) && !files.get(path).includes('"deleted"')));
});

test('Opening an old chat keeps its attachments: chats unchanged since read are not stripped by the budget', async () => {
  const first = await setup('anthropic');
  const payload = 'A'.repeat(20 * 1024 * 1024);
  const attachment = id => ({ id, fileName: `${id}.pdf`, mediaType: 'application/pdf', sizeBytes: 15 * 1024 * 1024, data: payload });
  const records = ['old', 'recent'].map((name, i) => {
    const c = api.chatState.newConversation(1000 + i);
    c.chatHistory.push({ type: 'user', text: name, turnId: `t${i}`, attachedFiles: [attachment(name)] });
    c.agentMessages.push({ role: 'user', turnId: `t${i}`, content: [{ type: 'file', file: attachment(name) }, text(name)] });
    return c;
  });
  // Saved one by one, each within the budget on its own.
  first.plugin.conversations = [records[0]];
  first.plugin.activeConversationId = records[0].id;
  await first.plugin.saveChatHistory();
  first.plugin.conversations = records;
  first.plugin.activeConversationId = records[1].id;
  first.plugin.agent.importMessages(records[1].agentMessages);
  await first.plugin.saveChatHistory();
  const { plugin, view } = await setup('anthropic', first.writes.at(-1));
  const old = plugin.conversations.find(c => c.id === records[0].id);
  await view.openConversation(old.id);
  await plugin.saveChatHistory();
  const files = old.agentMessages.flatMap(m => typeof m.content === 'string' ? [] : m.content).filter(b => b.type === 'file');
  assert.equal(files.length, 1);
  assert.equal(files[0].file.data.length, payload.length);
  const recent = plugin.conversations.find(c => c.id === records[1].id);
  assert.equal(recent.unloaded, true, 'idle saved attachment payload is evicted, not stripped');
  const beforeDisk = new Map([...plugin.app.vault.adapter.stored].filter(([path]) => /chats\/[^/]+\.json$/.test(path)));
  await view.openConversation(recent.id);
  await plugin.saveChatHistory();
  assert.equal(old.unloaded, true);
  assert.equal(recent.agentMessages[0].content[0].file.data.length, payload.length);
  for (const [path, data] of beforeDisk) assert.equal(plugin.app.vault.adapter.stored.get(path), data, 'opening kept disk file unchanged');
});

test('Edit and regenerate work within the conversation they belong to', async () => {
  const { plugin, view } = await setup('anthropic');
  const requests = answering('anthropic');
  await view.handleUserMessage('Q1', null);
  await view.handleUserMessage('Q2', null);
  const a = plugin.activeConversationId;
  const q2 = plugin.chatHistory[2].turnId;
  view.newChat();
  await view.handleUserMessage('Other', null);
  const b = plugin.activeConversationId;

  await view.openConversation(a);
  await view.editMessage(q2, 'Q2 edited');
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Q2 edited']);
  await view.regenerate();
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Q2 edited']);
  assert.deepEqual(texts(plugin.chatHistory), ['Q1', 'A1', 'Q2 edited', `A${requests.length}`]);

  await view.openConversation(b);
  assert.deepEqual(texts(plugin.chatHistory), ['Other', 'A3']);
});

const STATE = `${DIR}/chat-state.json`;
const NEXT = `${DIR}/chat-state.next.json`;
const chatPath = id => `${DIR}/chats/${id}.json`;

// A plugin loading from `adapter` (another start of Obsidian).
async function reload(adapter) {
  const { app } = vaultApp();
  app.vault.adapter = adapter;
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  await plugin.loadChatHistory();
  return plugin;
}

test('A save writes only the chats that changed, each to its own file, then the index; sizes are bytes', async () => {
  const { plugin, view, files } = await setup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('A question', null);
  view.newChat();
  await view.handleUserMessage('Other', null);
  await plugin.saveChatHistory();
  const adapter = plugin.app.vault.adapter;
  const order = [];
  const write = adapter.write;
  adapter.write = async (path, data) => { order.push(path.replace(`${DIR}/`, '')); await write(path, data); };
  // Sizes count bytes: "…" and "ü" take more than one.
  plugin.chatHistory.push({ type: 'error', text: 'A note … über' });
  await plugin.saveChatHistory();
  const id = plugin.activeConversationId;
  assert.deepEqual(order, [`chats/${id}.next.json`, `chats/${id}.json`, 'chat-state.next.json', 'chat-state.json']);
  // Nothing changed: only the index.
  order.length = 0;
  await plugin.saveChatHistory();
  assert.deepEqual(order, ['chat-state.next.json', 'chat-state.json']);
  // The index lists each chat with its file's size, not its messages.
  const index = JSON.parse(files.get(STATE));
  assert.equal(index.version, CHAT_STATE_VERSION);
  for (const entry of index.conversations) {
    assert.deepEqual(Object.keys(entry).sort(), ['automaticTitle', 'createdAt', 'customTitle', 'id', 'metadataSavedAt', 'size', 'title', 'titleSourceTurnId', 'updatedAt']);
    assert.equal(entry.size, Buffer.byteLength(files.get(chatPath(entry.id))));
  }
  assert.deepEqual(plugin.savedChatsSize(), { chats: 2, bytes: index.conversations.reduce((sum, c) => sum + c.size, 0) });
  assert.ok(plugin.listConversations().every(c => c.size > 0));
});

test('At start only the open chat\'s file is read; another chat\'s when it is opened', async () => {
  const first = await setup('anthropic');
  answering('anthropic');
  await first.view.handleUserMessage('First chat', null);
  first.view.newChat();
  await first.view.handleUserMessage('Second chat', null);
  await first.plugin.saveChatHistory();

  const restored = await setup('anthropic', first.writes.at(-1));
  const other = restored.plugin.conversations.find(c => c.id !== restored.plugin.activeConversationId);
  assert.equal(other.unloaded, true);
  assert.deepEqual(other.chatHistory, []);
  assert.deepEqual(titles(restored.plugin).sort(), ['First chat', 'Second chat']);
  // Saving meanwhile leaves its file as it is.
  const kept = restored.files.get(chatPath(other.id));
  await restored.plugin.saveChatHistory();
  assert.equal(restored.files.get(chatPath(other.id)), kept);

  await restored.view.openConversation(other.id);
  assert.equal(other.unloaded, undefined);
  assert.deepEqual(texts(restored.plugin.chatHistory), ['First chat', 'A1']);
  assert.deepEqual(texts(restored.chat.shown), ['First chat', 'A1']);
});

test('A chat whose file can\'t be read leaves the list, its file kept aside; one from a newer version is left as it is', async () => {
  for (const [content, corrupt] of [['{"version": 4, "conv', true], [JSON.stringify({ version: 4, conversation: { id: 'x', chatHistory: [{ type: 'user', text: 42 }] } }), true],
    ...[{ voiceContext: [{ role: 'system', text: 'Invalid role' }] }, { voiceContext: {} }, { voiceContextFor: {} }].map(fields => [JSON.stringify({ version: 4, conversation: { id: 'x', chatHistory: [{ type: 'user', text: 'Q', ...fields }] } }), true]),
    [JSON.stringify({ version: 99, conversation: {} }), false]]) {
    const first = await setup('anthropic');
    answering('anthropic');
    await first.view.handleUserMessage('Broken later', null);
    first.view.newChat();
    await first.view.handleUserMessage('Fine', null);
    await first.plugin.saveChatHistory();
    const restored = await setup('anthropic', first.writes.at(-1));
    const other = restored.plugin.conversations.find(c => c.id !== restored.plugin.activeConversationId);
    restored.files.set(chatPath(other.id), content);
    restored.files.delete(`${DIR}/chats/${other.id}.next.json`);
    globalThis.__notices = [];
    await restored.view.openConversation(other.id);
    assert.match(globalThis.__notices[0], /couldn't be read/);
    assert.deepEqual(titles(restored.plugin), ['Fine']);
    assert.deepEqual(texts(restored.plugin.chatHistory), ['Fine', 'A2']);
    assert.equal([...restored.files.keys()].some(path => path.startsWith(`${DIR}/chats/${other.id}.corrupt-`)), corrupt);
    assert.equal(restored.files.has(chatPath(other.id)), !corrupt);
  }
});

test('A chat file the index doesn\'t list comes back; a deleted chat\'s doesn\'t', async () => {
  const { plugin, view, files } = await setup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Kept', null);
  view.newChat();
  await view.handleUserMessage('Deleted', null);
  const deleted = plugin.activeConversationId;
  view.newChat();
  await view.handleUserMessage('Unlisted', null);
  const unlisted = plugin.activeConversationId;
  await view.deleteConversation(deleted);
  await plugin.saveChatHistory();
  assert.equal(files.has(chatPath(deleted)), false);
  // Obsidian ended after the new chat's file was written, before the index listed it.
  const index = JSON.parse(files.get(STATE));
  index.conversations = index.conversations.filter(c => c.id !== unlisted);
  files.set(STATE, JSON.stringify(index));
  files.delete(NEXT);
  // A deleted chat's file that couldn't be removed stays marked deleted.
  files.set(chatPath(deleted), JSON.stringify({ version: 4, deleted: true }));

  const reloaded = await reload(plugin.app.vault.adapter);
  assert.deepEqual(titles(reloaded).sort(), ['Kept', 'Unlisted']);
});

test('A version 3 chat-state.json is split once into the index and a file per chat; the old file is kept aside', async () => {
  const v3 = version3('b', [record('a', 'First', 2), record('b', 'Second', 1)]);
  const { adapter, writes } = chatFiles(v3);
  const plugin = await reload(adapter);
  // Saved in the new format right after loading.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, CHAT_STATE_VERSION);
  assert.deepEqual(writes[0].conversations.map(c => [c.id, c.chatHistory[0].text]), [['a', 'First'], ['b', 'Second']]);
  const kept = [...adapter.stored.keys()].find(path => /\/chat-state\.v3-\d+\.json$/.test(path));
  assert.deepEqual(JSON.parse(adapter.stored.get(kept)), v3);
  assert.ok(adapter.stored.has(chatPath('a')) && adapter.stored.has(chatPath('b')));
  assert.equal(plugin.activeConversationId, 'b');
  // Loading again reads the index; nothing to migrate.
  const again = await reload(adapter);
  assert.equal(writes.length, 1);
  assert.equal(again.activeConversationId, 'b');
  assert.deepEqual(texts(again.chatHistory), ['Second', 'Second answer']);
  assert.equal(again.conversations.find(c => c.id === 'a').unloaded, true);
});

test('Back from an older version that saved the index as version 3: its empty records take the chat files, nothing is lost', async () => {
  const first = await setup('anthropic');
  answering('anthropic');
  await first.view.handleUserMessage('Long chat', null);
  const long = first.plugin.activeConversationId;
  first.view.newChat();
  await first.view.handleUserMessage('Other chat', null);
  const other = first.plugin.activeConversationId;
  await first.plugin.saveChatHistory();
  const { adapter } = chatFiles(first.writes.at(-1));
  // An older version read only the index: it saved the open chat without its messages, and another chat of its own.
  const entry = id => JSON.parse(adapter.stored.get(STATE)).conversations.find(c => c.id === id);
  adapter.stored.set(STATE, JSON.stringify(version3(other, [
    { ...entry(other), chatHistory: [], agentMessages: [] },
    record('newer', 'Asked in the older version', 9),
  ])));
  adapter.stored.delete(NEXT);

  const plugin = await reload(adapter);
  assert.deepEqual(titles(plugin).sort(), ['Asked in the older version', 'Long chat', 'Other chat']);
  assert.deepEqual(texts(plugin.chatHistory), ['Other chat', 'A2']);
  await plugin.openConversation(long);
  assert.deepEqual(texts(plugin.chatHistory), ['Long chat', 'A1']);
});

test('Switching away and back keeps the API history and its images', async () => {
  const { plugin, view, writes } = await setup('anthropic');
  const requests = answering('anthropic');
  const long = plugin.activeConversation;
  const old = { id: 'old-image', fileName: 'old.png', mediaType: 'image/png', data: 'old-data', sizeBytes: 8 };
  for (let i = 0; i < 35; i++) {
    const images = i === 0 ? [old] : [];
    long.chatHistory.push({ type: 'user', text: `Q${i}`, turnId: `t${i}`, images }, { type: 'assistant', text: `A${i}` });
    const content = i === 0 ? [{ type: 'image', image: old }, text(`Q${i}`)] : `Q${i}`;
    long.agentMessages.push({ role: 'user', content, turnId: `t${i}` }, { role: 'assistant', content: [text(`A${i}`)] });
  }
  plugin.agent.importMessages(long.agentMessages);

  view.newChat();
  await view.openConversation(long.id);
  assert.equal(plugin.agent.exportMessages().length, 70);
  await view.handleUserMessage('Next', null);
  assert.equal(requests[0].messages.length, 71);

  // Saved and loaded again: the oldest turn and its image are still there.
  await plugin.saveChatHistory();
  const restored = await setup('anthropic', JSON.parse(JSON.stringify(writes.at(-1))));
  assert.equal(restored.plugin.agent.exportMessages().length, 72);
  assert.equal(restored.plugin.chatHistory[0].images[0].data, old.data);
});

test('A view whose UI failed to mount still starts a new chat (shown once it mounts)', async () => {
  const { plugin, view } = await setup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Earlier', null);
  const earlier = plugin.activeConversationId;
  view.chatContainer = undefined;
  view.newChat();
  assert.notEqual(plugin.activeConversationId, earlier);
  assert.deepEqual(plugin.chatHistory, []);
});

// The plugin with its chat view open and its UI mounted, for the commands.
async function withOpenView(provider) {
  const setupResult = await setup(provider);
  const { plugin, view, app } = setupResult;
  plugin.isProviderConfigured = () => true;
  app.workspace.getLeavesOfType = () => [{ view }];
  app.workspace.revealLeaf = async () => {};
  view.markReady();
  return setupResult;
}

test('"Chat about this note" and "Send selection to chat" start a new conversation', async () => {
  const { plugin, view, chat } = await withOpenView('anthropic');
  const requests = answering('anthropic');
  await view.handleUserMessage('Earlier topic', null);
  const earlier = plugin.activeConversationId;
  await tick();

  await plugin.openChatWithMessage('Tell me about Notes/Plan.md');
  while (requests.length < 2 || view.running) await tick();
  assert.notEqual(plugin.activeConversationId, earlier);
  assert.deepEqual(userTurns(requests[1]), ['Tell me about Notes/Plan.md']);
  assert.deepEqual(titles(plugin), ['Tell me about Notes/Plan.md', 'Earlier topic']);

  const selected = [];
  chat.setSelection = selection => selected.push(selection);
  const noteChat = plugin.activeConversationId;
  await plugin.openChatWithSelection({ text: 'Some words', filePath: 'Notes/Plan.md' });
  assert.notEqual(plugin.activeConversationId, noteChat);
  assert.deepEqual(chat.shown, []);
  assert.equal(chat.title, NEW_CHAT_TITLE);
  assert.deepEqual(selected, [{ text: 'Some words', filePath: 'Notes/Plan.md' }]);
});

test('The New chat command opens the chat on a new conversation; an empty one is kept', async () => {
  const { plugin, view, chat } = await withOpenView('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Earlier topic', null);
  const earlier = plugin.activeConversationId;

  await plugin.newChat();
  const fresh = plugin.activeConversationId;
  assert.notEqual(fresh, earlier);
  assert.deepEqual(chat.shown, []);
  assert.equal(chat.title, NEW_CHAT_TITLE);
  await plugin.newChat();
  assert.equal(plugin.activeConversationId, fresh);

  // Without a provider set up, nothing changes (a notice says what to do).
  plugin.isProviderConfigured = () => false;
  await view.openConversation(earlier);
  await plugin.newChat();
  assert.equal(plugin.activeConversationId, earlier);
  assert.equal(globalThis.__notices.length, 1);
});

test('Automatic titles survive long chats, reloads, appends and temporary custom names', async () => {
  const { plugin, view, writes } = await setup('anthropic');
  answering('anthropic');
  for (let i = 0; i < 61; i++) await view.handleUserMessage(`Original topic ${i}`, null);
  await plugin.saveChatHistory();
  const state = writes.at(-1);
  // Long chats keep their whole visible history (no cap), so the first turn stays.
  assert.equal(state.conversations[0].chatHistory[0].text, 'Original topic 0');
  const restored = await setup('anthropic', state);
  assert.equal(restored.plugin.activeConversation.title, 'Original topic 0');
  await restored.view.handleUserMessage('Later follow-up', null);
  assert.equal(restored.plugin.activeConversation.title, 'Original topic 0');
  await restored.view.renameConversation(restored.plugin.activeConversationId, 'Custom name');
  await restored.plugin.saveChatHistory();
  const again = await setup('anthropic', restored.writes.at(-1));
  assert.equal(again.plugin.activeConversation.title, 'Custom name');
  await again.view.renameConversation(again.plugin.activeConversationId, '');
  assert.equal(again.plugin.activeConversation.title, 'Original topic 0');
  // Editing a later turn keeps the title; editing the first one renames the chat.
  await again.view.editMessage(again.plugin.chatHistory.filter(row => row.type === 'user')[1].turnId, 'Edited later turn');
  assert.equal(again.plugin.activeConversation.title, 'Original topic 0');
  await again.view.editMessage(again.plugin.chatHistory.find(row => row.type === 'user').turnId, 'Edited first turn');
  assert.equal(again.plugin.activeConversation.title, 'Edited first turn');
  again.view.clearConversation();
  await again.view.handleUserMessage('New topic after clear', null);
  assert.equal(again.plugin.activeConversation.title, 'New topic after clear');
});

test('Legacy capped history keeps its stored automatic title without inventing a retained source', async () => {
  const old = record('capped', 'Retained Q10', 1, { title: 'Original Q0' });
  const { plugin, view } = await setup('anthropic', version3('capped', [old]));
  assert.equal(plugin.activeConversation.titleSourceTurnId, null);
  answering('anthropic');
  await view.handleUserMessage('Next', null);
  assert.equal(plugin.activeConversation.title, 'Original Q0');
});

test('Saving many attachment-heavy named chats bounds all retained data before either JSON write and reload', async () => {
  const { plugin, writes } = await setup('anthropic');
  const payload = 'A'.repeat(12 * 1024 * 1024);
  const records = [];
  for (let i = 0; i < 4; i++) {
    const attachment = { id: `large${i}`, fileName: `Large${i}.pdf`, mediaType: 'application/pdf', sizeBytes: 9 * 1024 * 1024, data: payload };
    const c = api.chatState.newConversation(i);
    c.chatHistory.push({ type: 'user', text: `Chat ${i}`, turnId: `t${i}`, attachedFiles: [attachment] });
    c.agentMessages.push({ role: 'user', turnId: `t${i}`, content: [{ type: 'file', file: attachment }, text(`Chat ${i}`)] });
    records.push(c);
  }
  plugin.conversations = records;
  plugin.activeConversationId = records[0].id;
  plugin.agent.importMessages(records[0].agentMessages);
  const written = new Map();
  const write = plugin.app.vault.adapter.write;
  plugin.app.vault.adapter.write = async (path, json) => { written.set(path, json); await write(path, json); };
  await plugin.saveChatHistory();
  // Each chat file and the index stay below the request ceiling; the index lists all four.
  assert.ok([...written.values()].every(json => Buffer.byteLength(json) < 33 * 1024 * 1024));
  assert.equal(writes.at(-1).conversations.length, 4);
  const data = c => c.agentMessages.flatMap(m => typeof m.content === 'string' ? [] : m.content).filter(b => b.type === 'file').map(b => b.file);
  assert.equal(data(records[0]).length, 1, 'active gets priority despite oldest timestamp');
  assert.equal(data(records[3]).length, 1, 'most recently used inactive gets remaining room');
  assert.equal(data(records[1]).length, 0);
  assert.equal(records[1].chatHistory[0].attachedFiles[0].data, '');
  const restored = await setup('anthropic', writes.at(-1));
  assert.equal(restored.plugin.conversations.length, 4);
  const second = restored.plugin.conversations.find(c => c.id === records[1].id);
  assert.ok(await restored.plugin.loadConversation(second));
  assert.equal(data(second).length, 0);
  assert.equal(second.chatHistory[0].attachedFiles[0].fileName, 'Large1.pdf');
});

test('Retention during an in-flight chained response forces replay of the bounded history next turn', async () => {
  const { plugin, view } = await setup('openai');
  plugin.app.workspace.getLeavesOfType = () => [];
  plugin.app.vault.adapter.write = async () => {};
  const payload = 'A'.repeat(12 * 1024 * 1024);
  const attachment = i => ({ id: `pdf${i}`, fileName: `${i}.pdf`, mediaType: 'application/pdf', sizeBytes: 9 * 1024 * 1024, data: payload });
  let release;
  const requests = transport((body, index) => index === 2 ? new Promise(resolve => { release = () => resolve(response('openai', [text('A3')], 'end_turn', index)); }) : response('openai', [text(`A${index}`)], 'end_turn', index));
  await view.handleUserMessage('Q1', null, [], [attachment(1)]);
  await view.handleUserMessage('Q2', null, [], [attachment(2)]);
  const third = view.handleUserMessage('Q3', null, [], [attachment(3)]);
  for (let i = 0; i < 100 && !release; i++) await tick();
  assert.ok(release, "third request reached transport");
  assert.ok(requests[2].previous_response_id);
  await plugin.saveChatHistory();
  release();
  await third;
  await view.handleUserMessage('Q4', null);
  assert.equal(requests[3].previous_response_id, undefined);
  const serialized = JSON.stringify(requests[3]);
  assert.match(serialized, /older chat history/);
  assert.doesNotMatch(serialized, /"filename":"1.pdf"/);
});

test('An old lazy-open completion cannot replace a newer navigation choice', async () => {
  const { plugin, view, app } = await setup('anthropic');
  const files = app.vault.adapter;
  answering('anthropic');
  await view.handleUserMessage('Chat A', null);
  const aid = plugin.activeConversationId;
  view.newChat();
  await view.handleUserMessage('Chat B', null);
  const bid = plugin.activeConversationId;
  await plugin.saveChatHistory();
  const restored = await reload(files);
  const read = files.read;
  let finish;
  files.read = path => path === chatPath(aid) ? new Promise(resolve => { finish = () => read(path).then(resolve); }) : read(path);
  const earlier = restored.openConversation(aid);
  for(let i=0;i<100&&!finish;i++) await tick();
  assert.ok(finish);
  restored.startNewConversation();
  const current = restored.activeConversationId;
  finish();
  assert.equal(await earlier, false);
  assert.equal(restored.activeConversationId, current);
  assert.notEqual(current, bid);
});

test('Deleting the active chat cannot steal focus from another chat opened during its lazy fallback read', async () => {
  const { plugin, view, app } = await setup('anthropic');
  answering('anthropic');
  await view.handleUserMessage('Fallback A', null);const aid = plugin.activeConversationId;
  view.newChat();await view.handleUserMessage('Chosen C', null);const cid = plugin.activeConversationId;
  view.newChat();await view.handleUserMessage('Deleted B', null);const bid = plugin.activeConversationId;
  plugin.conversations.find(c=>c.id===aid).updatedAt = Date.now()+1000;
  await plugin.saveChatHistory();
  const restored = await reload(app.vault.adapter);
  const adapter = app.vault.adapter, read = adapter.read;let finish;
  adapter.read = path => path === chatPath(aid) ? new Promise(resolve => { finish = () => read(path).then(resolve); }) : read(path);
  const deleting = restored.deleteConversation(bid);
  for(let i=0;i<100&&!finish;i++)await tick();
  assert.ok(finish);
  assert.equal(await restored.openConversation(cid), true);
  finish();await deleting;await restored.saveChatHistory();
  assert.equal(restored.activeConversationId, cid);
  assert.ok(!restored.conversations.some(c=>c.id===bid));
  assert.equal(JSON.parse(adapter.stored.get(STATE)).activeConversationId, cid);
});
