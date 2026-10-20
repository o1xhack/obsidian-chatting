// Compaction: each provider's own on its side (the request parameter, the
// compaction it returns, what later requests send), the plugin's summary
// where the provider can't (the ChatGPT route refusing it, another
// provider's compaction, a request too long, Compact now), and the note in
// the chat.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, sse, streamEvents, text, transport, withCatalog, settings, callbacks, vaultApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
  globalThis.__notices = [];
});

/** A summary request, by its instruction. */
const isSummaryRequest = body => JSON.stringify(body).includes('Summarize the conversation below');
const firstUserText = body => {
  const first = (body.messages ?? body.input)[0];
  const content = first.content;
  return typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
};

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    addUserMessage(value, images = [], turnId) { chat.shown.push({ id: nextId++, type: 'user', text: value, turnId }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult() {},
    addError(value, errorKind) { chat.shown.push({ id: nextId++, type: 'error', text: value, errorKind }); },
    showThinking() {}, hideThinking() {}, showAskUser: () => new Promise(() => {}), cancelAskUser() {},
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, updateConversations() {}, setContinue() {}, setQueued() {},
    clearMessages() { chat.shown = []; }, cutMessages() {}, focus() {}, setModel() {}, setTitle() {}, setSelection() {}, getSelection: () => null,
    usage: null, setUsage(value) { chat.usage = value; },
  };
  return chat;
}

// A plugin without a saved chat, and a chat view with a fake component.
async function chatSetup(provider) {
  const { app } = vaultApp();
  app.vault.adapter = { append: async () => {}, read: async () => { throw new Error('ENOENT'); }, exists: async () => false, write: async () => {} };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...plugin.settings, ...settings(provider) };
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { plugin, view, chat };
}

/** An Anthropic answer that compacted first: its compaction block (streamed in one delta), then the text. */
function compactedAnthropicAnswer(summary, answer, options = {}) {
  const events = streamEvents('anthropic', [text(answer)]);
  // The text block moves to index 1; the compaction block goes first.
  for (const event of events) if (typeof event.index === 'number') event.index += 1;
  events.splice(1, 0,
    { type: 'content_block_start', index: 0, content_block: { type: 'compaction', content: '', ...options.start } },
    ...(options.deltas ?? [{ type: 'compaction_delta', content: summary }]).map(delta => ({ type: 'content_block_delta', index: 0, delta })),
    { type: 'content_block_stop', index: 0 });
  return sse(events);
}

test('Anthropic: threshold compaction at 80 % of the window where the model list has it; the summary comes back; later requests start there', async () => {
  const loopSettings = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, compaction: true }]);
  const headers = [];
  const requests = transport((body, index, request) => {
    headers.push(request.headers['anthropic-beta']);
    return index === 1 ? compactedAnthropicAnswer('They planned a garden.', 'A2') : sse(streamEvents('anthropic', [text(`A${index + 1}`)]));
  });
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  let compacted = 0;
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks({ onCompacted: () => compacted++ }));
  await agent.run('Q3', callbacks());

  assert.deepEqual(requests[0].context_management, { edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 160000 } }] });
  assert.equal(headers[0], 'compact-2026-01-12');
  assert.equal(compacted, 1);
  const marker = agent.exportMessages().find(m => m.compaction);
  assert.deepEqual(marker.compaction, { summary: 'They planned a garden.' });
  // Q1, A1 and Q2 are covered by the compaction block: the third request starts with it.
  assert.equal(requests[2].messages[0].role, 'assistant');
  assert.equal(requests[2].messages[0].content[0].type, 'compaction');
  assert.equal(requests[2].messages.length, 2);
});

test('Anthropic: no compaction parameter for a model without it (or an unknown window)', async () => {
  const loopSettings = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, compaction: false }]);
  const headers = [];
  const requests = transport((body, index, request) => {
    headers.push(request.headers['anthropic-beta']);
    return sse(streamEvents('anthropic', [text('ok')]));
  });
  await new api.AgentLoop(vaultApp().app, loopSettings).run('Q1', callbacks());
  assert.equal(requests[0].context_management, undefined);
  assert.equal(headers[0], undefined);
});

/** A Responses answer whose output starts with a compaction item. */
function compactedResponsesAnswer(provider, answer, index) {
  return sse(streamEvents(provider, [{ type: 'compaction', id: `cmp_${index}`, encrypted_content: 'opaque' }, text(answer)], 'end_turn', index));
}

test('OpenAI: server-side compaction at 80 % of the window; a full replay starts at the compaction item', async () => {
  const loopSettings = await withCatalog('openai', [{ value: 'gpt-5.5', label: 'gpt-5.5', contextWindow: 400000, detailsCheckedAt: Date.now() }]);
  const requests = transport((body, index) => index === 1 ? compactedResponsesAnswer('openai', 'A2', index) : sse(streamEvents('openai', [text(`A${index + 1}`)], 'end_turn', index)));
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks());
  assert.deepEqual(requests[0].context_management, [{ type: 'compaction', compact_threshold: 320000 }]);
  assert.ok(agent.exportMessages().some(m => m.compaction));

  // After a restart (no chaining) the history is replayed from the compaction on.
  agent.importMessages(JSON.parse(JSON.stringify(agent.exportMessages())));
  await agent.run('Q3', callbacks());
  const input = requests[2].input;
  assert.equal(requests[2].previous_response_id, undefined);
  assert.deepEqual(input[0], { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' });
  assert.doesNotMatch(JSON.stringify(input), /Q1|A1/);
});

test('ChatGPT (Codex route): context_management at the catalog\'s point; its compaction item is replayed', async () => {
  const loopSettings = await withCatalog('chatgpt-oauth', [{ value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 380000, autoCompactTokens: 300000 }]);
  const requests = transport((body, index) => index === 0 ? compactedResponsesAnswer('chatgpt-oauth', 'A1', index) : sse(streamEvents('chatgpt-oauth', [text(`A${index + 1}`)], 'end_turn', index)));
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks());
  assert.deepEqual(requests[0].context_management, [{ type: 'compaction', compact_threshold: 300000 }]);
  assert.equal(requests[0].store, false);
  assert.deepEqual(requests[1].input[0], { type: 'compaction', id: 'cmp_0', encrypted_content: 'opaque' });
  assert.doesNotMatch(JSON.stringify(requests[1].input), /"Q1/);
});

test('Switching provider after an encrypted compaction: the new provider writes a readable summary first, once', async () => {
  const openai = await withCatalog('openai', [{ value: 'gpt-5.5', label: 'gpt-5.5', contextWindow: 400000, detailsCheckedAt: Date.now() }]);
  transport((body, index) => index === 1 ? compactedResponsesAnswer('openai', 'A2', index) : sse(streamEvents('openai', [text(`A${index + 1}`)], 'end_turn', index)));
  const app = vaultApp().app;
  const agent = new api.AgentLoop(app, openai);
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks());

  const switched = new api.AgentLoop(app, settings('anthropic'));
  switched.importMessages(agent.exportMessages());
  const requests = transport((body, index) => sse(streamEvents('anthropic', [text(isSummaryRequest(body) ? 'Readable summary of Q1.' : `B${index}`)])));
  await switched.run('Q3', callbacks());
  await switched.run('Q4', callbacks());
  assert.ok(isSummaryRequest(requests[0]));
  assert.match(JSON.stringify(requests[0]), /Q1/);
  // No tools, web search or MCP servers in the summary request.
  assert.equal(requests[0].tools, undefined);
  assert.match(firstUserText(requests[1]), /Readable summary of Q1\./);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /"Q1/);
  // Written once, kept with the history.
  assert.equal(requests.filter(isSummaryRequest).length, 1);
});

test('A request too long for the model: what came before the turn is summarized and the request sent again', async () => {
  const requests = transport((body, index) => {
    if (isSummaryRequest(body)) return sse(streamEvents('anthropic', [text('Summary of Q1.')]));
    if (index === 2) return { status: 400, json: { error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } } };
    return sse(streamEvents('anthropic', [text(`A${index}`)]));
  });
  const agent = new api.AgentLoop(vaultApp().app, settings('anthropic'));
  await agent.run('Q1', callbacks());
  await agent.run('Q2', callbacks());
  const cb = callbacks({ onCompacted: () => { cb.compacted = true; } });
  await agent.run('Q3', cb);
  assert.deepEqual(cb.errors, []);
  assert.equal(cb.compacted, true);
  assert.ok(isSummaryRequest(requests[3]));
  assert.match(firstUserText(requests[4]), /Summary of Q1\./);
  assert.deepEqual(cb.texts, ['A4']);
});

test('Compact now: the chat becomes a summary, a note shows it, the next request starts from it', async () => {
  const { plugin, view, chat } = await chatSetup('anthropic');
  const requests = transport((body, index) => sse(streamEvents('anthropic', [text(isSummaryRequest(body) ? 'All about tiles.' : `A${index + 1}`)])));
  await view.handleUserMessage('Q1', null);
  await view.compactNow();
  assert.ok(isSummaryRequest(requests[1]));
  assert.equal(chat.shown.at(-1).errorKind, 'compacted');
  assert.equal(plugin.chatHistory.at(-1).errorKind, 'compacted');
  // Turns before the summary can't be edited any more.
  assert.equal(plugin.agent.canEditTurn(plugin.chatHistory[0].turnId), false);
  await view.handleUserMessage('Q2', null);
  assert.match(firstUserText(requests[2]), /All about tiles\./);
  assert.equal(requests[2].messages.length, 2);
});

test('Transcript for a summary: roles, tools and files in short, its end kept when too long', () => {
  const S = api.summary;
  const messages = [
    { role: 'user', content: 'Plan the garden' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'read_document', input: { path: 'Garden.md' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(2000) }, { type: 'file', file: { fileName: 'Plan.pdf' } }] },
    { role: 'assistant', content: 'Done.' },
  ];
  const all = S.transcript(messages, 100000);
  assert.match(all, /^User: Plan the garden\n\nAssistant: \[tool call read_document: \{"path":"Garden.md"\}\]\n\nUser: \[tool result: x{1000}…\]\n\[file: Plan.pdf\]\n\nAssistant: Done\.$/);
  const short = S.transcript(messages, 20);
  assert.match(short, /^\(The beginning of the conversation is left out\.\)\n…/);
  assert.ok(short.endsWith('Assistant: Done.'));
  assert.equal(S.isContextOverflow(new api.ProviderError('x', 400, 'context_length_exceeded')), true);
  assert.equal(S.isContextOverflow(new Error('prompt is too long')), false);
});

test('Transcript for a summary: Chinese and Japanese text count about a token per character, so it fits the window', () => {
  const S = api.summary;
  const cjk = '日本語のメモです。'.repeat(500);
  const short = S.transcript([{ role: 'user', content: cjk }], 100);
  const kept = short.replace(/^\(The beginning of the conversation is left out\.\)\n…/, '');
  assert.ok(kept.length <= 100, `kept ${kept.length} characters`);
  // A window of 1000 tokens: at most 500 of them for the transcript.
  const request = S.summaryRequest([{ role: 'user', content: cjk }], 1000);
  const transcript = request.slice(request.indexOf('<conversation>'));
  assert.ok(transcript.length < 600, `transcript ${transcript.length} characters`);
});

test('Compact now: the summary request counts in the chat\'s tokens and cost', async () => {
  const { plugin, view } = await chatSetup('anthropic');
  transport((body, index) => sse(streamEvents('anthropic', [text(isSummaryRequest(body) ? 'All about tiles.' : `A${index + 1}`)])));
  await view.handleUserMessage('Q1', null);
  const before = plugin.activeConversation.usage.inputTokens;
  await view.compactNow();
  assert.ok(plugin.activeConversation.usage.inputTokens > before);
});

test('A message refused by its checks (attachments too large) runs no summary first and leaves the history as it was', async () => {
  const loopSettings = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, compaction: false }]);
  const requests = transport(() => sse(streamEvents('anthropic', [text('should not run')])));
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  agent.importMessages([{ role: 'user', content: 'Earlier', turnId: 'e' }, { role: 'assistant', content: 'Answer' }]);
  const huge = { id: 'big', fileName: 'big.png', mediaType: 'image/png', sizeBytes: 22 * 1024 * 1024, data: 'A'.repeat(30 * 1024 * 1024) };
  const refused = [];
  // Past the compaction point (190k of 200k): a summary would be due.
  await agent.run('Look', callbacks({ onPreflightRejected: error => refused.push(error) }), null, [huge], 'new', null, [], [], 190000);
  assert.equal(refused.length, 1);
  assert.equal(requests.length, 0);
  assert.deepEqual(agent.exportMessages().map(m => m.content), ['Earlier', 'Answer']);
});

test('Editing a message: the old context count does not trigger a summary of the shorter history', async () => {
  const { plugin, view } = await chatSetup('anthropic');
  // A model the plugin summarizes for (no compaction of its own), its window known.
  Object.assign(plugin.settings, await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', contextWindow: 200000, compaction: false }]));
  const requests = transport((body, index) => sse(streamEvents('anthropic', [text(isSummaryRequest(body) ? 'Summary.' : `A${index + 1}`)])));
  await view.handleUserMessage('Q1', null);
  await view.handleUserMessage('Q2', null);
  // As if the chat had been past its compaction point.
  const past = () => { plugin.activeConversation.usage = { ...plugin.activeConversation.usage, contextTokens: 190_000 }; };
  past();
  await view.editMessage(plugin.chatHistory[0].turnId, 'Q1 edited');
  assert.equal(requests.filter(isSummaryRequest).length, 0);
  // A new message past the point is summarized first (the setup works).
  past();
  await view.handleUserMessage('Q3', null);
  assert.equal(requests.filter(isSummaryRequest).length, 1);
});

// Last: the refusal holds for the rest of this process, as until Obsidian restarts.
test('ChatGPT: a refused context_management is dropped and the request sent again; the plugin then summarizes at the point', async () => {
  const loopSettings = await withCatalog('chatgpt-oauth', [{ value: 'gpt-5.5', label: 'GPT-5.5', contextWindow: 100000, autoCompactTokens: 80000 }]);
  const requests = transport((body, index) => {
    if (body.context_management) return { status: 400, json: { detail: "Unsupported parameter: 'context_management'" } };
    if (isSummaryRequest(body)) return sse(streamEvents('chatgpt-oauth', [text('Summary of Q1.')], 'end_turn', index));
    return sse(streamEvents('chatgpt-oauth', [text(`A${index}`)], 'end_turn', index));
  });
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  const cb = callbacks();
  await agent.run('Q1', cb);
  assert.deepEqual(cb.errors, []);
  assert.ok(requests[0].context_management);
  assert.equal(requests[1].context_management, undefined);

  // The last request filled 90k of 100k: the next turn summarizes first.
  let compacted = 0;
  await agent.run('Q2', callbacks({ onCompacted: () => compacted++ }), null, [], undefined, null, [], [], 90000);
  assert.equal(compacted, 1);
  assert.ok(isSummaryRequest(requests[2]));
  assert.equal(requests[2].context_management, undefined);
  assert.match(firstUserText(requests[3]), /^\[Summary of the earlier part of this conversation[\s\S]*Summary of Q1\./);
  assert.doesNotMatch(JSON.stringify(requests[3].input), /"Q1"|A1/);
});

test('Manual compaction blocks editing and sending, follows chat switches, and Stop cancels it', async () => {
  const { plugin, view, chat } = await chatSetup('openai');
  plugin.agent.importMessages([{ role: 'user', content: 'Remember the blue door', turnId: 't1' }]);
  plugin.chatHistory.push({ type: 'user', text: 'Remember the blue door', turnId: 't1' });
  let finish;
  plugin.agent.summarize = () => new Promise(resolve => { finish = resolve; });
  let restored;
  chat.restoreDraft = (...args) => { restored = args; };
  const busy = [];
  chat.setBusy = value => busy.push(value);
  const original = plugin.activeConversationId;
  const compacting = view.compactNow();
  assert.equal(view.running, true);
  await view.handleUserMessage('Keep this unsent', null);
  assert.equal(restored[0], 'Keep this unsent');
  await view.editMessage('t1', 'replace');
  assert.equal(plugin.chatHistory[0].text, 'Remember the blue door');
  view.newChat();
  assert.equal(view.running, false);
  await view.openConversation(original);
  assert.equal(view.running, true);
  view.handleStop();
  assert.equal(view.running, false);
  finish('Stale summary');
  await compacting;
  assert.equal(plugin.agent.exportMessages()[0].content, 'Remember the blue door');
  assert.equal(busy.at(-1), false);
});

test('Readable summaries retain external action receipts from native MCP history', () => {
  const value = api.summary.transcript([{ role: 'assistant', content: [], replay: { provider: 'openai', items: [
    { type: 'mcp_call', id: 'm1', server_label: 'tasks', name: 'create_task', arguments: '{"title":"Already created"}', output: '{"id":"created-1"}' },
  ] } }], 10000);
  assert.match(value, /Remote action tasks\/create_task/);
  assert.match(value, /completed/);
  assert.match(value, /created-1/);
});

test('Changing an API key creates a portable summary before replaying encrypted history', async () => {
  const original = settings('openai');
  const requests = transport((body, index) => isSummaryRequest(body)
    ? sse(streamEvents('openai', [text('Portable remembered fact: cobalt.')], 'end_turn', index))
    : index === 1 ? compactedResponsesAnswer('openai', 'A2', index) : sse(streamEvents('openai', [text('A')], 'end_turn', index)));
  const agent = new api.AgentLoop(vaultApp().app, original);
  await agent.run('The fact is cobalt', callbacks());
  await agent.run('Remember it', callbacks());
  agent.settings = { ...original, apiKey: 'new-account-key' };
  await agent.run('What was the fact?', callbacks());
  assert.ok(isSummaryRequest(requests[2]));
  assert.match(JSON.stringify(requests[3].input), /Portable remembered fact/);
  assert.doesNotMatch(JSON.stringify(requests[3].input), /encrypted_content/);
});

test('A context overflow after an MCP action preserves its receipt and never summarizes or re-posts', async () => {
  const requests = transport((body, index) => index === 0 ? sse(streamEvents('openai', [text('Earlier answer')], 'end_turn', index)) : sse([
    { type: 'response.output_item.done', output_index: 0, item: { type: 'mcp_call', id: 'm1', server_label: 'tasks', name: 'create', arguments: '{}', output: 'created-once' } },
    { type: 'error', code: 'context_length_exceeded', message: 'maximum context length exceeded' },
  ]));
  const agent = new api.AgentLoop(vaultApp().app, settings('openai'));
  await agent.run('Earlier turn', callbacks());
  const cb = callbacks();
  await agent.run('Create once', cb);
  assert.equal(requests.length, 2);
  assert.equal(requests.filter(isSummaryRequest).length, 0);
  assert.match(JSON.stringify(agent.exportMessages()), /created-once/);
  assert.ok(cb.errors.length);
});

test('Clearing a manually compacting chat cancels it and unlocks the composer immediately', async () => {
  const { plugin, view } = await chatSetup('openai');
  plugin.agent.importMessages([{ role: 'user', content: 'Old chat', turnId: 't1' }]);
  plugin.chatHistory.push({ type: 'user', text: 'Old chat', turnId: 't1' });
  let finish;
  plugin.agent.summarize = () => new Promise(resolve => { finish = resolve; });
  const pending = view.compactNow();
  assert.equal(view.running, true);
  view.clearConversation();
  assert.equal(view.running, false);
  finish('Must not return');
  await pending;
  assert.equal(plugin.agent.exportMessages().length, 0);
  assert.equal(plugin.chatHistory.length, 0);
});

for (const change of ['provider', 'model', 'api-key', 'chatgpt-account']) test(`Repeated opaque compactions preserve the earliest fact through saved-history ${change} changes`, async () => {
  const provider = change === 'chatgpt-account' ? 'chatgpt-oauth' : 'openai';
  const initial = settings(provider);
  transport((body, index) => compactedResponsesAnswer(provider, `Answer ${index}`, index));
  const agent = new api.AgentLoop(vaultApp().app, initial);
  await agent.run('Earliest fact: the archive key is EARLIEST-7319.', callbacks());
  await agent.run('Second compaction', callbacks());
  await agent.run('Third compaction', callbacks());
  agent.trimForRetention();
  const saved = JSON.parse(JSON.stringify(api.chatState.savedConversation({ id: 'repeat', title: 'Repeated', customTitle: false, createdAt: 1, updatedAt: 1, chatHistory: [], agentMessages: agent.exportMessages() })));
  assert.match(JSON.stringify(saved.agentMessages), /EARLIEST-7319/);
  const next = { ...initial };
  if (change === 'provider') Object.assign(next, settings('anthropic'));
  if (change === 'model') next.model = 'gpt-6.1-sol';
  if (change === 'api-key') next.apiKey = 'new-key';
  if (change === 'chatgpt-account') api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'other-token', accountId: 'other-account' }) });
  const restored = new api.AgentLoop(vaultApp().app, next);
  restored.importMessages(saved.agentMessages);
  const requests = transport((body, index) => {
    if (isSummaryRequest(body)) {
      assert.match(JSON.stringify(body), /EARLIEST-7319/);
      return sse(streamEvents(next.provider, [text('Portable summary: archive key EARLIEST-7319.')], 'end_turn', index));
    }
    return sse(streamEvents(next.provider, [text('EARLIEST-7319')], 'end_turn', index));
  });
  const cb = callbacks();
  await restored.run('What was the earliest fact?', cb);
  assert.deepEqual(cb.errors, []);
  assert.equal(requests.filter(isSummaryRequest).length, 1);
  assert.match(JSON.stringify(requests.at(-1)), /Portable summary: archive key EARLIEST-7319/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).input ?? requests.at(-1).messages), /encrypted_content/);
});

test('A multi-window portable summary carries earliest facts forward through every chunk', async () => {
  const loopSettings = await withCatalog('openai', [{ value: 'gpt-5.5', label: 'GPT', contextWindow: 1000 }]);
  const original = [{ role: 'user', content: `EARLIEST-FACT ${'middle '.repeat(1000)} LATEST-FACT`, turnId: 't1' }];
  const requests = transport(body => {
    const input = JSON.stringify(body.input);
    assert.match(input, /EARLIEST-FACT/);
    return sse(streamEvents('openai', [text(`Remember EARLIEST-FACT${input.includes('LATEST-FACT') ? ' and LATEST-FACT' : ''}`)]));
  });
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  agent.importMessages(original);
  assert.equal(await agent.compact(), true);
  assert.ok(requests.length > 2);
  assert.match(JSON.stringify(agent.exportMessages()), /EARLIEST-FACT and LATEST-FACT/);
  for (const body of requests) assert.equal(body.tools, undefined);
});

test('A failure partway through a rolling summary retains the whole original history', async () => {
  const loopSettings = await withCatalog('openai', [{ value: 'gpt-5.5', label: 'GPT', contextWindow: 1000 }]);
  const original = [{ role: 'user', content: `EARLIEST-FACT ${'middle '.repeat(1000)} LATEST-FACT`, turnId: 't1' }];
  const requests = transport((body, index) => index === 0 ? sse(streamEvents('openai', [text('EARLIEST-FACT')])) : { status: 400, json: { error: { message: 'Summary rejected' } } });
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  agent.importMessages(original);
  await assert.rejects(agent.compact(), /Summary rejected/);
  assert.equal(requests.length, 2);
  assert.deepEqual(agent.exportMessages(), original);
});

for (const mode of ['set', 'preserve-start', 'null']) test(`Anthropic compaction round-trips final encrypted metadata (${mode}) through restore and follow-up`, async () => {
  const loopSettings = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude', contextWindow: 200000, compaction: true }]);
  const encrypted = mode === 'null' ? null : mode === 'preserve-start' ? 'opaque-start' : 'opaque-final';
  const finalDelta = { type: 'compaction_delta', content: 'Final complete summary', ...(mode === 'preserve-start' ? {} : { encrypted_content: encrypted }) };
  const requests = transport((_body, index) => index === 0 ? compactedAnthropicAnswer(null, 'A1', {
    start: { content: null, encrypted_content: 'opaque-start' },
    deltas: [...mode === 'preserve-start' ? [] : [{ type: 'compaction_delta', content: 'Interim snapshot', encrypted_content: 'opaque-interim' }], finalDelta],
  }) : sse(streamEvents('anthropic', [text('A2')])));
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);
  await agent.run('Q1', callbacks());
  const saved = JSON.parse(JSON.stringify(agent.exportMessages()));
  assert.equal(saved.at(-1).replay.items[0].encrypted_content, encrypted);
  assert.equal(saved.at(-1).compaction.summary, 'Final complete summary');
  agent.importMessages(saved);await agent.run('Q2', callbacks());
  assert.deepEqual(requests[1].messages[0].content[0], { type: 'compaction', content: 'Final complete summary', encrypted_content: encrypted });
});

for (const mode of ['null', 'empty', 'failed-after-draft']) test(`An Anthropic ${mode} compaction is a no-op and cannot cut prior history`, async () => {
  const loopSettings = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude', contextWindow: 200000, compaction: true }]);
  const requests = transport((_body, index) => index === 1 ? compactedAnthropicAnswer(mode === 'empty' ? '' : null, 'A2', {
    start: { content: null, encrypted_content: 'opaque-start' },
    deltas: [...mode === 'failed-after-draft' ? [{ type: 'compaction_delta', content: 'Invalid draft', encrypted_content: 'draft' }] : [], { type: 'compaction_delta', content: mode === 'empty' ? '' : null, encrypted_content: null }],
  }) : sse(streamEvents('anthropic', [text(`A${index}`)])));
  const agent = new api.AgentLoop(vaultApp().app, loopSettings);let compacted = 0;
  await agent.run('EARLIEST-FACT', callbacks(), null, [], 't1');
  await agent.run('Q2', callbacks({ onCompacted: () => compacted++ }));
  agent.importMessages(JSON.parse(JSON.stringify(agent.exportMessages())));
  await agent.run('Q3', callbacks());
  assert.equal(compacted, 0);
  assert.equal(agent.exportMessages().some(m=>m.compaction), false);
  assert.match(JSON.stringify(requests[2].messages), /EARLIEST-FACT/);
  assert.equal(agent.canEditTurn('t1'), true);
});

test('A provider handoff ignores the previous provider token count after installing its portable summary', async () => {
  const first = settings('openai');
  transport((_body,index)=>compactedResponsesAnswer('openai', `A${index}`, index));
  const agent = new api.AgentLoop(vaultApp().app, first);
  await agent.run('EarliestOriginal', callbacks());
  const next = await withCatalog('anthropic', [{ value: 'claude-sonnet-4-6', label: 'Claude', contextWindow: 100000, compaction: false }]);
  transport(()=>sse(streamEvents('anthropic', [text('Primed')])));
  await api.sendAnthropicMessage(next, [{role:'user',content:'Prime catalog'}], [], 'System');
  const switched = new api.AgentLoop(vaultApp().app, next);switched.importMessages(agent.exportMessages());
  const requests = transport((body,index)=>sse(streamEvents('anthropic', [text(isSummaryRequest(body)?'Portable handoff summary.':`Answer ${index}`)])));
  const cb=callbacks();await switched.run('Q2',cb,null,[],'next',null,[],[],90000);
  assert.deepEqual(cb.errors,[]);
  assert.equal(requests.filter(isSummaryRequest).length,1);
  assert.equal(requests.length,2);
  assert.match(firstUserText(requests[1]),/Portable handoff summary/);
});
