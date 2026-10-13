// The chat view on phones: it lifts itself by the part of the view the
// on-screen keyboard covers (Obsidian doesn't shrink the sidebar for it).
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { api } from './harness.mjs';

afterEach(() => {
  delete globalThis.__isPhone;
  for (const name of ['ResizeObserver', 'MutationObserver', 'getComputedStyle', 'document', 'window']) delete globalThis[name];
});

// A chat view whose element ends at `screen.viewBottom` on a screen
// `screen.height` tall, with a keyboard `screen.keyboard` px high, as
// Obsidian reports it in --keyboard-height on <body>.
function phoneView(screen) {
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; this.observed = []; observers.push(this); }
    observe(el, options) { this.observed.push({ el, options }); }
    disconnect() { this.disconnected = true; }
  }
  const html = {}, body = {};
  globalThis.ResizeObserver = class extends Observer {};
  globalThis.MutationObserver = class extends Observer {};
  globalThis.document = { documentElement: html, body };
  globalThis.window = { get innerHeight() { return screen.height; } };
  globalThis.getComputedStyle = el => ({
    getPropertyValue: name => el === body && name === '--keyboard-height' ? ` ${screen.keyboard}px` : '',
  });
  const props = {};
  const cleanups = [];
  const view = new api.ObsidianChatView({}, {});
  view.contentEl = {
    getBoundingClientRect: () => ({ bottom: screen.viewBottom, height: screen.viewBottom - 50 }),
    style: { setProperty: (name, value) => { props[name] = value; } },
  };
  view.register = cleanup => cleanups.push(cleanup);
  view.followKeyboardOnPhone();
  // What Obsidian does when the keyboard opens or the view resizes.
  const changed = () => { for (const observer of observers) observer.callback([]); };
  return { view, observers, props, cleanups, changed, html, body };
}

test('On a phone the chat is lifted by the part of the view the keyboard covers', () => {
  globalThis.__isPhone = true;
  const screen = { height: 800, keyboard: 0, viewBottom: 760 };
  const { props, changed } = phoneView(screen);

  changed();
  assert.equal(props['--ochatting-lift'], '0px', 'no keyboard: no lift');

  // The keyboard covers 300px; below the view are 40px (the tab menu).
  screen.keyboard = 300;
  changed();
  assert.equal(props['--ochatting-lift'], '260px');

  // A view that ends above the keyboard isn't lifted.
  screen.viewBottom = 450;
  changed();
  assert.equal(props['--ochatting-lift'], '0px');

  screen.viewBottom = 760;
  screen.keyboard = 0;
  changed();
  assert.equal(props['--ochatting-lift'], '0px', 'keyboard closed again');
});

test('The lift follows the keyboard state on <html> and <body> and the view size; closing the view stops it', () => {
  globalThis.__isPhone = true;
  const { view, observers, cleanups, html, body } = phoneView({ height: 800, keyboard: 0, viewBottom: 760 });

  const [resize, keyboardState] = observers;
  assert.deepEqual(resize.observed.map(o => o.el), [view.contentEl]);
  assert.deepEqual(keyboardState.observed.map(o => o.el), [html, body]);
  for (const { options } of keyboardState.observed) {
    assert.deepEqual(options, { attributes: true, attributeFilter: ['style', 'class'] });
  }

  for (const cleanup of cleanups) cleanup();
  assert.ok(resize.disconnected && keyboardState.disconnected);
});

test('Desktop and tablets: nothing is measured', () => {
  const { observers, props } = phoneView({ height: 800, keyboard: 300, viewBottom: 760 });
  assert.equal(observers.length, 0);
  assert.deepEqual(props, {});
});
