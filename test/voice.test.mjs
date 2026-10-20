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
  open() { this.readyState = 'open'; this.onopen?.(); }
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
  rtc.pcs = [];
  Object.assign(S.SESSION_TIMING, { iceWait: 10, iceSettle: 5, startWait: 1000, closeWait: 300, quietLog: 5 });
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
  assert.deepEqual(events, []);
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
  const route = X.codexVoiceRoute({ getUsableCredential: async () => ({ accessToken: 'a', accountId: 'acct_1' }) }, 'cove', async () => '1.2.3');
  const checking = api.checkLiveVoice(route);
  await until(() => pc()?.channel?.readyState === 'open');
  await until(() => channel().sent.some((event) => event.type === 'session.close'));
  channel().receive({ type: 'session.closed' });
  const result = await checking;
  assert.equal(result[0], 'ok');
  assert.match(result[1], /call rtc_1 started .* then closed; events: session\.closed/);
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
  const route = X.codexVoiceRoute(auth, 'ember', async () => { versionLookups++; return '1.2.3'; });

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
  const route = X.codexVoiceRoute(auth, 'ember', async () => '1.2.3');
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
  const signedOut = X.codexVoiceRoute({ getUsableCredential: async () => null }, 'ember', async () => '1.2.3');
  await assert.rejects(signedOut.connect({ sdp: 'o', instructions: '', items: [] }), /Connect your ChatGPT account/);
  const noAccount = X.codexVoiceRoute({ getUsableCredential: async () => ({ accessToken: 'a' }) }, 'ember', async () => '1.2.3');
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
  assert.match(JSON.stringify(log.chat[1]), /\[The user added while you were working:\] Also, add a card to the right/);
  assert.deepEqual(plugin.chatHistory.filter((e) => e.type === 'user').map((e) => e.text), ['Add a card to the left', 'Also, add a card to the right']);

  // The voice delegates it after all, late: said done, not run again.
  said(ch, 'Also, add a card to the right');
  delegated(ch, 'del_2');
  await until(() => spoken(ch).some(([id]) => id === 'del_2'));
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
  assert.match(JSON.stringify(log.chat[1]), /\[The user added while you were working:\] Wait, there is a second empty one on the right/);
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
