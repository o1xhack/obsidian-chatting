// Live voice: calls on Codex's voice service with the ChatGPT sign-in, its
// events, delegation through the real chat view, steering, microphone
// modes, ending and the background. WebRTC, the microphone and the audio
// element are faked here.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, settings, text, call, response, vaultApp } from './harness.mjs';

const { voiceProtocol: P, voiceSession: S, voiceController: C, codexVoice: X } = api;
const { appLifecycle } = api.lifecycle;

// ─── Fake WebRTC, microphone and audio ──────────────────────────────────────

class FakeTrack { enabled = true; stopped = false; stop() { this.stopped = true; } }
class FakeStream {
  constructor() { this.track = new FakeTrack(); }
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}
class FakeChannel {
  readyState = 'connecting';
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; queueMicrotask(() => this.onclose?.()); }
  open() { this.readyState = 'open'; this.onopen?.(); this.receive({ type: 'session.started' }); }
  /** A server event arriving. */
  receive(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
const rtc = { pcs: [], mic: null, constraints: null };
class FakePeerConnection {
  constructor() { rtc.pcs.push(this); this.tracks = []; this.iceGatheringState = 'new'; this.connectionState = 'new'; this.closed = false; }
  addTrack(track) { this.tracks.push(track); }
  createDataChannel(label) { this.label = label; return (this.channel = new FakeChannel()); }
  async createOffer() { return { type: 'offer', sdp: 'offer-sdp' }; }
  async setLocalDescription(description) { this.localDescription = description; this.iceGatheringState = 'complete'; }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    setTimeout(() => { this.channel.open(); this.ontrack?.({ streams: [new FakeStream()], track: new FakeTrack() }); }, 0);
  }
  close() { this.closed = true; this.channel?.close(); }
}
globalThis.RTCPeerConnection = FakePeerConnection;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { userAgent: 'test', mediaDevices: { getUserMedia: async (constraints) => { rtc.constraints = constraints; return (rtc.mic = new FakeStream()); } } },
});
globalThis.createEl = () => ({ autoplay: false, srcObject: null, play: async () => {}, pause() {} });

const pc = () => rtc.pcs.at(-1);
const channel = () => pc().channel;
async function until(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  delete globalThis.__fetch;
  api.CAPABILITY_TIMING.networkMs = 1000;
  rtc.pcs = [];
  Object.assign(S.SESSION_TIMING, { iceWait: 10, iceSettle: 5, startWait: 1000, closeWait: 300, quietLog: 5 });
  Object.assign(S.SESSION_TIMING, { permissionWait: 1000, connectWait: 1000 });
  S.SESSION_TIMING.negotiationWait = 1000;
  Object.assign(C.VOICE_TIMING, { speaking: 20, continuation: 30, reconnectAfter: 40, endAfter: 150 });
  appLifecycle.markVisible();
  api.resetStreamTransport();
  globalThis.__notices = [];
});

// ─── A chat view with a fake component ──────────────────────────────────────

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    askUser: null,
    voice: null,
    voiceAvailable: false,
    queued: [],
    addUserMessage(value, images = [], turnId) { chat.shown.push({ id: nextId++, type: 'user', text: value, turnId }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.turnId === turnId); if (index >= 0) chat.shown = chat.shown.slice(0, index); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    addChanges() {}, setChangesUndone() {},
    showThinking() {}, hideThinking() {},
    showAskUser(question) { if (question !== undefined) chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, updateConversations() {}, setEditable() {},
    setQueued(texts) { chat.queued = texts; },
    setContinue() {}, clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {},
    setSelection() {}, getSelection: () => null, setEnterSends() {}, setFollowEdits() {},
    setVoice(state) { chat.voice = state; }, setVoiceAvailable(value) { chat.voiceAvailable = value; },
  };
  return chat;
}

const CHATGPT_KEY = 'chatting-with-ai-chatgpt-oauth';
const chatgptCredential = () => JSON.stringify({ accessToken: 'chatgpt-access', refreshToken: 'chatgpt-refresh', accountId: 'acct_1', expiresAt: Date.now() + 3600_000, updatedAt: Date.now() });
const codexAnswer = () => ({ status: 201, text: 'answer-sdp', headers: { Location: '/v1/live/rtc_1' } });

/** A plugin chatting with Anthropic, signed in to ChatGPT for voice, and a chat view with a fake component. */
async function voiceSetup({ micMode = 'hands-free' } = {}) {
  const { app } = vaultApp();
  const fileWatchers = new Set();
  app.workspace.on = (_name, changed) => { fileWatchers.add(changed); return changed; };
  app.workspace.offref = changed => fileWatchers.delete(changed);
  app.workspace.changedFile = () => { for (const changed of fileWatchers) changed(); };
  app.workspace.fileWatchers = fileWatchers;
  app.vault.adapter = { append: async () => {}, read: async () => { throw new Error('ENOENT'); }, exists: async () => false, write: async () => {} };
  const secrets = { [CHATGPT_KEY]: chatgptCredential() };
  app.secretStorage = { getSecret: (key) => secrets[key] ?? '', setSecret: (key, value) => { secrets[key] = value; } };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...plugin.settings, ...settings('anthropic'), voiceMicMode: micMode };
  plugin.chatgptOAuth = new api.ChatGPTOAuthService(new api.ChatGPTOAuthStore(app));
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { app, plugin, view, chat, secrets };
}

/** Routes voice call requests to `live` and chat requests (Anthropic, SSE) to `chat`. */
function serve({ live = codexAnswer, chat = () => response('anthropic', [text('OK')]) } = {}) {
  const log = { live: [], chat: [] };
  globalThis.__providerRequest = async (request) => {
    if (request.url.includes('/live/sessions') || request.url.includes('/realtime/calls')) {
      log.live.push(request);
      return live(request);
    }
    const body = JSON.parse(request.body);
    log.chat.push(body);
    return chat(body, log.chat.length - 1);
  };
  return log;
}

/** Start voice in the view and wait until it listens (once the data channel is open). */
async function startListening(view, chat) {
  const before = rtc.pcs.length;
  view.startVoice();
  await until(() => rtc.pcs.length > before && pc().channel?.readyState === 'open');
  await until(() => chat.voice?.status === 'listening');
}

const userText = (body) => {
  const last = body.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').at(-1);
  return last.content;
};
const said = (ch, words) => ch.receive({ type: 'input_transcript.added', item: { text: words } });
const answered = (ch, words) => ch.receive({ type: 'output_transcript.added', item: { text: words } });
/** A delegation; without `request` its text is empty and the request comes from the transcript. */
const delegated = (ch, id, request = '') => ch.receive({
  type: 'delegation.created',
  item: { id, type: 'delegation', target: 'client', content: request ? [{ type: 'input_text', text: request }] : [] },
});
/** What was sent back to a delegation on a channel, as [delegation ID, text]. */
const appended = (ch, kind) => ch.sent.filter((e) => e.type === 'delegation.context.append' && e.channel === kind)
  .map((e) => [e.delegation_item_id, e.content[0].text]);
/** Results handed to the voice model to say. */
const spoken = (ch) => appended(ch, 'speakable');
/** Progress notes for the voice model, not to be said. */
const notes = (ch) => appended(ch, 'commentary');

test('Spoken and progress chunks preserve every separator and edge whitespace', () => {
  const original = '  leading\n' + 'word café 🌍\tand another word\n'.repeat(60) + '\n trailing  ';
  for (const append of [P.speakEvents, P.progressEvents]) {
    const events = append('words', original);
    assert.ok(events.length > 1);
    assert.equal(events.map(e => e.content[0].text).join(''), original);
    assert.ok(events.every(e => new TextEncoder().encode(e.content[0].text).length <= 500));
  }
});

for (const terminal of ['user', 'assistant']) {
  test(`A ${terminal} terminal event queues a completed correction without a delegation`, async () => {
    const { view, chat, plugin } = await voiceSetup();
    let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('r', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
      : response('anthropic', [text('Done.')]) });
    await startListening(view, chat);
    const ch = channel();
    said(ch, 'Read the note'); delegated(ch, 'first', 'Read the note');
    await until(() => log.chat.length === 1);
    said(ch, 'Also keep the original title');
    ch.receive({ type: 'turn.done', turn: { role: terminal, transcript: terminal === 'user' ? 'Also keep the original title' : 'Okay.' } });
    answered(ch, 'Okay.');
    await until(() => chat.queued.includes('Also keep the original title'));
    release();
    await until(() => spoken(ch).length > 0);
    assert.equal(log.chat.length, 2);
    assert.match(JSON.stringify(log.chat[1]), /Also keep the original title/);
    assert.equal(plugin.chatHistory.filter(e => e.type === 'user' && e.text === 'Also keep the original title').length, 1);
    view.endVoice();
  });
}

test('A late original transcript is not re-steered when its delegation rephrased the request', async () => {
  const { view, chat } = await voiceSetup();
  let release;
  const log = serve({ chat: (_body, i) => i === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('r', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
    : response('anthropic', [text('Done.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Could you get the note content?');
  delegated(ch, 'first', 'Read Untitled.md');
  await until(() => log.chat.length === 1);
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Could you get the note content?' } });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(chat.queued, []);
  release();
  await until(() => spoken(ch).length > 0);
  assert.equal(log.chat.length, 2);
  assert.doesNotMatch(JSON.stringify(log.chat[1]), /The user added while you were working/);
  view.endVoice();
});

test('An open last-second correction runs next and its late terminal is not duplicated', async () => {
  const { view, chat, plugin } = await voiceSetup();
  let release;
  const log = serve({ chat: (_body, i) => i === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('First done.')])); })
    : response('anthropic', [text('Correction done.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Please read that note.');
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Please read that note.' } });
  delegated(ch, 'first', 'Read the note');
  await until(() => log.chat.length === 1);
  said(ch, 'Also preserve the title');
  release();
  await until(() => log.chat.length === 2 && spoken(ch).some(([, value]) => value === 'Correction done.'));
  assert.match(userText(log.chat[1]), /Also preserve the title/);
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Also preserve the title' } });
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Please read that note.' } });
  answered(ch, 'Okay.');
  await sleep(60);
  assert.equal(log.chat.length, 2);
  assert.equal(plugin.chatHistory.filter(e => e.type === 'user' && e.text === 'Also preserve the title').length, 1);
  view.endVoice();
});

for (const timing of ['before-waiter', 'after-waiter']) {
  test(`A pre-open channel close ${timing} immediately releases startup resources`, async () => {
    const original = FakePeerConnection.prototype.setRemoteDescription;
    FakePeerConnection.prototype.setRemoteDescription = async function () {
      if (timing === 'before-waiter') this.channel.onclose();
      else setTimeout(() => this.channel.close(), 0);
    };
    try {
      const { view, chat } = await voiceSetup();
      serve();
      view.startVoice();
      await until(() => chat.shown.some(e => e.type === 'error'), 200);
      assert.equal(chat.voice, null);
      assert.equal(rtc.mic.track.stopped, true);
      assert.equal(pc().closed, true);
      assert.equal(chat.shown.filter(e => e.type === 'error').length, 1);
    } finally { FakePeerConnection.prototype.setRemoteDescription = original; }
  });
}

test('A streaming probe aborts an unanswered fetch and advances with a timeout', async () => {
  api.CAPABILITY_TIMING.networkMs = 10;
  let signal, calls = 0;
  globalThis.__fetch = async (_url, init) => { calls++; signal = init.signal; return new Promise(() => {}); };
  await assert.rejects(api.streamProbe('https://probe.example', {}, {}, 'test'), /timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
});

test('A streaming probe cancels a stalled body reader even when fetch ignores abort', async () => {
  api.CAPABILITY_TIMING.networkMs = 10;
  let cancelled = false, signal;
  globalThis.__fetch = async (_url, init) => {
    signal = init.signal;
    return { ok: true, body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => { cancelled = true; } }) } };
  };
  await assert.rejects(api.streamProbe('https://probe.example', {}, {}, 'test'), /timed out/);
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
});

test('The abort probe also times out and releases a reader that ignores cancellation', async () => {
  api.CAPABILITY_TIMING.networkMs = 20;
  let calls = 0, cancelled = false;
  globalThis.__fetch = async () => {
    if (++calls === 1) return new Response('finished');
    let first = true;
    return { ok: true, body: { getReader: () => ({
      read: () => first ? (first = false, Promise.resolve({ done: false, value: new Uint8Array([1]) })) : new Promise(() => {}),
      cancel: async () => { cancelled = true; },
    }) } };
  };
  await assert.rejects(api.streamProbe('https://probe.example', {}, {}, 'test'), /timed out/);
  assert.equal(calls, 2);
  assert.equal(cancelled, true);
});

test('Successful streaming and an acknowledged abort report a passing capability probe', async () => {
  let calls = 0;
  globalThis.__fetch = async (_url, init) => {
    if (++calls === 1) return new Response(new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array([1])); setTimeout(() => { c.enqueue(new Uint8Array([2])); c.close(); }, 5);
    } }));
    let first = true;
    return { ok: true, body: { getReader: () => ({
      read: async () => { if (first) { first = false; return { done: false, value: new Uint8Array([1]) }; }
        if (init.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        return { done: true }; }, cancel: async () => {},
    }) } };
  };
  const result = await api.streamProbe('https://probe.example', {}, {}, 'test');
  assert.equal(result[0], 'ok');
  assert.match(result[1], /abort works/);
});

afterEach(() => { delete globalThis.__fetch; });

test('Ending while microphone permission is pending cancels startup and releases a late-granted stream', async () => {
  const original = navigator.mediaDevices.getUserMedia;
  let grant;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  const session = new S.VoiceSession({ name: 'pending', connect: async () => { throw Error('must not connect'); } }, {
    onMessage() {}, onEnded() {}, onAudioBlocked() {}, log() {},
  });
  try {
    const started = session.start('test', []);
    const rejected = assert.rejects(started, S.VoiceCancelled);
    await session.end();
    await rejected;
    const stream = new FakeStream();
    grant(stream);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stream.track.stopped, true);
    assert.equal(rtc.pcs.length, 0);
  } finally { navigator.mediaDevices.getUserMedia = original; }
});

test('A hung call-creation request times out without retrying or keeping the microphone', async () => {
  S.SESSION_TIMING.connectWait = 10;
  let calls = 0;
  const session = new S.VoiceSession({ name: 'pending', connect: () => { calls++; return new Promise(() => {}); } }, {
    onMessage() {}, onEnded() {}, onAudioBlocked() {}, log() {},
  });
  await assert.rejects(session.start('test', []), /voice service didn't answer/);
  assert.equal(calls, 1);
  assert.equal(rtc.mic.track.stopped, true);
  assert.equal(pc().closed, true);
});

test('The capability microphone probe times out and closes a stream granted afterward', async () => {
  const original = navigator.mediaDevices.getUserMedia;
  let grant;
  S.SESSION_TIMING.permissionWait = 10;
  navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { grant = resolve; });
  try {
    await assert.rejects(api.checkMicrophone(), /Microphone access timed out/);
    const stream = new FakeStream();
    grant(stream);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stream.track.stopped, true);
  } finally { navigator.mediaDevices.getUserMedia = original; }
});

test('A data-channel send failure during End still releases the microphone and peer', async () => {
  const ended = [];
  const session = new S.VoiceSession({ name: 'test', connect: async () => ({ sdp: 'answer' }) }, {
    onMessage() {}, onEnded: e => ended.push(e), onAudioBlocked() {}, log() {},
  });
  await session.start('test', []);
  channel().send = () => { throw Error('Channel closed during send'); };
  await session.end();
  assert.equal(rtc.mic.track.stopped, true);
  assert.equal(pc().closed, true);
  assert.equal(ended.length, 1);
});

test('A non-Error call failure is normalized and releases startup resources', async () => {
  const session = new S.VoiceSession({ name: 'test', connect: async () => { throw 'offline'; } }, {
    onMessage() {}, onEnded() {}, onAudioBlocked() {}, log() {},
  });
  await assert.rejects(session.start('test', []), error => error instanceof Error && error.message === 'offline');
  assert.equal(rtc.mic.track.stopped, true);
  assert.equal(pc().closed, true);
});

test('Hold mode is muted before SDP exchange, including reconnects', async () => {
  const { view, chat } = await voiceSetup({ micMode: 'hold' });
  serve({ live: () => {
    assert.equal(rtc.mic.track.enabled, false, 'no microphone audio during negotiation');
    return codexAnswer();
  } });
  await startListening(view, chat);
  view.endVoice();
});

test('Ending a session immediately ignores queued delegations and cannot unmute or play late audio', async () => {
  const events = [];
  const session = new S.VoiceSession({ name: 'test', connect: async () => codexAnswer() && ({ sdp: 'answer' }) }, {
    onMessage: value => events.push(value), onEnded() {}, onAudioBlocked() {}, log() {},
  });
  session.setMicEnabled(true);
  await session.start('Test', []);
  const ch = channel();
  const ending = session.end();
  session.setMicEnabled(true);
  delegated(ch, 'late', 'Create a note');
  assert.equal(rtc.mic.track.enabled, false);
  assert.deepEqual(events, [{ type: 'session.started' }]);
  ch.receive({ type: 'session.closed' });
  await ending;
  assert.equal(pc().closed, true);
});

test('A repeated delegation ID never dispatches the same request twice after completion', async () => {
  const { view, chat } = await voiceSetup();
  const log = serve();
  await startListening(view, chat);
  const ch = channel();
  delegated(ch, 'unique', 'Create a note');
  await until(() => spoken(ch).length > 0);
  delegated(ch, 'unique', 'Create a note');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(log.chat.length, 1);
  view.endVoice();
});

test('Voice refused during compaction reports failure and preserves the unsent typed composer', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve();
  const restored = [];
  chat.restoreDraft = (...args) => restored.push(args);
  await startListening(view, chat);
  view.compactions.set(plugin.activeConversationId, { agent: plugin.agent });
  const ch = channel();
  delegated(ch, 'busy', 'Edit my note');
  await until(() => spoken(ch).length > 0);
  assert.equal(log.chat.length, 0);
  assert.equal(restored.length, 0);
  assert.match(spoken(ch).map(([, s]) => s).join(''), /didn't work/);
  assert.ok(!notes(ch).some(([, s]) => s === C.TASK_DONE));
  assert.ok(chat.shown.some(row => row.type === 'error'));
  view.compactions.clear();
  view.endVoice();
});

test('Disconnecting ChatGPT ends an active call and releases the microphone', async () => {
  const { view, plugin, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  plugin.chatgptOAuth.clearCredential();
  view.updateVoiceAvailable();
  assert.equal(chat.voice, null);
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(chat.voiceAvailable, false);
});

test('A voice clarification prevents later writes in the same tool batch', async () => {
  const { view, chat, app } = await voiceSetup();
  let creations = 0;
  app.vault.create = async () => { creations++; };
  serve({ chat: () => response('anthropic', [
    call('q', 'ask_user', { question: 'Which folder?' }),
    call('w', 'create_file', { path: 'Wrong.md', content: 'premature' }),
  ], 'tool_use') });
  await startListening(view, chat);
  delegated(channel(), 'question', 'Create a note');
  await until(() => spoken(channel()).length > 0);
  assert.equal(creations, 0);
  assert.match(spoken(channel())[0][1], /Which folder/);
  view.endVoice();
});

test('Voice work enforces the selection displayed in the composer', async () => {
  const { view, chat, app, plugin } = await voiceSetup();
  const note = 'before\nselected\nafter';
  chat.getSelection = () => ({ filePath: 'Untitled.md', text: 'selected', from: 7, sourceText: note, occurrence: 0 });
  let writes = 0;
  app.vault.cachedRead = async () => note;
  app.vault.process = async () => { writes++; };
  const log = serve({ chat: (body, i) => i === 0 ? response('anthropic', [
    call('edit', 'edit_document', { path: 'Untitled.md', operation: 'replace', content: 'overwrite all' }),
  ], 'tool_use') : response('anthropic', [text('The edit was refused.')]) });
  await startListening(view, chat);
  delegated(channel(), 'scoped', 'Change this');
  await until(() => spoken(channel()).length > 0);
  assert.equal(writes, 0);
  assert.match(JSON.stringify(log.chat[1]), /selection/i);
  assert.equal(plugin.chatHistory.find(row => row.turnId)?.selection.filePath, 'Untitled.md');
  view.endVoice();
});

test('Stopping delegated work reports stopped rather than reading an earlier intermediate answer', async () => {
  const { view, chat } = await voiceSetup();
  let release;
  const log = serve({ chat: () => new Promise(resolve => { release = () => resolve(response('anthropic', [text('Done')])); }) });
  await startListening(view, chat);
  const ch = channel();
  delegated(ch, 'stop', 'Read the note');
  await until(() => log.chat.length > 0);
  view.handleStop();
  release();
  await until(() => spoken(ch).length > 0);
  assert.match(spoken(ch)[0][1], /task was stopped/);
  assert.ok(!notes(ch).some(([, s]) => s === C.TASK_DONE));
  view.endVoice();
});

// ─── Session creation ───────────────────────────────────────────────────────

test('A call with the instructions, voice, client delegation, recent chat and the offer; the answer SDP is applied', async () => {
  const { view, plugin, chat } = await voiceSetup();
  plugin.chatHistory.push({ type: 'user', text: 'Earlier question', turnId: 't0' }, { type: 'assistant', text: 'Earlier answer' }, { type: 'error', text: 'ignored' });
  const log = serve();
  await startListening(view, chat);

  const request = log.live[0];
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas');
  assert.equal(request.headers.Authorization, 'Bearer chatgpt-access');
  const body = JSON.parse(request.body);
  assert.equal(body.sdp, 'offer-sdp');
  assert.equal(body.session.model, 'gpt-live-1-codex');
  assert.deepEqual(body.session.audio, { output: { voice: 'cove' } });
  assert.deepEqual(body.session.delegation, { type: 'client' });
  assert.match(body.session.instructions, /^You are the voice of Chatting with AI,/);
  assert.match(body.session.instructions, /Delegate when:/);
  assert.match(body.session.instructions, /Never say you'll do something that you haven't handed over\./);
  assert.deepEqual(body.session.initial_items, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Earlier question' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Earlier answer' }] },
  ]);
  assert.deepEqual(pc().remoteDescription, { type: 'answer', sdp: 'answer-sdp' });
  assert.equal(pc().label, 'oai-events');
  assert.deepEqual(rtc.constraints, { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  assert.equal(chat.voice.micOn, true);
  view.endVoice();
});

test('The voice model knows the note or canvas open when the call starts', async () => {
  const { view, chat, app } = await voiceSetup();
  app.workspace.getActiveFile = () => ({ path: 'Ideas/App map.canvas', extension: 'canvas' });
  const log = serve();
  await startListening(view, chat);
  assert.match(JSON.parse(log.live[0].body).session.instructions, /The user has the canvas "Ideas\/App map\.canvas" open\.$/);
  view.endVoice();

  app.workspace.getActiveFile = () => null;
  await startListening(view, chat);
  assert.match(JSON.parse(log.live[1].body).session.instructions, /The user has no note or canvas open\.$/);
  view.endVoice();
});

test('Device check: one call starts and is closed at once; signed out, it is skipped', async () => {
  assert.deepEqual(await api.checkLiveVoice(null), ['skip', 'needs the ChatGPT account sign-in']);
  globalThis.__providerRequest = async () => codexAnswer();
  const route = X.codexVoiceRoute({ getUsableCredential: async () => ({ accessToken: 'a', accountId: 'acct_1' }) }, 'cove', () => '1.2.3');
  const checking = api.checkLiveVoice(route);
  await until(() => pc()?.channel?.readyState === 'open');
  await until(() => channel().sent.some((event) => event.type === 'session.close'));
  channel().receive({ type: 'session.closed' });
  const result = await checking;
  assert.equal(result[0], 'ok');
  assert.match(result[1], /call rtc_1 started .* then closed; events: session\.started, session\.closed/);
  assert.equal(pc().closed, true);
  assert.equal(rtc.mic.track.stopped, true);
});

test('An HTTP error ends voice with the status in the chat', async () => {
  const { view, chat, plugin } = await voiceSetup();
  serve({ live: () => ({ status: 403, text: 'Forbidden' }) });
  view.startVoice();
  await until(() => chat.shown.some((m) => m.type === 'error'));
  assert.match(chat.shown.at(-1).text, /Couldn't start voice \(HTTP 403\)/);
  assert.equal(plugin.chatHistory.at(-1).type, 'error');
  assert.equal(chat.voice, null);
  assert.equal(pc().closed, true);
  assert.equal(rtc.mic.track.stopped, true);
});

// ─── The route ──────────────────────────────────────────────────────────────

test('Codex route: prepare() starts the sign-in check and version lookup at once; connect() uses them, a later call checks again', async () => {
  let credentialChecks = 0;
  let versionLookups = 0;
  const auth = { getUsableCredential: async () => { credentialChecks++; return { accessToken: 'a', accountId: 'acct_1' }; } };
  globalThis.__providerRequest = async () => codexAnswer();
  const route = X.codexVoiceRoute(auth, 'ember', () => { versionLookups++; return '1.2.3'; });

  route.prepare();
  assert.equal(credentialChecks, 1);
  assert.equal(versionLookups, 1);
  await route.connect({ sdp: 'offer', instructions: 'x', items: [] });
  assert.equal(credentialChecks, 1);
  assert.equal(versionLookups, 1);
  await route.connect({ sdp: 'offer', instructions: 'x', items: [] });
  assert.equal(credentialChecks, 2);
});

test('Codex route: POST to the realtime calls route with Codex headers and the ChatGPT sign-in; the call ID comes from Location', async () => {
  const auth = { getUsableCredential: async () => ({ accessToken: 'chatgpt-access', accountId: 'acct_1' }) };
  const requests = [];
  globalThis.__providerRequest = async (request) => {
    requests.push(request);
    return { status: 201, text: 'answer-sdp', headers: { location: '/v1/live/rtc_abc123' } };
  };
  const route = X.codexVoiceRoute(auth, 'ember', () => '1.2.3');
  const items = P.seedItems([{ type: 'user', text: 'Hi' }]);
  // As in a mobile WebView without crypto.randomUUID().
  const randomUUID = crypto.randomUUID;
  crypto.randomUUID = undefined;
  let result;
  try {
    result = await route.connect({ sdp: 'offer-sdp', instructions: 'Be brief', items });
  } finally {
    crypto.randomUUID = randomUUID;
  }

  assert.deepEqual(result, { sdp: 'answer-sdp', callId: 'rtc_abc123' });
  const [request] = requests;
  assert.equal(request.url, 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas');
  assert.equal(request.method, 'POST');
  const h = request.headers;
  assert.equal(h.Authorization, 'Bearer chatgpt-access');
  assert.equal(h['ChatGPT-Account-ID'], 'acct_1');
  assert.equal(h['openai-alpha'], 'quicksilver=v2');
  assert.equal(h.originator, 'codex_cli_rs');
  assert.equal(h.version, '1.2.3');
  assert.match(h['User-Agent'], /^codex_cli_rs\/1\.2\.3 \(.+; unknown\) obsidian$/);
  assert.match(h['x-session-id'], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(h['session-id'], h['x-session-id']);
  assert.equal(h['thread-id'], h['x-session-id']);
  assert.deepEqual(JSON.parse(request.body), {
    sdp: 'offer-sdp',
    session: { instructions: 'Be brief', audio: { output: { voice: 'ember' } }, delegation: { type: 'client' }, model: 'gpt-live-1-codex', initial_items: items },
  });

  // Signed out, or a sign-in without an account: no call.
  const signedOut = X.codexVoiceRoute({ getUsableCredential: async () => null }, 'ember', () => '1.2.3');
  await assert.rejects(signedOut.connect({ sdp: 'o', instructions: '', items: [] }), /Connect your ChatGPT account/);
  const noAccount = X.codexVoiceRoute({ getUsableCredential: async () => ({ accessToken: 'a' }) }, 'ember', () => '1.2.3');
  await assert.rejects(noAccount.connect({ sdp: 'o', instructions: '', items: [] }), /no account ID/);
  assert.equal(requests.length, 1);
});

// ─── Event parsing ──────────────────────────────────────────────────────────

test('Events: transcripts, turns, delegations with and without text, errors, closed', () => {
  const parse = P.parseVoiceEvent;
  assert.deepEqual(parse({ type: 'input_transcript.added', item: { text: 'Find my' } }), { kind: 'input', text: 'Find my' });
  assert.deepEqual(parse({ type: 'output_transcript.added', item: { text: 'On it' } }), { kind: 'output', text: 'On it' });
  assert.deepEqual(parse({ type: 'turn.done', turn: { role: 'user', transcript: 'Find my note' } }), { kind: 'turn-done', role: 'user', text: 'Find my note' });
  assert.deepEqual(parse({ type: 'delegation.created', item: { id: 'it_1', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Find ' }, { type: 'input_text', text: 'my note' }] } }),
    { kind: 'delegation', id: 'it_1', text: 'Find my note' });
  assert.deepEqual(parse({ type: 'delegation.created', item: { id: 'it_2', type: 'delegation' } }), { kind: 'delegation', id: 'it_2', text: '' });
  assert.deepEqual(parse({ type: 'delegation.created', item: { id: 'it_3', target: 'responses' } }), { kind: 'other' });
  assert.deepEqual(parse({ type: 'error', error: { type: 'invalid_request_error', code: 'x', message: 'Bad event' } }), { kind: 'error', message: 'Bad event' });
  assert.deepEqual(parse({ type: 'error', message: 'Plain message' }), { kind: 'error', message: 'Plain message' });
  assert.deepEqual(parse({ type: 'session.closed', reason: 'expired' }), { kind: 'closed', reason: 'expired' });
  assert.deepEqual(parse({ type: 'session.usage.updated' }), { kind: 'other' });
  assert.deepEqual(parse('nonsense'), { kind: 'other' });
});

test('Answers go back in appends of at most 500 bytes; long answers point to the chat', () => {
  const japanese = '日本語のメモです。'.repeat(60);
  const events = P.speakEvents('it_1', japanese);
  assert.ok(events.length > 1);
  for (const event of events) {
    assert.deepEqual(Object.keys(event), ['type', 'delegation_item_id', 'channel', 'content']);
    assert.equal(event.type, 'delegation.context.append');
    assert.equal(event.channel, 'speakable');
    assert.ok(new TextEncoder().encode(event.content[0].text).length <= 500);
  }
  assert.equal(events.map((e) => e.content[0].text).join(''), japanese);
  assert.deepEqual(P.progressEvents('it_1', 'Reading'), [
    { type: 'delegation.context.append', delegation_item_id: 'it_1', channel: 'commentary', content: [{ type: 'input_text', text: 'Reading' }] },
  ]);

  const long = 'This is a sentence. '.repeat(300);
  const spokenText = P.spokenAnswer(long);
  assert.ok(spokenText.length < 3100);
  assert.match(spokenText, /The full answer is in the chat\.$/);
  assert.equal(P.spokenAnswer('Short.'), 'Short.');
});

// ─── Delegation through the chat view ───────────────────────────────────────

test('A delegation runs what the user said as a chat turn; progress and answer go back with the delegation ID', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve({
    chat: (body, index) => index === 0
      ? response('anthropic', [text('Let me check.'), call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')
      : response('anthropic', [text('Your note says Original.')]),
  });
  await startListening(view, chat);

  const ch = channel();
  said(ch, 'What does my ');
  said(ch, 'note say?');
  delegated(ch, 'del_1');
  await until(() => spoken(ch).length);

  const user = plugin.chatHistory.find((e) => e.type === 'user');
  assert.equal(user.text, 'What does my note say?');
  assert.ok(user.turnId);
  assert.match(userText(log.chat[0]), /This turn comes from a voice conversation/);
  assert.match(userText(log.chat[0]), /What does my note say\?$/);
  assert.equal(plugin.agent.exportMessages().find((m) => m.turnId)?.turnId, user.turnId);
  assert.ok(chat.shown.some((m) => m.type === 'tool-result'));
  assert.equal(plugin.chatHistory.at(-1).text, 'Your note says Original.');

  // Before the answer: the task is finished, so a request said now needs a delegation of its own.
  assert.deepEqual(notes(ch), [['del_1', 'Let me check.'], ['del_1', C.stepNote('read_file')], ['del_1', C.TASK_DONE]]);
  assert.deepEqual(spoken(ch), [['del_1', 'Your note says Original.']]);
  await until(() => chat.voice?.status === 'listening');
  assert.equal(chat.voice.you, 'What does my note say?');
  view.endVoice();
});

test('The live caption holds only the current words: cleared once the voice answers', async () => {
  const { view, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Hello there');
  assert.equal(chat.voice.you, 'Hello there');
  answered(ch, 'Hi!');
  assert.equal(chat.voice.you, '');
  said(ch, 'Next');
  assert.equal(chat.voice.you, 'Next');
  view.endVoice();
});

test('the delegation text runs as the turn; progress and the answer go back as ≤500-byte delegation.context.append chunks', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const answer = '日本語のメモです。'.repeat(60);
  const log = serve({
    live: codexAnswer,
    chat: (body, index) => index === 0
      ? response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')
      : response('anthropic', [text(answer)]),
  });
  await startListening(view, chat);
  assert.match(log.live[0].url, /backend-api\/codex\/realtime\/calls/);
  assert.equal(log.live[0].headers.Authorization, 'Bearer chatgpt-access');
  assert.equal(JSON.parse(log.live[0].body).session.audio.output.voice, 'cove');

  const ch = channel();
  ch.receive({ type: 'input_transcript.added', item: { text: 'Summarize my note' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_1', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Summarize the note' }] } });
  await until(() => ch.sent.some((e) => e.channel === 'speakable'));

  assert.equal(plugin.chatHistory.find((e) => e.type === 'user').text, 'Summarize the note');
  const progress = ch.sent.filter((e) => e.channel === 'commentary');
  assert.deepEqual(progress.map((e) => e.content[0].text), [C.stepNote('read_file'), C.TASK_DONE]);
  const spoken = ch.sent.filter((e) => e.channel === 'speakable');
  assert.ok(spoken.length > 1);
  for (const event of spoken) {
    assert.equal(event.type, 'delegation.context.append');
    assert.equal(event.delegation_item_id, 'it_1');
    assert.ok(new TextEncoder().encode(event.content[0].text).length <= 500);
  }
  assert.equal(spoken.map((e) => e.content[0].text).join(''), answer);
  view.endVoice();
});

test('the live caption isn\'t brought back by a user turn reported after the voice answered', async () => {
  const { view, chat } = await voiceSetup();
  serve({ live: codexAnswer });
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'input_transcript.added', item: { text: 'Hello there' } });
  assert.equal(chat.voice.you, 'Hello there');
  ch.receive({ type: 'output_transcript.added', item: { text: 'Hi!' } });
  assert.equal(chat.voice.you, '');
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Hello there' } });
  assert.equal(chat.voice.you, '');
  ch.receive({ type: 'input_transcript.added', item: { text: 'Next' } });
  assert.equal(chat.voice.you, 'Next');
  view.endVoice();
});

test('what was said since the last request goes with the next one; the request reported late isn\'t kept again', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve({ live: codexAnswer, chat: () => response('anthropic', [text('Added the heading test.')]) });
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'input_transcript.added', item: { text: 'Ask me what the heading should be called, ' } });
  ch.receive({ type: 'input_transcript.added', item: { text: 'then add it.' } });
  // The voice answers before the user's turn is reported: kept once.
  ch.receive({ type: 'output_transcript.added', item: { text: 'What should the heading be called?' } });
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Ask me what the heading should be called, then add it.' } });
  ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'What should the heading be called?' } });
  ch.receive({ type: 'input_transcript.added', item: { text: 'Test.' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_1', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'test' }] } });
  await until(() => ch.sent.some((e) => e.channel === 'speakable'));
  // The user turn reported late is the request already taken: not context next time.
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Test.' } });

  const sent = userText(log.chat[0]);
  assert.match(sent, /Said in the voice conversation before this request \(context\): User: "Ask me what the heading should be called, then add it\." Voice: "What should the heading be called\?"\./);
  assert.match(sent, /\n\ntest$/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Ask me what the heading should be called, then add it.', false], ['test', true]]);

  // The next request carries only what was said after this one.
  ch.receive({ type: 'output_transcript.added', item: { text: 'Done.' } });
  ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Done.' } });
  ch.receive({ type: 'input_transcript.added', item: { text: 'Now remove it.' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_2', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Remove the heading test' }] } });
  await until(() => log.chat.length === 2);
  const next = userText(log.chat[1]);
  assert.match(next, /\(context\): Voice: "Done\." User: "Now remove it\."\./);
  assert.doesNotMatch(next, /Ask me|Test\./);
  // "Now remove it." is the request as the voice put it: the chat shows the request only.
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text).slice(2), ['Remove the heading test']);
  view.endVoice();
});

test('a short reply after a request is kept as context, not taken for the request reported late', async () => {
  const { view, chat } = await voiceSetup();
  const log = serve({ live: codexAnswer, chat: () => response('anthropic', [text('OK.')]) });
  await startListening(view, chat);
  const ch = channel();
  ch.receive({ type: 'input_transcript.added', item: { text: 'Create a note about cats.' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_1', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Create a note about cats' }] } });
  await until(() => ch.sent.some((e) => e.channel === 'speakable'));
  // "No." contains no word of the request in order: a new user turn.
  ch.receive({ type: 'input_transcript.added', item: { text: 'No.' } });
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'No.' } });
  ch.receive({ type: 'output_transcript.added', item: { text: 'Should I stop?' } });
  ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Should I stop?' } });
  ch.receive({ type: 'input_transcript.added', item: { text: 'Yes, delete it.' } });
  ch.receive({ type: 'delegation.created', item: { id: 'it_2', type: 'delegation', target: 'client', content: [{ type: 'input_text', text: 'Delete the cats note' }] } });
  await until(() => log.chat.length === 2);
  assert.match(userText(log.chat[1]), /\(context\): User: "No\." Voice: "Should I stop\?" User: "Yes, delete it\."\./);
  view.endVoice();
});

test('What was said since the last request goes with the next one (the voice asked first, the user answered)', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve({ chat: () => response('anthropic', [text('Added the heading Test.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Ask me what the heading should be called, ');
  said(ch, 'then add it.');
  answered(ch, 'What should the heading be called?');
  said(ch, 'Test.');
  delegated(ch, 'del_1');
  await until(() => spoken(ch).length);

  const sent = userText(log.chat[0]);
  assert.match(sent, /Said in the voice conversation before this request \(context\): User: "Ask me what the heading should be called, then add it\." Voice: "What should the heading be called\?"\./);
  assert.match(sent, /\n\nTest\.$/);
  // The voice's question belongs to the request: the chat shows the user's words before it.
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Ask me what the heading should be called, then add it.', false], ['Test.', true]]);

  // The next request carries only what was said after this one.
  answered(ch, 'Done.');
  said(ch, 'Now remove it.');
  delegated(ch, 'del_2');
  await until(() => log.chat.length === 2);
  const next = userText(log.chat[1]);
  assert.match(next, /\(context\): Voice: "Done\."\./);
  assert.doesNotMatch(next, /Ask me|Test\./);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text).slice(2), ['Now remove it.']);
  view.endVoice();
});

test('What the voice answered itself stays out of the chat; the agent still gets it as context', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve({ chat: () => response('anthropic', [text('Deleted the card.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Anything unclear?');
  answered(ch, 'Nope.');
  // A pause: a new sentence, not the rest of the question.
  await new Promise((resolve) => setTimeout(resolve, 80));
  said(ch, 'Delete that card.');
  delegated(ch, 'del_1');
  await until(() => log.chat.length === 1);
  // The agent: everything said since the last request, then the request.
  assert.match(userText(log.chat[0]), /\(context\): User: "Anything unclear\?" Voice: "Nope\."\./);
  assert.match(userText(log.chat[0]), /Delete that card\.$/);
  // The chat: the request only.
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text), ['Delete that card.']);
  view.endVoice();
});

test('A new request while the voice turn runs steers it with what was said before it', async () => {
  const { view, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
      : response('anthropic', [text('Done.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Add a section');
  delegated(ch, 'del_1');
  await until(() => log.chat.length === 1);
  said(ch, 'Add another one');
  answered(ch, 'What should it be called?');
  said(ch, 'notes-notes');
  delegated(ch, 'del_2');
  await until(() => chat.queued?.length === 1);
  assert.deepEqual(chat.queued, ['notes-notes']);
  releaseFirst();
  await until(() => log.chat.length === 2);
  assert.match(JSON.stringify(log.chat[1]), /\[The user added while you were working: Said in the voice conversation before this request \(context\): User: \\"Add another one\\" Voice: \\"What should it be called\?\\"\.\] notes-notes/);
  view.endVoice();
});

test('A new request while the voice turn runs steers it: nothing is stopped, the agent gets it after its current step', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
      : response('anthropic', [text('Added both sections.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Add a Notes section');
  delegated(ch, 'del_1');
  await until(() => log.chat.length === 1);

  said(ch, 'Also add notes-notes');
  delegated(ch, 'del_2');
  await until(() => notes(ch).some(([id]) => id === 'del_2'));
  assert.equal(notes(ch).filter(([id]) => id === 'del_2').at(-1)[1], C.ADDED_TO_TASK);
  releaseFirst();
  await until(() => spoken(ch).length);

  // One turn: the second request went out with the step after the tool.
  assert.equal(log.chat.length, 2);
  assert.match(JSON.stringify(log.chat[1]), /\[The user added while you were working:\] Also add notes-notes/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Add a Notes section', true], ['Also add notes-notes', false]]);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'assistant').map((e) => e.text), ['Added both sections.']);
  assert.deepEqual(spoken(ch),
    [['del_2', 'Added both sections.']]);
  view.endVoice();
});

test('A short "Okay," of the voice in the middle of a sentence doesn\'t split the request', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve({ chat: () => response('anthropic', [text('Removed the left card.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Ah, wait, remove the one on the');
  answered(ch, 'Okay,');
  said(ch, 'left');
  delegated(ch, 'del_1');
  await until(() => log.chat.length === 1);
  assert.match(userText(log.chat[0]), /\n\nAh, wait, remove the one on the left$/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text), ['Ah, wait, remove the one on the left']);
  view.endVoice();
});

test('Said during a running task without a delegation: it still reaches the task; a late delegation of it runs nothing twice', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
      : response('anthropic', [text('Added cards on both sides.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Add a card to the left');
  delegated(ch, 'del_1');
  await until(() => log.chat.length === 1);

  // As live: the voice answers the addition itself and delegates nothing.
  said(ch, 'Also, add a card to the right');
  answered(ch, 'Okay, adding that too.');
  // Once the user has been quiet a moment (shortened here), the words go to the task.
  await new Promise((resolve) => setTimeout(resolve, 80));
  releaseFirst();
  await until(() => spoken(ch).length);
  assert.equal(log.chat.length, 2);
  assert.match(log.chat[1].messages.at(-1).content.findLast(part => part.type === 'text').text, /^\[The user added while you were working:[^\]]*\] Also, add a card to the right$/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text), ['Add a card to the left', 'Also, add a card to the right']);

  // The old terminal/delegation arrives late, without a fresh user utterance.
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Also, add a card to the right' } });
  delegated(ch, 'del_2', 'Also, add a card to the right');
  await until(() => appended(ch, 'commentary').some(([id]) => id === 'del_2'));
  assert.equal(log.chat.length, 2);
  view.endVoice();
});

test('Fragments around a short "Okay," during a running task reach it as one addition', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [call('r1', 'read_file', { path: 'Untitled.md' })], 'tool_use')); })
      : response('anthropic', [text('Done.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Add a card to the left');
  delegated(ch, 'del_1');
  await until(() => log.chat.length === 1);
  said(ch, 'Wait, there is a second empty one');
  answered(ch, 'Okay,');
  said(ch, 'on the right');
  answered(ch, 'Got it.');
  await new Promise((resolve) => setTimeout(resolve, 80));
  releaseFirst();
  await until(() => spoken(ch).length);
  assert.equal(log.chat.length, 2);
  assert.match(log.chat[1].messages.at(-1).content.findLast(part => part.type === 'text').text, /^\[The user added while you were working:[^\]]*\] Wait, there is a second empty one on the right$/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text),
    ['Add a card to the left', 'Wait, there is a second empty one on the right']);
  view.endVoice();
});

test('Words said just before a task ends, not yet added to it, run as the next turn', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [text('Added the left card.')])); })
      : response('anthropic', [text('Added the right card.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Add a card to the left');
  delegated(ch, 'del_1');
  await until(() => log.chat.length === 1);
  // Said, the voice answers, and the task ends before the wait is over.
  said(ch, 'Also one on the right');
  answered(ch, 'Sure.');
  releaseFirst();
  await until(() => log.chat.length === 2);
  assert.match(userText(log.chat[1]), /Also one on the right$/);
  await until(() => plugin.chatHistory.filter((e) => e.type === 'assistant').length === 2);
  view.endVoice();
});

test('The agent\'s question ends the voice turn as its answer; the spoken reply is the next request', async () => {
  const { view, plugin, chat } = await voiceSetup();
  const log = serve({
    chat: (body, index) => index === 0
      ? response('anthropic', [call('q1', 'ask_user', { question: 'Which name?' })], 'tool_use')
      : response('anthropic', [text('Added notes-notes.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Add a section');
  delegated(ch, 'del_1');
  // The question is the delegation's answer: spoken, the turn is over, nothing waits.
  await until(() => spoken(ch).some(([, words]) => words === 'Which name?'));
  await until(() => !view.running);
  assert.equal(chat.askUser, null);
  assert.equal(log.chat.length, 1);

  answered(ch, 'Which name?');
  said(ch, 'notes-notes');
  delegated(ch, 'del_2');
  await until(() => spoken(ch).some(([, words]) => words === 'Added notes-notes.'));

  assert.equal(log.chat.length, 2);
  const second = JSON.stringify(log.chat[1]);
  assert.match(second, /Asked aloud in the voice conversation/);
  assert.match(userText(log.chat[1]), /\(context\): Voice: "Which name\?"\.[\s\S]*notes-notes$/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]),
    [['Add a section', true], ['notes-notes', true]]);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'assistant').map((e) => e.text), ['Which name?', 'Added notes-notes.']);
  view.endVoice();
});

test('A request that arrives after the turn\'s last step runs as the next turn', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let releaseFirst;
  const log = serve({
    chat: (body, index) => index === 0
      ? new Promise((resolve) => { releaseFirst = () => resolve(response('anthropic', [text('First done.')])); })
      : response('anthropic', [text('Second done.')]),
  });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'First');
  delegated(ch, 'del_1');
  await until(() => log.chat.length === 1);
  said(ch, 'Second');
  delegated(ch, 'del_2');
  await until(() => notes(ch).some(([id]) => id === 'del_2'));
  releaseFirst();
  await until(() => spoken(ch).length === 2);

  assert.equal(log.chat.length, 2);
  assert.match(userText(log.chat[1]), /Second$/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => [e.text, !!e.turnId]), [['First', true], ['Second', true]]);
  assert.deepEqual(spoken(ch).map(([, words]) => words), ['First done.', 'Second done.']);
  view.endVoice();
});

test('Ending voice lets a running turn finish in the chat without speaking it', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let release;
  serve({ chat: () => new Promise((resolve) => { release = () => resolve(response('anthropic', [text('Done anyway')])); }) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Do it');
  delegated(ch, 'del_1');
  await until(() => typeof release === 'function');
  view.endVoice();
  release();
  await until(() => plugin.chatHistory.some((e) => e.text === 'Done anyway'));
  assert.equal(spoken(ch).length, 0);
});

test('Typed during a voice turn, then the call ends: the message still runs as a typed turn', async () => {
  const { view, plugin, chat } = await voiceSetup();
  let release;
  const log = serve({ chat: (body, index) => index === 0
    ? new Promise((resolve) => { release = () => resolve(response('anthropic', [text('First done.')])); })
    : response('anthropic', [text('Summary added.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Do it');
  delegated(ch, 'del_1');
  await until(() => typeof release === 'function');
  // Typed while the turn's last step runs: it can't join that step.
  await view.handleUserMessage('Also add a summary', null);
  view.endVoice();
  release();
  await until(() => plugin.chatHistory.some((e) => e.text === 'Summary added.'));
  assert.equal(log.chat.length, 2);
  assert.match(userText(log.chat[1]), /Also add a summary$/);
  assert.doesNotMatch(userText(log.chat[1]), /voice conversation/);
  assert.deepEqual(chat.queued, []);
});

// ─── Microphone and ending ──────────────────────────────────────────────────

test('Hold to talk: the microphone track is on only while pressed; hands-free mute toggles it', async () => {
  const held = await voiceSetup({ micMode: 'hold' });
  serve();
  await startListening(held.view, held.chat);
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(held.chat.voice.holdToTalk, true);
  held.view.handleVoice('talk-start');
  assert.equal(rtc.mic.track.enabled, true);
  assert.equal(held.chat.voice.micOn, true);
  held.view.handleVoice('talk-end');
  assert.equal(rtc.mic.track.enabled, false);
  held.view.endVoice();

  const free = await voiceSetup();
  serve();
  await startListening(free.view, free.chat);
  assert.equal(rtc.mic.track.enabled, true);
  free.view.handleVoice('talk-start');
  assert.equal(rtc.mic.track.enabled, true);
  free.view.handleVoice('mute');
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(free.chat.voice.micOn, false);
  free.view.handleVoice('mute');
  assert.equal(rtc.mic.track.enabled, true);
  free.view.endVoice();
});

test('End sends session.close and closes on session.closed, or after the timeout', async () => {
  const { view, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  const first = pc();
  const started = Date.now();
  view.endVoice();
  assert.equal(chat.voice, null);
  assert.deepEqual(first.channel.sent.at(-1), { type: 'session.close' });
  first.channel.receive({ type: 'session.closed', reason: 'close_requested' });
  await until(() => first.closed);
  assert.ok(Date.now() - started < 200);
  assert.equal(rtc.mic.track.stopped, true);
  assert.equal(chat.shown.filter((m) => m.type === 'error').length, 0);

  await startListening(view, chat);
  const second = pc();
  const again = Date.now();
  view.endVoice();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(second.closed, false);
  await until(() => second.closed);
  assert.ok(Date.now() - again >= 250);
});

test('Ending a call lets the screen sleep again and turns the microphone off at once, before the call has closed', async () => {
  api.screenAwake.reset();
  const { view, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  assert.equal(api.screenAwake.holders, 1);
  view.endVoice();
  // Nothing more is heard while the call closes.
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(api.screenAwake.holders, 0);
  await until(() => pc().closed);
  // A reconnect releases the old call's hold too.
  await startListening(view, chat);
  view.reconnectVoice();
  await until(() => chat.voice?.status === 'listening');
  assert.equal(api.screenAwake.holders, 1);
  view.endVoice();
  assert.equal(api.screenAwake.holders, 0);
});

test('A spoken addition during a voice turn is taken into it in the same chat; nothing is stopped', async () => {
  const { view, chat, plugin } = await voiceSetup();
  let release;
  serve({ chat: (body, index) => index === 0 ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Done.')])); }) : response('anthropic', [text('Next.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Create a note');
  delegated(ch, 'del_1', 'Create a note');
  // The voice turn runs: the addition joins it.
  await until(() => view.running);
  said(ch, 'call it Plan');
  delegated(ch, 'del_2', 'call it Plan');
  await until(() => !!release);
  release();
  await until(() => plugin.chatHistory.filter(e => e.type === 'assistant').length >= 2);
  assert.deepEqual(plugin.chatHistory.filter(e => e.type === 'error'), []);
  view.endVoice();
});

test('The server ending the session shows why; a new chat ends voice', async () => {
  const { view, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  channel().receive({ type: 'session.closed', reason: 'expired' });
  await until(() => chat.voice === null);
  assert.match(chat.shown.at(-1).text, /ended \(expired\)/);
  assert.equal(pc().closed, true);

  await startListening(view, chat);
  const ch = channel();
  view.newChat();
  assert.equal(chat.voice, null);
  assert.deepEqual(ch.sent.at(-1), { type: 'session.close' });
  await until(() => pc().closed);
});

test('The voice button is offered only with the ChatGPT sign-in', async () => {
  const { view, chat, secrets } = await voiceSetup();
  view.updateVoiceAvailable();
  assert.equal(chat.voiceAvailable, true);
  secrets[CHATGPT_KEY] = '';
  view.updateVoiceAvailable();
  assert.equal(chat.voiceAvailable, false);
  view.startVoice();
  assert.deepEqual(globalThis.__notices, ['Connect your ChatGPT account in Chatting with AI settings to use voice.']);
  assert.equal(rtc.pcs.length, 0);
});

test('The voice settings: the ChatGPT account row, the voice and the microphone mode in data.json', async () => {
  const { app, plugin, secrets } = await voiceSetup();
  app.workspace.getLeavesOfType = () => [];
  let saved;
  plugin.saveData = async (data) => { saved = data; };
  await plugin.saveSettings();
  assert.equal(saved.voice, 'cove');
  assert.equal(saved.voiceMicMode, 'hands-free');
  plugin.loadData = async () => ({ voice: 'ember', voiceMicMode: 'hold' });
  await plugin.loadSettings();
  assert.equal(plugin.settings.voice, 'ember');
  assert.equal(plugin.settings.voiceMicMode, 'hold');
  // Not one of Codex's voices (GPT-Live's "marin"): the service would refuse the call.
  plugin.loadData = async () => ({ voice: 'marin', voiceMicMode: 'shout' });
  await plugin.loadSettings();
  assert.equal(plugin.settings.voice, 'cove');
  assert.equal(plugin.settings.voiceMicMode, 'hands-free');

  // The account row: connected, or a button to connect.
  const tab = new api.ChatSettingTab({}, plugin);
  const row = () => {
    const setting = { buttons: [], setName() { return setting; }, setDesc(desc) { setting.desc = desc; return setting; },
      addButton(fn) { const b = { setButtonText(t) { b.text = t; return b; }, setCta() { return b; }, onClick() { return b; } }; fn(b); setting.buttons.push(b.text); return setting; } };
    return setting;
  };
  const connected = row();
  tab.renderVoiceAccount(connected);
  assert.match(connected.desc, /Connected \(account/);
  assert.deepEqual(connected.buttons, []);
  secrets[CHATGPT_KEY] = '';
  const signedOut = row();
  tab.renderVoiceAccount(signedOut);
  assert.match(signedOut.desc, /Not connected/);
  assert.deepEqual(signedOut.buttons, ['Connect ChatGPT']);
});

// ─── Background ─────────────────────────────────────────────────────────────

afterEach(() => { api.Platform.isMobileApp = false; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorsShown = (chat) => chat.shown.filter((m) => m.type === 'error').map((m) => m.text);

/** Voice listening on a phone, the peer connection up. */
async function phoneVoice(options) {
  api.Platform.isMobileApp = true;
  const setup = await voiceSetup(options);
  const log = serve();
  await startListening(setup.view, setup.chat);
  pc().connectionState = 'connected';
  return { ...setup, log, first: pc() };
}

test('Mobile: leaving turns the microphone off; back soon, the same call goes on with the microphone as it was', async () => {
  const { view, chat, first } = await phoneVoice();
  appLifecycle.markHidden();
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(chat.voice.micOn, true);
  appLifecycle.markVisible();
  assert.equal(rtc.pcs.length, 1);
  assert.equal(first.closed, false);
  assert.equal(rtc.mic.track.enabled, true);
  view.endVoice();

  // Hold to talk: a press when the app went away has ended.
  const held = await phoneVoice({ micMode: 'hold' });
  held.view.handleVoice('talk-start');
  assert.equal(rtc.mic.track.enabled, true);
  appLifecycle.markHidden();
  assert.equal(rtc.mic.track.enabled, false);
  appLifecycle.markVisible();
  assert.equal(rtc.mic.track.enabled, false);
  assert.equal(held.chat.voice.micOn, false);
  held.view.endVoice();
});

test('Mobile: back after more than 20 s (shortened here), the call is replaced, "Reconnecting…", with the chat as it is now and the mute kept', async () => {
  const { view, chat, plugin, log, first } = await phoneVoice();
  view.handleVoice('mute');
  appLifecycle.markHidden();
  plugin.chatHistory.push({ type: 'assistant', text: 'Finished while away' });
  await sleep(60);
  appLifecycle.markVisible();
  assert.equal(chat.voice.status, 'reconnecting');
  await until(() => rtc.pcs.length === 2 && chat.voice?.status === 'listening');
  assert.deepEqual(first.channel.sent.at(-1), { type: 'session.close' });
  await until(() => first.closed);
  const seeded = JSON.parse(log.live[1].body).session.initial_items.map((item) => item.content[0].text);
  assert.ok(seeded.includes('Finished while away'));
  assert.equal(chat.voice.micOn, false);
  assert.equal(rtc.mic.track.enabled, false);
  assert.deepEqual(errorsShown(chat), []);
  view.endVoice();
});

test('Mobile: a call lost in the background shows no error and is replaced on the return', async () => {
  const { view, chat, first } = await phoneVoice();
  appLifecycle.markHidden();
  first.connectionState = 'failed';
  first.onconnectionstatechange();
  await sleep(5);
  assert.deepEqual(errorsShown(chat), []);
  assert.notEqual(chat.voice, null);
  appLifecycle.markVisible();
  assert.equal(chat.voice.status, 'reconnecting');
  await until(() => rtc.pcs.length === 2 && chat.voice?.status === 'listening');
  assert.deepEqual(errorsShown(chat), []);
  view.endVoice();
});

test('Mobile: after 60 s (shortened here) in the background the call ends quietly, also while JavaScript still runs', async () => {
  const { chat, first } = await phoneVoice();
  appLifecycle.markHidden();
  await until(() => chat.voice === null, 1000);
  assert.deepEqual(first.channel.sent.at(-1), { type: 'session.close' });
  await until(() => first.closed);
  appLifecycle.markVisible();
  await sleep(20);
  assert.equal(rtc.pcs.length, 1);
  assert.equal(chat.voice, null);
  assert.deepEqual(errorsShown(chat), []);
});

test('Desktop: a minimised window keeps the call and its microphone', async () => {
  const { view, chat } = await voiceSetup();
  serve();
  await startListening(view, chat);
  pc().connectionState = 'connected';
  appLifecycle.markHidden();
  assert.equal(rtc.mic.track.enabled, true);
  await sleep(200);
  appLifecycle.markVisible();
  assert.equal(rtc.pcs.length, 1);
  assert.equal(pc().closed, false);
  assert.equal(chat.voice.status, 'listening');
  view.endVoice();
});

for (const lost of [false, true]) {
  test(`Mobile reconnect preserves a running delegated task (${lost ? 'lost' : 'healthy'} call) and seeds its result without replay`, async () => {
    api.Platform.isMobileApp = true;
    const { view, chat, plugin } = await voiceSetup();
    let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Preserved running result.')])); })
      : response('anthropic', [text('Next request done.')]) });
    await startListening(view, chat);
    const controller = view.voice, first = pc();
    first.connectionState = 'connected';
    delegated(channel(), 'original', 'Read the note');
    await until(() => log.chat.length === 1);
    appLifecycle.markHidden();
    if (lost) { first.connectionState = 'failed'; first.onconnectionstatechange(); }
    await sleep(60);
    appLifecycle.markVisible();
    assert.equal(view.voice, controller, 'in-flight hooks retain their owner');
    assert.equal(chat.voice.status, 'reconnecting');
    assert.equal(rtc.pcs.length, 1, 'replacement waits for the result, avoiding cross-call delegation IDs');
    assert.equal(rtc.mic.track.enabled, false);
    release();
    await until(() => rtc.pcs.length === 2 && chat.voice?.status === 'listening');
    assert.equal(log.chat.length, 1, 'original task was neither stopped nor replayed');
    assert.equal(plugin.chatHistory.filter(e => e.type === 'assistant' && e.text === 'Preserved running result.').length, 1);
    const seed = JSON.parse(log.live[1].body).session.initial_items;
    assert.ok(seed.some(e => e.content[0].text === 'Preserved running result.'));
    const announcement = channel().sent.filter(e => e.type === 'session.context.append' && e.channel === 'speakable').map(e => e.content[0].text).join('');
    assert.match(announcement, /Preserved running result/);
    delegated(channel(), 'new-call', 'Read another note');
    await until(() => spoken(channel()).some(([, value]) => value === 'Next request done.'));
    assert.equal(log.chat.length, 2);
    assert.deepEqual(errorsShown(chat), []);
    view.endVoice();
  });
}

for (const outcome of ['failed', 'stopped']) {
  test(`Reconnection carries the ${outcome} outcome instead of a previous successful answer`, async () => {
    const { view, chat, plugin } = await voiceSetup();
    const log = serve();
    plugin.chatHistory.push({ type: 'assistant', text: 'Old task succeeded.' });
    await startListening(view, chat);
    let release;
    view.voice.host.runTurn = async (_request, hooks) => {
      await new Promise(resolve => { release = resolve; });
      if (outcome === 'failed') hooks.onError('Synthetic backend refusal');
      else hooks.onStopped();
    };
    delegated(channel(), 'old', 'Work on the note');
    await until(() => release);
    view.reconnectVoice();
    release();
    await until(() => rtc.pcs.length === 2 && chat.voice?.status === 'listening');
    const prompt = JSON.parse(log.live[1].body).session.initial_items.at(-1).content[0].text;
    assert.match(prompt, outcome === 'failed' ? /task failed: Synthetic backend refusal/ : /task was stopped/);
    assert.doesNotMatch(prompt, /Old task succeeded/);
    assert.equal(log.chat.length, 0);
    view.endVoice();
  });
}

for (const ending of ['final-answer', 'spoken-question', 'before-loop', 'voice-ended']) {
  test(`Late voice steering keeps its preceding question when rerun after ${ending}`, async () => {
    const { view, chat, plugin, app } = await voiceSetup();
    let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(ending === 'spoken-question'
        ? response('anthropic', [call('ask', 'ask_user', { question: 'Which title?' }), call('unsafe', 'create_file', { path: 'Should-not-exist.md', content: 'unsafe' })], 'tool_use')
        : response('anthropic', [text('First completed.')])) })
      : response('anthropic', [text('Added context-aware section.')]) });
    await startListening(view, chat);
    const ch = channel();
    said(ch, 'Read the first note');
    delegated(ch, 'first');
    await until(() => log.chat.length === 1);
    if (ending === 'before-loop') view.turn.agent.steer = () => false;
    said(ch, 'Add another section');
    answered(ch, 'Should I use the heading Cobalt notes?');
    said(ch, 'Do that');
    delegated(ch, 'correction');
    await until(() => chat.queued.includes('Do that'));
    if (ending === 'voice-ended') view.endVoice();
    release();
    await until(() => plugin.chatHistory.some(row => row.type === 'assistant' && row.text === 'Added context-aware section.'));
    assert.equal(log.chat.length, 2);
    assert.match(userText(log.chat[1]), /Voice: "Should I use the heading Cobalt notes\?"/);
    assert.match(userText(log.chat[1]), /Do that$/);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.turnId && /Do that$/.test(row.text)).length, 1);
    assert.equal(app.vault.getFileByPath('Should-not-exist.md'), null);
    if (ending !== 'voice-ended') assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.turnId && row.text === 'Do that').length, 1, 'typed request stays separate from voice context');
    if (ending === 'spoken-question') {
      assert.ok(plugin.chatHistory.some(row => row.type === 'assistant' && row.text === 'Which title?'));
      assert.match(JSON.stringify(log.chat[1]), /Tool execution cancelled/);
    }
    view.endVoice();
  });
}

for (const finished of [false, true]) {
  test(`Fallback steering waits for the answer to a voice clarification (${finished ? 'backend finished' : 'backend running'})`, async () => {
    const { view, chat } = await voiceSetup();
    let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')); })
      : response('anthropic', [text(finished && i === 1 ? 'Old task completed.' : 'Clarified work completed.')]) });
    await startListening(view, chat);
    const ch = channel();
    said(ch, 'Read the first note'); delegated(ch, 'first', 'Read the first note');
    await until(() => release);
    const question = finished ? '要删除哪一篇笔记？' : 'Which note should I delete?';
    said(ch, 'Delete it');
    answered(ch, question);
    ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: question } });
    if (finished) {
      release();
      await until(() => spoken(ch).some(([, value]) => value === 'Old task completed.'));
      answered(ch, 'The old task is complete.');
    }
    await sleep(100);
    assert.deepEqual(chat.queued, [], 'an unanswered question cannot forward the incomplete request');
    assert.equal(log.chat.length, finished ? 2 : 1);
    if (!finished) said(ch, 'The left note, after making a backup');
    ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'The left note, after making a backup' } });
    answered(ch, 'Okay.');
    if (!finished) {
      await until(() => chat.queued.some(value => value.includes('after making a backup')));
      release();
    }
    await until(() => spoken(ch).some(([, value]) => value === 'Clarified work completed.'));
    assert.equal(log.chat.length, finished ? 3 : 2);
    assert.ok(JSON.stringify(log.chat.at(-1)).includes(question));
    assert.match(JSON.stringify(log.chat.at(-1)), /after making a backup/);
    const requests = log.chat.length;
    delegated(ch, 'late-empty');
    await sleep(80);
    assert.equal(log.chat.length, requests, 'consumed raw input cannot become another fallback request');
    view.endVoice();
  });
}

for (const shorter of ['delegation', 'transcript']) {
  test(`A shortened ${shorter} cannot drop a trailing constraint from the voice request`, async () => {
    const { view, chat, plugin } = await voiceSetup();
    let release;
    const log = serve({ chat: () => new Promise(resolve => { release = () => resolve(response('anthropic', [text('Request received safely.')])) }) });
    await startListening(view, chat);
    const ch = channel(), full = 'Delete the note after making a backup', prefix = 'Delete the note';
    said(ch, shorter === 'delegation' ? full : prefix);
    delegated(ch, 'prefix', shorter === 'delegation' ? prefix : full);
    await until(() => release);
    assert.match(userText(log.chat[0]), /Delete the note after making a backup$/);
    assert.equal(plugin.chatHistory.find(row => row.turnId)?.text, full);
    ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: shorter === 'delegation' ? full : prefix } });
    await sleep(100);
    assert.deepEqual(chat.queued, []);
    release();
    await until(() => spoken(ch).length > 0);
    assert.equal(log.chat.length, 1);
    view.endVoice();
  });
}

test('A selection is consumed after the accepted voice edit, so the next voice request is unscoped', async () => {
  const { view, chat, app, plugin } = await voiceSetup();
  let note = 'before\nselected\nafter', selection = { filePath: 'Untitled.md', text: 'selected', from: 7, sourceText: note }, clears = 0;
  chat.getSelection = () => selection;
  chat.clearSelection = () => { selection = null; clears++; };
  app.vault.cachedRead = async () => note;
  app.vault.process = async (_file, edit) => { note = edit(note); };
  const log = serve({ chat: (_body, i) => i === 0 ? response('anthropic', [call('scoped', 'edit_document', { path: 'Untitled.md', operation: 'find_replace', find: 'selected', content: 'changed' })], 'tool_use')
    : i === 2 ? response('anthropic', [call('whole', 'edit_document', { path: 'Untitled.md', operation: 'replace_all', content: 'Entire note replaced' })], 'tool_use')
    : response('anthropic', [text('Done.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Change the selected text'); delegated(ch, 'selected', 'Change the selected text');
  await until(() => spoken(ch).length > 0);
  assert.equal(note, 'before\nchanged\nafter');
  assert.equal(selection, null);
  said(ch, 'Replace the whole note'); delegated(ch, 'whole-note', 'Replace the whole note');
  await until(() => log.chat.length === 4 && spoken(ch).length === 2);
  assert.equal(note, 'Entire note replaced');
  assert.equal(clears, 1);
  assert.equal(plugin.chatHistory.filter(row => row.turnId && row.type === 'user')[1].selection, undefined);
  view.endVoice();
});

test('A voice preflight refusal keeps the selection for the next accepted request', async () => {
  const { view, chat, plugin } = await voiceSetup();
  let selection = { filePath: 'Untitled.md', text: 'Original', from: 0, sourceText: 'Original' }, clears = 0;
  chat.getSelection = () => selection;
  chat.clearSelection = () => { selection = null; clears++; };
  const log = serve();
  await startListening(view, chat);
  view.compactions.set(plugin.activeConversationId, { agent: plugin.agent });
  said(channel(), 'Read selection'); delegated(channel(), 'refused', 'Read selection');
  await until(() => spoken(channel()).length > 0);
  assert.equal(clears, 0);
  assert.equal(selection.text, 'Original');
  view.compactions.clear();
  said(channel(), 'Read selection'); delegated(channel(), 'accepted', 'Read selection');
  await until(() => log.chat.length === 1 && clears === 1);
  assert.equal(selection, null);
  assert.equal(plugin.chatHistory.find(row => row.turnId)?.selection.text, 'Original');
  view.endVoice();
});

test('Stop discards an addition awaiting clarification and its later answer cannot restart it', async () => {
  const { view, chat } = await voiceSetup();
  let release;
  const log = serve({ chat: (_body, i) => i === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Stopped intermediate')])) })
    : response('anthropic', [text('New request completed.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Read the first note'); delegated(ch, 'first', 'Read the first note');
  await until(() => release);
  said(ch, 'Delete it');
  answered(ch, 'Which note?');
  view.handleStop();
  release();
  await until(() => spoken(ch).some(([, value]) => /task was stopped/.test(value)));
  said(ch, 'The left one');
  answered(ch, 'Okay.');
  await sleep(100);
  assert.equal(log.chat.length, 1);
  assert.deepEqual(chat.queued, []);
  delegated(ch, 'new-request', 'Read the second note');
  await until(() => spoken(ch).some(([, value]) => value === 'New request completed.'));
  assert.equal(log.chat.length, 2);
  view.endVoice();
});

for (const order of [[0, 1], [1, 0]]) {
  test(`Consecutive delegated utterances ignore out-of-order terminal events (${order.join('-')})`, async () => {
    const { view, chat, plugin } = await voiceSetup();
    let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')) })
      : response('anthropic', [text('Both requests processed once.')]) });
    await startListening(view, chat);
    const ch = channel(), raw = ['Read the first note', 'Keep the original title'];
    said(ch, raw[0]); delegated(ch, 'a', 'Read the first note');
    await until(() => release);
    said(ch, raw[1]); delegated(ch, 'b', 'Keep the original title');
    for (const i of order) ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: raw[i] } });
    await sleep(100);
    assert.deepEqual(chat.queued, ['Keep the original title']);
    release();
    await until(() => spoken(ch).some(([, value]) => value === 'Both requests processed once.'));
    assert.equal(log.chat.length, 2);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user').length, 2);
    view.endVoice();
  });
}

for (const finished of [false, true]) {
  test(`A shorter late delegation after fallback steering cannot repeat constrained work (${finished ? 'finished' : 'running'})`, async () => {
    const { view, chat, plugin } = await voiceSetup();
    let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')) })
      : response('anthropic', [text('Constrained request completed.')]) });
    await startListening(view, chat);
    const ch = channel(), full = 'Delete the note after making a backup';
    said(ch, 'Read the note'); delegated(ch, 'first', 'Read the note');
    await until(() => release);
    said(ch, full); answered(ch, 'Okay.');
    await until(() => chat.queued.includes(full));
    if (finished) { release(); await until(() => spoken(ch).some(([, value]) => value === 'Constrained request completed.')); }
    delegated(ch, 'late-prefix', 'Delete the note');
    await sleep(100);
    if (!finished) { assert.deepEqual(chat.queued, [full]); release(); }
    await until(() => spoken(ch).some(([, value]) => value === 'Constrained request completed.'));
    assert.equal(log.chat.length, 2);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.text === full).length, 1);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.text === 'Delete the note').length, 0);
    view.endVoice();
  });
}

for (const finished of [false, true]) {
  test(`Reconnect preserves a pending clarification and waits for the reply (${finished ? 'old task done' : 'old task running'})`, async () => {
    api.Platform.isMobileApp = true;
    const { view, chat } = await voiceSetup();
    let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Original work complete.')])) })
      : response('anthropic', [text('Clarified request complete.')]) });
    await startListening(view, chat);
    pc().connectionState = 'connected';
    const old = channel();
    said(old, 'Read the first note'); delegated(old, 'original', 'Read the first note');
    await until(() => release);
    said(old, 'Delete it'); answered(old, 'Which note should I delete?');
    old.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Which note should I delete?' } });
    if (finished) { release(); await until(() => spoken(old).some(([, value]) => value === 'Original work complete.')); }
    appLifecycle.markHidden(); await sleep(60); appLifecycle.markVisible();
    if (!finished) release();
    await until(() => rtc.pcs.length === 2 && chat.voice?.status === 'listening');
    const ch = channel(), seed = JSON.stringify(JSON.parse(log.live[1].body).session.initial_items);
    assert.match(seed, /Delete it/); assert.match(seed, /Which note should I delete\?/);
    delegated(ch, 'new-call-id', 'Delete it');
    await sleep(80);
    assert.equal(log.chat.length, 1, 'reconnect cannot dispatch the unresolved request');
    ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'The left note after making a backup' } });
    answered(ch, 'Okay.');
    await until(() => spoken(ch).some(([, value]) => value === 'Clarified request complete.'));
    assert.equal(log.chat.length, 2);
    assert.match(userText(log.chat[1]), /Which note should I delete\?/);
    assert.match(userText(log.chat[1]), /after making a backup/);
    assert.ok(spoken(ch).some(([id, value]) => id === 'new-call-id' && value === 'Clarified request complete.'));
    view.endVoice();
  });
}

test('The consumed-utterance bound ends the call before another backend dispatch', async () => {
  const { view, chat } = await voiceSetup();
  const log = serve();
  await startListening(view, chat);
  view.voice.consumed = Array.from({ length: 4096 }, (_, i) => ['Consumed utterance ' + i]);
  said(channel(), 'Read another note'); delegated(channel(), 'too-long', 'Read another note');
  await until(() => chat.voice === null);
  assert.equal(log.chat.length, 0);
  assert.equal(rtc.mic.track.enabled, false);
  assert.ok(errorsShown(chat).some(value => /restart voice/.test(value)));
});

test('An older terminal prefix cannot clear a newer utterance with an added constraint', async () => {
  const { view, chat } = await voiceSetup();
  let release;
  const log = serve({ chat: (_body, i) => i === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('First result.')])) })
    : response('anthropic', [text('New constrained result.')]) });
  await startListening(view, chat);
  const ch = channel();
  said(ch, 'Read the note'); delegated(ch, 'first', 'Read the note');
  await until(() => release);
  said(ch, 'Read the note after checking the title');
  ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Read the note' } });
  release();
  await until(() => spoken(ch).some(([, value]) => value === 'New constrained result.'));
  assert.equal(log.chat.length, 2);
  assert.match(userText(log.chat[1]), /Read the note after checking the title$/);
  view.endVoice();
});

for (const outcome of ['success-lost', 'success-connected', 'failed', 'stopped']) {
  test(`A task completed before mobile return retains its undelivered ${outcome} result`, async () => {
    api.Platform.isMobileApp = true;
    const { view, chat, plugin } = await voiceSetup();
    const log = serve();
    plugin.chatHistory.push({ type: 'assistant', text: 'Old unrelated success.' });
    await startListening(view, chat);
    pc().connectionState = 'connected';
    const controller = view.voice, first = pc();
    let release, runs = 0;
    controller.host.runTurn = async (_request, hooks) => {
      runs++;
      await new Promise(resolve => { release = resolve; });
      if (outcome === 'failed') hooks.onError('Undelivered failure');
      else if (outcome === 'stopped') hooks.onStopped();
      else hooks.onText('Undelivered completed answer.');
    };
    delegated(channel(), 'task', 'Read the note');
    await until(() => release);
    appLifecycle.markHidden();
    if (outcome !== 'success-connected') { first.connectionState = 'failed'; first.onconnectionstatechange(); }
    release();
    await until(() => !controller.task && !controller.voiceTurnRunning);
    assert.equal(view.voice, controller);
    appLifecycle.markVisible();
    await until(() => rtc.pcs.length === 2 && chat.voice?.status === 'listening');
    const prompt = JSON.parse(log.live[1].body).session.initial_items.at(-1).content[0].text;
    assert.match(prompt, outcome === 'failed' ? /Undelivered failure/ : outcome === 'stopped' ? /task was stopped/ : /Undelivered completed answer/);
    assert.doesNotMatch(prompt, /Old unrelated success/);
    assert.equal(runs, 1, 'completed work is not rerun');
    view.endVoice();
  });
}

test('A fresh spoken repetition after a fallback result is an intentional new request', async () => {
  const { view, chat, plugin } = await voiceSetup();
  let release;
  const log = serve({ chat: (_body, i) => i === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')) })
    : response('anthropic', [text(i === 1 ? 'First fallback done.' : 'Repeated request done.')]) });
  await startListening(view, chat);
  const ch = channel(), full = 'Read the note after checking its title';
  said(ch, 'Read the first note'); delegated(ch, 'first', 'Read the first note');
  await until(() => release);
  said(ch, full); answered(ch, 'Okay.');
  await until(() => chat.queued.includes(full));
  release();
  await until(() => spoken(ch).some(([, value]) => value === 'First fallback done.'));
  said(ch, full); delegated(ch, 'intentional-repeat', full);
  await until(() => spoken(ch).some(([id, value]) => id === 'intentional-repeat' && value === 'Repeated request done.'));
  assert.equal(log.chat.length, 3);
  assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.text === full).length, 2);
  view.endVoice();
});

for (const cached of [false, true]) {
  test(`Voice starts before a stalled GitHub version refresh (${cached ? 'stale cache' : 'no cache'})`, async () => {
    const now = Date.now;
    Date.now = () => now() + (cached ? 20 : 10) * 60_000;
    let releaseMetadata;
    const calls = [];
    try {
      const { view, chat, plugin } = await voiceSetup();
      const expected = cached ? '9.8.7' : api.getCodexClientVersion();
      plugin.settings.modelCatalog = { entries: [], ...(cached ? { clientVersion: { value: expected, checkedAt: Date.now() - 2 * 86400_000 } } : {}) };
      globalThis.__providerRequest = request => {
        if (request.url.includes('api.github.com')) return new Promise(resolve => { releaseMetadata = () => resolve({ status: 200, json: { tag_name: 'rust-v9.8.8', prerelease: false, draft: false } }); });
        calls.push(request);
        return codexAnswer();
      };
      await startListening(view, chat);
      assert.equal(typeof releaseMetadata, 'function');
      assert.equal(calls.length, 1, 'call creation does not await the metadata response');
      assert.equal(calls[0].headers.version, expected);
      releaseMetadata(); releaseMetadata = undefined;
      await until(() => plugin.settings.modelCatalog.clientVersion?.value === '9.8.8');
      view.endVoice();
    } finally { releaseMetadata?.(); Date.now = now; }
  });
}


test('Replacement-call announcements use the session speakable stream with exact chunk separators', () => {
  const result = 'Recovered result: ' + 'café 🌍 and a safe note.\n'.repeat(80);
  const events = P.sessionSpeakEvents(result);
  assert.ok(events.length > 1);
  assert.ok(events.every(e => e.type === 'session.context.append' && e.channel === 'speakable' && !('delegation_item_id' in e)));
  assert.equal(events.map(e => e.content[0].text).join(''), result);
  assert.ok(events.every(e => new TextEncoder().encode(e.content[0].text).length <= 500));
});


test('A replacement waits for server readiness and announces its result only once', async () => {
  const original = FakePeerConnection.prototype.setRemoteDescription;
  FakePeerConnection.prototype.setRemoteDescription = async function () {
    this.channel.readyState = 'open'; this.channel.onopen?.();
  };
  const { view, chat } = await voiceSetup();
  serve();
  try {
    view.startVoice({ reconnecting: true, finishedTask: 'Recovered result SAFE.' });
    await until(() => chat.voice?.status === 'listening');
    const ch = channel();
    assert.match(chat.voice.resumeNotice, /Previous task ended/);
    assert.equal(ch.sent.filter(e => e.type === 'session.context.append').length, 0);
    ch.receive({ type: 'session.started' });
    assert.equal(ch.sent.filter(e => e.type === 'session.context.append').length, 1);
    ch.receive({ type: 'session.started' });
    assert.equal(ch.sent.filter(e => e.type === 'session.context.append').length, 1);
    assert.match(ch.sent[0].content[0].text, /Recovered result SAFE/);
    assert.match(chat.voice.resumeNotice, /Previous task ended/, 'a quiet service still leaves a visible outcome notice');
    ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Recovered result SAFE.' } });
    assert.equal(chat.voice.resumeNotice, undefined);
  } finally { view.endVoice(); FakePeerConnection.prototype.setRemoteDescription = original; }
});

for (const afterNew of [false, true]) {
  test(`A late fallback delegation preserves unrelated fresh speech (${afterNew ? 'after' : 'before'} its delegation)`, async () => {
    const { view, chat, plugin } = await voiceSetup();
    let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')); })
      : response('anthropic', [text(i === 1 ? 'Fallback completed.' : 'Fresh request completed.')]) });
    await startListening(view, chat);
    const ch = channel(), old = 'Preserve the original title', fresh = 'Archive the other test note';
    said(ch, 'Read the first note'); delegated(ch, 'initial', 'Read the first note'); await until(() => release);
    said(ch, old); answered(ch, 'Okay.'); await until(() => chat.queued.includes(old));
    release(); await until(() => !view.voice.voiceTurnRunning);
    said(ch, fresh);
    if (afterNew) {
      delegated(ch, 'fresh', fresh);
      await until(() => spoken(ch).some(([id, value]) => id === 'fresh' && value === 'Fresh request completed.'));
    }
    delegated(ch, 'late-old', old);
    await sleep(50);
    assert.equal(log.chat.length, afterNew ? 3 : 2, 'old work cannot run twice');
    if (!afterNew) {
      delegated(ch, 'fresh', fresh);
      await until(() => spoken(ch).some(([id, value]) => id === 'fresh' && value === 'Fresh request completed.'));
    }
    assert.equal(log.chat.length, 3);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.text === fresh).length, 1);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.text === old).length, 1);
    view.endVoice();
  });
}

test('Fallback delegation guards are bounded without forgetting earlier work', async () => {
  const { view, chat } = await voiceSetup();
  const log = serve(); await startListening(view, chat);
  const ctl = view.voice, turn = { role: 'user', text: 'One more addition' };
  ctl.steeredSpoken = Array(4096).fill('An earlier handled request');
  ctl.spoken = [turn]; ctl.pendingSteer = [turn];
  assert.equal(ctl.takePendingSteer(), undefined);
  await until(() => !chat.voice);
  assert.equal(log.chat.length, 0);
  assert.match(errorsShown(chat).at(-1), /restart voice/);
});

for (const next of ['resume', 'end', 'switch']) {
  test(`Mobile reconnect waits through a second hidden interval (${next})`, async () => {
    api.Platform.isMobileApp = true; C.VOICE_TIMING.endAfter = 1000;
    const { view, chat } = await voiceSetup(); let release;
    const log = serve({ chat: () => new Promise(resolve => { release = () => resolve(response('anthropic', [text('Finished while hidden again.')])); }) });
    await startListening(view, chat); pc().connectionState = 'connected';
    const old = view.voice;
    said(channel(), 'Read the note'); delegated(channel(), 'initial', 'Read the note'); await until(() => release);
    appLifecycle.markHidden(); await sleep(60); appLifecycle.markVisible();
    assert.equal(chat.voice.status, 'reconnecting');
    appLifecycle.markHidden(); release(); await until(() => !old.task); await sleep(30);
    assert.equal(rtc.pcs.length, 1, 'no replacement starts while hidden');
    assert.equal(rtc.mic.track.enabled, false);
    if (next === 'end') view.endVoice();
    if (next === 'switch') view.newChat();
    appLifecycle.markVisible();
    if (next === 'resume') {
      await until(() => rtc.pcs.length === 2 && chat.voice?.status === 'listening');
      assert.match(JSON.stringify(JSON.parse(log.live[1].body).session.initial_items), /Finished while hidden again/);
    } else {
      await sleep(30); assert.equal(rtc.pcs.length, 1); assert.equal(chat.voice, null);
    }
    assert.equal(log.chat.length, 1); view.endVoice();
  });
}

for (const outcome of ['success', 'second-401', 'refresh-failed', 'signed-out', 'account-changed']) {
  test(`A rejected voice credential renews only once (${outcome})`, async () => {
    const original = { accessToken: 'rejected', accountId: 'acct_1' }, requests = []; let renewals = 0;
    const auth = {
      getUsableCredential: async () => original,
      renewRejected: async rejected => {
        assert.equal(rejected, original); renewals++;
        if (outcome === 'refresh-failed') throw Error('Refresh unavailable');
        if (outcome === 'signed-out') return null;
        return { accessToken: 'renewed', accountId: outcome === 'account-changed' ? 'acct_2' : 'acct_1' };
      },
    };
    globalThis.__providerRequest = async request => {
      requests.push(request);
      return requests.length === 1 || outcome === 'second-401' ? { status: 401, text: 'Unauthorized' } : codexAnswer();
    };
    const route = X.codexVoiceRoute(auth, 'cove', () => '1.2.3');
    const call = route.connect({ sdp: 'same-offer', instructions: 'same instructions', items: [] });
    if (outcome === 'success') assert.equal((await call).sdp, 'answer-sdp');
    else await assert.rejects(call, /HTTP 401/);
    assert.equal(renewals, 1);
    assert.equal(requests.length, ['success', 'second-401'].includes(outcome) ? 2 : 1);
    if (requests.length === 2) {
      assert.equal(requests[1].headers.Authorization, 'Bearer renewed');
      assert.equal(requests[1].headers['ChatGPT-Account-ID'], 'acct_1');
      assert.equal(requests[1].body, requests[0].body);
      assert.equal(requests[1].headers['session-id'], requests[0].headers['session-id']);
    }
  });
}

test('Voice renews a prematurely rejected token through the shared ChatGPT sign-in', async () => {
  const { view, chat, secrets } = await voiceSetup(); let calls = 0, refreshes = 0;
  globalThis.__providerRequest = async request => {
    if (request.url.includes('/oauth/token')) {
      refreshes++;
      return { status: 200, json: { access_token: 'shared-renewed', refresh_token: 'shared-refresh', expires_in: 3600 } };
    }
    if (request.url.includes('/realtime/calls')) {
      calls++;
      if (calls === 1) return { status: 401, text: 'Unauthorized' };
      assert.equal(request.headers.Authorization, 'Bearer shared-renewed');
      return codexAnswer();
    }
    throw Error('Unexpected request');
  };
  await startListening(view, chat);
  assert.equal(calls, 2); assert.equal(refreshes, 1);
  assert.equal(JSON.parse(secrets[CHATGPT_KEY]).accessToken, 'shared-renewed');
  assert.deepEqual(errorsShown(chat), []); view.endVoice();
});

for (const ambiguous of ['empty', 'prefix', 'changed-symbol']) {
  test(`A stale ${ambiguous} delegation cannot consume fresh speech after fallback`, async () => {
    const { view, chat, plugin } = await voiceSetup(); let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')); })
      : response('anthropic', [text(i === 1 ? 'Old work finished.' : 'New work finished.')]) });
    await startListening(view, chat);
    const ch = channel(), old = ambiguous === 'changed-symbol' ? 'Append -1 to the score' : 'Read the first note';
    const fresh = ambiguous === 'changed-symbol' ? 'Append +1 to the score' : ambiguous === 'prefix' ? 'Read the first note and preserve every original heading' : 'Read the other safe test note';
    said(ch, 'Check the time'); delegated(ch, 'initial', 'Check the time'); await until(() => release);
    said(ch, old); answered(ch, 'Okay.'); await until(() => chat.queued.includes(old));
    release(); await until(() => !view.voice.voiceTurnRunning);
    said(ch, fresh);
    const stale = ambiguous === 'empty' ? '' : ambiguous === 'changed-symbol' ? old : 'Read the first';
    delegated(ch, 'stale', stale); await sleep(50);
    assert.equal(log.chat.length, 2, 'ambiguous events do not run fresh words under an old ID');
    assert.equal(view.voice.pendingInput, fresh);
    delegated(ch, 'actual-new', fresh);
    await until(() => spoken(ch).some(([id, value]) => id === 'actual-new' && value === 'New work finished.'));
    delegated(ch, 'stale-again', stale); await sleep(50);
    assert.equal(log.chat.length, 3);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.text === fresh).length, 1);
    view.endVoice();
  });
}

for (const withTool of [false, true]) {
  test(`An empty final answer sends a truthful speakable fallback (${withTool ? 'after a tool' : 'without tools'})`, async () => {
    const { view, chat } = await voiceSetup();
    const log = serve({ chat: (_body, i) => withTool && i === 0
      ? response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')
      : response('anthropic', [], 'end_turn') });
    await startListening(view, chat); const ch = channel();
    delegated(ch, 'empty-answer', 'Check the current date');
    await until(() => spoken(ch).some(([id, value]) => id === 'empty-answer' && /ended without a final answer/.test(value)));
    assert.equal(log.chat.length, withTool ? 2 : 1);
    assert.deepEqual(errorsShown(chat), []); view.endVoice();
  });
}

test('After fallback, an exact current reply delegates with its preceding clarification context', async () => {
  const { view, chat, plugin } = await voiceSetup(); let release;
  const log = serve({ chat: (_body, i) => i === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')); })
    : response('anthropic', [text(i === 1 ? 'Old work finished.' : 'Clarified request finished.')]) });
  await startListening(view, chat); const ch = channel();
  said(ch, 'Read the first note'); delegated(ch, 'initial', 'Read the first note'); await until(() => release);
  said(ch, 'Preserve the original title'); answered(ch, 'Okay.'); await until(() => chat.queued.length === 1);
  release(); await until(() => !view.voice.voiceTurnRunning);
  said(ch, 'Use the other note'); answered(ch, 'Which one?'); said(ch, 'The left note');
  delegated(ch, 'current-reply', 'The left note');
  await until(() => spoken(ch).some(([id, value]) => id === 'current-reply' && value === 'Clarified request finished.'));
  assert.equal(log.chat.length, 3);
  assert.match(JSON.stringify(log.chat[2]), /Use the other note/); assert.match(JSON.stringify(log.chat[2]), /Which one/);
  assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.turnId).at(-1).text, 'The left note');
  view.endVoice();
});

for (const smallTalk of [false, true]) {
  test(`A fresh repeated utterance survives its terminal before delegation (${smallTalk ? 'after small talk' : 'directly'})`, async () => {
    const { view, chat, plugin } = await voiceSetup(); let release;
    const repeated = 'Preserve the original title';
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')); })
      : response('anthropic', [text(i === 1 ? 'Old work finished.' : 'Repeated work finished.')]) });
    await startListening(view, chat); const ch = channel();
    said(ch, 'Read the note'); delegated(ch, 'initial', 'Read the note'); await until(() => release);
    said(ch, repeated); answered(ch, 'Okay.'); await until(() => chat.queued.includes(repeated));
    release(); await until(() => !view.voice.voiceTurnRunning);
    if (smallTalk) { said(ch, 'How are you?'); answered(ch, 'Fine.'); ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Fine.' } }); }
    said(ch, repeated); ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: repeated } });
    assert.equal(view.voice.openTurn?.text, repeated);
    delegated(ch, 'repeat', repeated);
    await until(() => spoken(ch).some(([id, value]) => id === 'repeat' && value === 'Repeated work finished.'));
    assert.equal(log.chat.length, 3);
    assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.text === repeated).length, 2);
    view.endVoice();
  });
}

for (const request of ['delete Backup.md', 'Move another note to Archive']) {
  test(`After fallback, a delegation without current speech cannot dispatch (${request})`, async () => {
    const { view, chat } = await voiceSetup(); let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [call('clock', 'get_current_datetime', {})], 'tool_use')); })
      : response('anthropic', [text(i === 1 ? 'Fallback finished.' : 'Fresh request finished.')]) });
    await startListening(view, chat); const ch = channel();
    said(ch, 'Read the first note'); delegated(ch, 'initial', 'Read the first note'); await until(() => release);
    said(ch, 'Remove the backup note'); answered(ch, 'Okay.'); await until(() => chat.queued.length === 1);
    release(); await until(() => !view.voice.voiceTurnRunning);
    delegated(ch, 'unverified', request); await sleep(50);
    assert.equal(log.chat.length, 2, 'paraphrases and unrelated requests cannot invent user intent');
    assert.match(appended(ch, 'commentary').find(([id]) => id === 'unverified')[1], /Wait for the user to speak/);
    said(ch, request); delegated(ch, 'verified', request);
    await until(() => spoken(ch).some(([id, value]) => id === 'verified' && value === 'Fresh request finished.'));
    assert.equal(log.chat.length, 3); view.endVoice();
  });
}

for (const terminalFirst of [false, true]) {
  for (const acknowledgement of [false, true]) {
    test(`Late original transcript cannot repeat a vault edit (${terminalFirst ? 'terminal first' : 'terminal last'}, ${acknowledgement ? 'with' : 'without'} acknowledgement)`, async () => {
      const { view, chat, app } = await voiceSetup(); let release, writes = 0, note = 'Original';
      app.vault.cachedRead = async () => note;
      app.vault.process = async (_file, edit) => { writes++; note = edit(note); };
      const request = 'Insert a marker in the note.';
      const edit = i => response('anthropic', [call(`edit-${i}`, 'edit_document', { path: 'Untitled.md', operation: 'insert', position: 'end', content: '!' })], 'tool_use');
      const log = serve({ chat: (_body, i) => i === 0 ? new Promise(resolve => { release = () => resolve(edit(i)); })
        : i % 2 === 0 ? edit(i) : response('anthropic', [text('Marker inserted.')]) });
      try {
        await startListening(view, chat); const ch = channel();
        delegated(ch, 'before-transcript', request); await until(() => release);
        if (terminalFirst) ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: request } });
        said(ch, 'insert a marker');
        if (acknowledgement) answered(ch, 'Okay.');
        said(ch, ' in the note'); said(ch, '.');
        await sleep(100);
        assert.deepEqual(chat.queued, [], 'owned late fragments never become steering');
        assert.equal(view.voice.pendingInput, '');
        release(); await until(() => !view.voice.voiceTurnRunning);
        if (!terminalFirst) ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: request } });
        await sleep(100);
        assert.equal(log.chat.length, 2); assert.equal(writes, 1); assert.equal(note, 'Original\n!');
        // The owned transcript is complete: an independent repeat still works.
        said(ch, request); delegated(ch, 'fresh-repeat', request);
        await until(() => !view.voice.voiceTurnRunning && log.chat.length === 4);
        assert.equal(writes, 2); assert.equal(note, 'Original\n!\n!');
      } finally { view.endVoice(); view.handleStop(); release?.(); }
    });
  }
}

for (const kind of ['second delegation', 'divergent signed fragment']) {
  test(`Unresolved unseen ownership requires a new call (${kind})`, async () => {
    const { view, chat } = await voiceSetup(); let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Original completed.')])) })
      : response('anthropic', [text('Must not repeat.')]) });
    try {
      await startListening(view, chat); const ch = channel();
      delegated(ch, 'unseen', 'Append -1 to the score.'); await until(() => release);
      if (kind === 'second delegation') delegated(ch, 'second', 'Read the second note');
      else { said(ch, 'Append '); said(ch, '+1 to the score.'); }
      assert.equal(view.voice, null); assert.deepEqual(chat.queued, []);
      assert.match(errorsShown(chat).at(-1), /Restart voice/);
      release(); await until(() => !view.running); assert.equal(log.chat.length, 1);
    } finally { view.endVoice(); view.handleStop(); release?.(); }
  });
}

test('Unseen-transcript ownership is bounded and released when the call ends', async () => {
  const { view, chat } = await voiceSetup(); const log = serve();
  await startListening(view, chat); const ctl = view.voice;
  for (let i = 0; i < 4096; i++) ctl.missingTranscripts.add([`Expected late transcript ${i}`]);
  delegated(channel(), 'over-budget', 'Read a new note');
  await until(() => !chat.voice);
  assert.equal(log.chat.length, 0);
  assert.equal(ctl.missingTranscripts.size, 0);
  assert.equal(ctl.lateTranscript, undefined);
});

for (const blank of [false, true]) {
test(`Earlier dialogue cannot disguise an unseen request or clear its late-transcript ownership (${blank ? 'empty input event' : 'no input event'})`, async () => {
  const { view, chat, app } = await voiceSetup(); let release, writes = 0, note = 'Original';
  app.vault.cachedRead = async () => note;
  app.vault.process = async (_file, edit) => { writes++; note = edit(note); };
  const request = 'Insert a marker in the note.';
  const log = serve({ chat: (_body, i) => i === 0 ? new Promise(resolve => { release = () => resolve(response('anthropic', [
    call('once', 'edit_document', { path: 'Untitled.md', operation: 'insert', position: 'end', content: '!' }),
  ], 'tool_use')); }) : response('anthropic', [text('Marker inserted.')]) });
  try {
    await startListening(view, chat); const ch = channel();
    said(ch, 'Which note do I have open?'); answered(ch, 'The left note is open.');
    ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'The left note is open.' } });
    if (blank) said(ch, '');
    delegated(ch, 'new-unseen', request); await until(() => release);
    ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Which note do I have open?' } });
    said(ch, 'Insert a marker'); answered(ch, 'Okay.'); said(ch, ' in the note.');
    await sleep(100); assert.deepEqual(chat.queued, []);
    release(); await until(() => !view.voice.voiceTurnRunning);
    ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: request } });
    await sleep(100);
    assert.equal(log.chat.length, 2); assert.equal(writes, 1); assert.equal(note, 'Original\n!');
  } finally { view.endVoice(); view.handleStop(); release?.(); }
});
}

test('Observed speech with an acknowledged paraphrase remains available for a later fresh repeat', async () => {
  const { view, chat, plugin } = await voiceSetup();
  const log = serve();
  try {
    await startListening(view, chat); const ch = channel();
    said(ch, 'Please preserve the left note heading'); answered(ch, 'Okay.');
    delegated(ch, 'paraphrased', 'Keep the heading of Left.md');
    await until(() => !view.voice.voiceTurnRunning && log.chat.length === 1);
    ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Please preserve the left note heading' } });
    said(ch, 'Please preserve the left note heading');
    assert.equal(view.voice.openTurn?.text, 'Please preserve the left note heading');
    ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Please preserve the left note heading' } });
    delegated(ch, 'fresh-literal', 'Please preserve the left note heading');
    await until(() => !view.voice.voiceTurnRunning && log.chat.length === 2);
    assert.equal(plugin.chatHistory.filter(row => row.turnId && row.type === 'user').length, 2);
  } finally { view.endVoice(); view.handleStop(); }
});

for (const prefix of ['Insert ', 'Insert a marker']) {
 for (const earlyAck of [false, true]) {
  test(`Remaining transcript after a partial request cannot repeat a vault edit (${prefix.trim()}, early acknowledgement ${earlyAck})`, async () => {
    const { view, chat, app } = await voiceSetup(); let release, writes = 0, note = 'Original';
    app.vault.cachedRead = async () => note;
    app.vault.process = async (_file, edit) => { writes++; note = edit(note); };
    const request = 'Insert a marker in the note.';
    const log = serve({ chat: (_body, i) => i === 0 ? new Promise(resolve => { release = () => resolve(response('anthropic', [
      call('once', 'edit_document', { path: 'Untitled.md', operation: 'insert', position: 'end', content: '!' }),
    ], 'tool_use')); }) : response('anthropic', [text('Marker inserted.')]) });
    try {
      await startListening(view, chat); const ch = channel();
      said(ch, prefix); if (earlyAck) answered(ch, 'Okay.'); delegated(ch, 'partially-heard', request); await until(() => release);
      answered(ch, 'Okay.'); said(ch, request.slice(prefix.length));
      await sleep(100); assert.deepEqual(chat.queued, []);
      release(); await until(() => !view.voice.voiceTurnRunning);
      ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: request } });
      await sleep(100);
      assert.equal(log.chat.length, 2); assert.equal(writes, 1); assert.equal(note, 'Original\n!');
    } finally { view.endVoice(); view.handleStop(); release?.(); }
  });
}

}

for (const method of ['createOffer', 'setLocalDescription', 'setRemoteDescription']) {
  for (const cancel of [false, true]) {
    test(`A pending ${method} ${cancel ? 'cancels promptly' : 'times out'} and releases startup resources`, async () => {
      const original = FakePeerConnection.prototype[method]; let finish, entered = false, calls = 0;
      FakePeerConnection.prototype[method] = () => { entered = true; return new Promise(resolve => { finish = resolve; }); };
      S.SESSION_TIMING.negotiationWait = cancel ? 1000 : 15;
      const session = new S.VoiceSession({ name: 'pending-sdp', connect: async () => { calls++; return { sdp: 'answer' }; } }, {
        onMessage() {}, onEnded() {}, onAudioBlocked() {}, log() {},
      });
      session.setMicEnabled(true);
      try {
        const rejected = assert.rejects(session.start('test', []), cancel ? S.VoiceCancelled : /voice connection couldn't/);
        await until(() => entered);
        if (cancel) await session.end();
        await rejected;
        assert.equal(rtc.mic.track.enabled, false); assert.equal(rtc.mic.track.stopped, true);
        assert.equal(pc().closed, true); assert.equal(channel().readyState, 'closed');
        finish(method === 'createOffer' ? { type: 'offer', sdp: 'late-offer' } : undefined);
        await sleep(10);
        assert.equal(calls, method === 'setRemoteDescription' ? 1 : 0);
        assert.equal(pc().remoteDescription, undefined);
      } finally { FakePeerConnection.prototype[method] = original; await session.end(); }
    });
  }
}

test('Switching active notes and canvases silently updates the live voice context and removes its watcher on End', async () => {
  const { view, chat, app } = await voiceSetup(); serve();
  let active = { path: 'First.md', extension: 'md' };
  app.workspace.getActiveFile = () => active;
  try {
    await startListening(view, chat); const ch = channel();
    const updates = () => ch.sent.filter(e => e.type === 'session.context.append' && e.channel === 'commentary');
    assert.equal(updates().length, 0); assert.equal(app.workspace.fileWatchers.size, 1);
    for (const file of [{ path: 'Second.md', extension: 'md' }, { path: 'Board.canvas', extension: 'canvas' }, null]) {
      active = file; app.workspace.changedFile();
      assert.ok(updates().at(-1).content[0].text.endsWith(P.openFileNote(file)));
    }
    const count = updates().length; app.workspace.changedFile(); assert.equal(updates().length, count);
    assert.equal(ch.sent.some(e => e.type === 'session.context.append' && e.channel === 'speakable'), false);
    view.endVoice(); assert.equal(app.workspace.fileWatchers.size, 0);
    active = { path: 'Later.md', extension: 'md' }; app.workspace.changedFile(); assert.equal(updates().length, count);
  } finally { view.endVoice(); }
});

for (const answer of ['Plan.md.', 'The left note.', '左边的笔记。']) {
  test(`A short substantive voice answer stays in context (${answer})`, async () => {
    const { view, chat } = await voiceSetup(); const log = serve();
    try {
      await startListening(view, chat); const ch = channel();
      said(ch, 'Which note?'); answered(ch, answer); said(ch, 'Delete it'); delegated(ch, 'short-answer');
      await until(() => !view.voice.voiceTurnRunning && log.chat.length === 1);
      assert.match(userText(log.chat[0]), /Delete it$/);
      assert.ok(userText(log.chat[0]).includes(answer));
      assert.ok(userText(log.chat[0]).includes('Which note?'));
    } finally { view.endVoice(); }
  });
}

for (const reason of ['rules', 'request budget']) {
 for (const newer of [false, true]) {
  test(`Agent preflight rejection restores voice scope (${reason}, newer selection ${newer})`, async () => {
    const { view, chat, app, plugin } = await voiceSetup();
    const original = { filePath: 'Folder/Note.md', text: 'Selected original', from: 0, sourceText: 'Selected original' };
    const replacement = { filePath: 'Other.md', text: 'New selection', from: 0, sourceText: 'New selection' };
    let selection = original, rejected = true;
    chat.getSelection = () => selection;
    chat.clearSelection = () => { selection = newer ? replacement : null; };
    chat.setSelection = value => { selection = value; };
    const getFile = app.vault.getFileByPath, read = app.vault.cachedRead;
    app.vault.getFileByPath = path => path === 'Folder/AGENTS.md' ? { path, extension: 'md' } : getFile(path);
    app.vault.cachedRead = async file => {
      if (file.path === 'Folder/AGENTS.md') {
        if (reason === 'rules' && rejected) throw Error('Rules unavailable');
        return 'Keep the selected scope.';
      }
      return read(file);
    };
    if (reason === 'request budget') plugin.agent.importMessages([{ role: 'user', turnId: 'oversized', content: 'x'.repeat(30_000_000) }]);
    const log = serve();
    try {
      await startListening(view, chat); const ch = channel();
      said(ch, 'Read the selection'); delegated(ch, 'preflight-refused', 'Read the selection');
      await until(() => !view.voice.voiceTurnRunning && spoken(ch).length > 0);
      assert.equal(log.chat.length, 0);
      assert.equal(selection, newer ? replacement : original);
      assert.equal(plugin.chatHistory.some(row => row.type === 'user' && row.text === 'Read the selection'), false);
      assert.match(plugin.chatHistory.find(row => row.type === 'error').text, reason === 'rules' ? /Rules unavailable/ : /30 MB chat limit/);
      rejected = false; plugin.agent.clear();
      // A fresh retry keeps whichever selection the user now has.
      said(ch, 'Read the selected text again'); delegated(ch, 'preflight-retry', 'Read the selected text again');
      await until(() => !view.voice.voiceTurnRunning && log.chat.length === 1);
      assert.match(userText(log.chat[0]), newer ? /New selection/ : /Selected original/);
    } finally { view.endVoice(); view.handleStop(); }
  });
 }
}

for (const method of ['createOffer', 'setLocalDescription']) {
  test(`The local WebRTC diagnostic closes a hung ${method} and ignores its late resolution`, async () => {
    const original = FakePeerConnection.prototype[method]; let finish, calls = 0;
    FakePeerConnection.prototype[method] = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
    S.SESSION_TIMING.negotiationWait = 10;
    try {
      await assert.rejects(api.checkLocalWebRTC(), /WebRTC capability check timed out/);
      assert.equal(calls, 1); assert.equal(pc().closed, true); assert.equal(channel().readyState, 'closed');
      finish(method === 'createOffer' ? { type: 'offer', sdp: 'late' } : undefined);
      await sleep(10); assert.equal(pc().localDescription, undefined);
    } finally { FakePeerConnection.prototype[method] = original; }
  });
}

for (const [prefix, rest] of [['-', '1 dollars in the total'], ['+', '1 dollars in the total'], ['/', 'Archive/Note.md']]) {
  test(`A fresh symbolic fragment after an owned late transcript is preserved (${prefix})`, async () => {
    const { view, chat } = await voiceSetup(); let release;
    const request = 'Read the current note';
    const log = serve({ chat: (_body, i) => i === 0 ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('First done.')])) }) : response('anthropic', [text('Second done.')]) });
    try {
      await startListening(view, chat); const ch = channel();
      delegated(ch, 'late-original', request); await until(() => release);
      said(ch, request);
      said(ch, prefix); said(ch, rest); answered(ch, 'Okay.');
      await sleep(100);
      assert.ok(chat.queued.includes(prefix + rest), JSON.stringify(chat.queued));
      release(); await until(() => log.chat.length === 2 && !view.voice.voiceTurnRunning);
      assert.ok(userText(log.chat[1]).includes(prefix + rest));
    } finally { view.endVoice(); view.handleStop(); release?.(); }
  });
}

for (const lateEvent of ['fragments', 'terminal-only', 'terminal-first', 'new-delegation', 'divergent-prefix']) {
  test(`Ambiguous unseen speech cannot repeat a completed write (${lateEvent})`, async () => {
    const { view, chat, app } = await voiceSetup(); let release, writes = 0, note = 'Original';
    app.vault.cachedRead = async () => note;
    app.vault.process = async (_file, edit) => { writes++; note = edit(note); };
    const log = serve({ chat: (_body, i) => i === 1
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Marker inserted.')])); })
      : i % 2 === 0 ? response('anthropic', [call(`edit-${i}`, 'edit_document', { path: 'Untitled.md', operation: 'insert', position: 'end', content: '!' })], 'tool_use')
      : response('anthropic', [text('Marker inserted.')]) });
    try {
      await startListening(view, chat); const ch = channel();
      delegated(ch, 'unseen', 'Insert a marker in Untitled.md'); await until(() => release);
      const raw = 'Could you add an exclamation mark to the current note?';
      if (lateEvent === 'new-delegation') delegated(ch, 'new-id', raw);
      else if (lateEvent === 'terminal-only' || lateEvent === 'terminal-first') ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: raw } });
      else { if (lateEvent === 'divergent-prefix') said(ch, 'Insert a '); said(ch, raw); }
      assert.equal(view.voice, null); assert.deepEqual(chat.queued, []);
      assert.match(errorsShown(chat).at(-1), /avoid repeating work/);
      // A new ID, terminal, or old fragment after the fault cannot revive work.
      said(ch, raw); ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: raw } });
      delegated(ch, 'after-fault', raw);
      release(); await until(() => !view.running); await sleep(80);
      assert.equal(writes, 1); assert.equal(note, 'Original\n!'); assert.equal(log.chat.length, 2);
      await until(() => pc().closed);
      assert.equal(rtc.mic.track.stopped, true);
    } finally { view.endVoice(); view.handleStop(); release?.(); }
  });
}

test('Ambiguous voice cleanup drops every unsent voice queue and preserves typed additions', async () => {
  const { view, chat, plugin } = await voiceSetup(); let release;
  const log = serve({ chat: (_body, i) => i === 0
    ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Original work completed.')])); })
    : response('anthropic', [text('Typed work completed.')]) });
  try {
    await startListening(view, chat); const ch = channel();
    delegated(ch, 'unseen', 'Read the note'); await until(() => release);
    const turn = view.turn, conversation = plugin.activeConversation;
    view.addToRunningTurn('Keep typed agent queue');
    view.steerByVoice('Discard voice agent queue', []);
    turn.unsteered.push({ text: 'Discard voice preflight queue', context: [] }, { text: 'Keep typed preflight queue' });
    view.voiceLeftovers.set(conversation, [{ text: 'Discard voice stash', context: [] }, { text: 'Keep typed stash' }]);
    conversation.pendingMessages = ['Discard voice stash', 'Keep typed stash'];
    said(ch, 'Unattributed new words');
    assert.equal(view.voice, null);
    assert.deepEqual(turn.agent.steered, [{ text: 'Keep typed agent queue' }]);
    assert.deepEqual(turn.unsteered, [{ text: 'Keep typed preflight queue' }]);
    assert.deepEqual(conversation.pendingMessages, ['Keep typed stash']);
    assert.deepEqual(chat.queued, ['Keep typed agent queue']);
    release(); await until(() => !view.running && log.chat.length === 2);
    assert.doesNotMatch(JSON.stringify(log.chat), /Discard voice/);
    assert.match(JSON.stringify(log.chat[1]), /Keep typed preflight queue/);
    assert.match(JSON.stringify(log.chat[1]), /Keep typed agent queue/);
    assert.deepEqual(conversation.pendingMessages, ['Keep typed stash']);
  } finally { view.endVoice(); view.handleStop(); release?.(); }
});

for (const [first, correction] of [
  ['Append -1 to the score', 'Append +1 to the score'],
  ['Read A/B.md now', 'Read A-B.md now'],
  ['Read Folder/A.md now', 'Read FolderA.md now'],
]) {
  test(`A terminal-only correction preserves meaningful punctuation (${correction})`, async () => {
    const { view, chat, plugin } = await voiceSetup(); let release;
    const log = serve({ chat: (_body, i) => i === 0
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('First done.')])); })
      : response('anthropic', [text('Correction done.')]) });
    try {
      await startListening(view, chat); const ch = channel();
      said(ch, first); delegated(ch, 'first', first); await until(() => release);
      ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: correction } });
      await until(() => chat.queued.includes(correction));
      release(); await until(() => !view.voice.voiceTurnRunning && log.chat.length === 2);
      assert.match(userText(log.chat[1]), new RegExp(correction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(plugin.chatHistory.filter(row => row.type === 'user' && row.text === correction).length, 1);
      assert.deepEqual(errorsShown(chat), []);
    } finally { view.endVoice(); view.handleStop(); release?.(); }
  });
}

for (const event of ['tail', 'acknowledged tail', 'terminal-only', 'earlier matching context']) {
  test(`A partial paraphrased transcript cannot authorize a second write (${event})`, async () => {
    const { view, chat, app } = await voiceSetup(); let release, writes = 0, note = 'Original';
    app.vault.cachedRead = async () => note;
    app.vault.process = async (_file, edit) => { writes++; note = edit(note); };
    const log = serve({ chat: (_body, i) => i === 1
      ? new Promise(resolve => { release = () => resolve(response('anthropic', [text('Marker inserted.')])); })
      : response('anthropic', [call(`edit-${i}`, 'edit_document', { path: 'Untitled.md', operation: 'insert', position: 'end', content: '!' })], 'tool_use') });
    try {
      await startListening(view, chat); const ch = channel();
      if (event === 'earlier matching context') {
        said(ch, 'Insert a marker in Untitled.md');
        ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Insert a marker in Untitled.md' } });
        answered(ch, 'Which marker should I use?');
        ch.receive({ type: 'turn.done', turn: { role: 'assistant', transcript: 'Which marker should I use?' } });
      }
      said(ch, 'Could you add'); if (event === 'acknowledged tail') answered(ch, 'Okay.');
      delegated(ch, 'partial-paraphrase', 'Insert a marker in Untitled.md'); await until(() => release);
      if (event === 'terminal-only') ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Could you add an exclamation mark to the current note?' } });
      else said(ch, ' an exclamation mark to the current note?');
      assert.equal(view.voice, null); assert.match(errorsShown(chat).at(-1), /avoid repeating work/);
      release(); await until(() => !view.running);
      assert.equal(writes, 1); assert.equal(note, 'Original\n!'); assert.equal(log.chat.length, 2);
    } finally { view.endVoice(); view.handleStop(); release?.(); }
  });
}

for (const request of ['Read Untitled.md', 'Read the current note Untitled.md']) {
  test(`A complete terminal before delegation permits normal later speech (${request})`, async () => {
    const { view, chat } = await voiceSetup();
    const log = serve();
    try {
      await startListening(view, chat); const ch = channel();
      said(ch, 'Read the current note');
      ch.receive({ type: 'turn.done', turn: { role: 'user', transcript: 'Read the current note' } });
      delegated(ch, 'complete', request);
      await until(() => !view.voice.voiceTurnRunning && log.chat.length === 1);
      assert.equal(view.voice.missingTranscripts.size, 0);
      said(ch, 'What is the current date?'); delegated(ch, 'next', 'What is the current date?');
      await until(() => !view.voice.voiceTurnRunning && log.chat.length === 2);
      assert.deepEqual(errorsShown(chat), []);
    } finally { view.endVoice(); view.handleStop(); }
  });
}
