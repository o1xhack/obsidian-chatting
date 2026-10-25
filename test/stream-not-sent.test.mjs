// MCP transport safety: early TLS failures may fall back, lost POSTs may not.
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { api, transport, response, text, sse, settings } from './harness.mjs';
import https from 'node:https';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

afterEach(() => {
  globalThis.window = globalThis;
  globalThis.__isDesktopApp = false;
  delete globalThis.__fetch;
  api.resetStreamTransport();
});

function nodeFailure(mode, signal) {
  let writes = 0, attempts = 0;
  globalThis.__isDesktopApp = true;
  globalThis.window = { require: () => ({ request(_url, _options, callback) {
    attempts++;
    const listeners = {};
    let ready;
    const req = {
      reusedSocket: mode === 'reused',
      on(event, fn) { listeners[event] = fn; },
      write() { writes++; },
      end() {
        if (mode === 'success') {
          const handlers = {};
          callback({ statusCode: 200, setEncoding() {}, on(event, fn) { handlers[event] = fn; } });
          queueMicrotask(() => handlers.end());
        } else queueMicrotask(() => listeners.error(new Error('Connection lost')));
      },
      destroy() {},
    };
    queueMicrotask(() => {
      listeners.socket({ connecting: mode !== 'reused' && mode !== 'unknown', encrypted: mode !== 'unknown',
        on(_event, fn) { ready = fn; } });
      if (mode === 'abort') { signal.abort(); ready?.(); }
      else if (mode === 'early') listeners.error(new Error('TLS failed'));
      else if (mode !== 'reused' && mode !== 'unknown') ready();
    });
    return req;
  } }) };
  return { writes: () => writes, attempts: () => attempts };
}

test('MCP: TLS failure before HTTP submission falls back once without writing a body', async () => {
  const node = nodeFailure('early');
  const requests = transport(() => sse([]));
  await api.streamSSE('https://example.test', { headers: {}, body: '{}', noFallback: true }, () => {});
  assert.equal(node.writes(), 0);
  assert.equal(requests.length, 1);
});

for (const mode of ['after-tls', 'reused', 'unknown']) test(`MCP: ${mode} failure cannot be retried without a response`, async () => {
  const node = nodeFailure(mode);
  const requests = transport(() => sse([]));
  await assert.rejects(api.streamSSE('https://example.test', { headers: {}, body: '{}', noFallback: true }, () => {}));
  assert.equal(node.writes(), 1);
  assert.equal(requests.length, 0);
});

test('MCP: abort before TLS never submits later or falls back', async () => {
  const controller = new AbortController();
  const node = nodeFailure('abort', controller);
  const requests = transport(() => sse([]));
  await assert.rejects(api.streamSSE('https://example.test', { headers: {}, body: '{}', noFallback: true }, () => {}, controller.signal), api.RequestNotSent);
  assert.equal(node.writes(), 0);
  assert.equal(requests.length, 0);
});

test('MCP: a successful ready TLS connection submits the body only once', async () => {
  const node = nodeFailure('success');
  const requests = transport(() => sse([]));
  const result = await api.streamSSE('https://example.test', { headers: {}, body: '{}', noFallback: true }, () => {});
  assert.equal(result.status, 200);
  assert.equal(node.writes(), 1);
  assert.equal(requests.length, 0);
});

for (const provider of ['openai', 'anthropic']) test(`${provider}: a failed fallback is uncertain even after a provably unsent Node attempt`, async () => {
  const node = nodeFailure('early');
  const requests = transport(() => { throw new Error('Fallback lost its response'); });
  const send = provider === 'openai' ? api.sendOpenAIMessage : api.sendAnthropicMessage;
  await assert.rejects(send({ ...settings(provider), mcpServers: [{ id: 's', name: 's', enabled: true, url: 'https://mcp.example.test' }] },
    [{ role: 'user', content: 'Q' }], [], 'System'), error => error.remoteEffectsPossible === true);
  assert.equal(node.writes(), 0);
  assert.equal(requests.length, 1);
});

for (const provider of ['openai', 'anthropic']) test(`${provider}: an early background failure retains its safe local type`, async () => {
  const node = nodeFailure('early');
  const lifecycle = api.lifecycle.appLifecycle;
  const original = lifecycle.hiddenSince;
  lifecycle.hiddenSince = () => true;
  const requests = transport(() => response(provider, [text('ok')]));
  const send = provider === 'openai' ? api.sendOpenAIMessage : api.sendAnthropicMessage;
  try {
    await assert.rejects(send({ ...settings(provider), mcpServers: [{ id: 's', name: 's', enabled: true, url: 'https://mcp.example.test' }] },
      [{ role: 'user', content: 'Q' }], [], 'System'), api.RequestNotSent);
  } finally { lifecycle.hiddenSince = original; }
  assert.equal(requests.length, 0);
  assert.equal(node.writes(), 0);
});

test('Real Node TLS: DNS, refused and untrusted certificates fall back; a delivered POST never does', async () => {
  await mkdir('temp', { recursive: true });
  const dir = await mkdtemp('temp/mcp-tls-');
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/key.pem`,
      '-out', `${dir}/cert.pem`, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const key = await readFile(`${dir}/key.pem`), cert = await readFile(`${dir}/cert.pem`);
    for (const mode of ['dns', 'refused', 'certificate', 'delivered']) {
      let delivered = 0;
      const server = https.createServer({ key, cert }, req => {
        delivered++;
        req.resume();
        req.on('end', () => req.socket.destroy());
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      const close = () => new Promise(resolve => server.close(resolve));
      if (mode === 'refused') await close();
      try {
        globalThis.__isDesktopApp = true;
        globalThis.window = { require: () => ({ request(url, options, callback) {
          return https.request(url, { ...options, agent: false,
            ...(mode === 'delivered' ? { ca: cert, checkServerIdentity: () => undefined } : {}),
            ...(mode === 'dns' ? { lookup: (_host, _options, done) => queueMicrotask(() => done(Object.assign(Error('DNS failed'), { code: 'ENOTFOUND' }))) } : {}),
          }, callback);
        } }) };
        const fallbacks = transport(() => sse([]));
        const pending = api.streamSSE(`https://${mode === 'dns' ? 'probe.invalid' : '127.0.0.1'}:${port}/mcp`,
          { headers: {}, body: '{}', noFallback: true }, () => {});
        if (mode === 'delivered') await assert.rejects(pending);
        else assert.equal((await pending).status, 200);
        assert.equal(fallbacks.length, mode === 'delivered' ? 0 : 1, mode);
        assert.equal(delivered, mode === 'delivered' ? 1 : 0, mode);
      } finally { if (mode !== 'refused') await close(); }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
