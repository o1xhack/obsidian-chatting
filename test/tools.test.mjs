// Vault tools through the real executor: every offered tool has a handler,
// the date for daily notes, set_properties and its input checks and how
// read_file and read_document refuse binary files. Also how a selection
// scope reaches the model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api, callbacks, response, settings, text, transport, vaultApp } from './harness.mjs';

const run = (app, name, input = {}) => api.executeTool(app, name, input, async () => 'yes');

test('Every tool offered to the model has a handler in the executor', async () => {
  const names = api.TOOL_DEFINITIONS.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length);
  // A fake vault without files: each tool fails its own way, never as unknown.
  const app = { workspace: { getActiveFile: () => null }, vault: { getFileByPath: () => null, getAbstractFileByPath: () => null } };
  for (const name of names) {
    const result = await api.executeTool(app, name, {}, async () => '');
    assert.doesNotMatch(result.result, /^Unknown tool/, name);
  }
  assert.match((await api.executeTool(app, 'not_a_tool', {}, async () => '')).result, /^Unknown tool: not_a_tool/);
});

test('get_current_datetime gives the local date, not the UTC one, near midnight', async () => {
  const RealDate = globalThis.Date;
  const zone = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  // 23:30 on 5 October in Los Angeles is already 6 October in UTC.
  const instant = RealDate.parse('2026-10-06T06:30:00Z');
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  };
  try {
    const result = await run({}, 'get_current_datetime');
    assert.equal(result.isError, false);
    assert.match(result.result, /\nDate: 2026-10-05$/);
    assert.match(result.result, /ISO: 2026-10-06T06:30:00\.000Z/);
  } finally {
    globalThis.Date = RealDate;
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
});

test('A multi-line selection is quoted line by line', async () => {
  const requests = transport(() => response('anthropic', [text('OK')]));
  const agent = new api.AgentLoop(vaultApp().app, settings('anthropic'));
  await agent.run('Shorten this', callbacks(), { text: 'First line\nSecond line\r\n\nFourth', filePath: 'Notes/Draft.md' });
  const sent = requests[0].messages[0].content;
  assert.match(sent, /Selected text:\n> First line\n> Second line\n> \n> Fourth\n\nShorten this$/);
});

// A note with frontmatter `properties`, edited through processFrontMatter.
function propertiesVault(properties = {}) {
  const frontmatter = { ...properties };
  let edits = 0;
  const app = {
    workspace: { getActiveFile: () => null },
    // The note's text stands in as its properties (set_properties reads it before and after).
    vault: { getFileByPath: path => (path === 'Note.md' ? { path } : null), cachedRead: async () => JSON.stringify(frontmatter) },
    fileManager: { processFrontMatter: async (file, fn) => { edits++; fn(frontmatter); } },
  };
  return { app, frontmatter, edits: () => edits };
}

test('set_properties refuses a list or a missing object and leaves the note alone', async () => {
  for (const properties of [['tag'], 'tag: x', undefined, null]) {
    const { app, frontmatter, edits } = propertiesVault({ keep: 1 });
    const result = await run(app, 'set_properties', { path: 'Note.md', properties });
    assert.equal(result.isError, true, JSON.stringify(properties));
    assert.match(result.result, /must be an object/);
    assert.equal(edits(), 0);
    assert.deepEqual(frontmatter, { keep: 1 });
  }
});

test('set_properties sets and removes keys through processFrontMatter, on the path or the active note', async () => {
  const { app, frontmatter } = propertiesVault({ status: 'draft', old: 'x', keep: 1 });
  const result = await run(app, 'set_properties', { path: 'Note.md', properties: { status: 'done', tags: ['a', 'b'], old: null } });
  assert.equal(result.isError, false);
  assert.deepEqual(frontmatter, { status: 'done', tags: ['a', 'b'], keep: 1 });
  assert.equal(result.result, 'Updated properties in Note.md. Set: status, tags. Removed: old.');

  assert.match((await run(app, 'set_properties', { path: 'Missing.md', properties: { a: 1 } })).result, /File not found: Missing\.md/);
  assert.match((await run(app, 'set_properties', { properties: { a: 1 } })).result, /No active document open/);
  app.workspace.getActiveFile = () => ({ path: 'Note.md' });
  await run(app, 'set_properties', { properties: { status: 'active' } });
  assert.equal(frontmatter.status, 'active');
});

test('read_file and read_document refuse images and binary files, read text and SVG; read_file attaches a PDF', async () => {
  const textFiles = new Map([['Notes/Beta.md', '# Beta'], ['Pics/logo.svg', '<svg/>'], ['Data/notes.txt', 'plain']]);
  const binary = ['Pics/cat.png', 'Pics/Photo.JPG', 'Pics/old.bmp', 'Docs/manual.pdf', 'Data/app.sqlite', 'Audio/memo.m4a'];
  const binaryReads = [];
  const app = {
    workspace: { getActiveFile: () => null },
    vault: {
      getFileByPath: path => (textFiles.has(path) || binary.includes(path) ? { path, extension: path.slice(path.lastIndexOf('.') + 1) } : null),
      cachedRead: async file => { if (!textFiles.has(file.path)) binaryReads.push(file.path); return textFiles.get(file.path); },
      readBinary: async () => new TextEncoder().encode('%PDF').buffer,
    },
  };
  for (const tool of ['read_file', 'read_document']) {
    for (const path of ['Pics/cat.png', 'Pics/Photo.JPG', 'Pics/old.bmp']) {
      const result = await run(app, tool, { path });
      assert.equal(result.isError, true, path);
      assert.match(result.result, new RegExp(`is an image; ${tool} reads text only\\. Use view_image to look at it\\.$`));
    }
    for (const path of ['Data/app.sqlite', 'Audio/memo.m4a']) {
      const result = await run(app, tool, { path });
      assert.equal(result.isError, true, path);
      assert.match(result.result, new RegExp(`is a binary file; ${tool} reads text only\\.`));
    }
  }
  // read_document points to read_file, which attaches a PDF or Office file.
  const refused = await run(app, 'read_document', { path: 'Docs/manual.pdf' });
  assert.equal(refused.isError, true);
  assert.match(refused.result, /PDF or Office file; read_document reads text only\. Use read_file/);
  for (const [path, content] of textFiles) {
    assert.deepEqual(await run(app, 'read_file', { path }), { result: content, isError: false });
    assert.deepEqual(await run(app, 'read_document', { path }), { result: `# ${path}\n\n${content}`, isError: false });
  }
  assert.deepEqual(binaryReads, []);
  // A PDF goes to the model as a file (files.test.mjs has the details).
  const pdf = await run(app, 'read_file', { path: 'Docs/manual.pdf' });
  assert.equal(pdf.isError, false);
  assert.equal(pdf.files[0].fileName, 'manual.pdf');
});
