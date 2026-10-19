// Desktop streaming through Node's https (no CORS check), and the per-URL
// fetch fallback.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, sseText, sse, transport } from './harness.mjs';

beforeEach(() => api.resetStreamTransport());
afterEach(() => {
  globalThis.window = globalThis;
  globalThis.__isDesktopApp = false;
  delete globalThis.__fetch;
});

// A fake Node `https` module, reached through window.require as in Electron.
// It answers with `body` in `chunk`-character pieces, or never ends with `hold`.
function fakeNodeHttps(body, { status = 200, chunk = 9, hold = false } = {}) {
  const calls = [];
  const https = {
    request(url, options, callback) {
      const listeners = {};
      const res = {
        statusCode: status,
        setEncoding() {},
        on(event, fn) { (listeners[event] ??= []).push(fn); },
      };
      const req = {
        written: '',
        destroyed: false,
        on() {},
        write(data) { this.written += data; },
        destroy() { this.destroyed = true; },
        end() {
          callback(res);
          queueMicrotask(async () => {
            for (let i = 0; i < body.length; i += chunk) {
              if (req.destroyed) return;
              for (const fn of listeners.data ?? []) fn(body.slice(i, i + chunk));
              await Promise.resolve();
            }
            if (!hold && !req.destroyed) for (const fn of listeners.end ?? []) fn();
          });
        },
      };
      calls.push({ url, options, req });
      return req;
    },
  };
  globalThis.window = { require: id => (id === 'https' ? https : undefined) };
  globalThis.__isDesktopApp = true;
  return calls;
}

test('Desktop: streams through Node https, never fetch', async () => {
  globalThis.__fetch = async () => { throw new Error('fetch must not be used on desktop'); };
  const body = sseText([{ type: 'response.output_text.delta', delta: 'Hel' }, { type: 'response.output_text.delta', delta: 'lo' }]);
  const calls = fakeNodeHttps(body);
  const events = [];
  const result = await api.streamSSE('https://api.openai.com/v1/responses', { headers: { Authorization: 'Bearer t' }, body: '{"a":"ä"}' }, e => events.push(e));
  assert.equal(result.status, 200);
  assert.deepEqual(events.map(e => e.delta), ['Hel', 'lo']);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer t');
  assert.equal(calls[0].options.headers['Content-Length'], '10'); // bytes, not characters
  assert.equal(calls[0].req.written, '{"a":"ä"}');
});

test('Desktop: an error status returns its body as text and JSON', async () => {
  fakeNodeHttps('{"error":{"message":"bad key"}}', { status: 401 });
  const result = await api.streamSSE('https://api.openai.com/v1/responses', { headers: {}, body: '{}' }, () => {});
  assert.equal(result.status, 401);
  assert.equal(result.json.error.message, 'bad key');
});

test('Desktop: Stop destroys the Node request', async () => {
  const calls = fakeNodeHttps(sseText([{ type: 'response.output_text.delta', delta: 'x' }]), { hold: true });
  const controller = new AbortController();
  const pending = api.streamSSE('https://api.openai.com/v1/responses', { headers: {}, body: '{}' }, () => {}, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls[0].req.destroyed, true);
});

test('Desktop: no answer through Node (proxy, certificate) falls back to requestUrl', async () => {
  const https = {
    request() {
      const req = {
        listeners: {},
        on(event, fn) { (req.listeners[event] ??= []).push(fn); },
        write() {},
        destroy() {},
        end() { queueMicrotask(() => { for (const fn of req.listeners.error ?? []) fn(new Error('self signed certificate in certificate chain')); }); },
      };
      return req;
    },
  };
  globalThis.window = { require: id => (id === 'https' ? https : undefined) };
  globalThis.__isDesktopApp = true;
  const requests = transport(() => sse([{ type: 'response.output_text.delta', delta: 'Hi' }]));
  const events = [];
  const result = await api.streamSSE('https://api.openai.com/v1/responses', { headers: {}, body: '{"model":"x"}' }, e => events.push(e));
  assert.equal(result.status, 200);
  assert.equal(requests.length, 1);
  assert.deepEqual(events.map(e => e.delta), ['Hi']);
});

test('Desktop: a connection lost after the answer began is a dropped stream, not a fallback', async () => {
  const listeners = {};
  const https = {
    request(url, options, callback) {
      return {
        on() {}, write() {}, destroy() {},
        end() {
          callback({ statusCode: 200, setEncoding() {}, on(event, fn) { (listeners[event] ??= []).push(fn); } });
          queueMicrotask(() => {
            for (const fn of listeners.data ?? []) fn(sseText([{ type: 'response.output_text.delta', delta: 'Hal' }]));
            for (const fn of listeners.error ?? []) fn(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
          });
        },
      };
    },
  };
  globalThis.window = { require: id => (id === 'https' ? https : undefined) };
  globalThis.__isDesktopApp = true;
  const requests = transport(() => sse([]));
  await assert.rejects(api.streamSSE('https://api.openai.com/v1/responses', { headers: {}, body: '{}' }, () => {}), { name: 'StreamDropped' });
  assert.equal(requests.length, 0);
});

test('Mobile: a blocked fetch only switches that URL to requestUrl', async () => {
  const fetched = [];
  globalThis.__fetch = async url => { fetched.push(url); throw new TypeError('Failed to fetch'); };
  transport(() => sse([]));
  await api.streamSSE('https://api.openai.com/v1/responses', { headers: {}, body: '{}' }, () => {});
  await api.streamSSE('https://api.openai.com/v1/responses', { headers: {}, body: '{}' }, () => {});
  await api.streamSSE('https://api.anthropic.com/v1/messages', { headers: {}, body: '{}' }, () => {});
  assert.deepEqual(fetched, ['https://api.openai.com/v1/responses', 'https://api.anthropic.com/v1/messages']);
});
