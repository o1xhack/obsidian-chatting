// Canvas tools (read_canvas, edit_canvas, canvas search) against the real executor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const askUser = async () => 'yes';

// Formatted like Obsidian writes canvases: tabs, one node or edge per line.
const BOARD = [
  '{',
  '\t"nodes":[',
  '\t\t{"id":"group1","type":"group","x":-20,"y":-20,"width":600,"height":300,"label":"Ideas","styleAttributes":{}}',
  '\t\t{"id":"a","type":"text","text":"Alpha idea\\nwith two lines","x":0,"y":0,"width":250,"height":60,"color":"4"}',
  '\t\t{"id":"b","type":"file","file":"Notes/Beta.md","subpath":"#Plan","x":300,"y":0,"width":250,"height":200}',
  '\t\t{"id":"c","type":"link","url":"https://example.com","x":800,"y":0,"width":400,"height":400}',
  '\t],',
  '\t"edges":[',
  '\t\t{"id":"e1","fromNode":"a","fromSide":"right","toNode":"b","toSide":"left","label":"leads to","custom":true}',
  '\t\t{"id":"e2","fromNode":"b","toNode":"c","fromEnd":"arrow"}',
  '\t],',
  '\t"metadata":{"version":"1.0"}',
  '}',
].join('\n').replace(/\}\n\t\t\{/g, '},\n\t\t{');

function canvasVault(extra = {}) {
  const files = new Map([
    ['Board.canvas', BOARD],
    ['Notes/Beta.md', '# Beta\nThe plan for beta.'],
    ['Notes/Gamma.md', 'Nothing about canvases.'],
    ...Object.entries(extra),
  ]);
  const fileOf = path => ({ path, extension: path.split('.').pop() });
  const app = {
    workspace: { getActiveFile: () => null },
    vault: {
      getFiles: () => [...files.keys()].map(fileOf),
      getMarkdownFiles: () => [...files.keys()].filter(p => p.endsWith('.md')).map(fileOf),
      getFileByPath: path => files.has(path) ? fileOf(path) : null,
      cachedRead: async file => files.get(file.path),
      process: async (file, fn) => { files.set(file.path, fn(files.get(file.path))); },
      modify: async (file, content) => { files.set(file.path, content); },
    },
  };
  return { app, files };
}

const run = (app, name, input) => api.executeTool(app, name, input, askUser);
const edit = (app, operations, path = 'Board.canvas') => run(app, 'edit_canvas', { path, operations });
const board = files => JSON.parse(files.get('Board.canvas'));
const node = (files, id) => board(files).nodes.find(n => n.id === id);
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const newIds = text => [...text.matchAll(/(?:node|edge) ([0-9a-f]{16})/g)].map(m => m[1]);

test('read_canvas lists groups with their nodes, ungrouped nodes, then edges', async () => {
  const { app } = canvasVault();
  const { result, isError } = await run(app, 'read_canvas', { path: 'Board.canvas' });
  assert.equal(isError, false);
  assert.equal(result, [
    'Board.canvas: 4 node(s), 2 edge(s). Positions are the top-left x,y; sizes are width×height.',
    '',
    '[group1] group "Ideas" at -20,-20 size 600×300',
    '  - [a] text "Alpha idea\\nwith two lines" at 0,0 size 250×60, color 4',
    '  - [b] file Notes/Beta.md#Plan at 300,0 size 250×200',
    '',
    'Not in a group:',
    '  - [c] link https://example.com at 800,0 size 400×400',
    '',
    'Edges:',
    '  - [e1] a → b: leads to',
    '  - [e2] b ↔ c',
  ].join('\n'));
});

test('read_canvas shortens long text and rejects non-canvas paths', async () => {
  const long = JSON.stringify({ nodes: [{ id: 'x', type: 'text', text: 'word '.repeat(100), x: 0, y: 0, width: 250, height: 60 }], edges: [] });
  const { app } = canvasVault({ 'Long.canvas': long, 'Empty.canvas': '' });
  assert.match((await run(app, 'read_canvas', { path: 'Long.canvas' })).result, /… \(\+300 chars; read_file shows all\)/);
  assert.match((await run(app, 'read_canvas', { path: 'Empty.canvas' })).result, /The canvas is empty/);
  const wrong = await run(app, 'read_canvas', { path: 'Notes/Beta.md' });
  assert.equal(wrong.isError, true);
  assert.match(wrong.result, /not a canvas.*read_document/);
});

test('edit_canvas writes Obsidian formatting and keeps unknown fields', async () => {
  const { app, files } = canvasVault();
  const { result, isError } = await edit(app, [{ op: 'add_node', type: 'text', text: 'New', x: 0, y: 500 }]);
  assert.equal(isError, false, result);
  const [id] = newIds(result);
  assert.match(id, /^[0-9a-f]{16}$/);
  const written = files.get('Board.canvas');
  assert.equal(written, BOARD.replace(
    '"height":400}\n\t],',
    `"height":400},\n\t\t{"id":"${id}","type":"text","text":"New","x":0,"y":500,"width":250,"height":60}\n\t],`,
  ));
  const data = board(files);
  assert.deepEqual(data.metadata, { version: '1.0' });
  assert.deepEqual(data.nodes[0].styleAttributes, {});
  assert.equal(data.edges[0].custom, true);
});

test('add_node next to a node slides past others instead of overlapping', async () => {
  const blocker = { id: 'blk', type: 'text', text: 'In the way', x: 900, y: 1000, width: 250, height: 100 };
  const canvas = { nodes: [{ id: 'a', type: 'text', text: 'A', x: 600, y: 1000, width: 250, height: 60 }, blocker], edges: [] };
  const { app, files } = canvasVault({ 'Board.canvas': JSON.stringify(canvas) });
  const { result } = await edit(app, [
    { op: 'add_node', type: 'text', text: 'Right of A', near: 'a', ref: 'r' },
    { op: 'add_node', type: 'file', file: 'Notes/Beta.md', near: 'a', side: 'bottom' },
  ]);
  const [right, below] = newIds(result).map(id => node(files, id));
  assert.equal(right.x, 600 + 250 + 40);
  assert.equal(right.y, 1000 + 100 + 40, 'slid below the blocker');
  // Directly below A would cover the first new node and the blocker, so it slides right past both.
  assert.deepEqual([below.x, below.y, below.width, below.height], [900 + 250 + 40, 1100, 400, 400]);
  const nodes = board(files).nodes;
  for (const n of nodes) for (const m of nodes) if (n !== m) assert.equal(overlaps(n, m), false, `${n.id} overlaps ${m.id}`);
});

test('add_node into a group grows the group; placing next to a grouped node keeps it in the group', async () => {
  const { app, files } = canvasVault();
  const { result, isError } = await edit(app, [
    { op: 'add_node', type: 'text', text: 'Third idea', group: 'group1' },
    { op: 'add_node', type: 'link', url: 'https://example.org', near: 'b', side: 'bottom' },
  ]);
  assert.equal(isError, false, result);
  assert.match(result, /grew group group1/);
  const group = node(files, 'group1');
  const [inside, belowB] = newIds(result).map(id => node(files, id));
  for (const n of [inside, belowB]) {
    assert.ok(n.x >= group.x && n.y >= group.y && n.x + n.width <= group.x + group.width && n.y + n.height <= group.y + group.height, `${n.id} is inside the group`);
  }
  const others = board(files).nodes.filter(n => n.type !== 'group');
  for (const n of others) for (const m of others) if (n !== m) assert.equal(overlaps(n, m), false, `${n.id} overlaps ${m.id}`);
  assert.equal(board(files).nodes[0].id, 'group1', 'groups stay at the bottom of the z-order');
  assert.match((await run(app, 'read_canvas', { path: 'Board.canvas' })).result, /\[group1\][^\n]*\n(  - [^\n]*\n){4}\nNot in a group/);
});

test('add_node and add_edge in one call link up via ref, with facing sides', async () => {
  const { app, files } = canvasVault();
  const { result, isError } = await edit(app, [
    { op: 'add_node', type: 'text', text: 'Below A', near: 'a', side: 'bottom', ref: 'new' },
    { op: 'add_edge', fromNode: 'a', toNode: 'new', label: 'then', ref: 'edge' },
    { op: 'update_edge', id: 'edge', color: '2' },
  ]);
  assert.equal(isError, false, result);
  const [nodeId, edgeId] = newIds(result);
  const edge = board(files).edges.find(e => e.id === edgeId);
  assert.deepEqual(edge, { id: edgeId, fromNode: 'a', fromSide: 'bottom', toNode: nodeId, toSide: 'top', label: 'then', color: '2' });
});

test('update_node changes content, color and size, and checks the field fits the type', async () => {
  const { app, files } = canvasVault();
  const ok = await edit(app, [
    { op: 'update_node', id: 'a', text: 'Changed', color: '', width: 300 },
    { op: 'update_node', id: 'b', subpath: '' },
    { op: 'update_node', id: 'group1', label: 'Renamed' },
    { op: 'update_node', id: 'c', url: 'https://example.net', color: '#ff0000' },
  ]);
  assert.equal(ok.isError, false, ok.result);
  assert.deepEqual(node(files, 'a'), { id: 'a', type: 'text', text: 'Changed', x: 0, y: 0, width: 300, height: 60 });
  assert.equal(node(files, 'b').subpath, undefined);
  assert.equal(node(files, 'group1').label, 'Renamed');
  assert.equal(node(files, 'c').color, '#ff0000');
  const before = files.get('Board.canvas');
  const wrong = await edit(app, [{ op: 'update_node', id: 'c', text: 'Links have no text' }]);
  assert.equal(wrong.isError, true);
  assert.match(wrong.result, /'text' only applies to text nodes/);
  assert.equal(files.get('Board.canvas'), before);
});

test('move_node moves a node, and a group together with the nodes inside it', async () => {
  const { app, files } = canvasVault();
  assert.equal((await edit(app, [{ op: 'move_node', id: 'c', y: 500 }])).isError, false);
  assert.deepEqual([node(files, 'c').x, node(files, 'c').y], [800, 500]);
  const { result } = await edit(app, [{ op: 'move_node', id: 'group1', x: 1000, y: 1000 }]);
  assert.match(result, /with the 2 node\(s\) inside it/);
  assert.deepEqual([node(files, 'a').x, node(files, 'a').y], [1020, 1020]);
  assert.deepEqual([node(files, 'b').x, node(files, 'b').y], [1320, 1020]);
  await edit(app, [{ op: 'move_node', id: 'c', group: 'group1' }]);
  const group = node(files, 'group1'), c = node(files, 'c');
  assert.ok(c.x >= group.x && c.y + c.height <= group.y + group.height);
});

test('remove_node removes its edges; remove_edge removes one edge', async () => {
  const { app, files } = canvasVault();
  const { result } = await edit(app, [{ op: 'remove_node', id: 'b' }]);
  assert.match(result, /Removed node b and its 2 edge\(s\)/);
  assert.deepEqual(board(files).edges, []);
  assert.equal(node(files, 'b'), undefined);

  const second = canvasVault();
  await edit(second.app, [{ op: 'update_edge', id: 'e1', label: '', toEnd: 'none' }, { op: 'remove_edge', id: 'e2' }]);
  assert.deepEqual(board(second.files).edges, [{ id: 'e1', fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left', custom: true, toEnd: 'none' }]);
});

test('invalid operations are rejected without writing anything', async () => {
  const cases = [
    [{ op: 'add_node', type: 'text', text: 'ok' }, { op: 'add_edge', fromNode: 'a', toNode: 'missing' }],
    [{ op: 'add_node', type: 'file', file: 'Notes/Nope.md' }],
    [{ op: 'remove_node', id: 'nope' }],
    [{ op: 'update_edge', id: 'e1', fromNode: 'nope' }],
    [{ op: 'add_node', type: 'text', text: 'x', color: 'blue' }],
    [{ op: 'move_node', id: 'a', group: 'b' }],
    [{ op: 'explode' }],
  ];
  for (const operations of cases) {
    const { app, files } = canvasVault();
    const { result, isError } = await edit(app, operations);
    assert.equal(isError, true, JSON.stringify(operations));
    assert.match(result, /^No changes made to Board\.canvas\. Operation \d/);
    assert.equal(files.get('Board.canvas'), BOARD);
  }
  const { app, files } = canvasVault({ 'Broken.canvas': '{"nodes": [' });
  assert.equal((await edit(app, [{ op: 'remove_node', id: 'a' }], 'Broken.canvas')).isError, true);
  assert.equal(files.get('Broken.canvas'), '{"nodes": [');
  assert.equal((await edit(app, [], 'Board.canvas')).isError, true);
  assert.match((await edit(app, [{ op: 'remove_node', id: 'a' }], 'Notes/Beta.md')).result, /not a canvas/);
});

test('search_vault finds canvas card text, group labels and edge labels', async () => {
  const { app } = canvasVault();
  const search = query => run(app, 'search_vault', { query, searchContent: true });
  assert.match((await search('alpha')).result, /- Board\.canvas \(node a\): \.\.\.Alpha idea with two lines\.\.\./);
  assert.match((await search('ideas')).result, /- Board\.canvas \(group group1\): \.\.\.Ideas\.\.\./);
  assert.match((await search('leads')).result, /- Board\.canvas \(edge e1\): \.\.\.leads to\.\.\./);
  assert.match((await search('plan')).result, /^Found 1 result\(s\):\n- Notes\/Beta\.md: /, 'canvas JSON (subpath "#Plan") is not searched');
  assert.match((await run(app, 'search_vault', { query: 'board' })).result, /- Board\.canvas/);
  assert.equal((await run(app, 'search_vault', { query: 'i', searchContent: true, limit: 2 })).result.split('\n').length, 3);
});

test('read_file and edit_document still work on canvases', async () => {
  const { app, files } = canvasVault();
  assert.equal((await run(app, 'read_file', { path: 'Board.canvas' })).result, BOARD);
  const { isError } = await run(app, 'edit_document', { path: 'Board.canvas', operation: 'find_replace', find: 'leads to', content: 'causes' });
  assert.equal(isError, false);
  assert.equal(board(files).edges[0].label, 'causes');
});

test('With a selection in a canvas, edit_canvas refuses that canvas; other canvases stay editable', async () => {
  const { app, files } = canvasVault({ 'Other.canvas': '{"nodes":[],"edges":[]}' });
  const scope = { filePath: 'Board.canvas', text: 'Alpha idea' };
  const refused = await api.executeTool(app, 'edit_canvas', { path: 'Board.canvas', operations: [{ op: 'remove_node', id: 'a' }] }, askUser, scope);
  assert.equal(refused.isError, true);
  assert.match(refused.result, /^Not changed:/);
  assert.equal(files.get('Board.canvas'), BOARD);
  const other = await api.executeTool(app, 'edit_canvas', { path: 'Other.canvas', operations: [{ op: 'add_node', type: 'text', text: 'ok' }] }, askUser, scope);
  assert.equal(other.isError, false, other.result);
});
