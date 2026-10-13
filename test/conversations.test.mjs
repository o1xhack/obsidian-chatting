// Named conversations: the chat-state.json version 3 format and its
// one-time migration, restoring the active conversation, titles, the caps
// per conversation; new chat, switching, renaming and deleting through the
// chat view, and that histories, OpenAI chaining and a stopped turn stay
// within their conversation; the commands that start a new chat. Through
// the real plugin and chat view with a fake Svelte component.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, response, transport, vaultApp } from './harness.mjs';

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
    addAssistantMessage(value) { chat.shown.push({ id: nextId++, type: 'assistant', text: value }); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId); if (index >= 0) chat.shown.splice(index); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {},
    showAskUser(question) { chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy(value) { chat.busy = value; }, foldTurn() {},
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {},
    title: null, setTitle(value) { chat.title = value; },
    setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin that loads `saved` as its chat-state.json (none when undefined),
// records its writes, and has a chat view with a fake component.
async function setup(provider, saved) {
  const { app } = vaultApp();
  const writes = [];
  app.vault.adapter = {
    append: async () => {},
    read: async (path) => { if (!saved || !path.endsWith('/chat-state.json')) throw new Error('ENOENT'); return JSON.stringify(saved); },
    exists: async (path) => !!saved && path.endsWith('/chat-state.json'),
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
  assert.equal(saved.version, 3);
  assert.equal(saved.conversations.length, 1);
  assert.equal(saved.activeConversationId, plugin.activeConversationId);
  assert.equal('chatHistory' in saved, false);
  assert.equal('agentMessages' in saved, false);
  // Version 3 isn't migrated again: the same conversation, the same ID.
  assert.deepEqual(migrateChatState(saved).conversations.map(c => c.id), [saved.activeConversationId]);
});

test('The active conversation is restored on load, with its own API history; the others are kept as they were', async () => {
  const saved = version3('b', [record('a', 'Topic A', 2), record('b', 'Topic B', 1)]);
  const { plugin, view, writes } = await setup('anthropic', saved);
  assert.equal(plugin.activeConversationId, 'b');
  assert.deepEqual(texts(plugin.chatHistory), ['Topic B', 'Topic B answer']);

  const requests = answering('anthropic');
  await view.handleUserMessage('Back to B', null);
  assert.deepEqual(userTurns(requests[0]), ['Topic B', 'Back to B']);
  const written = writes.at(-1);
  assert.equal(written.activeConversationId, 'b');
  assert.deepEqual(written.conversations.map(c => c.id), ['a', 'b']);
  assert.deepEqual(written.conversations[0], saved.conversations[0]);
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

  // Saved titles: an automatic one is taken from the history again, a custom one is kept.
  const state = migrateChatState(version3('a', [
    record('a', 'Question', 1, { title: 'Stale title' }),
    record('b', 'Question', 2, { title: 'My name', customTitle: true }),
  ]));
  assert.deepEqual(state.conversations.map(c => [c.title, c.customTitle]), [['Question', false], ['My name', true]]);
});

test('Each conversation is saved with its own caps (100 entries, 80 API messages); empty ones only while active', async () => {
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
  const saved = writes.at(-1);
  assert.equal(saved.conversations.length, 2);
  const capped = saved.conversations.find(c => c.id === big.id);
  assert.equal(capped.chatHistory.length, 100);
  assert.equal(capped.chatHistory[0].text, 'Q10');
  assert.equal(capped.agentMessages.length, 80);
  assert.equal(capped.agentMessages[0].turnId, 't20');
  // In memory nothing is cut.
  assert.equal(big.chatHistory.length, 120);

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

  view.openConversation(first);
  assert.equal(plugin.activeConversationId, first);
  assert.deepEqual(texts(chat.shown), ['First topic', 'A1']);
  assert.equal(chat.title, 'First topic');
  assert.deepEqual(texts(plugin.chatHistory), ['First topic', 'A1']);

  // Rename: kept over later turns; an empty name goes back to the automatic title.
  view.renameConversation(first, '  My   own name ');
  assert.equal(chat.title, 'My own name');
  await tick();
  await view.handleUserMessage('More', null);
  assert.deepEqual(titles(plugin), ['My own name', 'Second topic']);
  view.renameConversation(first, '   ');
  assert.deepEqual(titles(plugin), ['First topic', 'Second topic']);
  assert.equal(chat.title, 'First topic');

  // Deleting another conversation leaves the current one alone.
  view.deleteConversation(second);
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

  view.deleteConversation(plugin.activeConversationId);
  assert.deepEqual(texts(chat.shown), ['Newer', 'A2']);
  assert.deepEqual(titles(plugin), ['Newer', 'Older']);
  view.deleteConversation(plugin.activeConversationId);
  assert.equal(plugin.activeConversationId, older);
  assert.deepEqual(texts(chat.shown), ['Older', 'A1']);

  view.deleteConversation(older);
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
  first.view.openConversation(a);
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

  view.renameConversation(plugin.activeConversationId, 'Named');
  await plugin.saveChatHistory();
  const restored = await setup('anthropic', writes.at(-1));
  assert.equal(restored.plugin.activeConversation.title, 'Named');
  assert.equal(restored.plugin.activeConversation.customTitle, true);

  view.renameConversation(plugin.activeConversationId, '');
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

  view.openConversation(a);
  await view.handleUserMessage('Q3', null);
  assert.equal(requests[4].previous_response_id, undefined);
  assert.deepEqual(inputTexts(requests[4]), ['Q1', 'A1', 'Q2', 'A2', 'Q3']);
  await view.handleUserMessage('Q4', null);
  assert.equal(requests[5].previous_response_id, 'resp_4');

  // Back and forth: the first request after each switch replays only that conversation.
  for (const [id, question, expected] of [[b, 'B3', ['B1', 'A3', 'B2', 'A4', 'B3']], [a, 'Q5', ['Q1', 'A1', 'Q2', 'A2', 'Q3', 'A5', 'Q4', 'A6', 'Q5']]]) {
    view.openConversation(id);
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

for (const action of ['New chat', 'Switching', 'Deleting the chat']) {
  test(`${action} stops a running turn; what it showed stays in its own conversation`, async () => {
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

    if (action === 'New chat') view.newChat();
    else if (action === 'Switching') view.openConversation(other);
    else view.deleteConversation(waiting);
    assert.equal(view.running, false);
    assert.equal(chat.busy, false);
    // The input no longer answers the stopped turn's question.
    assert.equal(chat.askUser, null);
    await asking;
    assert.equal(requests.length, 1);
    assert.notEqual(plugin.activeConversationId, waiting);

    // The next message starts its own turn in the conversation shown now.
    await view.handleUserMessage('Next', null);
    assert.equal(requests.length, 2);
    assert.equal(userTurns(requests[1]).at(-1), 'Next');
    assert.equal(JSON.stringify(requests[1].messages).includes('Waiting question'), false);

    const stopped = plugin.conversations.find(c => c.id === waiting);
    if (action === 'Deleting the chat') {
      assert.equal(stopped, undefined);
      return;
    }
    // Back in the stopped conversation: its question is there, and its
    // API history stays valid (the call has its cancelled result).
    view.openConversation(waiting);
    assert.deepEqual(texts(chat.shown), ['Waiting question', 'Which note?']);
    await view.handleUserMessage('Go on', null);
    const sent = JSON.stringify(requests.at(-1).messages);
    assert.ok(sent.includes('Tool execution cancelled before completion.'));
    assert.deepEqual(userTurns(requests.at(-1)), ['Waiting question', 'Go on']);
  });
}

test('A stopped request that answers after the switch adds nothing anywhere', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  let answer;
  transport(() => new Promise(resolve => { answer = resolve; }));
  const running = view.handleUserMessage('Slow question', null);
  while (!answer) await tick();
  const slow = plugin.activeConversationId;
  view.newChat();
  answer(response('anthropic', [text('Late answer')]));
  await running;
  assert.deepEqual(chat.shown, []);
  assert.deepEqual(plugin.chatHistory, []);
  view.openConversation(slow);
  assert.deepEqual(texts(chat.shown), ['Slow question']);
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

  view.openConversation(a);
  await view.editMessage(q2, 'Q2 edited');
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Q2 edited']);
  await view.regenerate();
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Q2 edited']);
  assert.deepEqual(texts(plugin.chatHistory), ['Q1', 'A1', 'Q2 edited', `A${requests.length}`]);

  view.openConversation(b);
  assert.deepEqual(texts(plugin.chatHistory), ['Other', 'A3']);
});

test('Switching away and back keeps the API history up to 80 messages, and its images', async () => {
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
  view.openConversation(long.id);
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
  view.openConversation(earlier);
  await plugin.newChat();
  assert.equal(plugin.activeConversationId, earlier);
  assert.equal(globalThis.__notices.length, 1);
});
