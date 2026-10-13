import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, assistant, call, response, result, settings, text, transport } from './harness.mjs';

test('Anthropic web search as documented: results stay encrypted for replay, cited pages follow the answer', async () => {
  // Response shape from the web search tool docs (docs.claude.com, "Web search tool").
  const found = { type: 'web_search_result', url: 'https://en.wikipedia.org/wiki/Claude_Shannon', title: 'Claude Shannon - Wikipedia', encrypted_content: 'fake-encrypted', page_age: 'April 30, 2025' };
  const citation = { type: 'web_search_result_location', url: found.url, title: found.title, encrypted_index: 'fake-index', cited_text: 'Claude Elwood Shannon (April 30, 1916' };
  const failed = { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' };
  const content = [
    { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'claude shannon birth date' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [found] },
    { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'claude shannon' } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: failed },
    { type: 'text', text: 'Based on the search results, ' },
    { type: 'text', text: 'Claude Shannon was born on April 30, 1916.', citations: [citation] },
    { type: 'text', text: ' He worked at Bell Labs.', citations: [citation] },
  ];
  const requests = transport((body, index) => response('anthropic', index ? [text('Done')] : content));
  const messages = [{ role: 'user', content: 'When was Claude Shannon born?' }];
  const first = await api.sendAnthropicMessage(settings('anthropic'), messages, [], 'System');
  // Each cited page once; search results and errors are not shown as text.
  assert.equal(first.content.map(block => block.text).join(''),
    'Based on the search results, Claude Shannon was born on April 30, 1916. He worked at Bell Labs.' +
    '\n\nSources:\n- [Claude Shannon - Wikipedia](https://en.wikipedia.org/wiki/Claude_Shannon)');
  assert.deepEqual(first.replay.items, content);
  // The next turn sends the blocks back exactly as received.
  messages.push(assistant(first), { role: 'user', content: 'And where?' });
  await api.sendAnthropicMessage(settings('anthropic'), JSON.parse(JSON.stringify(messages)), [], 'System');
  assert.deepEqual(requests[1].messages[1], { role: 'assistant', content });
});

test('Anthropic sources: link text and address stay valid Markdown; no citations, no list', async () => {
  const bs = String.fromCharCode(92);
  const citation = { type: 'web_search_result_location', url: 'https://example.com/a (b)', title: `Notes [draft] a${bs}b`, cited_text: 'x' };
  transport(() => response('anthropic', [{ type: 'text', text: 'Answer', citations: [citation] }]));
  const cited = await api.sendAnthropicMessage(settings('anthropic'), [{ role: 'user', content: 'Q' }], [], 'System');
  assert.equal(cited.content[1].text, `\n\nSources:\n- [Notes ${bs}[draft${bs}] a${bs}${bs}b](https://example.com/a%20%28b%29)`);
  transport(() => response('anthropic', [text('Plain answer')]));
  const plain = await api.sendAnthropicMessage(settings('anthropic'), [{ role: 'user', content: 'Q' }], [], 'System');
  assert.deepEqual(plain.content, [text('Plain answer')]);
});

test('Anthropic sources come before a tool call, so another provider gets the call next to its result', async () => {
  const citation = { type: 'web_search_result_location', url: 'https://example.com', title: 'Example', cited_text: 'x' };
  transport(() => response('anthropic', [{ type: 'text', text: 'Saving it.', citations: [citation] }, call('save', 'create_file', { path: 'A.md', content: 'x' })], 'tool_use'));
  const first = await api.sendAnthropicMessage(settings('anthropic'), [{ role: 'user', content: 'Q' }], [], 'System');
  assert.deepEqual(first.content.map(block => block.type), ['text', 'text', 'tool_use']);
  // The same history after a switch to OpenAI (Responses API items).
  const history = [{ role: 'user', content: 'Q' }, assistant(first), { role: 'user', content: [result('save', 'Created')] }];
  const items = api.buildResponsesInput(history, 'openai');
  assert.deepEqual(items.map(item => item.type), ['message', 'message', 'function_call', 'function_call_output']);
  assert.deepEqual(items[1].content.map(part => part.text), ['Saving it.', '\n\nSources:\n- [Example](https://example.com)']);
});
