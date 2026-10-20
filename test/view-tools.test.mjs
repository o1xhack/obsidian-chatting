// Images in tool results (view_image, view_canvas): how each provider gets
// them, what the chat view and saved chat get, the tools themselves and
// read_file's refusal of binary files. Node has no image decoding or
// <canvas>: fakes record what would be drawn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, transport, response, call, text, callbacks, chatFiles } from './harness.mjs';

const senders = { anthropic: api.sendAnthropicMessage, openai: api.sendOpenAIMessage, 'chatgpt-oauth': api.sendChatGPTOAuthMessage };

/** The data URL of the image in the last tool result of a request. */
function imageOf(provider, body) {
  if (provider === 'anthropic') {
    const result = body.messages.at(-1).content[0];
    assert.equal(result.type, 'tool_result');
    assert.equal(result.content[0].type, 'text');
    assert.match(result.content[0].text, /Pics\/cat\.png/);
    assert.equal(result.content[1].type, 'image');
    return `data:${result.content[1].source.media_type};base64,${result.content[1].source.data}`;
  }
  const output = body.input.filter(item => item.type === 'function_call_output').at(-1).output;
  assert.ok(Array.isArray(output), 'function_call_output.output is a content array');
  assert.equal(output[0].type, 'input_text');
  assert.match(output[0].text, /Pics\/cat\.png/);
  assert.equal(output[1].type, 'input_image');
  return output[1].image_url;
}

const catImage = { id: 'cat', fileName: 'cat.png', mediaType: 'image/png', data: 'cat-data', sizeBytes: 8 };
const toolImageHistory = () => [
  { role: 'user', content: 'What is in cat.png?' },
  { role: 'assistant', content: [call('look', 'view_image', { path: 'Pics/cat.png' })] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'look', content: 'Pics/cat.png', is_error: false, images: [catImage] }] },
];

// ─── Provider encoding ──────────────────────────────────────────────────────

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: a tool result's images are sent inside the result`, async () => {
    api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
    api.clearOpenAIState();
    const requests = transport((body, index) => response(provider, [text('A cat')], 'end_turn', index));
    await senders[provider](settings(provider), toolImageHistory(), [], 'System');
    assert.equal(imageOf(provider, requests[0]), 'data:image/png;base64,cat-data');
  });
}

test('Responses: results without images keep a plain string output', () => {
  const items = api.buildResponsesInput([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'plain' }] }], 'openai');
  assert.equal(items[0].output, 'plain');
});

test('The transcript names the images of a tool result', () => {
  const agent = new api.AgentLoop({}, settings('anthropic'));
  agent.importMessages(toolImageHistory());
  assert.match(agent.exportTranscript(), /\[Image: cat\.png\]/);
  assert.doesNotMatch(agent.exportTranscript(), /cat-data/);
});

// ─── Fake browser image APIs ────────────────────────────────────────────────

const R = api.canvasRender;

/** A 2D context that records every call; measureText is 8 px per character. */
function fakeContext() {
  const calls = [];
  const state = {};
  return new Proxy(state, {
    get(target, key) {
      if (key === 'calls') return calls;
      if (key === 'measureText') return value => ({ width: String(value).length * 8 });
      if (key in target) return target[key];
      return (...args) => { calls.push([key, ...args]); };
    },
    set(target, key, value) { target[key] = value; calls.push(['set', key, value]); return true; },
  });
}

/** Minimal PNG headers; the fake decoder reads their dimensions. */
const imageBytes = (width, height, padding = 0) => {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width); view.setUint32(20, height);
  return bytes.buffer;
};

const surfaces = [];
let closedBitmaps = 0;
globalThis.createImageBitmap = async (blob, options) => {
  const bytes = await blob.arrayBuffer();
  if (bytes.byteLength < 24) throw new Error('cannot decode');
  const view = new DataView(bytes);
  return { width: options?.resizeWidth ?? view.getUint32(16), height: options?.resizeHeight ?? view.getUint32(20), close() { closedBitmaps++; } };
};
// Obsidian's global createEl(); only <canvas> is used.
globalThis.createEl = tag => {
  assert.equal(tag, 'canvas');
  const ctx = fakeContext();
  const surface = {
    width: 0, height: 0, ctx,
    getContext: type => type === '2d' ? ctx : null,
    toBlob(callback, type) { callback(new Blob([`${type} ${surface.width}x${surface.height}`])); },
  };
  surfaces.push(surface);
  return surface;
};

// ─── Vault ──────────────────────────────────────────────────────────────────

const BOARD = JSON.stringify({
  nodes: [
    { id: 'group1', type: 'group', label: 'Ideas', x: -20, y: -20, width: 600, height: 300, color: '1' },
    { id: 'aaaa1111bbbb2222', type: 'text', text: '## Alpha **idea**\n- with [[Beta|a link]] and `code`', x: 0, y: 0, width: 250, height: 100, color: '4' },
    { id: 'aaaa2222cccc3333', type: 'file', file: 'Pics/cat.png', x: 300, y: 0, width: 250, height: 200 },
    { id: 'c', type: 'link', url: 'https://example.com', x: 2800, y: 0, width: 400, height: 400, color: '#ABC' },
    { id: 'd', type: 'file', file: 'Notes/Beta.md', subpath: '#Plan', x: 800, y: 600, width: 300, height: 100 },
  ],
  edges: [
    { id: 'e1', fromNode: 'aaaa1111bbbb2222', fromSide: 'right', toNode: 'aaaa2222cccc3333', toSide: 'left', label: 'leads to' },
    { id: 'e2', fromNode: 'aaaa2222cccc3333', toNode: 'c', fromEnd: 'arrow', toEnd: 'none' },
    { id: 'e3', fromNode: 'c', toNode: 'missing' },
  ],
});

function imageVault() {
  const text = new Map([['Notes/Beta.md', '# Beta'], ['Board.canvas', BOARD], ['Pics/logo.svg', '<svg/>']]);
  const binary = new Map([
    ['Pics/cat.png', imageBytes(100, 80)],
    ['Pics/photo.jpg', imageBytes(4000, 3000)],
    ['Pics/wide.gif', imageBytes(3000, 100)],
    ['Pics/old.bmp', imageBytes(10, 10)],
  ]);
  const has = path => text.has(path) || binary.has(path);
  const fileOf = path => ({ path, extension: path.slice(path.lastIndexOf('.') + 1) });
  const app = {
    workspace: { getActiveFile: () => null },
    vault: {
      configDir: '.obsidian', adapter: { append: async () => {} },
      getName: () => 'Test vault',
      getFiles: () => [...text.keys(), ...binary.keys()].map(fileOf),
      getMarkdownFiles: () => [...text.keys()].filter(p => p.endsWith('.md')).map(fileOf),
      getFileByPath: path => has(path) ? fileOf(path) : null,
      getFolderByPath: () => null,
      cachedRead: async file => { assert.ok(text.has(file.path), `cachedRead of binary ${file.path}`); return text.get(file.path); },
      readBinary: async file => binary.get(file.path),
    },
  };
  return { app, text, binary };
}

const run = (app, name, input) => api.executeTool(app, name, input, async () => 'yes');
const base64 = buffer => Buffer.from(buffer).toString('base64');

// ─── The agent loop, the chat view and saving ───────────────────────────────

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: a view_image result reaches the model, survives a reload, and stays out of the chat view`, async () => {
    api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
    api.clearOpenAIState();
    const { app, binary } = imageVault();
    const expected = `data:image/png;base64,${base64(binary.get('Pics/cat.png'))}`;
    transport((body, index) => {
      if (index === 0) return response(provider, [call('look', 'view_image', { path: 'Pics/cat.png' })], 'tool_use', index);
      assert.equal(imageOf(provider, body), expected);
      return response(provider, [text('A cat')], 'end_turn', index);
    });
    const shown = [];
    const cb = callbacks({ onToolResult(name, result) { shown.push(result); } });
    const agent = new api.AgentLoop(app, settings(provider));
    await agent.run('What is in cat.png?', cb);
    assert.deepEqual(cb.errors, []);
    assert.deepEqual(cb.texts, ['A cat']);

    // The chat view gets text and a marker, never the image data.
    assert.equal(shown.length, 1);
    assert.equal(shown[0].images, undefined);
    assert.match(shown[0].result, /\[1 image prepared for the model\]$/);

    // The saved chat holds the image once: in the agent history only.
    const { adapter, writes } = chatFiles();
    app.vault.adapter = adapter;
    const plugin = new api.ChatPlugin();
    plugin.app = app;
    plugin.agent = agent;
    await plugin.loadChatHistory();
    plugin.chatHistory.push({ type: 'tool-result', toolName: 'view_image', toolInput: {}, toolResult: shown[0] });
    await plugin.saveChatHistory();
    const data = base64(binary.get('Pics/cat.png'));
    assert.equal(writes.length, 1);
    assert.equal(JSON.stringify(writes[0]).split(data).length - 1, 1);

    // A restored history sends the image again.
    const restored = new api.AgentLoop(app, settings(provider));
    restored.importMessages(writes[0].conversations[0].agentMessages);
    const requests = transport(() => response(provider, [text('Still a cat')]));
    await restored.run('And now?', callbacks());
    assert.equal(imageOf(provider, { ...requests[0], messages: requests[0].messages?.slice(0, 3) }), expected);
  });
}

// ─── view_image ─────────────────────────────────────────────────────────────

test('view_image sends a small image unchanged with its sizes', async () => {
  const { app, binary } = imageVault();
  const result = await run(app, 'view_image', { path: 'Pics/cat.png' });
  assert.equal(result.isError, false);
  assert.equal(result.result, 'Pics/cat.png (100×80, 24 B), sent unchanged.');
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mediaType, 'image/png');
  assert.equal(result.images[0].fileName, 'cat.png');
  assert.equal(result.images[0].data, base64(binary.get('Pics/cat.png')));
});

test('view_image scales a large photo down to 2048 px as JPEG; GIFs are sent unchanged', async () => {
  const { app } = imageVault();
  const before = closedBitmaps;
  const result = await run(app, 'view_image', { path: 'Pics/photo.jpg' });
  assert.equal(result.isError, false);
  assert.match(result.result, /^Pics\/photo\.jpg \(4000×3000, 24 B\), sent as 2048×1536, JPEG, \d+ B\.$/);
  assert.equal(result.images[0].mediaType, 'image/jpeg');
  assert.equal(Buffer.from(result.images[0].data, 'base64').toString(), 'image/jpeg 2048x1536');
  assert.equal(surfaces.at(-1).ctx.calls.filter(([name]) => name === 'drawImage').length, 1);
  assert.equal(closedBitmaps, before + 1);
  // GIFs are never re-encoded (that would drop the animation).
  const gif = await run(app, 'view_image', { path: 'Pics/wide.gif' });
  assert.match(gif.result, /sent unchanged/);
});

test('view_image rejects other formats, canvases and missing files with a hint', async () => {
  const { app } = imageVault();
  const bmp = await run(app, 'view_image', { path: 'Pics/old.bmp' });
  assert.equal(bmp.isError, true);
  assert.match(bmp.result, /not a PNG, JPEG, GIF or WebP image\. Other formats/);
  assert.match((await run(app, 'view_image', { path: 'Pics/logo.svg' })).result, /SVG is text: use read_file/);
  assert.match((await run(app, 'view_image', { path: 'Board.canvas' })).result, /Use view_canvas/);
  const missing = await run(app, 'view_image', { path: 'Pics/none.png' });
  assert.deepEqual(missing, { result: 'File not found: Pics/none.png', isError: true });
});

// ─── view_canvas ────────────────────────────────────────────────────────────

const board = () => JSON.parse(BOARD);

test('canvas layout fits all nodes into 1600 px with padding', () => {
  const layout = R.canvasLayout(board());
  // Content spans x -20..3200 and y -20..700, plus 40 padding each side.
  assert.deepEqual(layout.view, { x: -60, y: -60, width: 3300, height: 800 });
  assert.equal(layout.width, 1600);
  assert.equal(layout.height, Math.round(800 * 1600 / 3300));
  assert.equal(layout.scale, 1600 / 3300);
  assert.deepEqual(layout.visible.map(n => n.id), ['group1', 'aaaa1111bbbb2222', 'aaaa2222cccc3333', 'c', 'd']);
  // A tiny canvas is enlarged at most 2×.
  const small = R.canvasLayout({ nodes: [{ id: 'x', type: 'text', text: 'hi', x: 0, y: 0, width: 100, height: 50 }], edges: [] });
  assert.equal(small.scale, 2);
  assert.deepEqual([small.width, small.height], [360, 260]);
  // An empty canvas still gives a picture.
  assert.equal(R.canvasLayout({ nodes: [], edges: [] }).visible.length, 0);
});

test('canvas layout zooms to a group and keeps only the nodes in view', () => {
  const layout = R.canvasLayout(board(), 'group1');
  assert.deepEqual(layout.view, { x: -60, y: -60, width: 680, height: 380 });
  // 1600 / 680 would enlarge more than 2×.
  assert.equal(layout.scale, 2);
  assert.deepEqual([layout.width, layout.height], [1360, 760]);
  assert.deepEqual(layout.visible.map(n => n.id), ['group1', 'aaaa1111bbbb2222', 'aaaa2222cccc3333']);
  assert.throws(() => R.canvasLayout(board(), 'nope'), /no node or group with id "nope"/);
});

test('edges connect the chosen sides with arrows per fromEnd/toEnd', () => {
  const nodes = new Map(board().nodes.map(n => [n.id, n]));
  const [e1, e2, e3] = board().edges;
  const g1 = R.edgeGeometry(e1, nodes);
  assert.deepEqual([g1.from, g1.to], [{ x: 250, y: 50 }, { x: 300, y: 100 }]);
  assert.deepEqual([g1.fromArrow, g1.toArrow], [false, true]);
  assert.ok(g1.c1.x > g1.from.x && g1.c2.x < g1.to.x, 'curve leaves right, enters from the left');
  const g2 = R.edgeGeometry(e2, nodes);
  assert.deepEqual([g2.fromSide, g2.toSide], ['right', 'left']);
  assert.deepEqual([g2.fromArrow, g2.toArrow], [true, false]);
  assert.equal(R.edgeGeometry(e3, nodes), null);
});

test('colours, short IDs, plain text and wrapping', () => {
  assert.equal(R.colorOf('1'), '#fb464c');
  assert.equal(R.colorOf('6'), '#a882ff');
  assert.equal(R.colorOf('#ABC'), '#aabbcc');
  assert.equal(R.colorOf('7'), undefined);
  assert.deepEqual([...R.shortIds([{ id: 'aaaa1111bbbb2222' }, { id: 'aaaa2222cccc3333' }, { id: 'c' }, { id: 'group123' }, { id: '0123456789abcdef' }])],
    [['0123456789abcdef', '0123'], ['aaaa1111bbbb2222', 'aaaa1'], ['aaaa2222cccc3333', 'aaaa2'], ['c', 'c'], ['group123', 'group123']]);
  assert.equal(R.plainText('## Alpha **idea**\n- with [[Beta|a link]] and `code`\n```\nx\n```'), 'Alpha idea\n• with a link and code\nx');
  const ctx = fakeContext();
  assert.deepEqual(R.wrapText(ctx, 'one two three four', 80, 5), ['one two', 'three four']);
  assert.deepEqual(R.wrapText(ctx, 'one two three four five six', 80, 2), ['one two', 'three fou…']);
  assert.deepEqual(R.wrapText(ctx, 'abcdefghijklmnop', 40, 5), ['abcde', 'fghij', 'klmno', 'p']);
});

test('canvas previews stop wrapping after the visible lines, even for a long unbroken word', () => {
  let measured = 0;
  const ctx = { measureText: value => { measured++; return { width: value.length * 8 }; } };
  const lines = R.wrapText(ctx, '字'.repeat(4000), 80, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /…$/);
  assert.ok(measured < 200, `Only visible lines need layout; measured ${measured} times`);
});

test('the renderer draws groups, cards, images, edges and tags', async () => {
  const loaded = [];
  const { surface, legend, layout } = await R.renderCanvas(board(), {
    createSurface: (width, height) => ({ width, height, ctx: fakeContext(), getContext() { return this.ctx; } }),
    loadImage: async path => { loaded.push(path); return { width: 400, height: 200 }; },
    focus: 'group1',
  });
  const calls = surface.ctx.calls;
  const texts = calls.filter(([name]) => name === 'fillText').map(([, value]) => value);
  assert.deepEqual([surface.width, surface.height], [layout.width, layout.height]);
  // Group label, card text, edge label and tags.
  for (const expected of ['Ideas', 'Alpha idea', '• with a link and code', 'leads to', 'group1', 'aaaa1', 'aaaa2']) {
    assert.ok(texts.includes(expected), `draws "${expected}"`);
  }
  // Nodes outside the focused group aren't drawn or loaded.
  assert.ok(!texts.some(value => String(value).includes('example.com')));
  assert.deepEqual(loaded, ['Pics/cat.png']);
  const image = calls.find(([name]) => name === 'drawImage');
  assert.deepEqual(image.slice(2), [300, 37.5, 250, 125]);
  // The edge label sits at the curve's middle; e1 ends in one arrowhead (a filled triangle).
  const geometry = R.edgeGeometry(board().edges[0], new Map(board().nodes.map(n => [n.id, n])));
  assert.deepEqual(calls.find(([name, value]) => name === 'fillText' && value === 'leads to').slice(2), [geometry.mid.x, geometry.mid.y]);
  assert.equal(calls.filter(([name]) => name === 'bezierCurveTo').length, 2);
  assert.ok(calls.some(([name, key, value]) => name === 'set' && key === 'strokeStyle' && value === '#fb464c'), 'group preset colour');
  assert.ok(calls.some(([name, key, value]) => name === 'set' && key === 'strokeStyle' && value === '#44cf6e'), 'card preset colour');
  assert.match(legend, /zoomed to group group1; 3 of 5 node\(s\) in view/);
  assert.match(legend, /- aaaa1 \[aaaa1111bbbb2222\]: text "Alpha idea • with a link and code"/);
  assert.match(legend, /- aaaa2 \[aaaa2222cccc3333\]: file Pics\/cat\.png/);
  assert.match(legend, /- group1: group "Ideas"/);
});

test('view_canvas returns a PNG and the legend; bad focus and paths are errors', async () => {
  const { app } = imageVault();
  const result = await run(app, 'view_canvas', { path: 'Board.canvas' });
  assert.equal(result.isError, false);
  assert.match(result.result, /^Picture of Board\.canvas: 1600×388 px \(all 5 node\(s\), 2 edge\(s\), scale 0\.48\)/);
  assert.match(result.result, /Text is small at this scale: call view_canvas again with focus/);
  assert.match(result.result, /- c: link https:\/\/example\.com/);
  assert.match(result.result, /- d: file Notes\/Beta\.md#Plan/);
  assert.equal(result.images[0].mediaType, 'image/png');
  assert.equal(result.images[0].fileName, 'Board.canvas.png');
  assert.equal(Buffer.from(result.images[0].data, 'base64').toString(), 'image/png 1600x388');
  // The image node was drawn from the vault (the note file node isn't an image).
  assert.equal(surfaces.at(-1).ctx.calls.filter(([name]) => name === 'drawImage').length, 1);

  // focus takes a full ID or the short tag from the picture.
  const byTag = await run(app, 'view_canvas', { path: 'Board.canvas', focus: 'aaaa2' });
  assert.match(byTag.result, /zoomed to file aaaa2222cccc3333/);

  const bad = await run(app, 'view_canvas', { path: 'Board.canvas', focus: 'nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.result, /No node or group with id "nope"/);
  assert.match((await run(app, 'view_canvas', { path: 'Notes/Beta.md' })).result, /is not a canvas/);
});

// ─── Older tool images left out of requests ─────────────────────────────────

// Three turns: the first with an attached image and a view_canvas image,
// the second with a view_image image.
function imageHistory() {
  const picture = (id, fileName) => ({ id, fileName, mediaType: 'image/png', data: `${id}-data`, sizeBytes: 1 });
  return [
    { role: 'user', content: [{ type: 'image', image: picture('attached', 'photo.png') }, text('Look at this and the board')], turnId: 't1' },
    { role: 'assistant', content: [call('canvas', 'view_canvas', { path: 'Board.canvas' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'canvas', content: 'Board.canvas', is_error: false, images: [picture('board', 'Board.png')] }] },
    { role: 'assistant', content: [text('A board')] },
    { role: 'user', content: 'Now the cat', turnId: 't2' },
    { role: 'assistant', content: [call('cat', 'view_image', { path: 'Pics/cat.png' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'cat', content: 'Pics/cat.png', is_error: false, images: [picture('cat', 'cat.png')] }] },
    { role: 'assistant', content: [text('A cat')] },
    { role: 'user', content: 'Compare them', turnId: 't3' },
  ];
}

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: tool images older than the last 2 turns are left out of the request; attached images stay`, async () => {
    api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
    api.clearOpenAIState();
    const history = imageHistory();
    const saved = JSON.stringify(history);
    const requests = transport((body, index) => response(provider, [text('Done')], 'end_turn', index));
    await senders[provider](settings(provider), history, [], 'System');
    const note = 'Board.canvas\n\n[image from view_canvas omitted to save context]';
    const body = requests[0];
    if (provider === 'anthropic') {
      assert.equal(body.messages[0].content[0].source.data, 'attached-data');
      assert.deepEqual(body.messages[2].content, [{ type: 'tool_result', tool_use_id: 'canvas', content: note, is_error: false }]);
      assert.equal(body.messages[6].content[0].content[1].source.data, 'cat-data');
    } else {
      assert.equal(body.input[0].content[0].image_url, 'data:image/png;base64,attached-data');
      const outputs = body.input.filter(item => item.type === 'function_call_output').map(item => item.output);
      assert.equal(outputs[0], note);
      assert.equal(outputs[1][1].image_url, 'data:image/png;base64,cat-data');
    }
    // The history itself (saved, edited, regenerated) keeps every image.
    assert.equal(JSON.stringify(history), saved);
  });
}

test('Tool images: fewer than 3 turns keep all; several images and unknown tools get one note', () => {
  const history = imageHistory();
  assert.equal(api.withoutOldToolImages(history.slice(0, 8))[2], history[2]);
  const many = [...history];
  many[2] = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'gone', content: '', images: history[2].content[0].images.concat(history[6].content[0].images) }] };
  assert.deepEqual(api.withoutOldToolImages(many)[2].content, [{ type: 'tool_result', tool_use_id: 'gone', content: '[2 images from a tool omitted to save context]' }]);
  // Later messages are the same objects.
  assert.equal(api.withoutOldToolImages(many)[6], many[6]);
});


test('Tool images: one long turn is bounded by image count and actual payload bytes', () => {
  const picture = (id, data) => ({ id, fileName: `${id}.png`, mediaType: 'image/png', data, sizeBytes: 1 });
  const history = [
    { role: 'user', content: [{ type: 'image', image: picture('attached', 'user-data') }, text('Inspect')], turnId: 'long' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `v${i}`, content: `image ${i}`, images: [picture(`tool-${i}`, 'abcd')] }] })),
  ];
  const original = JSON.stringify(history);
  const sent = api.withoutOldToolImages(history);
  const retained = sent.flatMap(m => typeof m.content === 'string' ? [] : m.content.flatMap(b => b.images ?? []));
  assert.deepEqual(retained.map(i => i.id), ['tool-16', 'tool-17', 'tool-18', 'tool-19']);
  assert.match(sent[1].content[0].content, /omitted to save context/);
  assert.equal(sent[0], history[0]);
  assert.equal(JSON.stringify(history), original);
  // A saved sizeBytes value cannot bypass the cap; use base64 payload length.
  const data = 'A'.repeat(4 * 1024 * 1024); // 3 MiB per image, despite sizeBytes=1.
  const big = [{ role: 'user', content: 'Inspect', turnId: 'big' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'all', images: Array.from({ length: 5 }, (_, i) => picture(`big-${i}`, data)) }] }];
  const block = api.withoutOldToolImages(big)[1].content[0];
  assert.deepEqual(block.images.map(i => i.id), ['big-2', 'big-3', 'big-4']);
  assert.match(block.content, /2 images.*omitted/);
  assert.equal(big[1].content[0].images.length, 5);
});


test('view_canvas rejects oversized source bytes and pixel dimensions before bitmap decode', async () => {
  const { app, binary } = imageVault();
  let decoded = 0;
  const original = globalThis.createImageBitmap;
  globalThis.createImageBitmap = async (...args) => { decoded++; return original(...args); };
  try {
    binary.set('Pics/cat.png', imageBytes(8000, 6000));
    const hugePixels = await run(app, 'view_canvas', { path: 'Board.canvas' });
    assert.equal(hugePixels.isError, false);
    assert.equal(decoded, 0);
    assert.match(hugePixels.result, /Image preview omitted.*cat\.png/);
    binary.set('Pics/cat.png', imageBytes(100, 80, 10 * 1024 * 1024));
    await run(app, 'view_canvas', { path: 'Board.canvas' });
    assert.equal(decoded, 0);
    // A headerless source must not bypass the pixel check.
    binary.set('Pics/cat.png', new Uint8Array([1,2,3]).buffer);
    await run(app, 'view_canvas', { path: 'Board.canvas' });
    assert.equal(decoded, 0);
    // Normal images still decode and draw once.
    binary.set('Pics/cat.png', imageBytes(100, 80));
    await run(app, 'view_canvas', { path: 'Board.canvas' });
    assert.equal(decoded, 1);
  } finally { globalThis.createImageBitmap = original; }
});


test('Canvas raster header bounds cover JPEG, GIF and every WebP encoding', () => {
  const dims = bytes => api.imagePreview.rasterDimensions(Uint8Array.from(bytes).buffer);
  assert.deepEqual(dims([255,216,255,224,0,4,1,2,255,192,0,8,8,0,80,0,100,1]), {width:100,height:80});
  assert.equal(dims([255,216,255,224,0,0]), null);
  assert.equal(dims([255,216,255,192,0,30,8,0,80,0,100]), null);
  assert.deepEqual(dims([...Buffer.from('GIF89a'),100,0,80,0]), {width:100,height:80});
  const webp = (type, body) => [...Buffer.from('RIFF'),body.length+12,0,0,0,...Buffer.from('WEBP'+type),body.length,0,0,0,...body];
  assert.deepEqual(dims(webp('VP8X',[0,0,0,0,99,0,0,79,0,0])), {width:100,height:80});
  const bits = 99 | (79 << 14);
  assert.deepEqual(dims(webp('VP8L',[0x2f,bits&255,(bits>>>8)&255,(bits>>>16)&255,(bits>>>24)&255])), {width:100,height:80});
  assert.deepEqual(dims(webp('VP8 ',[0,0,0,0x9d,1,0x2a,100,0,80,0])), {width:100,height:80});
  assert.equal(dims(webp('VP8X',[0,0,0,0,99])), null);
  assert.equal(api.imagePreview.canvasImageWithinBudget(imageBytes(0,80)), false);
  assert.equal(api.imagePreview.canvasImageWithinBudget(imageBytes(1,9000)), false);
  assert.equal(api.imagePreview.canvasImageWithinBudget(imageBytes(2048,2048)), true);
});

test('Canvas source byte cap uses file metadata before reading the file', async () => {
  const {app} = imageVault();
  const get = app.vault.getFileByPath;
  app.vault.getFileByPath = path => ({...get(path),stat:{size:11*1024*1024}});
  app.vault.readBinary = async () => {throw Error('must not read the oversized file');};
  const result = await run(app,'view_canvas',{path:'Board.canvas'});
  assert.equal(result.isError,false);
  assert.match(result.result,/Image preview omitted/);
});

test('Agent bounds retained and persisted tool images within one long multi-call turn', async () => {
  const {app}=imageVault();
  const agent=new api.AgentLoop(app,settings('anthropic'));
  const cb=callbacks();
  transport((body,index)=> index===0
    ? response('anthropic',Array.from({length:12},(_,i)=>call(`v${i}`,'view_image',{path:'Pics/cat.png'})),'tool_use')
    : response('anthropic',[text('Done')]));
  await agent.run('Inspect repeatedly',cb,null,[catImage]);
  assert.deepEqual(cb.errors,[]);
  const saved=agent.exportMessages();
  const blocks=saved.flatMap(m=>typeof m.content==='string'?[]:m.content);
  assert.equal(blocks.filter(b=>b.type==='tool_result').length,12,'all tool pairs stay');
  assert.equal(blocks.flatMap(b=>b.images??[]).length,4,'older tool pixels do not accumulate in memory or saved state');
  assert.equal(blocks.find(b=>b.type==='image').image.id,'cat','user attachment stays');
  assert.match(blocks.find(b=>b.tool_use_id==='v0').content,/omitted to save context/);
  assert.equal(blocks.find(b=>b.tool_use_id==='v11').images.length,1,'later batch results are retained after pruning');
  // Age the remaining tool images out without altering the imported source.
  const snapshot=JSON.stringify(saved);
  const restored=new api.AgentLoop(app,settings('anthropic'));restored.importMessages([...saved,{role:'user',content:'Second'},{role:'assistant',content:[text('OK')]},{role:'user',content:'Third'}]);
  assert.equal(restored.exportMessages().flatMap(m=>typeof m.content==='string'?[]:m.content.flatMap(b=>b.images??[])).length,0);
  assert.equal(JSON.stringify(saved),snapshot);
});

test('view_image requests a bounded decode for a 48MP image and never retries at full size', async () => {
  const {app,binary}=imageVault();binary.set('Pics/photo.jpg',imageBytes(8000,6000));
  const original=globalThis.createImageBitmap;const options=[];
  globalThis.createImageBitmap=async(blob,opts)=>{options.push(opts);return {width:opts?.resizeWidth??8000,height:opts?.resizeHeight??6000,close(){}};};
  try {
    const viewed=await run(app,'view_image',{path:'Pics/photo.jpg'});
    assert.equal(viewed.isError,false);
    assert.deepEqual(options,[{resizeWidth:2048,resizeHeight:1536,resizeQuality:'high'}]);
    options.length=0;globalThis.createImageBitmap=async(blob,opts)=>{options.push(opts);throw Error('resize unavailable');};
    assert.equal((await run(app,'view_image',{path:'Pics/photo.jpg'})).isError,true);
    assert.equal(options.length,1);assert.equal(options[0].resizeWidth,2048);
  }finally{globalThis.createImageBitmap=original;}
});


test('JPEG EXIF rotation is included in preflight dimensions for resized decoding', () => {
  const tiff=[73,73,42,0,8,0,0,0,1,0,0x12,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0];
  const jpeg=Uint8Array.from([255,216,255,225,0,tiff.length+8,...Buffer.from('Exif\0\0'),...tiff,255,192,0,8,8,0,80,0,100,1]).buffer;
  assert.deepEqual(api.imagePreview.rasterDimensions(jpeg),{width:80,height:100});
});

test('view_image refuses oversized source bytes before reading and never decodes GIFs', async () => {
  const {app}=imageVault();const get=app.vault.getFileByPath;
  app.vault.getFileByPath=path=>({...get(path),stat:{size:21*1024*1024}});
  app.vault.readBinary=async()=>{throw Error('must not read the oversized source');};
  assert.match((await run(app,'view_image',{path:'Pics/photo.jpg'})).result,/20 MiB/);
  const normal=imageVault();const original=globalThis.createImageBitmap;let calls=0;
  globalThis.createImageBitmap=async()=>{calls++;throw Error('must not decode a GIF');};
  try{assert.equal((await run(normal.app,'view_image',{path:'Pics/wide.gif'})).isError,false);assert.equal(calls,0);}
  finally{globalThis.createImageBitmap=original;}
});

test('view_canvas reports actual embedded image reads and delivers their folder rules with pixels', async () => {
  const { app, text: notes } = imageVault();
  notes.set('Pics/AGENTS.md', 'Use private pictures only for this request.');
  const result = await run(app, 'view_canvas', { path: 'Board.canvas' });
  assert.ok(result.instructionPaths.includes('Pics/cat.png'));
  assert.ok(!result.instructionPaths.includes('Notes/Beta.md'));
  const loop = new api.AgentLoop(app, settings('anthropic'));
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('canvas', 'view_canvas', { path: 'Board.canvas' })], 'tool_use')
    : response('anthropic', [text('Done')], 'end_turn', index));
  await loop.run('Describe the board', callbacks());
  const sent = JSON.stringify(requests[1]);
  assert.match(sent, /Use private pictures only for this request/);
  assert.match(sent, /base64/);
  assert.doesNotMatch(sent, /instructionPaths|instructionSources/);
  const focused = await run(app, 'view_canvas', { path: 'Board.canvas', focus: 'c' });
  assert.deepEqual(focused.instructionPaths, ['Board.canvas']);
});
