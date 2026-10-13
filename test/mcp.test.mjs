// Remote MCP servers through the provider: what each provider's request
// names, the calls it reports shown as steps and replayed as sent, nothing
// for the ChatGPT account, tokens kept out of data.json, and the settings.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, assistant, response, text, transport, settings, callbacks, vaultApp, settingsApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

const SERVERS = [
  { id: 'a', name: 'linear', url: 'https://mcp.linear.app/sse', enabled: true, token: 'secret-token' },
  { id: 'b', name: 'off', url: 'https://off.example/mcp', enabled: false },
  { id: 'c', name: 'bad name!', url: 'https://x.example', enabled: true },
  { id: 'd', name: 'plain', url: 'http://insecure.example', enabled: true },
  { id: 'e', name: 'linear', url: 'https://twice.example', enabled: true },
];

test('Anthropic: servers on and valid as mcp_servers with a toolset each and the beta header; calls shown as steps, replayed as sent', async () => {
  const headers = [];
  const content = [
    text('Filing it.'),
    { type: 'mcp_tool_use', id: 'm1', name: 'create_issue', server_name: 'linear', input: { title: 'Fix tiles' } },
    { type: 'mcp_tool_result', tool_use_id: 'm1', is_error: false, content: [{ type: 'text', text: 'Created ENG-12' }] },
    text('Done: ENG-12'),
  ];
  const requests = transport((body, index, request) => {
    headers.push(request.headers['anthropic-beta']);
    return index === 0 ? response('anthropic', content) : response('anthropic', [text('ok')]);
  });
  const steps = [];
  const cb = callbacks({ onToolCall: (name, input) => steps.push(['call', name, input]), onToolResult: (name, result) => steps.push(['result', name, result]) });
  const loop = new api.AgentLoop(vaultApp().app, { ...settings('anthropic'), enableWebSearch: false, mcpServers: SERVERS });
  await loop.run('File a bug', cb);

  assert.deepEqual(requests[0].mcp_servers, [{ type: 'url', url: 'https://mcp.linear.app/sse', name: 'linear', authorization_token: 'secret-token' }]);
  assert.deepEqual(requests[0].tools.at(-1), { type: 'mcp_toolset', mcp_server_name: 'linear' });
  assert.equal(requests[0].tools.filter(tool => tool.type === 'mcp_toolset').length, 1);
  assert.equal(headers[0], 'mcp-client-2025-11-20');
  assert.deepEqual(steps, [
    ['call', 'mcp:linear:create_issue', { title: 'Fix tiles' }],
    ['result', 'mcp:linear:create_issue', { result: 'Created ENG-12', isError: false }],
  ]);
  // Nothing to run here: one request, the answer's text as the reply.
  assert.equal(requests.length, 1);
  assert.deepEqual(cb.texts, ['Filing it.Done: ENG-12']);

  // The next turn sends the blocks back as the provider sent them.
  await loop.run('Thanks', callbacks());
  assert.deepEqual(requests[1].messages[1], { role: 'assistant', content });
});

test('Anthropic without servers on: no mcp_servers, no beta header', async () => {
  const headers = [];
  const requests = transport((body, index, request) => { headers.push(request.headers['anthropic-beta']); return response('anthropic', [text('ok')]); });
  await new api.AgentLoop(vaultApp().app, { ...settings('anthropic'), mcpServers: [SERVERS[1]] }).run('Hi', callbacks());
  assert.equal(requests[0].mcp_servers, undefined);
  assert.equal(headers[0], undefined);
});

test('OpenAI: one mcp tool per server, without approvals; mcp_call items shown as steps (an error as a failed step), replayed as sent', async () => {
  const items = [
    { type: 'mcp_list_tools', id: 'l1', server_label: 'linear', tools: [] },
    { type: 'mcp_call', id: 'c1', server_label: 'linear', name: 'search', arguments: '{"q":"tiles"}', output: '3 issues' },
    { type: 'mcp_call', id: 'c2', server_label: 'linear', name: 'delete', arguments: '{}', error: 'Not allowed' },
  ];
  const requests = transport(() => response('openai', [...items, text('Found 3')]));
  const steps = [];
  const cb = callbacks({ onToolCall: (name, input) => steps.push(['call', name, input]), onToolResult: (name, result) => steps.push(['result', name, result]) });
  await new api.AgentLoop(vaultApp().app, { ...settings('openai'), enableWebSearch: false, mcpServers: SERVERS }).run('Search', cb);
  assert.deepEqual(requests[0].tools.filter(tool => tool.type === 'mcp'), [
    { type: 'mcp', server_label: 'linear', server_url: 'https://mcp.linear.app/sse', require_approval: 'never', authorization: 'secret-token' },
  ]);
  assert.deepEqual(steps, [
    ['call', 'mcp:linear:search', { q: 'tiles' }],
    ['result', 'mcp:linear:search', { result: '3 issues', isError: false }],
    ['call', 'mcp:linear:delete', {}],
    ['result', 'mcp:linear:delete', { result: 'Not allowed', isError: true }],
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(cb.texts, ['Found 3']);

  // A restored history (no previous_response_id) sends the items back unchanged.
  const parsed = api.fromResponsesOutput({ output: [...items, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Found 3', annotations: [] }] }] }, 'openai', 'gpt-5.5');
  const input = api.buildResponsesInput([{ role: 'user', content: 'Search' }, assistant(parsed)], 'openai', 'gpt-5.5', undefined, SERVERS);
  assert.deepEqual(input.slice(1, 4), items);
});

test('A server switched off or removed: its earlier calls are no longer sent back', async () => {
  // Anthropic: the call and its result leave the replayed answer; the text stays.
  let requests = transport((body, index) => index === 0
    ? response('anthropic', [
      { type: 'mcp_tool_use', id: 'm1', name: 'create_issue', server_name: 'linear', input: {} },
      { type: 'mcp_tool_result', tool_use_id: 'm1', is_error: false, content: [{ type: 'text', text: 'Created' }] },
      text('Done'),
    ])
    : response('anthropic', [text('Next')]));
  const anthropic = { ...settings('anthropic'), enableWebSearch: false, mcpServers: SERVERS };
  let agent = new api.AgentLoop(vaultApp().app, anthropic);
  await agent.run('File a bug', callbacks());
  anthropic.mcpServers = [];
  await agent.run('Thanks', callbacks());
  assert.deepEqual(requests[1].messages[1].content.map(block => block.type), ['text']);
  assert.equal(requests[1].mcp_servers, undefined);
  // Still on: sent back as received.
  anthropic.mcpServers = SERVERS;
  await agent.run('Again', callbacks());
  assert.deepEqual(requests[2].messages[1].content.map(block => block.type), ['mcp_tool_use', 'mcp_tool_result', 'text']);

  // OpenAI: its mcp_list_tools and mcp_call items leave the input.
  api.clearOpenAIState();
  requests = transport((body, index) => index === 0
    ? response('openai', [
      { type: 'mcp_list_tools', id: 'l1', server_label: 'linear', tools: [] },
      { type: 'mcp_call', id: 'c1', server_label: 'linear', name: 'search', arguments: '{}', output: 'found' },
      text('Found'),
    ])
    : response('openai', [text('Next')]));
  const openai = { ...settings('openai'), enableWebSearch: false, mcpServers: SERVERS };
  agent = new api.AgentLoop(vaultApp().app, openai);
  await agent.run('Search', callbacks());
  openai.mcpServers = [];
  // A fresh history (no chaining), so the replayed items are in the input.
  agent.importMessages(agent.exportMessages());
  api.clearOpenAIState();
  await agent.run('Thanks', callbacks());
  assert.equal(requests[1].input.some(item => item.type === 'mcp_call' || item.type === 'mcp_list_tools'), false);
});

test('The ChatGPT account gets no MCP servers', async () => {
  const requests = transport(() => response('chatgpt-oauth', [text('ok')]));
  await new api.AgentLoop(vaultApp().app, { ...settings('chatgpt-oauth'), mcpServers: SERVERS }).run('Hi', callbacks());
  assert.doesNotMatch(JSON.stringify(requests[0]), /mcp|linear/);
});

test('Labels: the tool and its server', () => {
  const label = api.toolLabels.toolLabel;
  assert.equal(label('mcp:linear:create_issue', {}, 'running'), 'Using create_issue on linear…');
  assert.equal(label('mcp:linear:create_issue', {}, 'done'), 'Used create_issue on linear');
  assert.equal(label('mcp:linear:delete', {}, 'error'), 'Using delete on linear failed');
});

test('Tokens go to SecretStorage only; data.json keeps name, address and on/off', async () => {
  const secrets = new Map();
  let saved;
  const plugin = new api.ChatPlugin();
  plugin.app = { secretStorage: { getSecret: key => secrets.get(key) ?? null, setSecret: (key, value) => secrets.set(key, value) }, workspace: { getLeavesOfType: () => [] } };
  plugin.loadData = async () => ({ mcpServers: [{ id: 'a', name: 'linear', url: 'https://mcp.linear.app/sse', enabled: true, token: 'from-data-json' }] });
  plugin.saveData = async data => { saved = JSON.parse(JSON.stringify(data)); };
  secrets.set('chatting-with-ai-mcp-a', 'kept-secret');
  await plugin.loadSettings();
  assert.equal(plugin.settings.mcpServers[0].token, 'kept-secret');

  plugin.settings.mcpServers[0].token = 'new-secret';
  await plugin.saveSettings();
  assert.deepEqual(saved.mcpServers, [{ id: 'a', name: 'linear', url: 'https://mcp.linear.app/sse', enabled: true }]);
  assert.equal(secrets.get('chatting-with-ai-mcp-a'), 'new-secret');

  await plugin.removeMcpServer('a');
  assert.deepEqual(saved.mcpServers, []);
  assert.equal(secrets.get('chatting-with-ai-mcp-a'), '');
});

// A settings row that records its name, description, fields, toggle and buttons.
function row() {
  const r = { texts: [], buttons: {}, setName(name) { r.name = name; return r; }, setDesc(desc) { r.desc = desc; return r; }, setClass(cls) { r.cls = cls; return r; } };
  r.addText = fn => {
    const t = { inputEl: {}, setPlaceholder(p) { t.placeholder = p; return t; }, setValue(v) { t.value = v; return t; }, onChange(f) { t.change = f; return t; } };
    fn(t);
    r.texts.push(t);
    return r;
  };
  r.addToggle = fn => { const t = { setValue(v) { r.value = v; return t; }, setTooltip() { return t; }, onChange(f) { r.toggle = f; return t; } }; fn(t); return r; };
  r.addButton = fn => { const b = { setButtonText(label) { b.label = label; return b; }, onClick(f) { r.buttons[b.label] = f; return b; } }; fn(b); return r; };
  r.addExtraButton = fn => { const b = { setIcon() { return b; }, setTooltip(t) { b.tip = t; return b; }, onClick(f) { r.buttons[b.tip] = f; return b; } }; fn(b); return r; };
  return r;
}

function settingsTab(servers) {
  const plugin = {
    settings: { ...settings('anthropic'), mcpServers: servers.map(server => ({ ...server })) }, saves: 0,
    async saveSettings() { plugin.saves++; },
    async removeMcpServer(id) { plugin.settings.mcpServers = plugin.settings.mcpServers.filter(server => server.id !== id); },
  };
  const tab = new api.ChatSettingTab(settingsApp, plugin);
  const redraws = { count: 0 };
  tab.update = tab.display = () => { redraws.count++; };
  return { plugin, tab, redraws };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('Settings (Obsidian 1.13+): a heading and a list of servers, each row checked as typed; add and delete', async () => {
  const { plugin, tab, redraws } = settingsTab([SERVERS[0], SERVERS[3]]);
  const definitions = tab.getSettingDefinitions();
  const at = definitions.findIndex(d => d.name === 'MCP servers');
  const heading = row();
  definitions[at].render(heading);
  assert.match(heading.desc, /add only servers you trust/);

  const list = definitions[at + 1];
  assert.equal(list.type, 'list');
  assert.deepEqual(list.items.map(item => item.name), ['linear', 'plain']);
  const linear = row();
  list.items[0].render(linear);
  assert.equal(linear.cls, 'ochatting-mcp-server');
  assert.deepEqual(linear.texts.map(t => t.value), ['linear', 'https://mcp.linear.app/sse', 'secret-token']);
  assert.equal(linear.texts[2].inputEl.type, 'password');
  assert.equal(linear.desc, 'On');
  // The list has its own delete; no remove button in the row.
  assert.deepEqual(Object.keys(linear.buttons), []);
  const plain = row();
  list.items[1].render(plain);
  assert.equal(plain.desc, 'Needs an https address.');
  await plain.texts[0].change('bad name!');
  assert.equal(plain.desc, 'Needs a name of letters, digits, - or _ and an https address.');
  await plain.texts[0].change('linear');
  await plain.texts[1].change(' https://other.example ');
  assert.equal(plugin.settings.mcpServers[1].url, 'https://other.example');
  assert.equal(plain.desc, 'Another server has this name.');
  await plain.texts[0].change('plain');
  assert.equal(plain.desc, 'On');
  await linear.toggle(false);
  assert.equal(linear.desc, 'Off');
  await linear.texts[2].change('  ');
  assert.equal(plugin.settings.mcpServers[0].token, undefined);
  assert.equal(plugin.saves, 6);

  list.addItem.action();
  await settle();
  assert.deepEqual(plugin.settings.mcpServers.at(-1), { id: plugin.settings.mcpServers.at(-1).id, name: '', url: '', enabled: true });
  list.onDelete(0);
  await settle();
  assert.deepEqual(plugin.settings.mcpServers.map(server => server.name), ['plain', '']);
  assert.equal(redraws.count, 2);

  // With the ChatGPT account the heading says it doesn't apply.
  plugin.settings.provider = 'chatgpt-oauth';
  definitions[at].render(heading);
  assert.match(heading.desc, /ChatGPT account doesn't offer them/);
  assert.equal(settingsTab([]).tab.getSettingDefinitions().find(d => d.type === 'list' && d.emptyState === 'No servers yet.').items.length, 0);
});

test('Settings before Obsidian 1.13: display() draws the heading, a row per server with Remove, and Add server', async () => {
  const { tab } = settingsTab([SERVERS[0]]);
  const rows = [];
  const ignore = () => {};
  Object.assign(tab, { containerEl: { empty: ignore }, renderProvider: ignore, renderApiKeySection: ignore, renderModelSection: ignore,
    renderWebSearch: ignore, renderEnterSends: ignore, renderFollowEdits: ignore, renderInstructions: ignore, renderSkills: ignore, renderMaxIterations: ignore, renderChats: ignore, renderVoice: ignore, renderDebugLog: ignore, loadCatalog: async () => {},
    renderMcpHeading: () => rows.push('heading'), renderMcpServer: (setting, server, removable) => rows.push(`${server.name}, removable: ${removable}`), renderAddMcpServer: () => rows.push('add') });
  delete tab.display;
  tab.display();
  assert.deepEqual(rows, ['heading', 'linear, removable: true', 'add']);

  // The real rows: Remove on each server row; Add server below, saying when there are none.
  const fresh = settingsTab([SERVERS[0], SERVERS[1]]);
  const server = row();
  fresh.tab.renderMcpServer(server, fresh.plugin.settings.mcpServers[0], true);
  await server.buttons.Remove();
  assert.deepEqual(fresh.plugin.settings.mcpServers.map(s => s.id), ['b']);
  const add = row();
  fresh.tab.renderAddMcpServer(add);
  assert.equal(add.desc, '');
  await add.buttons['Add server']();
  assert.equal(fresh.plugin.settings.mcpServers.length, 2);
  assert.equal(fresh.redraws.count, 2);
  const empty = row();
  settingsTab([]).tab.renderAddMcpServer(empty);
  assert.equal(empty.desc, 'No servers yet.');
});
