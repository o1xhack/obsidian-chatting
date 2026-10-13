// AGENTS.md: the vault root's file in the system prompt, a folder's file
// with the first tool result touching that folder, once per conversation
// (found again by the history).
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, text, call, response, transport, vaultApp, callbacks } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
});

function loopWith(files) {
  const vault = vaultApp();
  for (const [path, content] of Object.entries(files)) vault.files.set(path, content);
  return { ...vault, loop: new api.AgentLoop(vault.app, settings('anthropic')) };
}

const systemText = body => typeof body.system === 'string' ? body.system : body.system.map(block => block.text).join('');
const toolResults = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result') : []);
const resultText = block => typeof block.content === 'string' ? block.content : block.content.map(c => c.text ?? '').join('');

test('The root AGENTS.md is in the system prompt; without it the prompt is the built-in one', async () => {
  const { loop, files } = loopWith({ 'AGENTS.md': 'Write in British English.\nDates as YYYY-MM-DD.' });
  const requests = transport(() => response('anthropic', [text('ok')]));
  await loop.run('Hi', callbacks());
  assert.match(systemText(requests[0]), /You are Chatting with AI,[\s\S]*This vault's instructions \(AGENTS\.md\)[\s\S]*Write in British English\.\nDates as YYYY-MM-DD\./);
  assert.match(loop.exportTranscript(), /Write in British English\./);

  files.delete('AGENTS.md');
  await loop.run('Again', callbacks());
  assert.doesNotMatch(systemText(requests[1]), /This vault's instructions/);
  assert.match(systemText(requests[1]), /You are Chatting with AI,/);
});

test('A long root AGENTS.md is cut after 32,768 characters', async () => {
  const { loop } = loopWith({ 'AGENTS.md': 'a'.repeat(40000) });
  const requests = transport(() => response('anthropic', [text('ok')]));
  await loop.run('Hi', callbacks());
  const system = systemText(requests[0]);
  assert.ok(system.endsWith(`\n\n${'a'.repeat(32768)}\n(cut after 32768 characters)`));
  assert.ok(!system.includes('a'.repeat(32769)));
});

test('A folder\'s AGENTS.md comes with the first result touching it, outer folders first, once per conversation; again after a cut', async () => {
  const { loop } = loopWith({
    'Work/AGENTS.md': 'Work notes: keep a Status line.',
    'Work/Sub/AGENTS.md': 'Sub notes: in German.',
    'Work/Sub/Plan.md': 'Plan',
    'Home/Garden.md': 'Garden',
  });
  const requests = transport((body, index) => {
    if (index === 0) return response('anthropic', [call('r1', 'read_document', { path: 'Work/Sub/Plan.md' }), call('r2', 'read_document', { path: 'Home/Garden.md' })], 'tool_use');
    if (index === 2) return response('anthropic', [call('r3', 'read_document', { path: 'Work/Sub/Plan.md' })], 'tool_use', index);
    return response('anthropic', [text(`A${index}`)], 'end_turn', index);
  });
  await loop.run('Read the plan and the garden', callbacks(), null, [], 'turn-1');
  const [plan, garden] = toolResults(requests[1]);
  assert.match(resultText(plan), /^[\s\S]*Plan\n\n\[Instructions for files in Work\/, from Work\/AGENTS\.md[\s\S]*keep a Status line[\s\S]*Instructions for files in Work\/Sub\/, from Work\/Sub\/AGENTS\.md[\s\S]*in German.$/);
  assert.doesNotMatch(resultText(garden), /Instructions for files/);

  // The next turn reads the same note: the instructions aren't repeated.
  await loop.run('Read it again', callbacks());
  const again = toolResults(requests[3]).at(-1);
  assert.equal(resultText(again).includes('Instructions for files'), false);

  // Editing the first message cuts the turn that had them: they come again.
  transport((body, index) => index === 0
    ? response('anthropic', [call('r4', 'read_document', { path: 'Work/Sub/Plan.md' })], 'tool_use')
    : response('anthropic', [text('done')], 'end_turn', index));
  loop.cutBeforeTurn('turn-1');
  await loop.run('Read the plan', callbacks());
  const results = toolResults({ messages: loop.exportMessages() });
  assert.equal(results.length, 1);
  assert.match(results[0].content, /from Work\/AGENTS\.md[\s\S]*from Work\/Sub\/AGENTS\.md/);
});

test('Tools on the active note (no path) count for its folder', () => {
  const app = { workspace: { getActiveFile: () => ({ path: 'Work/Plan.md' }) } };
  assert.deepEqual(api.instructions.toolPaths(app, 'read_document', {}), ['Work/Plan.md']);
  assert.deepEqual(api.instructions.toolPaths(app, 'get_links', {}), ['Work/Plan.md']);
  assert.deepEqual(api.instructions.toolPaths(app, 'search_vault', { query: 'x' }), []);
  assert.deepEqual(api.instructions.toolPaths(app, 'rename_file', { path: 'A/x.md', new_path: 'B/x.md' }), ['A/x.md', 'B/x.md']);
});

// A settings row that records its name, description and button.
function row() {
  const r = { setName(name) { r.name = name; return r; }, setDesc(desc) { r.desc = desc; return r; } };
  r.addButton = fn => { const b = { setButtonText(t) { r.button = t; return b; }, onClick(f) { r.click = f; return b; } }; fn(b); return r; };
  return r;
}

test('Settings: Vault instructions creates AGENTS.md with a short comment, then opens it; in both settings paths', async () => {
  const { app, files } = vaultApp();
  const opened = [];
  app.workspace.getLeaf = () => ({ openFile: async file => { opened.push(file.path); } });
  const plugin = { settings: settings('anthropic') };
  const tab = new api.ChatSettingTab(app, plugin);
  let redraws = 0;
  tab.update = tab.display = () => { redraws++; };

  // Obsidian 1.13+: a definition of its own. No file yet: Create.
  const r = row();
  tab.getSettingDefinitions().find(d => d.name === 'Vault instructions').render(r);
  assert.equal(r.name, 'Vault instructions');
  assert.equal(r.button, 'Create');
  assert.match(r.desc, /There is none yet/);
  await r.click();
  assert.match(files.get('AGENTS.md'), /^<!-- Instructions for AI assistants working in this vault \(Chatting with AI and other tools that read AGENTS\.md\)/);
  assert.deepEqual(opened, ['AGENTS.md']);
  assert.equal(redraws, 1);

  // Drawn again, the file is there: Open, and it isn't created twice.
  const again = row();
  tab.getSettingDefinitions().find(d => d.name === 'Vault instructions').render(again);
  assert.equal(again.button, 'Open');
  await again.click();
  assert.deepEqual(opened, ['AGENTS.md', 'AGENTS.md']);

  // Older Obsidian: display() draws it (the other rows are left out here).
  const drawn = [];
  const ignore = () => {};
  delete tab.display;
  Object.assign(tab, { containerEl: { empty: ignore }, renderProvider: ignore, renderApiKeySection: ignore, renderModelSection: ignore,
    renderWebSearch: ignore, renderEnterSends: ignore, renderFollowEdits: ignore, renderSkills: ignore, renderMaxIterations: ignore, renderChats: ignore, renderMcpServers: ignore, renderVoice: ignore, renderDebugLog: ignore, loadCatalog: async () => {}, renderInstructions: setting => drawn.push(setting) });
  tab.display();
  assert.equal(drawn.length, 1);
});
