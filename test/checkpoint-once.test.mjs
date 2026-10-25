// A durable per-turn MCP uncertainty marker is reusable until a later save
// replaces it. No format change or extra index write is required per step.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, vaultApp, chatFiles } from './harness.mjs';

const DIR = '.obsidian/plugins/chatting-with-ai';
const STATE = `${DIR}/chat-state.json`;
async function setup() {
  const { adapter } = chatFiles();
  adapter.stored.set(STATE, JSON.stringify({ chatHistory: [{ type: 'user', text: 'Original ' + 'x'.repeat(1024 * 1024) }], agentMessages: [] }));
  const { app } = vaultApp(); app.vault.adapter = adapter;
  const plugin = new api.ChatPlugin(); plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('openai'));
  await plugin.loadChatHistory();
  return { plugin, adapter, path: `${DIR}/chats/${plugin.activeConversationId}.json` };
}
const pending = (start = 1) => ({ turnId: 'remote', startedAt: start, remoteEffectsPossible: true });
const savedPending = (adapter, path) => JSON.parse(adapter.stored.get(path)).conversation.pendingTurn;

test('A durable MCP marker makes later changed steps and retries require no disk writes', async () => {
  const { plugin, adapter, path } = await setup();
  plugin.activeConversation.pendingTurn = pending();
  await plugin.checkpointChatHistory();
  const original = adapter.stored.get(path), writes = [];
  const write = adapter.write;
  adapter.write = async (path, data) => { writes.push(path); await write(path, data); };
  for (let step = 0; step < 5; step++) {
    plugin.chatHistory.push({ type: 'assistant', text: `Changed step ${step}` });
    await plugin.checkpointChatHistory();
  }
  assert.deepEqual(writes, []);
  assert.equal(adapter.stored.get(path), original);
  assert.deepEqual(savedPending(adapter, path), pending());
});

test('A new MCP turn persists its new input before reusing a checkpoint', async () => {
  const { plugin, adapter, path } = await setup();
  plugin.activeConversation.pendingTurn = pending();
  await plugin.checkpointChatHistory();
  plugin.chatHistory.push({ type: 'user', text: 'New request', turnId: 'remote' });
  plugin.activeConversation.pendingTurn = pending(2);
  await plugin.checkpointChatHistory();
  const saved = JSON.parse(adapter.stored.get(path)).conversation;
  assert.deepEqual(saved.pendingTurn, pending(2));
  assert.equal(saved.chatHistory.at(-1).text, 'New request');
});

test('A checkpoint waits for an older save that clears its cached marker, then persists the marker again', async () => {
  const { plugin, adapter, path } = await setup();
  plugin.activeConversation.pendingTurn = pending();
  await plugin.checkpointChatHistory();
  plugin.activeConversation.pendingTurn.remoteEffectsPossible = false;
  let entered, release;
  const blocked = new Promise(resolve => { entered = resolve; });
  const write = adapter.write;
  adapter.write = async (file, data) => {
    if (!release && file.includes('/chats/')) await new Promise(resolve => { release = resolve; entered(); });
    await write(file, data);
  };
  const oldSave = plugin.saveChatHistory(); await blocked;
  plugin.activeConversation.pendingTurn = pending();
  const checkpoint = plugin.checkpointChatHistory();
  release(); await Promise.all([oldSave, checkpoint]);
  assert.deepEqual(savedPending(adapter, path), pending());
});

test('A failed replacement invalidates both the durable marker and the old payload digest', async () => {
  const { plugin, adapter, path } = await setup();
  plugin.activeConversation.pendingTurn = pending();
  await plugin.checkpointChatHistory();
  plugin.activeConversation.pendingTurn.remoteEffectsPossible = false;
  const write = adapter.write;
  adapter.write = async (file, data) => { if (file === path) throw Error('Main copy failed'); await write(file, data); };
  await plugin.saveChatHistory();
  assert.equal(JSON.parse(adapter.stored.get(path.replace('.json', '.next.json'))).conversation.pendingTurn.remoteEffectsPossible, false);
  adapter.write = write;
  // Restore the exact previous snapshot: a stale digest would skip the repair.
  plugin.activeConversation.pendingTurn = pending();
  await plugin.checkpointChatHistory();
  assert.deepEqual(savedPending(adapter, path), pending());
  assert.deepEqual(savedPending(adapter, path.replace('.json', '.next.json')), pending());
});

test('A new instance can reuse an uncertainty marker actually read from a complete chat file', async () => {
  const { plugin, adapter } = await setup();
  plugin.activeConversation.pendingTurn = pending();
  await plugin.checkpointChatHistory();
  const { app } = vaultApp(); app.vault.adapter = adapter;
  const restored = new api.ChatPlugin(); restored.app = app;
  restored.agent = new api.AgentLoop(app, settings('openai'));
  await restored.loadChatHistory();
  adapter.write = async () => assert.fail('The marker is already durable');
  await restored.checkpointChatHistory();
});

test('A superseded marker cannot authorize another request when its repair cannot be saved', async () => {
  const { plugin, adapter } = await setup();
  plugin.activeConversation.pendingTurn = pending();
  await plugin.checkpointChatHistory();
  plugin.activeConversation.pendingTurn.remoteEffectsPossible = false;
  await plugin.saveChatHistory();
  plugin.activeConversation.pendingTurn = pending();
  adapter.write = async () => { throw Error('Storage unavailable'); };
  await assert.rejects(plugin.checkpointChatHistory(), /Couldn't save the chat checkpoint/);
});
