// Investigation probes for the 0.11.0 baseline; intentionally outside *.test.mjs.
// Run from the repository root: node test/investigate-issues-60-62.mjs
// Uses local TLS only, fake provider credentials and mocked fallback responses.
import assert from 'node:assert/strict';
import https from 'node:https';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { api, settings, transport, sse, text, vaultApp, chatFiles } from './harness.mjs';

if (api.RequestNotSent) {
  console.log('The original 0.11.0 baseline is archived in docs/issues-60-62-evidence.json. Run npm test for the fixed behavior.');
  process.exit(0);
}

const output = 'temp/issues-60-62';
await mkdir(output, { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', `${output}/local.key`, '-out', `${output}/local.pem`,
  '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
const key = await readFile(`${output}/local.key`);
const cert = await readFile(`${output}/local.pem`);
const evidence = { baseline: '0.11.0 / aefc8d5', node: process.version, transport: [], checkpoints: [], compaction: [], voice: [] };
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const close = server => new Promise(resolve => server.close(resolve));

// Real TLS/Node events distinguish a handshake failure from a lost response.
for (const mode of ['dns', 'refused', 'certificate', 'response-lost']) {
  for (const mcp of [false, true]) {
    let serverRequests = 0, bytesReceived = 0;
    const server = https.createServer({ key, cert }, (req, res) => {
      serverRequests++;
      req.on('data', chunk => { bytesReceived += chunk.length; });
      req.on('end', () => { req.socket.destroy(); });
    });
    let port = await listen(server);
    if (mode === 'refused') await close(server);
    const events = [];
    let nodeError;
    const module = { request(url, options, callback) {
      const req = https.request(url, { ...options, agent: false,
        ...(mode === 'response-lost' ? { ca: cert, checkServerIdentity: () => undefined } : {}),
        ...(mode === 'dns' ? { lookup: (_host, _options, cb) => queueMicrotask(() => cb(Object.assign(new Error('synthetic DNS failure'), { code: 'ENOTFOUND' }))) } : {}),
      }, callback);
      req.on('socket', socket => {
        events.push('socket');
        socket.on('connect', () => events.push('connect'));
        socket.on('secureConnect', () => events.push('secureConnect'));
      });
      req.on('finish', () => events.push('finish'));
      req.on('error', error => { nodeError = error.code; events.push(`error:${error.code}`); });
      return req;
    } };
    globalThis.window = { require: id => id === 'https' ? module : undefined };
    globalThis.__isDesktopApp = true;
    const fallbacks = transport(() => sse([]));
    let failed = false;
    try {
      await api.streamSSE(`https://${mode === 'dns' ? 'probe.invalid' : '127.0.0.1'}:${port}/responses`,
        { headers: {}, body: '{}', noFallback: mcp }, () => {});
    } catch { failed = true; }
    if (mode !== 'refused') await close(server);
    assert.equal(fallbacks.length, mcp ? 0 : 1);
    assert.equal(failed, mcp);
    assert.equal(serverRequests, mode === 'response-lost' ? 1 : 0);
    evidence.transport.push({ mode, mcp, events, nodeError, serverRequests, bytesReceived, fallbacks: fallbacks.length, failed });
  }
}

// Adapter-level false warning: no request reached the provider, yet both adapters
// expose an uncertain external effect. No actual MCP service is contacted.
for (const provider of ['openai', 'anthropic']) {
  globalThis.window = { require: () => ({ request() {
    const listeners = {};
    return { on(event, fn) { listeners[event] = fn; }, write() {}, destroy() {},
      end() { queueMicrotask(() => listeners.error(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }))); } };
  } }) };
  const fallbacks = transport(() => sse([]));
  let error;
  const fn = provider === 'openai' ? api.sendOpenAIMessage : api.sendAnthropicMessage;
  try {
    await fn({ ...settings(provider), mcpServers: [{ id: 'probe', name: 'probe', url: 'https://mcp.example.test', enabled: true }] },
      [{ role: 'user', content: 'Probe' }], [], 'System');
  } catch (caught) { error = caught; }
  assert.equal(error.remoteEffectsPossible, true);
  assert.match(error.message, /Remote MCP tools may already have run/);
  assert.equal(fallbacks.length, 0);
  evidence.transport.push({ provider, mode: 'adapter-before-connect', remoteEffectsPossible: error.remoteEffectsPossible, message: error.message });
}
globalThis.window = globalThis;
globalThis.__isDesktopApp = false;

// A marker-only change still rewrites both copies of the full conversation.
{
  const { adapter } = chatFiles();
  const { app } = vaultApp();
  app.vault.adapter = adapter;
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('openai'));
  await plugin.loadChatHistory();
  plugin.chatHistory.push({ type: 'user', text: 'x'.repeat(1024 * 1024), turnId: 'checkpoint-probe' });
  await plugin.saveChatHistory();
  const writes = [];
  const write = adapter.write;
  adapter.write = async (path, data) => { writes.push({ path, bytes: Buffer.byteLength(data) }); await write(path, data); };
  plugin.activeConversation.pendingTurn = { turnId: 'checkpoint-probe', startedAt: 1, remoteEffectsPossible: true };
  await plugin.checkpointChatHistory();
  const changed = writes.splice(0);
  assert.equal(changed.filter(write => write.path.includes('/chats/')).length, 2);
  await plugin.checkpointChatHistory();
  const unchanged = writes.splice(0);
  assert.equal(unchanged.filter(write => write.path.includes('/chats/')).length, 0);
  evidence.checkpoints.push({ markerOnlyChange: changed, unchangedCheckpoint: unchanged });
}

// Repeated opaque compactions: native requests stay small, saved API history grows.
for (const provider of ['openai', 'chatgpt-oauth']) for (const windows of [1, 2, 4, 8]) {
  const conversation = api.chatState.newConversation(1);
  for (let i = 0; i < windows; i++) {
    conversation.agentMessages.push({ role: 'user', content: `FACT-${i} ` + 'x'.repeat(64 * 1024), turnId: `t${i}` },
      { role: 'assistant', content: [text(`Answer ${i}`)], compaction: {}, replay: {
        provider, model: 'probe', items: [{ type: 'compaction', id: `cmp-${i}`, encrypted_content: `opaque-${i}` }],
      } });
  }
  const saved = api.chatState.savedConversation(conversation);
  const request = api.buildResponsesInput(conversation.agentMessages, provider, 'probe');
  assert.equal(saved.agentMessages.length, windows * 2);
  assert.equal(request.length, 1);
  evidence.compaction.push({ provider, windows, savedMessages: saved.agentMessages.length,
    savedBytes: Buffer.byteLength(JSON.stringify(saved)), requestBytes: Buffer.byteLength(JSON.stringify(request)) });
}

// Two-window deletion alone loses the earliest fact at a provider handoff.
const messages = [
  { role: 'user', content: 'EARLIEST-FACT', turnId: 'first' },
  { role: 'assistant', content: [text('A')], compaction: {}, replay: { provider: 'openai', items: [{ type: 'compaction', encrypted_content: 'opaque-old' }] } },
  { role: 'user', content: 'Recent fact', turnId: 'second' },
  { role: 'assistant', content: [text('B')], compaction: {}, replay: { provider: 'openai', items: [{ type: 'compaction', encrypted_content: 'opaque-new' }] } },
];
assert.match(JSON.stringify(api.compaction.afterCompaction(messages, () => false)), /EARLIEST-FACT/);
assert.doesNotMatch(JSON.stringify(api.compaction.afterCompaction(messages.slice(1), () => false)), /EARLIEST-FACT/);
evidence.compaction.push({ twoWindowDeletionLosesPortableEarliestFact: true });

// The same status conceals distinguishable service/proxy causes.
for (const body of [
  { error: { code: 'model_not_found', message: 'Requested voice model is unavailable.' } },
  { error: { code: 'route_not_found', message: 'Requested endpoint was not found.' } },
  '<html>Corporate proxy: route not found</html>',
]) {
  let renewals = 0;
  globalThis.__providerRequest = async () => ({ status: 404, text: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'x-request-id': 'probe-request' } });
  const route = api.codexVoice.codexVoiceRoute({ getUsableCredential: async () => ({ accessToken: 'fake', accountId: 'fake' }),
    renewRejected: async () => { renewals++; return null; } }, 'cove', () => 'test');
  let error;
  try { await route.connect({ sdp: 'fake-offer', instructions: 'test', items: [] }); } catch (caught) { error = caught; }
  assert.equal(error.message, "Couldn't start voice (HTTP 404).");
  assert.equal(renewals, 0);
  evidence.voice.push({ body, shownError: error.message, renewals });
}
await writeFile(`${output}/evidence.json`, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
