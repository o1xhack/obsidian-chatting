// Skills: found in the skills folder, listed in the system prompt, loaded
// by use_skill or /name with their other files, offered after `/`.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, transport, response, text, call, callbacks } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
});

const { skills } = api;

const TEXT = {
  'Skills/meeting-notes/SKILL.md': '---\nname: meeting-notes\ndescription: Write meeting notes from a transcript.\n---\n\nUse the template.',
  'Skills/meeting-notes/template.md': '# Meeting',
  'Skills/meeting-notes/examples/one.md': 'Example',
  'Skills/Weekly review/SKILL.md': 'Go through the week.',
};
const PROPERTIES = {
  'Skills/meeting-notes/SKILL.md': { frontmatter: { name: 'meeting-notes', description: 'Write meeting notes from a transcript.' }, frontmatterPosition: { end: { offset: TEXT['Skills/meeting-notes/SKILL.md'].indexOf('\n\nUse') } } },
};

// A vault with the files above (and an empty skill folder), as far as skills and the loop use it.
function skillsApp() {
  const files = new Map();
  const folders = new Map();
  const folder = path => {
    if (!folders.has(path)) {
      const created = new api.TFolder(path);
      folders.set(path, created);
      const parent = path.includes('/') ? folder(path.slice(0, path.lastIndexOf('/'))) : null;
      parent?.children.push(created);
    }
    return folders.get(path);
  };
  for (const path of Object.keys(TEXT)) {
    const parent = folder(path.slice(0, path.lastIndexOf('/')));
    const file = Object.assign(new api.TFile(path), { parent });
    parent.children.push(file);
    files.set(path, file);
  }
  folder('Skills/empty');
  return {
    workspace: { getActiveFile: () => null },
    vault: {
      getName: () => 'Test vault',
      getMarkdownFiles: () => [...files.values()],
      getFolderByPath: path => folders.get(path) ?? null,
      getFileByPath: path => files.get(path) ?? null,
      cachedRead: async file => TEXT[file.path],
    },
    metadataCache: { getFileCache: file => PROPERTIES[file.path] ?? null, getFirstLinkpathDest: () => null },
  };
}

const systemText = body => typeof body.system === 'string' ? body.system : body.system.map(block => block.text).join('');
const resultText = block => typeof block.content === 'string' ? block.content : block.content.map(c => c.text ?? '').join('');

test('skills: each subfolder with a SKILL.md; the name from its properties, else the folder', () => {
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(found, [
    { name: 'meeting-notes', description: 'Write meeting notes from a transcript.', path: 'Skills/meeting-notes/SKILL.md' },
    { name: 'Weekly review', description: '', path: 'Skills/Weekly review/SKILL.md' },
  ]);
  assert.deepEqual(skills.findSkills(skillsApp(), 'Elsewhere'), []);
});

test('skills: the system prompt lists them after the built-in prompt and before AGENTS.md; none without skills', () => {
  const list = skills.skillsPrompt(skills.findSkills(skillsApp(), 'Skills'));
  assert.match(list, /call use_skill with its name/);
  assert.match(list, /- meeting-notes: Write meeting notes from a transcript\.\n- Weekly review: \(no description\)/);
  assert.equal(skills.skillsPrompt([]), null);
  const prompt = api.buildSystemPrompt('Be brief.', list);
  assert.ok(prompt.indexOf('## Skills') < prompt.indexOf('## This vault\'s instructions'));
  assert.doesNotMatch(api.buildSystemPrompt(null, null), /## Skills/);
});

test('A turn: the skills of the folder in the settings are in the system prompt and the transcript; use_skill loads from it', async () => {
  const app = skillsApp();
  const loop = new api.AgentLoop(app, { ...settings('anthropic'), skillsFolder: 'Skills' });
  const requests = transport((body, index) => index === 0
    ? response('anthropic', [call('s1', 'use_skill', { name: 'meeting-notes' })], 'tool_use')
    : response('anthropic', [text('done')], 'end_turn', index));
  const run = callbacks();
  await loop.run('Notes from this transcript, please', run);
  assert.match(systemText(requests[0]), /## Skills\n[\s\S]*- meeting-notes: Write meeting notes/);
  assert.match(loop.exportTranscript(), /- meeting-notes: Write meeting notes/);
  assert.deepEqual(run.executed, ['use_skill']);
  const result = requests[1].messages.at(-1).content.find(b => b.type === 'tool_result');
  assert.match(resultText(result), /^<skill name="meeting-notes"/);

  // Another folder in the settings: no skills, no Skills section.
  const elsewhere = new api.AgentLoop(app, { ...settings('anthropic'), skillsFolder: 'Elsewhere' });
  const more = transport(() => response('anthropic', [text('ok')]));
  await elsewhere.run('Hi', callbacks());
  assert.doesNotMatch(systemText(more[0]), /## Skills/);
});

test('use_skill: the instructions without properties and the skill\'s other files; an unknown name lists the skills', async () => {
  const loaded = await api.executeTool(skillsApp(), 'use_skill', { name: '/Meeting-Notes' }, async () => '', undefined, 'Skills');
  assert.equal(loaded.isError, false);
  assert.match(loaded.result, /^<skill name="meeting-notes" path="Skills\/meeting-notes\/SKILL\.md">\nUse the template\.\n<\/skill>/);
  assert.match(loaded.result, /other files.*:\n- Skills\/meeting-notes\/examples\/one\.md\n- Skills\/meeting-notes\/template\.md$/);
  assert.doesNotMatch(loaded.result, /description:/);
  const plain = await skills.useSkill(skillsApp(), 'Skills', { name: 'weekly review' });
  assert.equal(plain.result, '<skill name="Weekly review" path="Skills/Weekly review/SKILL.md">\nGo through the week.\n</skill>');
  const missing = await skills.useSkill(skillsApp(), 'Skills', { name: 'nope' });
  assert.deepEqual(missing, { result: 'No skill named "nope". Skills: meeting-notes, Weekly review.', isError: true });
  assert.equal(api.toolLabels.toolLabel('use_skill', { name: '/meeting-notes' }), 'Used the skill meeting-notes');
});

test('/name: invoked at the start or after a space, loaded along with the message', async () => {
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(skills.invokedSkills('/meeting-notes for today, see a/b and /nope', found).map(s => s.name), ['meeting-notes']);
  assert.deepEqual(skills.invokedSkills('and/meeting-notes', found), []);
  // A name with a space (the folder's), any case, punctuation after it; in the order named.
  assert.deepEqual(skills.invokedSkills('Do /weekly review. Then /Meeting-Notes!', found).map(s => s.name), ['Weekly review', 'meeting-notes']);
  assert.deepEqual(skills.invokedSkills('/meeting-notes-long and /meeting-notes2', found), []);
  const loaded = await skills.invokedSkillsText(skillsApp(), 'Skills', 'Please /meeting-notes');
  assert.match(loaded, /^\[Skills the user invoked with \/name; follow them for this request:\]\n<skill name="meeting-notes"/);
  assert.equal(await skills.invokedSkillsText(skillsApp(), 'Skills', 'no skill here'), null);
});

test('/ autocomplete: what is being typed after a slash, and the matching skills', () => {
  assert.deepEqual(skills.skillAt('/mee', 4), { start: 0, query: 'mee' });
  assert.deepEqual(skills.skillAt('hi /', 4), { start: 3, query: '' });
  assert.equal(skills.skillAt('a/b', 3), null);
  assert.equal(skills.skillAt('/done now', 9), null);
  const found = skills.findSkills(skillsApp(), 'Skills');
  assert.deepEqual(skills.skillCandidates(found, '').map(s => s.name), ['meeting-notes', 'Weekly review']);
  assert.deepEqual(skills.skillCandidates(found, 'wr').map(s => s.name), ['Weekly review']);
});

test('Sending /name from the chat: the skill goes to the model before the message; the chat shows the text only', async () => {
  const app = skillsApp();
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.settings = { ...settings('anthropic'), skillsFolder: 'Skills' };
  plugin.agent = new api.AgentLoop(app, plugin.settings);
  plugin.chatHistory = [];
  plugin.saveChatHistory = async () => {};
  const view = new api.ObsidianChatView({}, plugin);
  const shown = [];
  view.chatContainer = {
    addUserMessage(value) { shown.push(value); }, addAssistantMessage() {}, addToolCall() { return 0; }, updateToolResult() {},
    addError(value) { shown.push(value); }, showThinking() {}, hideThinking() {},
    setInputEnabled() {}, setBusy() {}, foldTurn() {}, focus() {}, cancelAskUser() {}, setTitle() {},
  };
  const requests = transport(() => response('anthropic', [text('ok')]));
  await view.handleUserMessage('/meeting-notes for the call', null);
  const sent = requests[0].messages.at(-1).content;
  assert.match(sent, /\[Skills the user invoked with \/name[\s\S]*Use the template\.\n<\/skill>[\s\S]*\n\n\/meeting-notes for the call$/);
  assert.deepEqual(shown, ['/meeting-notes for the call']);
  assert.equal(plugin.chatHistory[0].text, '/meeting-notes for the call');
});

// A settings row that records its name, description, text field and buttons.
function row() {
  const r = { buttons: {}, setName(name) { r.name = name; return r; }, setDesc(desc) { r.desc = desc; return r; } };
  r.addText = fn => {
    const t = { inputEl: { addEventListener(type, f) { r[type] = f; } }, setPlaceholder() { return t; }, setValue(v) { r.value = v; return t; }, onChange(f) { r.change = f; return t; } };
    fn(t);
    return r;
  };
  r.addButton = fn => { const b = { setButtonText(t) { b.text = t; return b; }, onClick(f) { r.buttons[b.text] = f; return b; } }; fn(b); return r; };
  r.addExtraButton = fn => { const b = { setIcon() { return b; }, setTooltip(t) { r.tooltip = t; return b; }, onClick(f) { r.open = f; return b; } }; fn(b); return r; };
  return r;
}

// The skills vault, where New skill can create folders and files and open them.
function settingsTab(skillsFolder) {
  const app = skillsApp();
  const made = new Map();
  const opened = [];
  Object.assign(app.vault, {
    getAbstractFileByPath: path => made.get(path) ?? app.vault.getFolderByPath(path) ?? app.vault.getFileByPath(path),
    createFolder: async path => { made.set(path, { path }); },
    create: async (path, content) => { assert.ok(!made.has(path)); made.set(path, { path, content }); return { path }; },
  });
  app.workspace.getLeaf = () => ({ openFile: async file => { opened.push(file.path); } });
  const plugin = { settings: { ...settings('anthropic'), skillsFolder }, saves: 0, async saveSettings() { plugin.saves++; } };
  const tab = new api.ChatSettingTab(app, plugin);
  const redraws = { count: 0 };
  tab.update = tab.display = () => { redraws.count++; };
  return { plugin, tab, made, opened, redraws };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('Settings (Obsidian 1.13+): the skills folder, a list of its skills each opening its SKILL.md, and New skill', async () => {
  const { plugin, tab, made, opened, redraws } = settingsTab('Skills');
  const definitions = tab.getSettingDefinitions();
  const at = definitions.findIndex(d => d.name === 'Skills');

  const folder = row();
  definitions[at].render(folder);
  assert.equal(folder.name, 'Skills');
  assert.equal(folder.value, 'Skills');
  await folder.change(' Work/Skills ');
  assert.equal(plugin.settings.skillsFolder, 'Work/Skills');
  await folder.change('  ');
  assert.equal(plugin.settings.skillsFolder, 'Skills');
  assert.equal(plugin.saves, 2);
  folder.blur();
  assert.equal(redraws.count, 1);

  const list = definitions[at + 1];
  assert.equal(list.type, 'list');
  assert.deepEqual(list.items.map(item => item.name), ['/meeting-notes', '/Weekly review']);
  const notes = row();
  list.items[0].render(notes);
  assert.equal(notes.desc, 'Write meeting notes from a transcript.');
  const weekly = row();
  list.items[1].render(weekly);
  assert.match(weekly.desc, /No description: the AI can't tell when to use it/);
  weekly.open();
  assert.deepEqual(opened, ['Skills/Weekly review/SKILL.md']);

  // New skill: a folder with a SKILL.md from the template, opened; the next one is numbered.
  list.addItem.action();
  await settle();
  list.addItem.action();
  await settle();
  assert.deepEqual([...made.keys()], ['Skills/new-skill', 'Skills/new-skill/SKILL.md', 'Skills/new-skill-2', 'Skills/new-skill-2/SKILL.md']);
  assert.match(made.get('Skills/new-skill/SKILL.md').content, /^---\nname: new-skill\ndescription: [^\n]+\n---\n/);
  assert.deepEqual(opened.slice(1), ['Skills/new-skill/SKILL.md', 'Skills/new-skill-2/SKILL.md']);
  assert.equal(redraws.count, 3);

  // A folder that isn't there yet: the list says so, New skill creates it.
  const empty = settingsTab('Elsewhere');
  const emptyList = empty.tab.getSettingDefinitions().find(d => d.type === 'list');
  assert.deepEqual(emptyList.items, []);
  assert.equal(emptyList.emptyState, 'No skills in Elsewhere/ yet.');
  emptyList.addItem.action();
  await settle();
  assert.deepEqual([...empty.made.keys()], ['Elsewhere', 'Elsewhere/new-skill', 'Elsewhere/new-skill/SKILL.md']);
});

test('Settings before Obsidian 1.13: display() draws the folder row, a row per skill and New skill', async () => {
  const { tab, made } = settingsTab('Skills');
  const newSkill = tab.renderNewSkill.bind(tab);
  // The other rows are left out here; they have their own tests.
  const drawn = [];
  const ignore = () => {};
  Object.assign(tab, { containerEl: { empty: ignore }, renderProvider: ignore, renderApiKeySection: ignore, renderModelSection: ignore,
    renderWebSearch: ignore, renderEnterSends: ignore, renderFollowEdits: ignore, renderInstructions: ignore, renderMaxIterations: ignore, renderMcpServers: ignore, renderDebugLog: ignore, loadCatalog: async () => {},
    renderSkillsFolder: () => drawn.push('folder'), renderSkill: (setting, skill) => drawn.push(skill.name), renderNewSkill: (setting, empty) => drawn.push(`new, empty: ${empty}`) });
  delete tab.display;
  tab.display();
  assert.deepEqual(drawn, ['folder', 'meeting-notes', 'Weekly review', 'new, empty: false']);

  // The New skill row: says when there are none; its button creates one.
  const r = row();
  newSkill(r, true);
  assert.equal(r.desc, 'No skills in Skills/ yet.');
  r.buttons['New skill']();
  await settle();
  assert.ok(made.has('Skills/new-skill/SKILL.md'));
});
