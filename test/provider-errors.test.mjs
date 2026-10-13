import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, response, settings, sse, text, transport } from './harness.mjs';

let previousWindow, waits;
beforeEach(() => {
  api.clearOpenAIState();
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
  previousWindow = globalThis.window;
  waits = [];
  globalThis.window = { setTimeout(fn, ms) { waits.push(ms); queueMicrotask(fn); } };
});
afterEach(() => { globalThis.window = previousWindow; });

const hi = [{ role: 'user', content: 'Hi' }];
const failure = (status, error, headers) => ({ status, json: { error }, text: JSON.stringify({ error }), headers });

test('Rate limit: retried once after the wait Retry-After asks for', async () => {
  const requests = transport((body, index) => index ? response('anthropic', [text('OK')])
    : failure(429, { type: 'rate_limit_error', message: 'Slow down' }, { 'Retry-After': '2' }));
  const result = await api.sendMessage(settings('anthropic'), hi, [], 'System');
  assert.equal(result.content[0].text, 'OK');
  assert.equal(requests.length, 2);
  assert.deepEqual(waits, [2000]);
});

test('Overload (529) without Retry-After waits 5 s; a wait over 30 s is not retried', async () => {
  let requests = transport((body, index) => index ? response('anthropic', [text('OK')]) : failure(529, { type: 'overloaded_error', message: 'Overloaded' }));
  await api.sendMessage(settings('anthropic'), hi, [], 'System');
  assert.equal(requests.length, 2);
  requests = transport((body, index) => index ? response('openai', [text('OK')], 'end_turn', index)
    : failure(429, { code: 'rate_limit_exceeded', message: 'Slow down' }, { 'retry-after': new Date(Date.now() + 120_000).toUTCString() }));
  await assert.rejects(api.sendMessage(settings('openai'), hi, [], 'System'), /Slow down/);
  assert.equal(requests.length, 1);
  assert.deepEqual(waits, [5000]);
});

test('Errors that only mention 429 or a rate limit in their text are not retried', async () => {
  for (const message of ['Prompt is 429 tokens over the limit', 'Unknown parameter: rate_limit']) {
    for (const provider of ['openai', 'anthropic']) {
      api.clearOpenAIState();
      const requests = transport(() => failure(400, { type: 'invalid_request_error', message }));
      await assert.rejects(api.sendMessage(settings(provider), hi, [], 'System'), e => e.message.includes(message));
      assert.equal(requests.length, 1, `${provider}: ${message}`);
    }
  }
  assert.deepEqual(waits, []);
});

test('Usage limits are not retried, though they come as a 429', async () => {
  let requests = transport(() => failure(429, { type: 'usage_limit_reached', message: 'The usage limit has been reached' }));
  await assert.rejects(api.sendMessage(settings('chatgpt-oauth'), hi, [], 'System'), /usage limit has been reached/);
  assert.equal(requests.length, 1);
  requests = transport(() => failure(429, { code: 'usage_not_included', message: 'Your plan does not include Codex' }));
  await assert.rejects(api.sendMessage(settings('chatgpt-oauth'), hi, [], 'System'), /does not include Codex/);
  assert.equal(requests.length, 1);
  requests = transport(() => failure(429, { type: 'insufficient_quota', code: 'insufficient_quota', message: 'You exceeded your current quota' }));
  await assert.rejects(api.sendMessage(settings('openai'), hi, [], 'System'), /current quota/);
  assert.equal(requests.length, 1);
  // The same inside a response that had started.
  requests = transport(() => sse([{ type: 'error', code: 'insufficient_quota', message: 'You exceeded your current quota' }]));
  await assert.rejects(api.sendMessage(settings('chatgpt-oauth'), hi, [], 'System'), /current quota/);
  assert.equal(requests.length, 1);
  assert.deepEqual(waits, []);
});

test('ChatGPT: a rate limit inside the response is retried by its code', async () => {
  const requests = transport((body, index) => index ? response('chatgpt-oauth', [text('OK')], 'end_turn', index)
    : sse([{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message: 'Slow down' } } }]));
  const result = await api.sendMessage(settings('chatgpt-oauth'), hi, [], 'System');
  assert.equal(result.content[0].text, 'OK');
  assert.equal(requests.length, 2);
  // Any other failure inside the response is not retried.
  const failed = transport(() => sse([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'Failed' } } }]));
  await assert.rejects(api.sendMessage(settings('chatgpt-oauth'), hi, [], 'System'), /Failed/);
  assert.equal(failed.length, 1);
});

test('ChatGPT: the wait named in an in-stream rate limit, and the Codex overload codes', async () => {
  // Message as the Codex backend sends it; there is no Retry-After inside a response.
  const limited = message => sse([{ type: 'response.failed', response: { error: { code: 'rate_limit_exceeded', message } } }]);
  const retried = async (first, expected) => {
    const requests = transport((body, index) => index ? response('chatgpt-oauth', [text('OK')], 'end_turn', index) : first);
    assert.equal((await api.sendMessage(settings('chatgpt-oauth'), hi, [], 'System')).content[0].text, 'OK');
    assert.equal(requests.length, expected);
  };
  await retried(limited('Rate limit reached for gpt-5.1 on tokens per min (TPM). Please try again in 11.054s. Visit https://platform.openai.com/account/rate-limits to learn more.'), 2);
  await retried(limited('Rate limit reached. Please try again in 28ms.'), 2);
  await retried(sse([{ type: 'error', code: 'slow_down', message: 'Slow down' }]), 2);
  await retried(failure(503, { code: 'server_is_overloaded', message: 'Our servers are currently overloaded' }), 2);
  assert.deepEqual(waits, [11_054, 28, 5000, 5000]);
  // A named wait over 30 s is not retried.
  const requests = transport(() => limited('Rate limit reached. Please try again in 45s.'));
  await assert.rejects(api.sendMessage(settings('chatgpt-oauth'), hi, [], 'System'), /try again in 45s/);
  assert.equal(requests.length, 1);
});

test('OpenAI: a failed response (HTTP 200) is retried by its code like an HTTP error', async () => {
  const failedResponse = code => sse([{ type: 'response.failed', response: { id: 'resp_failed', status: 'failed', output: [], error: { code, message: `Failed: ${code}` } } }]);
  let requests = transport((body, index) => index ? response('openai', [text('OK')], 'end_turn', index) : failedResponse('rate_limit_exceeded'));
  assert.equal((await api.sendMessage(settings('openai'), hi, [], 'System')).content[0].text, 'OK');
  assert.equal(requests.length, 2);
  api.clearOpenAIState();
  requests = transport(() => failedResponse('server_error'));
  await assert.rejects(api.sendMessage(settings('openai'), hi, [], 'System'), /Failed: server_error/);
  assert.equal(requests.length, 1);
  assert.deepEqual(waits, [5000]);
});
