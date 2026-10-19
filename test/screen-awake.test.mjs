// The screen stays on while an answer is generated; asked for again when
// the app is back; nothing where the Wake Lock API is missing.
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { api, settings, text, call, response, transport, vaultApp } from './harness.mjs';

const { screenAwake } = api;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let requests;
let locks;
let listeners;
beforeEach(() => {
  requests = 0;
  locks = [];
  listeners = new Map();
  // Newer Node versions define a read-only `navigator`; replace it the way a browser test would.
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      wakeLock: {
        request: async (type) => {
          assert.equal(type, 'screen');
          requests++;
          const lock = { released: false, release: async () => { lock.released = true; } };
          locks.push(lock);
          return lock;
        },
      },
    },
    configurable: true,
    writable: true,
  });
  // Listeners by target and event, e.g. "document resume".
  const target = (name) => ({
    addEventListener(type, fn) { listeners.set(`${name} ${type}`, fn); },
    removeEventListener(type, fn) { if (listeners.get(`${name} ${type}`) === fn) listeners.delete(`${name} ${type}`); },
  });
  globalThis.document = { visibilityState: 'visible', ...target('document') };
  globalThis.window = target('window');
});

afterEach(() => {
  screenAwake.reset();
  delete globalThis.document;
  delete globalThis.window;
});

function emit(event) {
  listeners.get(event)?.();
}

test('A hold from before a reset lets go of nothing later', async () => {
  const old = screenAwake.hold();
  screenAwake.reset();
  const current = screenAwake.hold();
  await tick();
  old();
  await tick();
  assert.equal(locks.at(-1).released, false);
  current();
  await tick();
  assert.equal(locks.at(-1).released, true);
  // Nothing went below zero: the next hold asks for a lock again.
  const next = screenAwake.hold();
  await tick();
  assert.equal(locks.at(-1).released, false);
  next();
});

function setVisibility(state) {
  globalThis.document.visibilityState = state;
  emit('document visibilitychange');
}

test('One lock while anyone holds it; released when the last one lets go', async () => {
  const first = screenAwake.hold();
  const second = screenAwake.hold();
  await tick();
  assert.equal(requests, 1);
  first();
  first(); // letting go twice counts once
  await tick();
  assert.equal(locks[0].released, false);
  second();
  await tick();
  assert.equal(locks[0].released, true);
});

test('The system drops the lock in the background; it is asked for again on the return', async () => {
  const release = screenAwake.hold();
  await tick();
  setVisibility('hidden');
  locks[0].released = true;
  await tick();
  assert.equal(requests, 1);
  setVisibility('visible');
  await tick();
  assert.equal(requests, 2);
  release();
  await tick();
  assert.equal(locks[1].released, true);
  // Unloading stops listening.
  screenAwake.reset();
  assert.equal(listeners.size, 0);
});

test('Asked for again on Capacitor resume, window focus and pageshow; no listeners while nobody holds it', async () => {
  const release = screenAwake.hold();
  await tick();
  assert.deepEqual([...listeners.keys()].sort(), ['document resume', 'document visibilitychange', 'window focus', 'window pageshow']);
  for (const event of ['document resume', 'window focus', 'window pageshow']) {
    // The system dropped the lock without a visibilitychange.
    locks.at(-1).released = true;
    const before = requests;
    emit(event);
    await tick();
    assert.equal(requests, before + 1, event);
  }
  // A hint while the lock is still held asks for nothing.
  emit('window focus');
  await tick();
  assert.equal(requests, 4);
  release();
  await tick();
  assert.equal(listeners.size, 0);
  assert.equal(locks.at(-1).released, true);
});

test('Without the API nothing happens', async () => {
  globalThis.navigator = {};
  const release = screenAwake.hold();
  await tick();
  release();
  assert.equal(requests, 0);
});

// A chat view with a fake component that ignores what it is shown.
function chatSetup(provider) {
  const { app } = vaultApp();
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings(provider));
  const view = new api.ObsidianChatView({}, plugin);
  const ignore = () => {};
  view.chatContainer = {
    addUserMessage: ignore, addAssistantMessage: () => 0, updateAssistantMessage: ignore, removeMessage: ignore, addError: ignore, addToolCall: () => 0, updateToolResult: ignore,
    showThinking: ignore, hideThinking: ignore, cancelAskUser: ignore, setInputEnabled: ignore, setBusy: ignore, foldTurn: ignore, focus: ignore, clearMessages: ignore, setTitle: ignore,
  };
  return { plugin, view };
}

test('A turn holds the screen on until it ends', async () => {
  const { view } = chatSetup('anthropic');
  let answer;
  transport(() => new Promise((resolve) => { answer = () => resolve(response('anthropic', [text('Done')])); }));
  const turn = view.handleUserMessage('Q', null);
  while (!answer) await tick();
  assert.equal(requests, 1);
  assert.equal(locks[0].released, false);
  answer();
  await turn;
  await tick();
  assert.equal(locks[0].released, true);
});

test('Stop lets the screen sleep again while the stopped request is still out', async () => {
  const { view } = chatSetup('anthropic');
  let started = false;
  transport(() => { started = true; return new Promise(() => {}); });
  void view.handleUserMessage('Q', null);
  while (!started) await tick();
  assert.equal(locks[0].released, false);
  view.handleStop();
  await tick();
  assert.equal(locks[0].released, true);
});

// Errors the chat is shown, with their kind.
function recordErrors(view) {
  const errors = [];
  view.chatContainer.addError = (text, errorKind) => errors.push({ text, errorKind });
  return errors;
}

test('Stop before any answer text leaves a quiet "Stopped." note, also in the history', async () => {
  const { plugin, view } = chatSetup('anthropic');
  const errors = recordErrors(view);
  let started = false;
  transport(() => { started = true; return new Promise(() => {}); });
  void view.handleUserMessage('Q', null);
  while (!started) await tick();
  view.handleStop();
  assert.deepEqual(errors, [{ text: 'Stopped.', errorKind: 'stopped' }]);
  assert.deepEqual(plugin.chatHistory.at(-1), { type: 'error', text: 'Stopped.', errorKind: 'stopped' });
  // Stop again with nothing running: no second note.
  view.handleStop();
  assert.equal(errors.length, 1);
});

test('Stop after a tool step without text leaves no note', async () => {
  const { plugin, view } = chatSetup('anthropic');
  const errors = recordErrors(view);
  let sent = 0;
  transport(() => {
    sent++;
    if (sent === 1) return response('anthropic', [call('t1', 'no_such_tool', {})], 'tool_use');
    return new Promise(() => {});
  });
  void view.handleUserMessage('Q', null);
  while (sent < 2) await tick();
  view.handleStop();
  assert.deepEqual(errors, []);
  assert.equal(plugin.chatHistory.some((entry) => entry.errorKind === 'stopped'), false);
});

test('Stop after some of the answer was shown leaves no note', async () => {
  const { plugin, view } = chatSetup('anthropic');
  const errors = recordErrors(view);
  let sent = 0;
  transport(() => {
    sent++;
    if (sent === 1) return response('anthropic', [text('Looking.'), call('t1', 'no_such_tool', {})], 'tool_use');
    return new Promise(() => {});
  });
  void view.handleUserMessage('Q', null);
  while (sent < 2) await tick();
  view.handleStop();
  assert.deepEqual(errors, []);
  assert.equal(plugin.chatHistory.some((entry) => entry.errorKind === 'stopped'), false);
});
