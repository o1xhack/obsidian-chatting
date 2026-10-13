// get_links against a fake metadata cache: linked mentions with their
// lines, unlinked mentions (name or alias, any case, not inside links or
// properties), outgoing links, and the earlier name get_backlinks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const TEXT = {
  'Garden.md': '---\naliases: [Veg patch]\n---\nSee [[Seeds]] and [[Compost]].',
  'Plan.md': 'Intro\nWork on the [[Garden#Beds|beds]] today.\nThen the garden shed.',
  'Diary.md': '---\ntopic: Garden\n---\nThe veg patch needs water.\nGardening is fun.\nGarden again.',
  'Seeds.md': 'Nothing here.',
};
// Offsets of the link in Plan.md and of the front matter in Diary.md.
const planLink = TEXT['Plan.md'].indexOf('[[Garden');
const diaryProps = TEXT['Diary.md'].indexOf('\nThe veg');
const CACHE = {
  'Garden.md': { frontmatter: { aliases: ['Veg patch'] } },
  'Plan.md': { links: [{ link: 'Garden#Beds', position: { start: { line: 1, offset: planLink }, end: { line: 1, offset: planLink + 21 } } }] },
  'Diary.md': { frontmatterPosition: { start: { line: 0, offset: 0 }, end: { line: 2, offset: diaryProps } } },
  'Seeds.md': {},
};

function linksApp() {
  const files = Object.keys(TEXT).map(path => ({ path, extension: 'md', basename: path.replace(/\.md$/, '') }));
  const byPath = path => files.find(file => file.path === path) ?? null;
  return {
    vault: { getMarkdownFiles: () => files, getFileByPath: byPath, cachedRead: async file => TEXT[file.path] },
    workspace: { getActiveFile: () => byPath('Garden.md') },
    metadataCache: {
      getFileCache: file => CACHE[file.path] ?? null,
      getFirstLinkpathDest: linkpath => byPath(`${linkpath}.md`),
      resolvedLinks: { 'Plan.md': { 'Garden.md': 1 }, 'Garden.md': { 'Seeds.md': 1 }, 'Diary.md': {} },
      unresolvedLinks: { 'Garden.md': { Compost: 1 } },
    },
  };
}

test('get_links: linked mentions with the line, unlinked mentions by name or alias, outgoing links', async () => {
  const { result, isError } = await api.executeTool(linksApp(), 'get_links', {}, async () => '');
  assert.equal(isError, false);
  assert.match(result, /Linked mentions \(1 note\):\n- Plan\.md \(1 link\)\n  > Work on the \[\[Garden#Beds\|beds\]\] today\./);
  // "garden shed" in Plan.md and "veg patch" and "Garden again" in Diary.md; not
  // "Gardening", not the link, not the property.
  assert.match(result, /Unlinked mentions \(2 notes; to link one, edit it to \[\[Garden\]\]\):/);
  assert.match(result, /- Diary\.md \(2 lines\)\n  > The veg patch needs water\.\n  > Garden again\./);
  assert.match(result, /- Plan\.md \(1 line\)\n  > Then the garden shed\./);
  assert.doesNotMatch(result, /Gardening|topic/);
  assert.match(result, /Outgoing links \(2\):\n- Seeds\.md\n- Compost \(no such note yet\)/);
});

test('get_links: a note nobody mentions; the earlier name still runs', async () => {
  const { result } = await api.executeTool(linksApp(), 'get_backlinks', { path: 'Diary.md' }, async () => '');
  assert.equal(api.toolLabels.toolLabel('get_backlinks', { path: 'Diary.md' }), 'Found links of Diary');
  assert.match(result, /Linked mentions: none\./);
  assert.match(result, /Unlinked mentions of "Diary": none\./);
  assert.match(result, /Outgoing links: none\./);
  const missing = await api.executeTool(linksApp(), 'get_links', { path: 'Nope.md' }, async () => '');
  assert.deepEqual(missing, { result: 'File not found: Nope.md', isError: true });
});
