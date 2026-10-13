// The one-line labels of tool steps: what the AI does or did, and with what.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { api } from './harness.mjs';

const { toolLabel, fileLabel } = api.toolLabels;

test('Labels name the note (file name without .md) and change with the state', () => {
  const input = { path: 'Projects/Kitchen Renovation.md', operation: 'find_replace' };
  assert.equal(toolLabel('edit_document', input, 'running'), 'Editing Kitchen Renovation…');
  assert.equal(toolLabel('edit_document', input, 'done'), 'Edited Kitchen Renovation');
  assert.equal(toolLabel('edit_document', input, 'error'), 'Editing Kitchen Renovation failed');
  assert.equal(toolLabel('read_document', {}, 'done'), 'Read the current note');
  assert.equal(toolLabel('read_file', { path: 'Ideas/App map.canvas' }), 'Read App map.canvas');
  assert.equal(toolLabel('get_links', { path: 'People/Ada.md' }, 'running'), 'Finding links of Ada…');
  assert.equal(toolLabel('view_image', { path: 'Pics/cat.png' }), 'Looked at cat.png');
  assert.equal(toolLabel('view_canvas', { path: 'Board.canvas' }, 'running'), 'Looking at Board.canvas…');
});

test('Searches, lists, renames, trash and unknown tools read naturally', () => {
  assert.equal(toolLabel('search_vault', { query: 'tiles' }), 'Searched for "tiles"');
  assert.equal(toolLabel('list_files', {}), 'Listed the vault');
  assert.equal(toolLabel('list_files', { path: 'Meetings/' }, 'running'), 'Listing Meetings…');
  assert.equal(toolLabel('rename_file', { path: 'A.md', new_path: 'Archive/B.md' }), 'Renamed A to B');
  assert.equal(toolLabel('delete_file', { path: 'Old.md' }), 'Moved to the trash: Old');
  assert.equal(toolLabel('get_current_datetime', {}), 'Checked the date');
  assert.equal(toolLabel('ask_user', { question: 'Which week?' }, 'running'), 'Asking a question…');
  assert.equal(toolLabel('some_new_tool', {}, 'running'), 'some new tool…');
  assert.equal(toolLabel('some_new_tool', {}, 'error'), 'some new tool failed');
  assert.equal(fileLabel('  '), 'the current note');
});

test('Every vault tool has its own label', () => {
  const tools = [
    'read_document', 'edit_document', 'search_vault', 'read_file', 'create_file', 'list_files', 'rename_file',
    'delete_file', 'get_properties', 'set_properties', 'get_links', 'get_current_datetime', 'open_document', 'ask_user',
    'query_notes', 'list_metadata',
    'read_canvas', 'edit_canvas',
    'read_web_page',
    'view_image', 'view_canvas',
    'use_skill',
  ];
  for (const name of tools) {
    assert.notEqual(toolLabel(name, {}), name.replace(/_/g, ' '), name);
  }
});
