// query_notes and list_metadata against a fake metadata cache: tag and
// property filters, sorting, limits, and the vault's tags and properties.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const NOTES = {
  'Work/Alpha.md': { tags: ['#project/alpha'], frontmatter: { status: 'active', due: '2026-11-01', owner: '[[Ana]]' }, mtime: 3 },
  'Work/Beta.md': { tags: [], frontmatter: { tags: ['project', 'urgent'], status: 'Done', due: '2026-10-15' }, mtime: 2 },
  'Work/Gamma.md': { tags: ['#project'], frontmatter: { status: 'active', people: ['Ana', 'Ben'] }, mtime: 5 },
  'Home/Garden.md': { tags: ['#idea'], frontmatter: { status: 'active', due: '2026-10-01' }, mtime: 1 },
  'Inbox.md': { tags: ['#projects'], frontmatter: undefined, mtime: 4 },
};

function metadataApp() {
  const files = Object.entries(NOTES).map(([path, note]) => ({ path, extension: 'md', stat: { mtime: note.mtime } }));
  return {
    vault: { getMarkdownFiles: () => files },
    metadataCache: {
      getFileCache: file => {
        const note = NOTES[file.path];
        return { tags: note.tags.map(tag => ({ tag })), ...(note.frontmatter ? { frontmatter: { ...note.frontmatter, position: {} } } : {}) };
      },
    },
  };
}

const query = input => api.executeTool(metadataApp(), 'query_notes', input, async () => '');
const paths = result => result.result.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2).split(' (')[0]);

test('query_notes: a tag matches itself and nested tags, from the body and the frontmatter, not a longer tag', async () => {
  assert.deepEqual(paths(await query({ tags: ['project'] })), ['Work/Alpha.md', 'Work/Beta.md', 'Work/Gamma.md']);
  assert.deepEqual(paths(await query({ tags: ['#project', 'urgent'] })), ['Work/Beta.md']);
  assert.deepEqual(paths(await query({ tags: ['urgent', 'idea'], match: 'any' })), ['Home/Garden.md', 'Work/Beta.md']);
});

test('query_notes: properties by value (any case, in lists, links by name) or only set; folder', async () => {
  assert.deepEqual(paths(await query({ properties: { status: 'ACTIVE' } })), ['Home/Garden.md', 'Work/Alpha.md', 'Work/Gamma.md']);
  assert.deepEqual(paths(await query({ properties: { people: 'ben' } })), ['Work/Gamma.md']);
  assert.deepEqual(paths(await query({ properties: { owner: 'Ana' } })), ['Work/Alpha.md']);
  assert.deepEqual(paths(await query({ properties: { due: null }, folder: 'Work' })), ['Work/Alpha.md', 'Work/Beta.md']);
  assert.deepEqual(paths(await query({ tags: ['project'], properties: { status: 'active' } })), ['Work/Alpha.md', 'Work/Gamma.md']);
});

test('query_notes: sorted by a property (missing last) or by modification; shows tags and the asked properties; limit', async () => {
  const byDue = await query({ properties: { status: 'active' }, sort_by: 'due' });
  assert.deepEqual(paths(byDue), ['Home/Garden.md', 'Work/Alpha.md', 'Work/Gamma.md']);
  assert.match(byDue.result, /- Work\/Alpha\.md \(tags: #project\/alpha; status: active; due: 2026-11-01\)/);
  assert.deepEqual(paths(await query({ folder: 'Work', sort_by: 'modified' })), ['Work/Gamma.md', 'Work/Alpha.md', 'Work/Beta.md']);

  const limited = await query({ folder: 'Work', limit: 2 });
  assert.equal(paths(limited).length, 2);
  assert.match(limited.result, /Showing 2 of 3 notes/);
});

test('query_notes: no filter is an error; no match says so', async () => {
  const empty = await query({});
  assert.equal(empty.isError, true);
  assert.match(empty.result, /list_metadata/);
  assert.deepEqual(await query({ tags: ['missing'] }), { result: 'No notes match.', isError: false });
});

test('list_metadata: tags and properties with counts, most used first, without Obsidian\'s position', async () => {
  const { result, isError } = await api.executeTool(metadataApp(), 'list_metadata', {}, async () => '');
  assert.equal(isError, false);
  const [tags, properties] = result.split('\n\n');
  assert.match(tags, /^Tags:\n- #project \(2\)\n/);
  assert.match(tags, /- #projects \(1\)/);
  assert.match(properties, /^Properties:\n- status \(4\), e\.g\. active\n- due \(3\), e\.g\. 2026-11-01/);
  assert.doesNotMatch(properties, /position/);

  const work = await api.executeTool(metadataApp(), 'list_metadata', { folder: 'Home' }, async () => '');
  assert.match(work.result, /^Tags:\n- #idea \(1\)\n\nProperties:/);
});

test('Labels: the filters in words', () => {
  const label = api.toolLabels.toolLabel;
  assert.equal(label('query_notes', { tags: ['project', '#urgent'], properties: { status: 'active', due: null }, folder: 'Work' }, 'done'),
    'Found notes tagged #project #urgent, status active, with due in Work');
  assert.equal(label('query_notes', { tags: ['a', 'b'], match: 'any' }, 'running'), 'Finding notes tagged #a or #b…');
  assert.equal(label('query_notes', {}, 'error'), 'Finding notes failed');
  assert.equal(label('list_metadata', {}, 'done'), 'Listed the tags and properties of the vault');
});
