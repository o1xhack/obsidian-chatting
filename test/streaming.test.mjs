// Streamed answers: the SSE parser, each adapter over a streamed fetch, the
// requestUrl() fallback, Stop, the rate-limit retry and a cut-off stream.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, settings, text, call, streamEvents, responsesData, sseText, sse, transport, vaultApp, callbacks } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.resetStreamTransport();
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});
afterEach(() => { delete globalThis.__fetch; });

// A fetch Response whose body arrives in `chunk`-byte pieces; with `hold`
// it never ends (until cancelled).
function streamedResponse(body, { chunk = 7, hold = false, status = 200, onCancel } = {}) {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        if (hold) return new Promise(() => {});
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
    cancel() { onCancel?.(); },
  }), { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json' } });
}

function fakeFetch(handler) {
  const calls = [];
  globalThis.__fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return handler(calls.length - 1, init);
  };
  return calls;
}

// The ChatGPT adapter takes its stop check before the stream options.
const send = { anthropic: api.sendAnthropicMessage, openai: api.sendOpenAIMessage,
  'chatgpt-oauth': (s, m, t, p, options) => api.sendChatGPTOAuthMessage(s, m, t, p, undefined, options) };
const identityKey = { anthropic: 'fake-test-key', openai: 'fake-test-key', 'chatgpt-oauth': 'fake-account' };

// What the non-streamed API would have produced for the same content.
async function expected(provider, blocks, stop) {
  const model = settings(provider).model;
  const identity = await api.catalogIdentity(provider, identityKey[provider]);
  if (provider !== 'anthropic') return api.fromResponsesOutput(responsesData(blocks, stop), provider, model, identity);
  const content = blocks.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text }]
    : block.type === 'tool_use' ? [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }] : []);
  // The cited pages follow the answer's text, before the first tool call.
  const urls = [...new Set(blocks.flatMap(block => block.citations ?? []).map(citation => citation.url))];
  const firstCall = content.findIndex(block => block.type === 'tool_use');
  if (urls.length) content.splice(firstCall === -1 ? content.length : firstCall, 0, { type: 'text', text: `\n\nSources:\n${urls.map(url => `- [${url}](${url})`).join('\n')}` });
  return { content, replay: { provider, model, identity, items: blocks }, stopReason: stop, usage: { inputTokens: 10, outputTokens: 5 } };
}

// ─── SSE parser ─────────────────────────────────────────────────────────────

function parse(pieces) {
  const events = [];
  const parser = api.createSSEParser(event => events.push(event));
  for (const piece of pieces) parser.push(piece);
  parser.end();
  return events;
}

test('SSE parser: any chunk boundary, LF/CRLF/CR, multi-line data, comments, [DONE]', () => {
  const body = ': keep-alive comment\r\n' +
    'event: first\r\ndata: {"type":"first",\r\ndata: "value":"a"}\r\n\r\n' +
    'data: {"value":"no type"}\r\r' +
    'event: named\ndata:{"value":"from event name"}\n\n' +
    'data: not json\n\n' +
    'data: [DONE]\n\n' +
    'data: {"type":"last","text":"日本語"}';
  const want = [
    { type: 'first', value: 'a' },
    { value: 'no type' },
    { type: 'named', value: 'from event name' },
    { type: 'last', text: '日本語' },
  ];
  assert.deepEqual(parse([body]), want);
  for (let size = 1; size <= 5; size++) {
    const pieces = [];
    for (let i = 0; i < body.length; i += size) pieces.push(body.slice(i, i + size));
    assert.deepEqual(parse(pieces), want, `chunks of ${size}`);
  }
  // A CR at the end of one chunk and LF at the start of the next is one line end.
  assert.deepEqual(parse(['data: {"a":1}\r', '\n\r', '\ndata: {"b":2}\r\n\r\n']), [{ a: 1 }, { b: 2 }]);
});

// ─── Adapters over a streamed fetch ─────────────────────────────────────────

const cases = {
  anthropic: [
    { type: 'thinking', thinking: 'Internal test reasoning', signature: 'fake-signature' },
    { type: 'redacted_thinking', data: 'fake-redacted-data' },
    { type: 'server_tool_use', id: 'server1', name: 'web_search', input: { query: 'test' } },
    { type: 'web_search_tool_result', tool_use_id: 'server1', content: [{ type: 'web_search_result', title: 'Example', url: 'https://example.com', encrypted_content: 'fake-encrypted' }] },
    { type: 'text', text: 'Reading 日本語 notes', citations: [{ type: 'web_search_result_location', url: 'https://example.com', cited_text: 'Example' }] },
    call('read', 'read_file', { path: 'Cases/Case Template.md' }),
  ],
  openai: [
    { type: 'reasoning', id: 'reasoning1', encrypted_content: 'fake-encrypted', summary: [] },
    { type: 'web_search_call', id: 'search1', status: 'completed', action: { type: 'search', query: 'test' } },
    text('Reading 日本語 notes'),
    call('read', 'read_file', { path: 'Cases/Case Template.md' }),
  ],
};
cases['chatgpt-oauth'] = cases.openai;

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: streamed deltas arrive in order and the result equals the non-streamed one`, async () => {
    const blocks = cases[provider];
    const calls = fakeFetch(() => streamedResponse(sseText(streamEvents(provider, blocks, 'tool_use'))));
    globalThis.__providerRequest = async () => assert.fail('requestUrl must not be used when fetch works');
    const deltas = [];
    const controller = new AbortController();
    const result = await send[provider](settings(provider), [{ role: 'user', content: 'Read' }], [], 'System', { onTextDelta: delta => deltas.push(delta), signal: controller.signal });
    assert.deepEqual(deltas, ['Reading 日', '本語 notes']);
    assert.deepEqual(result, await expected(provider, blocks, 'tool_use'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].init.signal, controller.signal);
    if (provider === 'anthropic') assert.equal(calls[0].init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    if (provider === 'chatgpt-oauth') {
      // The Codex route keeps its endpoint and headers.
      assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(calls[0].init.headers.originator, 'opencode');
      assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'fake-account');
      assert.equal(calls[0].body.store, false);
    }
  });

  test(`${provider}: fetch blocked → requestUrl gives the same result, later requests skip fetch`, async () => {
    const blocks = [text('Hello there'), call('read', 'read_file', { path: 'x' })];
    let fetches = 0;
    globalThis.__fetch = async () => { fetches++; throw new TypeError('Failed to fetch'); };
    const requests = transport(() => response(provider, blocks));
    const deltas = [];
    const messages = [{ role: 'user', content: 'Hi' }];
    const first = await send[provider](settings(provider), messages, [], 'System', { onTextDelta: delta => deltas.push(delta) });
    assert.deepEqual(first, await expected(provider, blocks, 'tool_use'));
    assert.deepEqual(deltas, ['Hello ', 'there']);
    await send[provider](settings(provider), [{ role: 'user', content: 'Again' }], [], 'System');
    assert.equal(fetches, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].stream, true);
  });

  test(`${provider}: an error status read from fetch reports the API message`, async () => {
    fakeFetch(() => new Response(JSON.stringify({ error: { message: 'Synthetic bad request' } }), { status: 400 }));
    await assert.rejects(send[provider](settings(provider), [{ role: 'user', content: 'Hi' }], [], 'System'), /400.*Synthetic bad request/);
  });
}

function response(provider, blocks) {
  return sse(streamEvents(provider, blocks, 'tool_use'));
}

test('fetch failure with a failing requestUrl keeps trying fetch next time', async () => {
  let fetches = 0;
  globalThis.__fetch = async () => { fetches++; throw new TypeError('Failed to fetch'); };
  globalThis.__providerRequest = async () => { throw new Error('offline'); };
  await assert.rejects(api.sendOpenAIMessage(settings('openai'), [{ role: 'user', content: 'Hi' }], [], 'System'), /offline/);
  await assert.rejects(api.sendOpenAIMessage(settings('openai'), [{ role: 'user', content: 'Hi' }], [], 'System'), /offline/);
  assert.equal(fetches, 2);
});

test('fetch failing other than a CORS-like TypeError is not marked blocked', async () => {
  let fetches = 0;
  globalThis.__fetch = async () => { fetches++; throw new Error('connection reset'); };
  transport(() => response('openai', [text('OK')]));
  await api.sendOpenAIMessage(settings('openai'), [{ role: 'user', content: 'Hi' }], [], 'System');
  await api.sendOpenAIMessage(settings('openai'), [{ role: 'user', content: 'Hi' }], [], 'System');
  assert.equal(fetches, 2);
});

test('A URL marked fetch-blocked tries fetch again after 10 minutes', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  let fetches = 0;
  globalThis.__fetch = async () => { fetches++; throw new TypeError('Failed to fetch'); };
  transport(() => response('openai', [text('OK')]));
  const sendOnce = () => api.sendOpenAIMessage(settings('openai'), [{ role: 'user', content: 'Hi' }], [], 'System');
  await sendOnce();
  now += 10 * 60_000 - 1;
  await sendOnce();
  assert.equal(fetches, 1);
  now += 1;
  await sendOnce();
  assert.equal(fetches, 2);
});

test('An incomplete stream is an error, not a partial answer', async () => {
  const events = streamEvents('anthropic', [text('Half an answer')]).filter(event => event.type !== 'message_stop');
  fakeFetch(() => streamedResponse(sseText(events)));
  await assert.rejects(api.sendAnthropicMessage(settings('anthropic'), [{ role: 'user', content: 'Hi' }], [], 'System'), /ended before the answer was complete/);
});

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: a cut-off stream is sent again, at most twice per turn`, async () => {
    const { app } = vaultApp();
    const whole = streamEvents(provider, [text('All good.')]);
    const cut = whole.slice(0, whole.findIndex(event => event.type === 'response.completed' || event.type === 'message_stop'));
    let requests = 0;
    fakeFetch(() => streamedResponse(sseText(++requests === 1 ? cut : whole)));
    const agent = new api.AgentLoop(app, settings(provider));
    // The view drops the cut attempt's text when the loop shows it thinking again.
    let thinking = 0;
    const cb = callbacks({ onThinking() { thinking++; } });
    await agent.run('Hi', cb);
    assert.equal(requests, 2);
    assert.equal(thinking, 2);
    assert.deepEqual(cb.errors, []);
    assert.deepEqual(cb.texts, ['All good.']);

    // Cut every time: two resends, then the error.
    requests = 0;
    fakeFetch(() => { requests++; return streamedResponse(sseText(cut)); });
    const failing = callbacks();
    await new api.AgentLoop(app, settings(provider)).run('Hi', failing);
    assert.equal(requests, 3);
    assert.match(failing.errors[0], /ended before the answer was complete/);
  });
}

// ─── Stop ───────────────────────────────────────────────────────────────────

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: Stop cancels the streamed request and keeps history unchanged`, async () => {
    const { app } = vaultApp();
    let cancelled = false;
    const events = streamEvents(provider, [text('Never finished')]);
    const open = events.slice(0, events.findIndex(event => event.type === 'response.output_item.done' || event.type === 'content_block_stop'));
    fakeFetch(() => streamedResponse(sseText(open), { chunk: 1e6, hold: true, onCancel: () => { cancelled = true; } }));
    const agent = new api.AgentLoop(app, settings(provider));
    const deltas = [];
    const cb = callbacks({ onTextDelta(delta) { deltas.push(delta); agent.abort(); } });
    await agent.run('Write', cb);
    assert.equal(cancelled, true);
    assert.deepEqual(deltas, ['Never f']);
    assert.deepEqual(cb.texts, []);
    assert.deepEqual(cb.errors, []);
    assert.equal(agent.exportMessages().length, 1);
  });
}

test('Stop during a requestUrl fallback drops the late result', async () => {
  globalThis.__fetch = async () => { throw new TypeError('Failed to fetch'); };
  let release;
  globalThis.__providerRequest = () => new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const events = [];
  const pending = api.streamSSE('https://api.openai.com/v1/responses', { headers: {}, body: '{}' }, event => events.push(event), controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release(sse(streamEvents('openai', [text('Late')])));
  await assert.rejects(pending, /cancelled/);
  assert.deepEqual(events, []);
});

// ─── Agent loop and retry ───────────────────────────────────────────────────

test('Agent loop: deltas reach the view before the whole text and tool cards', async () => {
  const { app } = vaultApp();
  fakeFetch(index => streamedResponse(sseText(streamEvents('anthropic', index
    ? [text('Done reading')]
    : [text('Let me read'), call('read', 'read_file', { path: 'Cases/Case Template.md' })], index ? 'end_turn' : 'tool_use'))));
  const order = [];
  const cb = callbacks({
    onTextDelta(delta) { order.push(`delta:${delta}`); },
    onResponse(value) { order.push(`text:${value}`); },
    onToolCall(name) { order.push(`tool:${name}`); },
  });
  const agent = new api.AgentLoop(app, settings('anthropic'));
  await agent.run('Read', cb);
  assert.deepEqual(order, ['delta:Let me', 'delta: read', 'text:Let me read', 'tool:read_file', 'delta:Done r', 'delta:eading', 'text:Done reading']);
  assert.deepEqual(cb.errors, []);
});

test('Rate limit: retried before any text was shown, not after', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout(fn) { queueMicrotask(fn); }, fetch: globalThis.fetch };
  try {
    // 429 before the stream starts: one retry.
    let calls = fakeFetch(index => index ? streamedResponse(sseText(streamEvents('openai', [text('After retry')]))) : new Response('{"error":{"message":"Rate limit reached"}}', { status: 429 }));
    const deltas = [];
    const result = await api.sendMessage(settings('openai'), [{ role: 'user', content: 'Hi' }], [], 'System', () => false, { onTextDelta: delta => deltas.push(delta) });
    assert.equal(calls.length, 2);
    assert.equal(result.content[0].text, 'After retry');
    assert.deepEqual(deltas, ['After ', 'retry']);

    // Rate limit after text was shown: no retry, the error goes to the user.
    api.clearOpenAIState();
    const failing = [
      { type: 'response.output_text.delta', output_index: 0, delta: 'Partial' },
      { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } } },
    ];
    calls = fakeFetch(() => streamedResponse(sseText(failing)));
    const shown = [];
    await assert.rejects(api.sendMessage(settings('openai'), [{ role: 'user', content: 'Hi' }], [], 'System', () => false, { onTextDelta: delta => shown.push(delta) }), /Rate limit reached/);
    assert.equal(calls.length, 1);
    assert.deepEqual(shown, ['Partial']);

    // Anthropic reports a rate limit or overload inside the stream: one retry before any text.
    for (const [type, message] of [['rate_limit_error', 'Number of request tokens has exceeded your per-minute limit'], ['overloaded_error', 'Overloaded']]) {
      const failed = [streamEvents('anthropic', [])[0], { type: 'error', error: { type, message } }];
      calls = fakeFetch(index => streamedResponse(sseText(index ? streamEvents('anthropic', [text('After retry')]) : failed)));
      const retried = await api.sendMessage(settings('anthropic'), [{ role: 'user', content: 'Hi' }], [], 'System');
      assert.equal(calls.length, 2, type);
      assert.equal(retried.content[0].text, 'After retry');
    }
    // After text was shown it is not retried.
    calls = fakeFetch(() => streamedResponse(sseText([...streamEvents('anthropic', [text('Partial')]).slice(0, 4), { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }])));
    await assert.rejects(api.sendMessage(settings('anthropic'), [{ role: 'user', content: 'Hi' }], [], 'System', () => false, { onTextDelta() {} }), /overloaded_error/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('Rate limit: the retry waits as Retry-After says; other errors mentioning 429 or a rate limit are not retried', async () => {
  const previousWindow = globalThis.window;
  const waits = [];
  globalThis.window = { setTimeout(fn, ms) { waits.push(ms); queueMicrotask(fn); }, fetch: globalThis.fetch };
  try {
    let calls = fakeFetch(index => index ? streamedResponse(sseText(streamEvents('anthropic', [text('OK')])))
      : new Response('{"error":{"type":"rate_limit_error","message":"Slow down"}}', { status: 429, headers: { 'retry-after': '2' } }));
    await api.sendMessage(settings('anthropic'), [{ role: 'user', content: 'Hi' }], [], 'System');
    assert.equal(calls.length, 2);
    assert.deepEqual(waits, [2000]);

    // A 400 whose text happens to say "429" or "rate limit" is no rate limit.
    for (const message of ['Prompt is 429 tokens over the limit', 'Unknown parameter: rate_limit']) {
      api.clearOpenAIState();
      calls = fakeFetch(() => new Response(JSON.stringify({ error: { message } }), { status: 400 }));
      await assert.rejects(api.sendMessage(settings('openai'), [{ role: 'user', content: 'Hi' }], [], 'System'), e => e instanceof Error && e.message.includes(message));
      assert.equal(calls.length, 1, message);
    }
  } finally {
    globalThis.window = previousWindow;
  }
});
