// Images in tool results (view_image, view_canvas): how each provider gets
// them, what the chat view and saved chat get, the tools themselves and
// read_file's refusal of binary files. Node has no image decoding or
// <canvas>: fakes record what would be drawn.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, settings, transport, response, call, text, callbacks } from './harness.mjs';

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

/** Fake image bytes: the decoder reads the size from the text, e.g. "IMG 4000x3000". */
const imageBytes = (width, height, padding = 0) => new TextEncoder().encode(`IMG ${width}x${height}${' '.repeat(padding)}`).buffer;

const surfaces = [];
let closedBitmaps = 0;
globalThis.createImageBitmap = async blob => {
  const match = /IMG (\d+)x(\d+)/.exec(await blob.text());
  if (!match) throw new Error('cannot decode');
  return { width: Number(match[1]), height: Number(match[2]), close() { closedBitmaps++; } };
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
    assert.match(shown[0].result, /\[1 image sent to the model\]$/);

    // The saved chat holds the image once: in the agent history only.
    const writes = [];
    app.vault.adapter = { read: async () => { throw new Error('ENOENT'); }, exists: async () => false, write: async (path, data) => { if (path.endsWith('/chat-state.json')) writes.push(data); } };
    const plugin = new api.ChatPlugin();
    plugin.app = app;
    plugin.agent = agent;
    await plugin.loadChatHistory();
    plugin.chatHistory.push({ type: 'tool-result', toolName: 'view_image', toolInput: {}, toolResult: shown[0] });
    await plugin.saveChatHistory();
    const data = base64(binary.get('Pics/cat.png'));
    assert.equal(writes.length, 1);
    assert.equal(writes[0].split(data).length - 1, 1);

    // A restored history sends the image again.
    const restored = new api.AgentLoop(app, settings(provider));
    restored.importMessages(JSON.parse(writes[0]).conversations[0].agentMessages);
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
  assert.equal(result.result, 'Pics/cat.png (100×80, 10 B), sent unchanged.');
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
  assert.match(result.result, /^Pics\/photo\.jpg \(4000×3000, 13 B\), sent as 2048×1536, JPEG, \d+ B\.$/);
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
