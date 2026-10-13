// Back from the background: the foreground/background hints, a request
// that failed or stalled while Obsidian was away sent again in the same
// turn, and Continue after the phone ended Obsidian mid-turn. Through the
// real plugin and chat view with a fake Svelte component.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, settings, text, call, response, streamEvents, sseText, sse, transport, vaultApp, chatFiles } from './harness.mjs';

const { AppLifecycle, appLifecycle } = api.lifecycle;

beforeEach(async () => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  globalThis.__notices = [];
  appLifecycle.markVisible();
  // Times are in ms: a request started in the ms the app went away counts
  // as hidden, so start a test's requests a little later.
  await new Promise(resolve => setTimeout(resolve, 2));
});
afterEach(() => {
  delete globalThis.__fetch;
  delete globalThis.document;
  api.Platform.isMobileApp = false;
});

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    askUser: null,
    thinkingLabels: [],
    continueShown: false,
    addUserMessage(value, images = [], turnId) { chat.shown.push({ id: nextId++, type: 'user', text: value, turnId }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking(label = '') { chat.thinkingLabels.push(label); }, hideThinking() {},
    showAskUser(question) { if (question !== undefined) chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, updateConversations() {}, setQueued() {},
    setContinue(value) { chat.continueShown = value; },
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {},
    setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin that loads `saved` as its chat-state.json (none when undefined),
// records its writes, and has a chat view with a fake component.
async function chatSetup(provider, saved) {
  const { app } = vaultApp();
  const { adapter, writes } = chatFiles(saved);
  app.vault.adapter = adapter;
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...plugin.settings, ...settings(provider) };
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { app, plugin, view, chat, writes };
}

/** A fake document and window, and an owner that records the listeners the way registerDomEvent does. */
function hintSources() {
  const doc = { visibilityState: 'visible' };
  const win = {};
  const listeners = [];
  const owner = { registerDomEvent: (target, type, listener) => listeners.push({ target, type, listener }) };
  const fire = (target, type) => {
    for (const entry of listeners) if (entry.target === target && entry.type === type) entry.listener();
  };
  return { doc, win, owner, listeners, fire };
}

// ─── Hints ──────────────────────────────────────────────────────────────────

test('Lifecycle: visibilitychange, pause/resume, focus and pageshow decide hidden and visible; repeats count once', async (t) => {
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const lifecycle = new AppLifecycle();
  const { doc, win, owner, listeners, fire } = hintSources();
  const hints = [];
  lifecycle.watch(owner, (hint, visibility) => hints.push(`${hint}:${visibility}`), doc, win);
  assert.deepEqual(listeners.map(l => [l.target === doc ? 'document' : 'window', l.type]),
    [['document', 'visibilitychange'], ['document', 'pause'], ['document', 'resume'], ['window', 'focus'], ['window', 'pageshow']]);
  const events = [];
  lifecycle.onHidden(() => events.push('hidden'));
  lifecycle.onVisible(ms => events.push(`visible after ${ms}`));

  assert.equal(lifecycle.isHidden(), false);
  assert.equal(lifecycle.hiddenSince(0), false);
  await lifecycle.whenVisible();

  const before = now;
  now += 10;
  doc.visibilityState = 'hidden';
  fire(doc, 'visibilitychange');
  fire(doc, 'pause');
  assert.equal(lifecycle.isHidden(), true);
  assert.equal(lifecycle.hiddenSince(before), true);
  let back = false;
  const waiting = lifecycle.whenVisible().then(() => { back = true; });
  // Focus while the page says hidden isn't a return.
  fire(win, 'focus');
  await Promise.resolve();
  assert.equal(back, false);

  now += 5_000;
  fire(doc, 'resume');
  await waiting;
  assert.equal(back, true);
  assert.equal(lifecycle.isHidden(), false);
  assert.equal(lifecycle.hiddenSince(before), true);
  assert.equal(lifecycle.hiddenSince(now + 1), false);

  fire(doc, 'pause');
  now += 100;
  doc.visibilityState = 'visible';
  fire(win, 'pageshow');
  fire(win, 'focus');
  fire(doc, 'visibilitychange');
  assert.deepEqual(events, ['hidden', 'visible after 5000', 'hidden', 'visible after 100']);
  // Every hint is logged (debug.log), for checking which ones a device sends.
  assert.deepEqual(hints, ['visibilitychange:hidden', 'pause:hidden', 'focus:hidden', 'resume:hidden', 'pause:hidden',
    'pageshow:visible', 'focus:visible', 'visibilitychange:visible']);
});

test('Leaving Obsidian saves the chats (the phone may end it in the background)', async () => {
  const { plugin, writes } = await chatSetup('anthropic');
  globalThis.document = { visibilityState: 'visible' };
  const { owner, listeners } = hintSources();
  const cleanups = [];
  plugin.registerDomEvent = owner.registerDomEvent;
  plugin.register = cleanup => cleanups.push(cleanup);
  plugin.watchLifecycle();
  assert.equal(listeners.length, 5);
  appLifecycle.markHidden();
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(writes.length, 1);
  for (const cleanup of cleanups) cleanup();
  appLifecycle.markVisible();
  appLifecycle.markHidden();
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(writes.length, 1);
});

// ─── Resuming a request ─────────────────────────────────────────────────────

const tick = () => new Promise(resolve => setTimeout(resolve, 1));
async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await tick();
  }
}

/**
 * A streamed fetch body: `head` first; then the rest (`tail`), a failure
 * from `fail()`, or with `hold` nothing more until cancelled.
 */
function body(head, { tail = '', fail, hold = false, onCancel } = {}) {
  const encoder = new TextEncoder();
  let step = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      step++;
      if (step === 1) return controller.enqueue(encoder.encode(head));
      if (fail) return controller.error(fail());
      if (hold) return new Promise(() => {});
      if (tail) controller.enqueue(encoder.encode(tail));
      controller.close();
    },
    cancel() { onCancel?.(); },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const answer = streamEvents('anthropic', [text('The whole answer')]);
// Up to the first text delta ("The whol").
const partial = sseText(answer.slice(0, 3));

/** Fetch answers from `handler(index)`; returns the request bodies. */
function fakeFetch(handler) {
  const requests = [];
  globalThis.__fetch = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return handler(requests.length - 1, init);
  };
  transport(() => assert.fail('requestUrl must not be used'));
  return requests;
}

const shown = chat => chat.shown.map(m => [m.type, m.text]);

test('A request that fails in the background is sent again when Obsidian is back: same turn, the partial text replaced', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  const requests = fakeFetch(index => index === 0
    ? body(partial, { fail: () => { appLifecycle.markHidden(); return new TypeError('Load failed'); } })
    : body(sseText(answer)));
  const turn = view.handleUserMessage('Question', null);
  await until(() => appLifecycle.isHidden());
  await tick();
  // The loop waits for the return; the partial text is still shown.
  assert.deepEqual(shown(chat), [['user', 'Question'], ['assistant', 'The whol']]);
  assert.equal(view.running, true);

  appLifecycle.markVisible();
  await turn;
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages, requests[0].messages);
  assert.equal(requests[1].messages.length, 1);
  assert.deepEqual(shown(chat), [['user', 'Question'], ['assistant', 'The whole answer']]);
  assert.deepEqual(plugin.chatHistory.map(e => [e.type, e.text]), [['user', 'Question'], ['assistant', 'The whole answer']]);
  assert.deepEqual(plugin.agent.exportMessages().map(m => m.role), ['user', 'assistant']);
  assert.ok(chat.thinkingLabels.includes('Resuming…'));
});

test('A turn resumes at most twice; then the error shows as usual', async () => {
  const { view, chat } = await chatSetup('anthropic');
  const requests = fakeFetch(() => {
    appLifecycle.markHidden();
    throw new TypeError('Load failed');
  });
  const off = appLifecycle.onHidden(() => setTimeout(() => appLifecycle.markVisible(), 1));
  try {
    await view.handleUserMessage('Question', null);
  } finally {
    off();
  }
  assert.equal(requests.length, 3);
  assert.equal(chat.thinkingLabels.filter(label => label === 'Resuming…').length, 2);
  assert.deepEqual(shown(chat), [['user', 'Question'], ['error', 'Load failed']]);
});

test('A request failing while Obsidian is in the foreground errors as before, without resuming', async () => {
  const { view, chat } = await chatSetup('anthropic');
  let fetches = 0;
  globalThis.__fetch = async () => { fetches++; throw new TypeError('Failed to fetch'); };
  transport(() => { throw new Error('offline'); });
  await view.handleUserMessage('Question', null);
  assert.equal(fetches, 1);
  assert.deepEqual(shown(chat), [['user', 'Question'], ['error', 'offline']]);
  assert.equal(chat.thinkingLabels.includes('Resuming…'), false);
});

test('A fetch failing in the background neither falls back to requestUrl nor marks the URL fetch-blocked', async () => {
  const url = 'https://api.anthropic.com/v1/messages';
  let fetches = 0;
  globalThis.__fetch = async () => {
    fetches++;
    if (fetches === 1) appLifecycle.markHidden();
    throw new TypeError('Load failed');
  };
  const fallbacks = transport(() => sse([]));
  await assert.rejects(api.streamSSE(url, { headers: {}, body: '{}' }, () => {}), /Load failed/);
  assert.equal(fallbacks.length, 0);
  appLifecycle.markVisible();
  // Times are in ms: a request started in the ms the app went away counts as hidden.
  await new Promise(resolve => setTimeout(resolve, 2));
  // In the foreground the fallback runs, and only now is fetch skipped.
  await api.streamSSE(url, { headers: {}, body: '{}' }, () => {});
  await api.streamSSE(url, { headers: {}, body: '{}' }, () => {});
  assert.equal(fetches, 2);
  assert.equal(fallbacks.length, 2);
});

/** Run `fn` with the platform a phone (or not) and the stall wait `ms`. */
async function onPhone(ms, fn, { mobile = true } = {}) {
  api.Platform.isMobileApp = mobile;
  const stall = api.RESUME.stallMs;
  api.RESUME.stallMs = ms;
  try {
    await fn();
  } finally {
    api.RESUME.stallMs = stall;
  }
}

test('Mobile: a request that stays silent after the return is given up and sent again', () => onPhone(30, async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  let cancelled = false;
  const requests = fakeFetch(index => index === 0
    ? body(partial, { hold: true, onCancel: () => { cancelled = true; } })
    : body(sseText(answer)));
  const turn = view.handleUserMessage('Question', null);
  await until(() => chat.shown.some(m => m.text === 'The whol'));
  appLifecycle.markHidden();
  appLifecycle.markVisible();
  await turn;
  assert.equal(cancelled, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(shown(chat), [['user', 'Question'], ['assistant', 'The whole answer']]);
  assert.deepEqual(plugin.agent.exportMessages().map(m => m.role), ['user', 'assistant']);
}));

test('Mobile: data arriving after the return keeps the request', () => onPhone(150, async () => {
  const { view, chat } = await chatSetup('anthropic');
  let cancelled = false;
  let more;
  fakeFetch(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(partial));
      more = (events, end) => {
        controller.enqueue(new TextEncoder().encode(sseText(events)));
        if (end) controller.close();
      };
    },
    cancel() { cancelled = true; },
  }), { status: 200 }));
  const turn = view.handleUserMessage('Question', null);
  await until(() => chat.shown.some(m => m.text === 'The whol'));
  appLifecycle.markHidden();
  appLifecycle.markVisible();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Data 75 ms after the return; the rest 165 ms after it, which is more
  // than 150 ms after the return but not after that data.
  await sleep(75);
  more(answer.slice(3, 4));
  await sleep(90);
  assert.equal(cancelled, false);
  more(answer.slice(4), true);
  await turn;
  assert.equal(cancelled, false);
  assert.deepEqual(shown(chat), [['user', 'Question'], ['assistant', 'The whole answer']]);
}));

test('Mobile: a requestUrl() request hung in the background is abandoned after the return and sent again', () => onPhone(30, async () => {
  const { view, chat } = await chatSetup('anthropic');
  globalThis.__fetch = async () => { throw new TypeError('Failed to fetch'); };
  const requests = transport((body, index) => index === 0 ? new Promise(() => {}) : sse(answer));
  const turn = view.handleUserMessage('Question', null);
  await until(() => requests.length === 1);
  appLifecycle.markHidden();
  appLifecycle.markVisible();
  await turn;
  assert.equal(requests.length, 2);
  assert.deepEqual(shown(chat), [['user', 'Question'], ['assistant', 'The whole answer']]);
}));

test('Desktop: a minimised window keeps its open request (no watch)', () => onPhone(10, async () => {
  const { view, chat } = await chatSetup('anthropic');
  let cancelled = false;
  fakeFetch(() => body(partial, { hold: true, onCancel: () => { cancelled = true; } }));
  const turn = view.handleUserMessage('Question', null);
  await until(() => chat.shown.some(m => m.text === 'The whol'));
  appLifecycle.markHidden();
  appLifecycle.markVisible();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(cancelled, false);
  view.handleStop();
  await turn;
  assert.equal(cancelled, true);
}, { mobile: false }));

// ─── Continue after Obsidian was ended mid-turn ─────────────────────────────

const roles = messages => messages.map(m => m.role);
const hasToolResult = message => Array.isArray(message.content) && message.content.some(b => b.type === 'tool_result');

test('A turn cut off mid-way is saved with its mark and finished tool results; Continue completes it after a restart without running the tool again', async () => {
  const { plugin, view, writes } = await chatSetup('anthropic');
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [text('Reading'), call('read', 'read_file', { path: 'Untitled.md' })], 'tool_use')
    // The phone ends Obsidian while this request runs.
    : new Promise(() => {}));
  void view.handleUserMessage('What does my note say?', null);
  await until(() => requests.length === 2);
  // What leaving the app saves (see the test above).
  await plugin.saveChatHistory();
  const saved = JSON.parse(JSON.stringify(writes.at(-1)));
  assert.equal(saved.version, api.chatState.CHAT_STATE_VERSION);
  const [conversation] = saved.conversations;
  assert.equal(conversation.pendingTurn.turnId, plugin.chatHistory[0].turnId);
  assert.deepEqual(roles(conversation.agentMessages), ['user', 'assistant', 'user']);
  assert.ok(hasToolResult(conversation.agentMessages[2]));
  assert.match(JSON.stringify(conversation.agentMessages[2]), /Original/);
  assert.deepEqual(conversation.chatHistory.map(e => e.type), ['user', 'assistant', 'tool-result']);

  const restored = await chatSetup('anthropic', saved);
  restored.view.renderHistory();
  assert.equal(restored.chat.continueShown, true);
  const after = transport(() => response('anthropic', [text('Your note says Original.')]));
  await restored.view.continueTurn();
  assert.equal(after.length, 1);
  // The saved history as it was: no new user message, the tool result sent, not run again.
  assert.deepEqual(roles(after[0].messages), ['user', 'assistant', 'user']);
  assert.ok(hasToolResult(after[0].messages[2]));
  assert.deepEqual(restored.plugin.chatHistory.map(e => [e.type, e.text]),
    [['user', 'What does my note say?'], ['assistant', 'Reading'], ['tool-result', undefined], ['assistant', 'Your note says Original.']]);
  assert.deepEqual(restored.chat.shown.filter(m => m.type === 'user').map(m => m.text), ['What does my note say?']);
  assert.equal(restored.chat.continueShown, false);
  assert.equal(restored.plugin.activeConversation.pendingTurn, undefined);
  await tick();
  assert.equal(restored.writes.at(-1).conversations[0].pendingTurn, undefined);
});

test('A finished turn leaves no mark; Continue only while the model owes an answer; a new message, Stop, Clear or a new chat dismiss it', async () => {
  const cutOff = (agentMessages) => ({
    version: 3, activeConversationId: 'c1',
    conversations: [{
      id: 'c1', title: 'Q', customTitle: false, createdAt: 1, updatedAt: 1,
      chatHistory: [{ type: 'user', text: 'Q', turnId: 't1' }],
      agentMessages, pendingTurn: { turnId: 't1', startedAt: 1 },
    }],
  });
  const owed = [{ role: 'user', content: 'ctx\n\nQ', turnId: 't1' }];

  const fresh = await chatSetup('anthropic');
  transport(() => response('anthropic', [text('A')]));
  await fresh.view.handleUserMessage('Q', null);
  await tick();
  assert.equal(fresh.writes.at(-1).conversations[0].pendingTurn, undefined);

  // Answered before Obsidian ended: nothing to continue.
  const answered = await chatSetup('anthropic', cutOff([...owed, { role: 'assistant', content: [text('A')] }]));
  answered.view.renderHistory();
  assert.equal(answered.chat.continueShown, false);

  for (const action of ['message', 'stop', 'clear', 'new chat']) {
    const { plugin, view, chat } = await chatSetup('anthropic', cutOff(owed));
    view.renderHistory();
    assert.equal(chat.continueShown, true, action);
    transport(() => response('anthropic', [text('A')]));
    if (action === 'message') await view.handleUserMessage('Something else', null);
    else if (action === 'stop') view.handleStop();
    else if (action === 'clear') view.clearConversation();
    else view.newChat();
    assert.equal(chat.continueShown, false, action);
    assert.equal(plugin.conversations.find(c => c.id === 'c1')?.pendingTurn, undefined, action);
  }
});

test('A turn running in another chat keeps its mark while the user switches; its own chat offers no Continue while it runs', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  let release;
  transport((body, index) => index === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Done.')])); })
    : response('anthropic', [text('B')], 'end_turn', index));
  const running = view.handleUserMessage('Long one', null);
  while (!release) await tick();
  const a = plugin.activeConversationId;
  view.newChat();
  assert.ok(plugin.conversations.find(c => c.id === a).pendingTurn);
  await view.openConversation(a);
  assert.equal(chat.continueShown, false);
  release();
  await running;
  assert.equal(plugin.conversations.find(c => c.id === a).pendingTurn, undefined);
});
