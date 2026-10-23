import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, text, call, response, transport, vaultApp, callbacks } from './harness.mjs';

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: a huge textual read is bounded before follow-up and the conversation remains usable`, async () => {
    api.clearOpenAIState();
    api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake', accountId: 'fake' }) });
    const { app, files } = vaultApp();
    files.set('Huge.md', 'L'.repeat(31_000_000));
    const loop = new api.AgentLoop(app, { ...settings(provider), maxIterations: 2 });
    const attachment = { id: 'pdf', fileName: 'TenMiB.pdf', mediaType: 'application/pdf', sizeBytes: 10 * 1024 * 1024, data: 'A'.repeat(4 * Math.ceil(10 * 1024 * 1024 / 3)) };
    loop.importMessages([
      { role: 'user', turnId: 'old1', content: [{ type: 'file', file: attachment }, text('First')] }, { role: 'assistant', content: [text('A1')] },
      { role: 'user', turnId: 'old2', content: [{ type: 'file', file: { ...attachment, id: 'second' } }, text('Second')] }, { role: 'assistant', content: [text('A2')] },
    ]);
    const requests = transport((_body, index) => index === 0
      ? response(provider, [call('large-read', 'read_document', { path: 'Huge.md' })], 'tool_use', index)
      : response(provider, [text('Read a focused extract instead.')], 'end_turn', index));
    const cb = callbacks({ onToolResult: (_name, result) => assert.ok(result.result.length <= 100000) });
    await loop.run('Read huge note', cb);
    assert.deepEqual(cb.errors, []);
    assert.equal(requests.length, 2);
    const block = loop.exportMessages().flatMap(m => typeof m.content === 'string' ? [] : m.content).find(b => b.type === 'tool_result');
    assert.equal(block.tool_use_id, 'large-read');
    assert.match(block.content, /Tool text truncated/);
    await loop.run('Continue without clearing', callbacks());
    assert.equal(requests.length, 3);
  });
}

test('Restored oversized tool text is bounded, clipped provenance is forgotten and a second pass is stable', () => {
  const messages = [{ role: 'user', content: 'Q' }, { role: 'assistant', content: [call('old', 'read_document', {})] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'X'.repeat(2_000_000), instructionSources: ['Work/AGENTS.md'] }] }];
  const bounded = api.withoutLargeToolText(messages);
  assert.equal(bounded[2].content[0].instructionSources, undefined);
  assert.ok(bounded[2].content[0].content.length <= 100000);
  assert.equal(api.withoutLargeToolText(bounded), bounded);
  const { app } = vaultApp();
  const loop = new api.AgentLoop(app, settings('anthropic'));
  loop.importMessages(messages);
  assert.match(loop.exportMessages()[2].content[0].content, /Tool text truncated/);
});

test('Saved and inactive restored conversations also bound visible/API tool text', () => {
  const record = api.chatState.newConversation();
  record.chatHistory = [{ type: 'user', text: 'Q', turnId: 't' }, { type: 'tool-result', toolName: 'read_file', toolResult: { result: 'V'.repeat(2_000_000), isError: false } }];
  record.agentMessages = [{ role: 'user', turnId: 't', content: 'Q' }, { role: 'assistant', content: [call('r', 'read_file', {})] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'A'.repeat(2_000_000) }] }];
  const saved = api.chatState.savedConversation(record);
  assert.ok(saved.chatHistory[1].toolResult.result.length <= 100000);
  assert.ok(saved.agentMessages[2].content[0].content.length <= 100000);
  const state = api.chatState.migrateChatState({ version: 3, activeConversationId: 'other', conversations: [record, { ...api.chatState.newConversation(), id: 'other' }] });
  assert.ok(state.conversations[0].chatHistory[1].toolResult.result.length <= 100000);
  assert.ok(state.conversations[0].agentMessages[2].content[0].content.length <= 100000);
});

test('A turn keeps everything it read (each result capped); earlier turns share the allowance, clipped once when the next turn starts', async () => {
  const { app, files } = vaultApp();
  for (let i = 1; i <= 4; i++) files.set(`N${i}.md`, String(i).repeat(80000));
  const loop = new api.AgentLoop(app, settings('anthropic'));
  const results = body => body.messages.flatMap(m => typeof m.content === 'string' ? [] : m.content).filter(b => b.type === 'tool_result').map(b => typeof b.content === 'string' ? b.content : b.content.map(part => part.text ?? '').join(''));
  const reads = (offset, count) => transport((_body, index) => index < count
    ? response('anthropic', [call(`r${offset + index}`, 'read_document', { path: `N${index + 1}.md` })], 'tool_use', index)
    : response('anthropic', [text('Done.')], 'end_turn', index));
  // 4 × 80,000 characters: more than the 200,000 the turns share.
  let requests = reads(0, 4);
  await loop.run('Read N1 to N4', callbacks());
  const last = results(requests.at(-1));
  assert.equal(last.length, 4);
  assert.ok(last.every(result => result.length >= 80000 && !/Tool text truncated/.test(result)));
  // Within the turn, what was sent stays as sent (the cached prefix holds).
  for (let i = 1; i < requests.length; i++) assert.deepEqual(results(requests[i]).slice(0, i - 1), results(requests[i - 1]).slice(0, i - 1));

  // The next turn: the earlier results share the allowance from its first request on, and stay so.
  requests = reads(4, 1);
  await loop.run('Read N1 again', callbacks());
  const before = results(requests[0]);
  assert.ok(before.reduce((n, result) => n + result.length, 0) <= 210000);
  assert.match(before[0], /Tool text truncated/);
  assert.deepEqual(results(requests[1]).slice(0, 4), before);
});
