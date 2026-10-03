import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { build } from 'esbuild';

// Bundle the actual production adapters/loop; only transport and the vault are fake.
const bundled = await build({
  stdin: { contents: `
    export { ChatSettingTab } from './src/settings';
    export * from './src/api/model-catalog';
    export { sendMessage } from './src/api/client';
    export { AgentLoop } from './src/agent/loop';
    export { trimHistory } from './src/agent/history';
    export { sendAnthropicMessage } from './src/api/anthropic';
    export { sendOpenAIMessage, clearOpenAIState } from './src/api/openai';
    export { sendChatGPTOAuthMessage, setChatGPTOAuthService } from './src/api/chatgpt-oauth';
    export { buildResponsesInput, fromResponsesOutput } from './src/api/responses-format';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'obsidian-test-transport', setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: `
      export class App {}
      export class Modal {}
      export class PluginSettingTab {}
      export class Setting {}
      export const requireApiVersion = () => globalThis.__supportsNewObsidian === true;
      export class Notice {}
      export class TFile { constructor(path) { this.path = path; this.extension = 'md'; } }
      export const normalizePath = path => path;
      export const requestUrl = request => globalThis.__providerRequest(request);
    `, loader: 'js' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const settings = provider => ({ provider, model: provider === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-5.5', apiKey: 'fake-test-key', maxIterations: 20, enableWebSearch: true });
const image = { id: 'image', fileName: 'test.png', mediaType: 'image/png', data: 'fake-base64', sizeBytes: 1 };
const text = value => ({ type: 'text', text: value });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const result = (id, content, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
const assistant = response => ({ role: 'assistant', content: response.content, replay: response.replay });
const responseMessage = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value, annotations: [] }] });
const nativeCall = (id, name, input) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) });
function response(provider, blocks, stop = 'end_turn', index = 0) {
  if (provider === 'anthropic') return { status: 200, json: { content: blocks, stop_reason: stop } };
  const output = blocks.map(block => block.type === 'text' ? responseMessage(block.text) : block.type === 'tool_use' ? nativeCall(block.id, block.name, block.input) : block);
  const data = { id: `resp_${index}`, output, status: stop === 'max_tokens' ? 'incomplete' : 'completed' };
  if (provider === 'openai') return { status: 200, json: data };
  const events = output.map((item, output_index) => ({ type: 'response.output_item.done', item, output_index }));
  events.push({ type: stop === 'max_tokens' ? 'response.incomplete' : 'response.completed', response: { ...data, output: [] } });
  return sse(events);
}
function sse(events) {
  const body = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return { status: 200, text: body, get json() { throw new SyntaxError('iOS lazy JSON getter'); } };
}
function transport(handler) {
  const requests = [];
  globalThis.__providerRequest = async request => {
    const body = JSON.parse(request.body);
    requests.push(body);
    return handler(body, requests.length - 1, request);
  };
  return requests;
}
function vaultApp() {
  const files = new Map([['Cases/Case Template.md', '# Template\n日本語本文'], ['Untitled.md', 'Original']]);
  const app = {
    workspace: { getActiveFile: () => ({ path: 'Untitled.md' }) },
    vault: {
      configDir: '.obsidian', adapter: { append: async () => {} },
      getName: () => 'Test vault',
      getMarkdownFiles: () => [...files.keys()].map(path => ({ path })),
      getFileByPath: path => files.has(path) ? { path } : null,
      getFolderByPath: () => ({}),
      cachedRead: async file => files.get(file.path),
      create: async (path, content) => { assert.ok(!files.has(path)); files.set(path, content); return { path }; },
      process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
      modify: async (file, content) => { files.set(file.path, content); },
    },
  };
  return { app, files };
}
function callbacks(extra = {}) {
  const errors = [], texts = [], executed = [];
  return { errors, texts, executed, onThinking() {}, onToolCall(name) { executed.push(name); }, onToolResult() {}, onResponse(value) { texts.push(value); }, onAskUser: async () => 'yes', onError(error) { errors.push(error); }, ...extra };
}
beforeEach(() => {
  api.clearOpenAIState();
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

for (const provider of ['chatgpt-oauth', 'openai']) {
  test(`${provider}: legacy history encodes assistant text/output and preserves tool pairs`, () => {
    const input = api.buildResponsesInput([
      { role: 'user', content: [text('Copy template'), { type: 'image', image }] },
      { role: 'assistant', content: [text('Reading'), call('read', 'read_file', { path: 'Cases/Case Template.md' }), text('Then copy')] },
      { role: 'user', content: [result('read', 'template')] },
      { role: 'assistant', content: 'Done' },
    ], provider);
    assert.deepEqual(input.map(item => item.type), ['message', 'message', 'function_call', 'message', 'function_call_output', 'message']);
    assert.equal(input[0].content[0].type, 'input_text');
    assert.equal(input[0].content[1].type, 'input_image');
    assert.equal(input[1].content[0].type, 'output_text');
    assert.equal(input[3].content[0].type, 'output_text');
    assert.equal(input[5].content[0].type, 'output_text');
    assert.equal(input[2].call_id, input[4].call_id);
  });
  test(`${provider}: native reasoning/search/refusal survive persistence`, () => {
    const output = [{ type: 'reasoning', id: 'reasoning1', encrypted_content: 'fake-encrypted', summary: [] }, { type: 'web_search_call', id: 'search1', status: 'completed', action: { type: 'search', query: 'test' } }, { type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot do that' }] }];
    const parsed = api.fromResponsesOutput({ output }, provider);
    assert.equal(parsed.content[0].text, 'Cannot do that');
    const saved = JSON.parse(JSON.stringify([assistant(parsed)]));
    assert.deepEqual(api.buildResponsesInput(saved, provider), output);
    const other = provider === 'openai' ? 'chatgpt-oauth' : 'openai';
    assert.equal(api.buildResponsesInput(saved, other)[0].content[0].type, 'output_text');
  });
  test(`${provider}: malformed complete tool arguments recover without vault writes`, async () => {
    for (const argumentsValue of ['{', 'null', '[]', '"string"', '']) {
      const { app, files } = vaultApp();
      const requests = transport((body, index) => {
        if (!index) return response(provider, [{ ...nativeCall('bad', 'edit_document', {}), arguments: argumentsValue }], 'tool_use', index);
        if (index === 2) return response(provider, [text('Done')], 'end_turn', index);
        assert.equal(files.get('Untitled.md'), 'Original');
        assert.match(body.input.at(-1).output, /Invalid tool arguments/);
        return response(provider, [text('Retrying'), call('retry', 'edit_document', { path: 'Untitled.md', operation: 'replace_all', content: 'Corrected' })], 'tool_use', index);
      });
      const cb = callbacks();
      await new api.AgentLoop(app, settings(provider)).run('Edit the note', cb);
      assert.deepEqual(cb.errors, []);
      assert.equal(requests.length, 3);
      assert.equal(files.get('Untitled.md'), 'Corrected');
    }
  });
}

for (const provider of ['chatgpt-oauth', 'openai', 'anthropic']) {
  for (const operation of ['create', 'edit']) {
    test(`${provider}: actual agent reads template then ${operation}s a note`, async () => {
      const { app, files } = vaultApp();
      const template = files.get('Cases/Case Template.md');
      const requests = transport((body, index) => {
        if (provider !== 'anthropic') {
          for (const item of body.input.filter(item => item.role === 'assistant')) {
            assert.ok(item.content.every(part => ['output_text', 'refusal'].includes(part.type)));
          }
        }
        if (index === 0) return response(provider, [text('Reading the template'), call('read', 'read_file', { path: 'Cases/Case Template.md' })], 'tool_use', index);
        const returned = provider === 'anthropic' ? body.messages.at(-1).content[0].content : body.input.at(-1).output;
        if (index === 1) {
          assert.equal(returned, template);
          return response(provider, [text('Writing the note'), operation === 'create' ? call('write', 'create_file', { path: 'Cases/Test Case.md', content: returned }) : call('write', 'edit_document', { path: 'Untitled.md', operation: 'replace_all', content: returned })], 'tool_use', index);
        }
        assert.match(returned, /Created|Replaced/);
        return response(provider, [text('Done')], 'end_turn', index);
      });
      const agent = new api.AgentLoop(app, settings(provider));
      const cb = callbacks();
      await agent.run(`Read the template then ${operation} the note`, cb);
      assert.deepEqual(cb.errors, []);
      assert.equal(requests.length, 3);
      assert.equal(files.get(operation === 'create' ? 'Cases/Test Case.md' : 'Untitled.md'), template);
      assert.equal(files.get('Cases/Case Template.md'), template);
      const saved = JSON.parse(JSON.stringify(agent.exportMessages()));
      agent.importMessages(saved);
      transport(body => {
        if (provider === 'anthropic') assert.deepEqual(body.messages[1].content, saved[1].replay.items);
        else {
          assert.equal(body.previous_response_id, undefined);
          assert.equal(body.input.filter(item => item.type === 'function_call').length, 2);
          assert.equal(body.input.filter(item => item.type === 'function_call_output').length, 2);
        }
        return response(provider, [text('Still here')]);
      });
      await agent.run('Continue after reloading', cb);
      assert.deepEqual(cb.errors, []);
    });
  }
  test(`${provider}: parallel results include tool errors with matching IDs`, async () => {
    const { app } = vaultApp();
    transport((body, index) => {
      if (!index) return response(provider, [call('good', 'read_file', { path: 'Cases/Case Template.md' }), call('bad', 'read_file', { path: 'missing.md' })], 'tool_use');
      const results = provider === 'anthropic' ? body.messages.at(-1).content : body.input.filter(item => item.type === 'function_call_output');
      assert.equal(results.length, 2);
      assert.deepEqual(results.map(item => item.tool_use_id ?? item.call_id), ['good', 'bad']);
      assert.match(results[1].content ?? results[1].output, /not found/i);
      if (provider === 'anthropic') assert.equal(results[1].is_error, true);
      return response(provider, [text('Reported failure')]);
    });
    const cb = callbacks();
    await new api.AgentLoop(app, settings(provider)).run('Read two files', cb);
    assert.deepEqual(cb.errors, []);
  });
  test(`${provider}: stopping parallel execution leaves complete call/result pairs`, async () => {
    const { app, files } = vaultApp();
    transport(() => response(provider, [call('read', 'read_file', { path: 'Cases/Case Template.md' }), call('write', 'create_file', { path: 'Never.md', content: 'Do not create' })], 'tool_use'));
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks({ onToolResult() { agent.abort(); } });
    await agent.run('Two tools', cb);
    assert.equal(files.has('Never.md'), false);
    const results = agent.exportMessages().at(-1).content;
    assert.equal(results.length, 2);
    assert.equal(results[1].tool_use_id, 'write');
    assert.equal(results[1].is_error, true);
  });
  test(`${provider}: token limit does not execute a partial tool call`, async () => {
    const { app, files } = vaultApp();
    transport(() => response(provider, [call('write', 'create_file', { path: 'Never.md', content: 'partial' })], 'max_tokens'));
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks();
    await agent.run('Too long', cb);
    assert.equal(files.has('Never.md'), false);
    assert.match(cb.errors[0], /token limit/);
    assert.equal(agent.exportMessages().length, 1);
  });
}

test('Anthropic: thinking/signatures/redacted thinking/search/citations replay unchanged', async () => {
  const raw = [
    { type: 'thinking', thinking: 'Internal test reasoning', signature: 'fake-signature' },
    { type: 'redacted_thinking', data: 'fake-redacted-data' },
    { type: 'server_tool_use', id: 'server1', name: 'web_search', input: { query: 'test' } },
    { type: 'web_search_tool_result', tool_use_id: 'server1', content: [{ type: 'web_search_result', title: 'Example', url: 'https://example.com', encrypted_content: 'fake-encrypted' }] },
    { type: 'text', text: 'Reading', citations: [{ type: 'web_search_result_location', url: 'https://example.com', cited_text: 'Example' }] },
    call('read', 'read_file', { path: 'Cases/Case Template.md' }),
  ];
  const messages = [{ role: 'user', content: [text('Read'), { type: 'image', image }] }];
  const requests = transport((body, index) => response('anthropic', index ? [text('Done')] : raw, index ? 'end_turn' : 'tool_use'));
  const first = await api.sendAnthropicMessage(settings('anthropic'), messages, [], 'System');
  assert.deepEqual(first.content.map(block => block.type), ['text', 'tool_use']);
  messages.push(assistant(first), { role: 'user', content: [result('read', 'Contents', true)] });
  await api.sendAnthropicMessage(settings('anthropic'), JSON.parse(JSON.stringify(messages)), [], 'System');
  assert.deepEqual(requests[1].messages[1].content, raw);
  assert.equal(requests[1].messages[0].content[1].source.media_type, 'image/png');
  assert.equal(requests[1].messages[2].content[0].is_error, true);
  assert.equal(requests[1].system[0].cache_control.type, 'ephemeral');
  assert.equal(requests[1].tools.at(-1).cache_control.type, 'ephemeral');
});

test('Anthropic: pause_turn continues server search within the same user turn', async () => {
  const { app } = vaultApp();
  const raw = [{ type: 'server_tool_use', id: 'search1', name: 'web_search', input: { query: 'test' } }];
  const requests = transport((body, index) => {
    if (!index) return response('anthropic', raw, 'pause_turn');
    assert.deepEqual(body.messages.at(-1), { role: 'assistant', content: raw });
    assert.deepEqual(body.tools, requests[0].tools);
    return response('anthropic', [text('Search completed')]);
  });
  const cb = callbacks();
  await new api.AgentLoop(app, settings('anthropic')).run('Search', cb);
  assert.equal(requests.length, 2);
  assert.deepEqual(cb.errors, []);
  assert.deepEqual(cb.texts, ['Search completed']);
});

for (const [model, thinking] of [['claude-sonnet-4-6', { type: 'adaptive' }], ['claude-opus-4-7', { type: 'adaptive' }], ['claude-opus-4-8', { type: 'adaptive' }], ['claude-opus-4-5', { type: 'enabled', budget_tokens: 8192 }], ['claude-sonnet-4-20250514', { type: 'enabled', budget_tokens: 8192 }], ['claude-haiku-4-5-20251001', undefined]]) {
  test(`Anthropic: ${model} thinking configuration`, async () => {
    const requests = transport(() => response('anthropic', [text('Hello')]));
    await api.sendAnthropicMessage({ ...settings('anthropic'), model, enableWebSearch: false }, [{ role: 'user', content: 'Hello' }], [{ name: 'read', description: 'read', inputSchema: { type: 'object' } }], 'System');
    assert.deepEqual(requests[0].thinking, thinking);
    assert.equal(requests[0].tools.at(-1).cache_control.type, 'ephemeral');
  });
}

test('OpenAI: settings connection tests do not steal a conversation response ID', async () => {
  const history = [{ role: 'user', content: 'Hello' }];
  const requests = transport((body, index) => response('openai', [text('Hello')], 'end_turn', index));
  const first = await api.sendOpenAIMessage(settings('openai'), history, [], 'System');
  history.push(assistant(first), { role: 'user', content: 'Follow up' });
  await api.sendOpenAIMessage(settings('openai'), [{ role: 'user', content: 'Connection test' }], [], 'Test');
  await api.sendOpenAIMessage(settings('openai'), history, [], 'System');
  assert.equal(requests[1].previous_response_id, undefined);
  assert.equal(requests[2].previous_response_id, 'resp_0');
  assert.equal(requests[2].input.length, 1);
  assert.equal(requests[2].input[0].content[0].text, 'Follow up');
});

test('OpenAI: restored legacy history retains function call/output pairs', async () => {
  const history = [{ role: 'user', content: 'Read' }, { role: 'assistant', content: [text('Reading'), call('read', 'read_file', { path: 'x' })] }, { role: 'user', content: [result('read', 'value')] }];
  const requests = transport(() => response('openai', [text('Done')]));
  await api.sendOpenAIMessage(settings('openai'), history, [], 'System');
  assert.deepEqual(requests[0].input.map(item => item.type), ['message', 'message', 'function_call', 'function_call_output']);
});

test('ChatGPT: incomplete SSE is rejected instead of executing finished tool items', async () => {
  transport(() => sse([{ type: 'response.output_item.done', output_index: 0, item: nativeCall('write', 'create_file', { path: 'Never.md' }) }]));
  await assert.rejects(api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Create' }], [], 'System'), /without a completed response/);
});

test('History trimming retains complete user turns rather than orphan tool results', () => {
  const history = [];
  for (let turn = 0; turn < 6; turn++) {
    history.push({ role: 'user', content: `Turn ${turn}` });
    for (let step = 0; step < 4; step++) history.push({ role: 'assistant', content: [call(`${turn}_${step}`, 'read_file', {})] }, { role: 'user', content: [result(`${turn}_${step}`, 'value')] });
  }
  const trimmed = api.trimHistory(history, 40);
  assert.equal(trimmed[0].content, 'Turn 1');
  assert.equal(trimmed.length, 45);
  assert.equal(api.trimHistory(history.slice(2), 100)[0].content, 'Turn 1');
  const longTurn = history.slice(0, 9);
  assert.deepEqual(api.trimHistory(longTurn, 3), longTurn);
});

test('Anthropic: mixed server search and client read preserve raw content through agent loop', async () => {
  const { app } = vaultApp();
  const raw = [
    { type: 'thinking', thinking: '', signature: 'fake-signature' },
    { type: 'redacted_thinking', data: 'fake-encrypted' },
    { type: 'server_tool_use', id: 'search1', name: 'web_search', input: { query: 'test' } },
    text('I will read the file'), call('read', 'read_file', { path: 'Cases/Case Template.md' }),
  ];
  transport((body, index) => {
    if (!index) return response('anthropic', raw, 'tool_use');
    assert.deepEqual(body.messages[1].content, raw);
    assert.deepEqual(body.messages.at(-1).content.map(block => block.type), ['tool_result']);
    return response('anthropic', [{ type: 'web_search_tool_result', tool_use_id: 'search1', content: [] }, text('Done')]);
  });
  const cb = callbacks();
  await new api.AgentLoop(app, settings('anthropic')).run('Search and read', cb);
  assert.deepEqual(cb.errors, []);
  assert.deepEqual(cb.executed, ['read_file']);
  assert.deepEqual(cb.texts, ['I will read the file', 'Done']);
});

test('Anthropic: repeated pause_turn respects iteration limit', async () => {
  const { app } = vaultApp();
  const requests = transport(() => response('anthropic', [{ type: 'server_tool_use', id: 'search1', name: 'web_search', input: {} }], 'pause_turn'));
  const cb = callbacks();
  await new api.AgentLoop(app, { ...settings('anthropic'), maxIterations: 2 }).run('Search', cb);
  assert.equal(requests.length, 2);
  assert.match(cb.errors[0], /maximum iterations/);
});

test('OpenAI: changing model/key or clearing state rebuilds full history', async () => {
  const history = [{ role: 'user', content: 'Hello' }];
  const requests = transport((body, index) => response('openai', [text('Hello')], 'end_turn', index));
  let s = settings('openai');
  for (let step = 0; step < 4; step++) {
    if (step === 1) s = { ...s, model: 'gpt-4o' };
    if (step === 2) s = { ...s, apiKey: 'different-fake-key' };
    if (step === 3) api.clearOpenAIState();
    const received = await api.sendOpenAIMessage(s, history, [], 'System');
    history.push(assistant(received), { role: 'user', content: 'More' });
    assert.equal(requests[step].previous_response_id, undefined);
    assert.equal(requests[step].input.length, step * 2 + 1);
  }
});

for (const provider of ['chatgpt-oauth', 'openai', 'anthropic']) {
  test(`${provider}: clearing during an API request cannot restore old history`, async () => {
    const { app } = vaultApp();
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    transport(async () => { started(); return new Promise(resolve => { release = resolve; }); });
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks();
    const running = agent.run('Waiting', cb);
    await ready;
    agent.abort();
    agent.clear();
    release(response(provider, [text('Late response')]));
    await running;
    assert.deepEqual(agent.exportMessages(), []);
    assert.deepEqual(cb.texts, []);
  });
  test(`${provider}: Stop during a vault read keeps history valid for a new turn`, async () => {
    const { app } = vaultApp();
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    app.vault.cachedRead = () => { started(); return new Promise(resolve => { release = resolve; }); };
    transport((body, index) => response(provider, index ? [text('New turn complete')] : [call('read', 'read_file', { path: 'Cases/Case Template.md' })], index ? 'end_turn' : 'tool_use', index));
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks();
    const running = agent.run('Read', cb);
    await ready;
    agent.abort();
    const pending = agent.exportMessages().at(-1).content;
    assert.equal(pending[0].tool_use_id, 'read');
    assert.equal(pending[0].is_error, true);
    await agent.run('New turn', cb);
    release('Late read result');
    await running;
    assert.equal(pending[0].is_error, true);
    assert.deepEqual(cb.texts, ['New turn complete']);
    assert.deepEqual(cb.errors, []);
  });
}

test('ChatGPT: response.failed SSE surfaces an error', async () => {
  transport(() => sse([{ type: 'response.failed', response: { error: { message: 'Synthetic service failure' } } }]));
  await assert.rejects(api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Hello' }], [], 'System'), /Synthetic service failure/);
});

test('ChatGPT: aggregated completed SSE output is retained without item.done events', async () => {
  transport(() => sse([{ type: 'response.completed', response: { id: 'r1', output: [responseMessage('Hello')] } }]));
  const parsed = await api.sendChatGPTOAuthMessage(settings('chatgpt-oauth'), [{ role: 'user', content: 'Hello' }], [], 'System');
  assert.equal(parsed.content[0].text, 'Hello');
});


test('Model catalog: migration preserves future/custom IDs and fixes only version dashes', () => {
  for (const id of ['gpt-6.1-sol', 'gpt-6-astra', 'o9', 'custom-model', 'gpt-5-mini']) assert.equal(api.migrateOAuthModel(id), id);
  assert.equal(api.migrateOAuthModel('gpt-6-1-sol'), 'gpt-6.1-sol');
  assert.equal(api.migrateOAuthModel('gpt-5-5'), 'gpt-5.5');
});
test('Catalog persistence rejects credentials and invalid identities', () => {
  const state = api.normalizeCatalogState({entries:[{provider:'openai',identity:'secret-key',fetchedAt:1,models:[]}],accessToken:'secret'});
  assert.deepEqual(state, {entries:[]});
});
test('Catalog: OAuth stable client discovery, hidden filtering, reasoning metadata, TTL, force refresh and dedupe', async () => {
  const state = {entries:[]};
  const identity = await api.catalogIdentity('chatgpt-oauth', 'catalog-account');
  const requests = [];
  let releaseCalls = 0;
  globalThis.__providerRequest = async request => {
    requests.push(request);
    if (request.url.includes('api.github.com')) { releaseCalls++; return {status:200,json:{tag_name:'rust-v0.161.0',prerelease:false,draft:false}}; }
    assert.ok(request.url.includes('client_version=0.161.0'));
    assert.equal(request.headers['ChatGPT-Account-Id'], 'catalog-account');
    return {status:200,json:{models:[
      {slug:'gpt-6.1-sol',display_name:'GPT 6.1',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'ultra'}],default_reasoning_level:'ultra'},
      {slug:'hidden-review',visibility:'hide'},
    ]}};
  };
  const oauth = {getUsableCredential:async()=>({accessToken:'fake-token',accountId:'catalog-account'})};
  const [models, duplicate] = await Promise.all([api.refreshCatalog(state,'chatgpt-oauth',identity,'',oauth,true),api.refreshCatalog(state,'chatgpt-oauth',identity,'',oauth,true)]);
  assert.equal(models,duplicate);
  assert.deepEqual(models.map(m=>m.value),['gpt-6.1-sol']);
  assert.equal(api.oauthReasoning('gpt-6.1-sol').effort,'ultra');
  assert.equal(state.clientVersion.value,'0.161.0');
  assert.equal(releaseCalls,1);
  const count = requests.length;
  await api.refreshCatalog(state,'chatgpt-oauth',identity,'',oauth);
  assert.equal(requests.length,count);
  await api.refreshCatalog(state,'chatgpt-oauth',identity,'',oauth,true);
  assert.equal(requests.length,count+2);
  assert.ok(!JSON.stringify(state).includes('fake-token'));
  api.clearCatalogModels('chatgpt-oauth');
});
test('Catalog: expired cache failure retained, backoff, manual retry and account isolation', async () => {
  const identity = await api.catalogIdentity('openai','key-a');
  const other = await api.catalogIdentity('openai','key-b');
  const models = [{value:'gpt-6.1-sol',label:'GPT 6.1'}];
  const state = {entries:[{provider:'openai',identity,models,fetchedAt:Date.now()-api.CATALOG_TTL-1}]};
  let requests = 0;
  globalThis.__providerRequest = async()=>{requests++;return {status:429,json:{}};};
  await assert.rejects(api.refreshCatalog(state,'openai',identity,'key-a',{}));
  assert.equal(state.entries[0].models,models);
  assert.equal(await api.refreshCatalog(state,'openai',identity,'key-a',{}),models);
  assert.equal(requests,1);
  assert.equal(api.cachedCatalog(state,'openai',other),undefined);
  assert.equal(api.getCatalogModels('openai'),undefined);
  globalThis.__providerRequest = async()=>({status:200,json:{data:[{id:'gpt-6.1-sol'},{id:'o9'},{id:'gpt-audio'},{id:'embedding'}]}});
  const next = await api.refreshCatalog(state,'openai',other,'key-b',{},true);
  assert.deepEqual(next.map(m=>m.value),['gpt-6.1-sol','o9']);
  assert.equal(state.entries.length,1);
  assert.equal(state.entries[0].identity,other);
});
test('Anthropic catalog: pagination and aliases for future generations', async () => {
  const identity = await api.catalogIdentity('anthropic','pagination');
  const urls = [];
  globalThis.__providerRequest = async request => {
    urls.push(request.url);
    return {status:200,json:urls.length===1 ? {data:[{type:'model',id:'claude-opus-5-5',display_name:'Claude Opus 5.5'}],has_more:true,last_id:'claude-opus-5-5'} : {data:[{type:'model',id:'claude-sonnet-6-1'}],has_more:false}};
  };
  const models = await api.refreshCatalog({entries:[]},'anthropic',identity,'pagination',{},true);
  assert.equal(models.length,2);
  assert.ok(urls[1].includes('after_id=claude-opus-5-5'));
});
test('OAuth catalog: GitHub outage retains bundled version without saving a false successful check', async () => {
  const state = {entries:[]};
  const identity = await api.catalogIdentity('chatgpt-oauth','outage');
  globalThis.__providerRequest = async request => request.url.includes('api.github.com') ? {status:503} : {status:200,json:{models:[{slug:'gpt-6.1-sol',visibility:'list'}]}};
  await api.refreshCatalog(state,'chatgpt-oauth',identity,'',{getUsableCredential:async()=>({accessToken:'fake',accountId:'outage'})},true);
  assert.equal(state.clientVersion,undefined);
  assert.equal(state.entries[0].models[0].value,'gpt-6.1-sol');
  api.clearCatalogModels('chatgpt-oauth');
});
test('GPT 6.1: both adapters include encrypted reasoning, support tools and use canonical web search', async () => {
  for (const provider of ['openai','chatgpt-oauth']) {
    const requests = transport(()=>response(provider,[text('OK')]));
    await (provider==='openai'?api.sendOpenAIMessage:api.sendChatGPTOAuthMessage)({...settings(provider),model:'gpt-6.1-sol'},[{role:'user',content:'test'}],[],'test');
    assert.equal(requests[0].reasoning.effort,'medium');
    assert.deepEqual(requests[0].include,['reasoning.encrypted_content']);
    assert.equal(requests[0].tools[0].type,'web_search');
  }
});
test('Anthropic Opus 5.5: adaptive thinking and model changes strip old signatures while preserving tool pairs', async () => {
  const requests = transport(()=>response('anthropic',[{type:'thinking',thinking:'private',signature:'signed-old'},text('Reading'),call('read','read_file',{path:'template'})],'tool_use'));
  const first = await api.sendAnthropicMessage({...settings('anthropic'),model:'claude-opus-5-5'},[{role:'user',content:'test'}],[],'test');
  await api.sendAnthropicMessage({...settings('anthropic'),model:'claude-sonnet-6-1'},[{role:'user',content:'test'},assistant(first),{role:'user',content:[result('read','contents')]}],[],'test');
  assert.deepEqual(requests[0].thinking,{type:'adaptive'});
  assert.ok(!JSON.stringify(requests[1]).includes('signed-old'));
  assert.equal(requests[1].messages[1].content[1].type,'tool_use');
  assert.equal(requests[1].messages[2].content[0].tool_use_id,'read');
});
test('Responses: model changes rebuild text and tool pairs without encrypted reasoning from the prior model', () => {
  const input = api.buildResponsesInput([{role:'assistant',content:[text('Reading'),call('a','read_file',{})],replay:{provider:'chatgpt-oauth',model:'gpt-5.5',items:[{type:'reasoning',encrypted_content:'old'}]}},{role:'user',content:[result('a','data')]}],'chatgpt-oauth','gpt-6.1-sol');
  assert.deepEqual(input.map(i=>i.type),['message','function_call','function_call_output']);
});

test('Provider replay is isolated across credential changes even with the same model', async () => {
  for (const provider of ['anthropic','openai','chatgpt-oauth']) {
    let account = 'first-account';
    api.setChatGPTOAuthService({getUsableCredential:async()=>({accessToken:'fake',accountId:account})});
    const native = provider === 'anthropic' ? {type:'thinking',thinking:'private',signature:'old-account-signature'} : {type:'reasoning',encrypted_content:'old-account-signature'};
    const requests = transport(()=>response(provider,[native,text('Read'),call('r','read_file',{})],'tool_use'));
    const send = provider==='anthropic'?api.sendAnthropicMessage:provider==='openai'?api.sendOpenAIMessage:api.sendChatGPTOAuthMessage;
    const first = await send(settings(provider),[{role:'user',content:'test'}],[],'test');
    account = 'second-account';
    await send({...settings(provider),apiKey:'different-key'},[{role:'user',content:'test'},assistant(first),{role:'user',content:[result('r','content')]}],[],'test');
    assert.ok(!JSON.stringify(requests[1]).includes('old-account-signature'));
    assert.ok(JSON.stringify(requests[1]).includes('read_file'));
  }
});

test('Settings: fresh persisted catalog opens repeatedly without network or resetting selected custom model', async () => {
  const identity = await api.catalogIdentity('openai','settings-cache');
  const plugin = {settings:{...settings('openai'),apiKey:'settings-cache',model:'future-custom',modelCatalog:{entries:[{identity,provider:'openai',models:[{value:'gpt-6.1-sol',label:'GPT 6.1'}],fetchedAt:Date.now()}]}},saveSettings:async()=>assert.fail('No write needed for fresh cache')};
  const tab = new api.ChatSettingTab({},plugin);
  tab.display = ()=>{};
  globalThis.__providerRequest = async()=>assert.fail('Fresh cache must not request network');
  await tab.loadCatalog(false);
  await tab.loadCatalog(false);
  assert.equal(tab.catalogModels[0].value,'gpt-6.1-sol');
  assert.equal(plugin.settings.model,'future-custom');
});
test('Settings: stale cache renders before background request resolves and failures keep the selection', async () => {
  const identity = await api.catalogIdentity('openai','settings-stale');
  const models = [{value:'gpt-5.5',label:'GPT 5.5'}];
  const plugin = {settings:{...settings('openai'),apiKey:'settings-stale',model:'future-custom',modelCatalog:{entries:[{identity,provider:'openai',models,fetchedAt:0}]}},saveSettings:async()=>{}};
  const tab = new api.ChatSettingTab({},plugin);
  const displays=[];
  tab.display=()=>displays.push(tab.catalogModels);
  let finish, started;
  const waiting = new Promise(resolve=>started=resolve);
  globalThis.__providerRequest=async()=>{started();return new Promise(resolve=>finish=resolve);};
  const refreshing=tab.loadCatalog(false);
  await waiting;
  assert.equal(displays[0],models);
  finish({status:503,json:{}});
  await refreshing;
  assert.equal(tab.catalogModels,models);
  assert.equal(plugin.settings.model,'future-custom');
});
test('Settings: account change during refresh never displays the former account result', async () => {
  let account='account-a';
  const plugin={settings:{...settings('chatgpt-oauth'),modelCatalog:{entries:[]}},chatgptOAuth:{getCredential:()=>({accountId:account}),getUsableCredential:async()=>({accessToken:'fake',accountId:account})},saveSettings:async()=>{}};
  const tab=new api.ChatSettingTab({},plugin);
  tab.display=()=>{};
  let finish, started;
  const waiting=new Promise(resolve=>started=resolve);
  globalThis.__providerRequest=async request=>request.url.includes('github.com') ? {status:200,json:{tag_name:'rust-v0.160.0'}} : (started(),new Promise(resolve=>finish=resolve));
  const refreshing=tab.loadCatalog(true);
  await waiting;
  account='account-b';
  finish({status:200,json:{models:[{slug:'only-account-a',visibility:'list'}]}});
  await refreshing;
  assert.equal(tab.catalogModels,undefined);
  globalThis.__providerRequest=async()=>({status:200,json:{models:[{slug:'only-account-b',visibility:'list'}]}});
  await tab.loadCatalog(false);
  assert.equal(tab.catalogModels[0].value,'only-account-b');
});

test('Catalog identity is stable without WebCrypto and scoped to the provider', async () => {
  const {createHash}=await import('node:crypto');
  const identity=await api.catalogIdentity('openai','synthetic-key');
  assert.equal(identity,createHash('sha256').update('openai:synthetic-key').digest('hex'));
  assert.notEqual(identity,await api.catalogIdentity('anthropic','synthetic-key'));
});

test('OAuth honors model capability metadata for summary and parallel calls', async () => {
  const identity=await api.catalogIdentity('chatgpt-oauth','capability-account');
  const model='future-custom-model';
  const state={entries:[{provider:'chatgpt-oauth',identity,fetchedAt:Date.now(),models:[{value:model,label:model,reasoningEfforts:['high'],defaultReasoningEffort:'invalid',supportsReasoningSummary:false,supportsParallelTools:false}]}]};
  api.setChatGPTOAuthService({getUsableCredential:async()=>({accessToken:'fake',accountId:'capability-account'})});
  const requests=transport(()=>response('chatgpt-oauth',[text('OK')]));
  await api.sendChatGPTOAuthMessage({...settings('chatgpt-oauth'),model,modelCatalog:state},[{role:'user',content:'test'}],[],'test');
  assert.deepEqual(requests[0].reasoning,{effort:'high'});
  assert.equal(requests[0].parallel_tool_calls,false);
});

for (const provider of ['anthropic','openai','chatgpt-oauth']) {
  test(`${provider}: stopped request errors cannot affect a newer turn`, async () => {
    const {app}=vaultApp(); const agent=new api.AgentLoop(app,settings(provider));
    let rejectRequest, started;
    const waiting=new Promise(resolve=>started=resolve);
    globalThis.__providerRequest=async()=>{started();return new Promise((resolve,reject)=>rejectRequest=reject);};
    const old=callbacks(); const run=agent.run('old',old); await waiting;
    agent.clear();
    transport(()=>response(provider,[text('new completed')]));
    const next=callbacks(); await agent.run('new',next);
    rejectRequest(new Error('late transport failure')); await run;
    assert.deepEqual(old.errors,[]); assert.deepEqual(next.errors,[]);
    assert.equal(agent.exportMessages().length,2);
  });
}
test('Agent freezes provider/model configuration for a multi-tool turn', async () => {
  const {app}=vaultApp(); const config=settings('anthropic'); const agent=new api.AgentLoop(app,config);
  const requests=transport((body,index)=>response('anthropic',index===0?[call('r','read_file',{path:'Untitled.md'})]:[text('done')],index===0?'tool_use':'end_turn'));
  await agent.run('read',callbacks({onToolCall(){config.model='claude-opus-5-5';config.provider='openai';config.apiKey='changed';}}));
  assert.equal(requests.length,2);
  assert.equal(requests[0].model,requests[1].model);
});

test('Declarative settings stay searchable and reuse the legacy renderers without fetching during indexing', () => {
  const plugin={settings:settings('openai')}; const tab=new api.ChatSettingTab({},plugin);
  globalThis.__providerRequest=async()=>assert.fail('Indexing must not perform network I/O');
  const definitions=tab.getSettingDefinitions();
  assert.deepEqual(definitions.map(d=>d.name),['Provider','API key','ChatGPT account','Model','Web search','Max tool iterations']);
  assert.equal(definitions[1].visible(),true); assert.equal(definitions[2].visible(),false);
  plugin.settings.provider='chatgpt-oauth'; assert.equal(definitions[1].visible(),false); assert.equal(definitions[2].visible(),true);
  let updates=0,displays=0; tab.display=()=>displays++;
  tab.refreshSettingsTab(); assert.equal(displays,1);
  globalThis.__supportsNewObsidian=true;
  tab.update=()=>updates++; tab.refreshSettingsTab(); assert.equal(updates,1); assert.equal(displays,1);
  globalThis.__supportsNewObsidian=false;
});
test('OAuth catalog refuses to associate a new account credential with an old cache identity', async () => {
  const state={entries:[]};
  const identity=await api.catalogIdentity('chatgpt-oauth','previous-account');
  globalThis.__providerRequest=async()=>assert.fail('Wrong account must not make a catalog request');
  await assert.rejects(api.refreshCatalog(state,'chatgpt-oauth',identity,'',{getUsableCredential:async()=>({accessToken:'fake',accountId:'new-account'})},true),/account changed/);
  assert.deepEqual(state.entries,[]);
});
test('Stopping during rate-limit backoff prevents the retried network request', async () => {
  let stopped=false,requests=0;
  const previousWindow=globalThis.window;
  globalThis.window={setTimeout(fn){stopped=true;queueMicrotask(fn);}};
  globalThis.__providerRequest=async()=>{requests++;throw new Error('HTTP 429');};
  try {
    await assert.rejects(api.sendMessage(settings('openai'),[{role:'user',content:'test'}],[],'test',()=>stopped),/cancelled/);
    assert.equal(requests,1);
  } finally { globalThis.window=previousWindow; }
});
