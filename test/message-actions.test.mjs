// Editing a message and continuing, copying and regenerating an answer:
// both histories cut at the same turn, through the real chat view with a
// fake Svelte component.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { api, settings, image, text, call, response, transport, vaultApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
});

// Records what the view shows, in place of ChatContainer.svelte (as in
// chat-view.test.mjs, plus turn IDs, selections and cutting).
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    askUser: null,
    busy: false,
    addUserMessage(value, images = [], turnId, selection) { chat.shown.push({ id: nextId++, type: 'user', text: value, images, turnId, selection }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId); if (index >= 0) chat.shown.splice(index); },
    addToolCall(name, input) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name, toolInput: input }); return nextId++; },
    updateToolResult(id) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.type = 'tool-result'; },
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    restoreDraft(text, selection, images, files) { chat.draft = { text, selection, images, files }; },
    showThinking() {}, hideThinking() {},
    showAskUser(question) { chat.addAssistantMessage(question); return new Promise(resolve => { chat.askUser = resolve; }); },
    cancelAskUser() { const resolve = chat.askUser; chat.askUser = null; resolve?.(''); },
    setInputEnabled() {}, setBusy(value) { chat.busy = value; }, foldTurn() {},
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {},
    setSelection() {}, getSelection: () => null,
    editable: () => true, setEditable(check) { chat.editable = check; },
  };
  return chat;
}

// A plugin that loads `saved` as its chat-state.json (none when undefined),
// records its writes, and has a chat view with a fake component.
async function setup(provider, saved) {
  const { app } = vaultApp();
  const writes = [];
  app.vault.adapter = {
    append: async () => {},
    read: async () => { if (!saved) throw new Error('ENOENT'); return JSON.stringify(saved); },
    exists: async () => !!saved,
    write: async (path, data) => { if (path.endsWith('/chat-state.json')) writes.push(JSON.parse(data)); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings(provider));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  const chat = fakeChat();
  view.chatContainer = chat;
  return { plugin, view, chat, writes };
}

// Waits until `condition()` holds; fails after about a second.
async function until(condition) {
  for (let i = 0; i < 1000 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(condition(), 'timed out');
}

// Anthropic request: the user turns' texts (without the context prefix) and the tool pairs.
const userTurns = body => body.messages.filter(m => m.role === 'user' && (typeof m.content === 'string' || m.content.some(b => b.type === 'text')))
  .map(m => (typeof m.content === 'string' ? m.content : m.content.find(b => b.type === 'text').text).split('\n').at(-1));
const toolUseIds = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use').map(b => b.id) : []);
const toolResultIds = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result').map(b => b.tool_use_id) : []);
const turnIdsOf = plugin => ({
  ui: plugin.chatHistory.filter(e => e.type === 'user' && e.turnId).map(e => e.turnId),
  agent: plugin.agent.exportMessages().filter(m => m.turnId).map(m => m.turnId),
});
// Answers each request with "A<n>"; the answer to `withTool` first reads a file.
function answering(provider, { withTool } = {}) {
  let answer = 0;
  return transport(body => {
    const last = provider === 'anthropic' ? body.messages.at(-1) : null;
    const question = last && typeof last.content === 'string' ? last.content.split('\n').at(-1) : '';
    if (question === withTool) return response(provider, [text('Reading'), call(`read-${answer}`, 'read_file', { path: 'Untitled.md' })], 'tool_use');
    return response(provider, [text(`A${++answer}`)], 'end_turn', answer);
  });
}

for (const [label, index] of [['first', 0], ['middle', 1], ['last', 2]]) {
  test(`Edit the ${label} turn: both histories are cut there and the edited text runs`, async () => {
    const { plugin, view, chat } = await setup('anthropic');
    const requests = answering('anthropic');
    for (const question of ['Q1', 'Q2', 'Q3']) await view.handleUserMessage(question, null);
    const before = turnIdsOf(plugin);
    assert.deepEqual(before.ui, before.agent);
    assert.equal(new Set(before.ui).size, 3);

    await view.editMessage(before.ui[index], 'Edited');
    const kept = ['Q1', 'Q2', 'Q3'].slice(0, index);
    assert.deepEqual(userTurns(requests.at(-1)), [...kept, 'Edited']);
    assert.equal(requests.at(-1).messages.length, 2 * index + 1);
    assert.deepEqual(plugin.chatHistory.map(e => e.text), [...kept.flatMap((q, i) => [q, `A${i + 1}`]), 'Edited', 'A4']);
    const after = turnIdsOf(plugin);
    assert.deepEqual(after.ui, after.agent);
    assert.deepEqual(after.ui.slice(0, index), before.ui.slice(0, index));
    assert.notEqual(after.ui[index], before.ui[index]);
    assert.deepEqual(chat.shown.map(m => m.text), plugin.chatHistory.map(e => e.text));
    assert.equal(chat.busy, false);
  });
}

test('Edit after a turn with tool calls keeps its call/result pairs; editing that turn drops them whole', async () => {
  const { plugin, view } = await setup('anthropic');
  const requests = answering('anthropic', { withTool: 'Q2' });
  for (const question of ['Q1', 'Q2', 'Q3']) await view.handleUserMessage(question, null);
  const ids = turnIdsOf(plugin).ui;

  await view.editMessage(ids[2], 'Edited 3');
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Q2', 'Edited 3']);
  assert.equal(toolUseIds(requests.at(-1)).length, 1);
  assert.deepEqual(toolResultIds(requests.at(-1)), toolUseIds(requests.at(-1)));

  await view.editMessage(ids[1], 'Edited 2');
  assert.deepEqual(userTurns(requests.at(-1)), ['Q1', 'Edited 2']);
  assert.deepEqual(toolUseIds(requests.at(-1)), []);
  assert.deepEqual(toolResultIds(requests.at(-1)), []);
  assert.equal(plugin.chatHistory.some(e => e.type === 'tool-result'), false);
});

test('Editing a turn while its ask_user question waits stops it and cuts before it', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  let runningDuringNewTurn;
  const requests = transport(async (body, index) => {
    if (index === 0) return response('anthropic', [text('A1')]);
    if (index === 1) return response('anthropic', [call('ask', 'ask_user', { question: 'Which note?' })], 'tool_use');
    // The stopped turn ends while this one runs; it must not end this one's running state.
    await new Promise(resolve => setTimeout(resolve, 10));
    runningDuringNewTurn = view.running;
    return response('anthropic', [text('A2')]);
  });
  await view.handleUserMessage('Q1', null);
  const asking = view.handleUserMessage('Q2', null);
  await until(() => chat.askUser);
  const q2 = turnIdsOf(plugin).ui[1];

  const editing = view.editMessage(q2, 'Q2 again');
  // The question was dropped: nothing waits for an answer.
  assert.equal(chat.askUser, null);
  await Promise.all([asking, editing]);
  assert.equal(runningDuringNewTurn, true);
  assert.equal(view.running, false);
  assert.deepEqual(userTurns(requests[2]), ['Q1', 'Q2 again']);
  assert.deepEqual(toolUseIds(requests[2]), []);
  assert.deepEqual(toolResultIds(requests[2]), []);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Q1', 'A1', 'Q2 again', 'A2']);
  assert.deepEqual(chat.shown.map(m => m.text), ['Q1', 'A1', 'Q2 again', 'A2']);
});

test('An ask_user answer is no turn of its own: not editable; editing or regenerating its turn cuts it', async () => {
  const { plugin, view, chat, writes } = await setup('anthropic');
  transport((body, index) => index === 0
    ? response('anthropic', [call('ask', 'ask_user', { question: 'Which note?' })], 'tool_use')
    : response('anthropic', [text(`A${index + 1}`)]));
  const asking = view.handleUserMessage('Q1', null);
  await until(() => chat.askUser);
  chat.addUserMessage('The plan');
  chat.askUser('The plan');
  await asking;
  assert.deepEqual(plugin.chatHistory.map(e => [e.type, e.text]),
    [['user', 'Q1'], ['assistant', 'Which note?'], ['user', 'The plan'], ['assistant', 'A2']]);
  assert.equal(plugin.chatHistory[2].turnId, undefined);
  assert.equal(chat.shown[2].turnId, undefined);
  assert.deepEqual(turnIdsOf(plugin).ui, turnIdsOf(plugin).agent);

  await until(() => writes.length === 1);
  const restored = await setup('anthropic', JSON.parse(JSON.stringify(writes[0])));
  assert.equal(restored.plugin.chatHistory[2].turnId, undefined);
  transport(() => response('anthropic', [text('Again')]));
  await restored.view.regenerate();
  assert.deepEqual(restored.plugin.chatHistory.map(e => e.text), ['Q1', 'Again']);
});

test('A chat saved without turn IDs gets matching IDs on load and can be edited', async () => {
  const saved = {
    chatHistory: [
      { type: 'user', text: 'Old Q1' }, { type: 'assistant', text: 'Old A1' },
      { type: 'user', text: 'Old Q2' }, { type: 'tool-result', toolName: 'read_file', toolInput: {}, toolResult: { result: 'x', isError: false } },
      { type: 'assistant', text: 'Old A2' },
    ],
    agentMessages: [
      { role: 'user', content: 'ctx\n\nOld Q1' }, { role: 'assistant', content: [text('Old A1')] },
      { role: 'user', content: 'ctx\n\nOld Q2' }, { role: 'assistant', content: [call('r', 'read_file', { path: 'Untitled.md' })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'x' }] }, { role: 'assistant', content: [text('Old A2')] },
    ],
  };
  const { plugin, view } = await setup('anthropic', saved);
  const ids = turnIdsOf(plugin);
  assert.equal(ids.ui.length, 2);
  assert.deepEqual(ids.ui, ids.agent);
  assert.equal(plugin.agent.exportMessages()[4].turnId, undefined); // tool results are not turn starts

  const requests = answering('anthropic');
  await view.editMessage(ids.ui[1], 'New Q2');
  assert.deepEqual(userTurns(requests[0]), ['Old Q1', 'New Q2']);
  assert.deepEqual(toolUseIds(requests[0]), []);
});

test('A chat saved without turn IDs: an ask_user answer in it gets no ID; turns with images and selections pair', async () => {
  const saved = {
    chatHistory: [
      { type: 'user', text: 'Q1', images: [image] }, { type: 'assistant', text: 'Which note?' },
      { type: 'user', text: 'The plan' }, { type: 'assistant', text: 'A1' },
      { type: 'user', text: 'Q2' }, { type: 'assistant', text: 'A2' },
    ],
    agentMessages: [
      { role: 'user', content: [{ type: 'image', image }, text('ctx\n\nQ1')] },
      { role: 'assistant', content: [call('ask', 'ask_user', { question: 'Which note?' })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ask', content: 'The plan' }] },
      { role: 'assistant', content: [text('A1')] },
      { role: 'user', content: 'ctx\n\n[Selection scope: ...]\n\nSelected text:\n> words\n\nQ2' }, { role: 'assistant', content: [text('A2')] },
    ],
  };
  const { plugin } = await setup('anthropic', saved);
  assert.deepEqual(plugin.chatHistory.map(e => e.turnId), ['legacy-2', undefined, undefined, undefined, 'legacy-1', undefined]);
  assert.deepEqual(turnIdsOf(plugin).agent, ['legacy-2', 'legacy-1']);
});

test('A chat that has turn IDs is loaded unchanged', async () => {
  const saved = {
    chatHistory: [{ type: 'user', text: 'Q1', turnId: 'turn-a' }, { type: 'assistant', text: 'Which note?' }, { type: 'user', text: 'The plan' }, { type: 'assistant', text: 'A1' }],
    agentMessages: [{ role: 'user', content: 'ctx\n\nQ1', turnId: 'turn-a' }, { role: 'assistant', content: [text('A1')] }],
  };
  const { plugin } = await setup('anthropic', saved);
  assert.deepEqual(plugin.chatHistory, saved.chatHistory);
  assert.deepEqual(plugin.agent.exportMessages(), saved.agentMessages);
});

test("A turn older than the saved API history can't be edited; both histories stay", async () => {
  // The visible history reaches further back than the trimmed API history.
  const saved = {
    chatHistory: [{ type: 'user', text: 'Ancient' }, { type: 'assistant', text: 'Old' }, { type: 'user', text: 'Recent' }, { type: 'assistant', text: 'New' }],
    agentMessages: [{ role: 'user', content: 'ctx\n\nRecent' }, { role: 'assistant', content: [text('New')] }],
  };
  const { plugin, view } = await setup('anthropic', saved);
  const ids = turnIdsOf(plugin);
  assert.equal(ids.agent.length, 1);
  assert.equal(ids.agent[0], ids.ui[1]);

  // Editing it would leave the model without the chat: refused, nothing sent.
  const requests = answering('anthropic');
  await view.editMessage(ids.ui[0], 'Ancient, edited');
  assert.equal(requests.length, 0);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Ancient', 'Old', 'Recent', 'New']);
  assert.equal(plugin.agent.exportMessages().length, 2);
  // The turn the API history holds still can; after it, the pencil shows only there.
  await view.editMessage(ids.ui[1], 'Recent, edited');
  assert.deepEqual(userTurns(requests[0]), ['Recent, edited']);
  const shownIds = turnIdsOf(plugin).ui;
  assert.equal(view.chatContainer.editable(shownIds[0]), false);
  assert.equal(view.chatContainer.editable(shownIds[1]), true);
});

test('The accepted replacement is saved consistently without persisting a premature cut', async () => {
  const { plugin, view, writes } = await setup('anthropic');
  answering('anthropic');
  for (const question of ['Q1', 'Q2', 'Q3']) await view.handleUserMessage(question, null);
  const ids = turnIdsOf(plugin).ui;
  // The last turn's save has finished (saves run one at a time; a save
  // asked for during one takes the state when it starts).
  await until(() => writes.length === 3);
  await new Promise(resolve => setTimeout(resolve, 2));

  await view.editMessage(ids[1], 'Edited');
  // No intermediate cut is persisted before preflight; the accepted replacement is saved.
  await until(() => writes.length === 4);
  const final = writes.at(-1);
  assert.deepEqual(final.conversations[0].chatHistory.map(e => e.text), ['Q1', 'A1', 'Edited', 'A4']);
  const restored = await setup('anthropic', JSON.parse(JSON.stringify(final)));
  const restoredIds = turnIdsOf(restored.plugin);
  assert.deepEqual(restoredIds.ui, restoredIds.agent);
  assert.deepEqual(restoredIds.ui, turnIdsOf(plugin).ui);
  const requests = answering('anthropic');
  await restored.view.editMessage(restoredIds.ui[1], 'Edited after restart');
  assert.deepEqual(userTurns(requests[0]), ['Q1', 'Edited after restart']);
});

test('OpenAI: after a cut the next request replays in full, without previous_response_id', async () => {
  const { plugin, view } = await setup('openai');
  const requests = transport((body, index) => response('openai', [text(`A${index + 1}`)], 'end_turn', index));
  await view.handleUserMessage('Q1', null);
  await view.handleUserMessage('Q2', null);
  assert.equal(requests[1].previous_response_id, 'resp_0'); // chained before the cut

  await view.editMessage(turnIdsOf(plugin).ui[1], 'Q2 edited');
  assert.equal(requests[2].previous_response_id, undefined);
  const texts = requests[2].input.flatMap(item => item.content ?? []).map(part => part.text.split('\n').at(-1));
  assert.deepEqual(texts, ['Q1', 'A1', 'Q2 edited']);

  await view.regenerate();
  assert.equal(requests[3].previous_response_id, undefined);
  // Chaining resumes on the cut history.
  await view.handleUserMessage('Q3', null);
  assert.equal(requests[4].previous_response_id, 'resp_3');
});

test('Regenerate runs the last turn again with the same text, images and selection', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  const requests = answering('anthropic');
  await view.handleUserMessage('Q1', null);
  const selection = { text: 'Selected words', filePath: 'Notes/Draft.md' };
  await view.handleUserMessage('Describe this', selection, [image]);
  const firstRun = requests[1].messages.at(-1).content;

  await view.regenerate();
  const rerun = requests[2].messages.at(-1).content;
  assert.deepEqual(rerun, firstRun);
  assert.equal(rerun[0].type, 'image');
  assert.equal(rerun[0].source.data, image.data);
  assert.match(rerun[1].text, /Selection scope: .*Notes\/Draft\.md[\s\S]*> Selected words[\s\S]*Describe this$/);
  assert.equal(requests[2].messages.length, 3);
  assert.deepEqual(plugin.chatHistory.map(e => e.text), ['Q1', 'A1', 'Describe this', 'A3']);
  const turn = plugin.chatHistory[2];
  assert.deepEqual(turn.images, [image]);
  assert.deepEqual(turn.selection, selection);
  assert.deepEqual(chat.shown.at(-2).images, [image]);
  assert.deepEqual(chat.shown.at(-2).selection, selection);
});

test('Copy puts the answer\'s Markdown source on the clipboard', async () => {
  const markdown = '**Bold** and \\(x^2\\)\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const { view, chat } = await setup('anthropic');
  transport(() => response('anthropic', [text(markdown)]));
  await view.handleUserMessage('Q', null);
  const answer = chat.shown.at(-1);
  assert.equal(answer.text, markdown);

  const copied = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: { clipboard: { writeText: async value => { copied.push(value); } } } });
  try {
    view.copyAnswer(answer.text);
    await until(() => globalThis.__notices.length === 1);
    assert.deepEqual(copied, [markdown]);
    assert.deepEqual(globalThis.__notices, ['Copied']);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous); else delete globalThis.navigator;
  }
});

for (const answer of ['Q1', 'tail']) test(`Legacy migration distinguishes an ask_user answer matching the prompt (${answer})`, async () => {
  const prompt = answer === 'tail' ? 'Q1\n\ntail' : 'Q1';
  const saved = {
    chatHistory:[{type:'user',text:prompt},{type:'assistant',text:'Which note?'},{type:'user',text:answer},{type:'assistant',text:'Done'}],
    agentMessages:[{role:'user',content:`ctx\n\n${prompt}`},{role:'assistant',content:[call('ask','ask_user',{question:'Which note?'})]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'ask',content:answer,is_error:false}]},{role:'assistant',content:[text('Done')]}],
  };
  const {plugin,view}=await setup('anthropic',saved);
  assert.ok(plugin.chatHistory[0].turnId);
  assert.equal(plugin.chatHistory[2].turnId,undefined);
  assert.equal(plugin.chatHistory[0].turnId,plugin.agent.exportMessages()[0].turnId);
  const requests=answering('anthropic');
  await view.regenerate();
  assert.ok(JSON.stringify(requests[0].messages).includes(prompt.replace(/\n/g,'\\n')));
  assert.deepEqual(toolUseIds(requests[0]),[]);
});

test('Selected turns keep a compact fingerprint, enforce their live snapshot, and fail closed after note changes', async () => {
  const {plugin,view,writes}=await setup('anthropic');
  const sourceText='before SELECT after '+ 'x'.repeat(1024*1024);
  const selection={filePath:'Untitled.md',text:'SELECT',from:7,occurrence:0,sourceText};
  const file=plugin.app.vault.getFileByPath('Untitled.md');
  let note=sourceText;
  plugin.app.vault.process=async(f,fn)=>{note=fn(note);};
  transport((body,i)=>i===0?response('anthropic',[call('edit','edit_document',{path:'Untitled.md',operation:'find_replace',find:'SELECT',content:'EDITED'})],'tool_use'):response('anthropic',[text('Done')]));
  await view.handleUserMessage('Edit selection',selection);
  assert.ok(note.startsWith('before EDITED after'),'live snapshot still enforces edits');
  const stored=plugin.chatHistory[0].selection;
  assert.equal(stored.sourceText,undefined);assert.match(stored.sourceHash,/^[a-f0-9]{64}$/);
  assert.equal(selection.sourceText,sourceText,'input snapshot is not mutated');
  await plugin.saveChatHistory();
  assert.ok(JSON.stringify(writes.at(-1)).length<10000,'whole note is not duplicated into saved chat');
  // Even if another identical occurrence now occupies the original offset,
  // a regenerated turn may not silently edit that different selection.
  note=sourceText+' SELECT';
  const guarded=await api.executeTool(plugin.app,'edit_document',{path:file.path,operation:'find_replace',find:'SELECT',content:'WRONG'},async()=>'',stored);
  assert.equal(guarded.isError,true);assert.ok(!note.includes('WRONG'));
});

test('Restoring old selected turns drops full-note snapshots while retaining safe edit metadata', async () => {
  const saved={version:2,chatHistory:[{type:'user',text:'Q',turnId:'t1',selection:{filePath:'Untitled.md',text:'selected',from:0,sourceText:'selected '+ 'x'.repeat(100000)}}],agentMessages:[{role:'user',content:'Q',turnId:'t1'}]};
  const {plugin}=await setup('anthropic',saved);
  assert.equal(plugin.chatHistory[0].selection.sourceText,undefined);
  assert.match(plugin.chatHistory[0].selection.sourceHash,/^[a-f0-9]{64}$/);
});

for (const action of ['edit', 'regenerate']) {
  test(`${action}: grown linked attachments rejected before transport retain original turns and undo identity`, async () => {
    const { plugin, view, chat, writes } = await setup('anthropic');
    const requests = answering('anthropic');
    for (const q of ['Q1', 'Q2', 'Q3']) await view.handleUserMessage(q, null);
    const index = action === 'edit' ? 1 : 2;
    const original = [...plugin.chatHistory];
    const messages = JSON.parse(JSON.stringify(plugin.agent.exportMessages()));
    const entry = plugin.chatHistory[index * 2];
    entry.text = 'Compare [[One.pdf]] [[Two.pdf]]';
    plugin.app.metadataCache = { getFirstLinkpathDest: link => ({ path: link, name: link, extension: 'pdf', stat: { size: 10 * 1024 * 1024 } }) };
    plugin.app.vault.readBinary = async () => new Uint8Array(10 * 1024 * 1024).buffer;
    if (action === 'edit') await view.editMessage(entry.turnId, entry.text);
    else await view.regenerate();
    assert.equal(requests.length, 3);
    assert.deepEqual(plugin.agent.exportMessages(), messages);
    assert.deepEqual(plugin.chatHistory.slice(0, original.length), original);
    for (let i = 0; i < original.length; i++) assert.equal(plugin.chatHistory[i], original[i]);
    assert.match(chat.shown.at(-1).text, /budget|limit/i);
    assert.equal(chat.draft.text, entry.text);
    await plugin.saveChatHistory();
    assert.equal(writes.at(-1).conversations[0].chatHistory.filter(row => row.type === 'user').length, 3);
  });
}

test('Edited resend rejected by final payload preflight restores all later answers and permits a smaller edit', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  const file = { id: 'file', fileName: '10MiB.pdf', mediaType: 'application/pdf', sizeBytes: 10 * 1024 * 1024, data: 'A'.repeat(4 * Math.ceil(10 * 1024 * 1024 / 3)) };
  plugin.agent.importMessages([
    { role: 'user', turnId: 'one', content: [{ type: 'file', file }, text('Q1')] }, { role: 'assistant', content: [text('A1')] },
    { role: 'user', turnId: 'two', content: [{ type: 'file', file }, text('Q2')] }, { role: 'assistant', content: [text('A2')] },
    { role: 'user', turnId: 'three', content: 'Q3' }, { role: 'assistant', content: [text('A3')] },
    { role: 'user', turnId: 'four', content: 'Q4' }, { role: 'assistant', content: [text('A4')] },
  ]);
  for (let i = 0; i < 4; i++) plugin.chatHistory.push({ type: 'user', turnId: ['one','two','three','four'][i], text: `Q${i+1}`, ...(i === 2 ? { attachedFiles: [file] } : {}) }, { type: 'assistant', text: `A${i+1}` });
  const original = [...plugin.chatHistory];
  const messages = plugin.agent.exportMessages();
  plugin.activeConversation.notes = ['Keep pending undo note.'];
  const requests = answering('anthropic');
  await view.editMessage('three', 'Too large');
  assert.equal(requests.length, 0);
  assert.deepEqual(plugin.chatHistory.slice(0, 8), original);
  assert.deepEqual(plugin.agent.exportMessages(), messages);
  assert.deepEqual(plugin.activeConversation.notes, ['Keep pending undo note.']);
  assert.equal(chat.draft.text, 'Too large');
  plugin.chatHistory[4].attachedFiles = [];
  await view.editMessage('three', 'Small edit');
  assert.equal(requests.length, 1);
  assert.deepEqual(plugin.chatHistory.filter(row => row.type === 'user').map(row => row.text), ['Q1', 'Q2', 'Small edit']);
});

test('Switching chats during edited context loading restores the source conversation before leaving', async () => {
  const { plugin, view } = await setup('anthropic');
  const requests = answering('anthropic');
  for (const q of ['Q1', 'Q2']) await view.handleUserMessage(q, null);
  const source = plugin.activeConversation;
  const original = [...plugin.chatHistory];
  const messages = JSON.parse(JSON.stringify(plugin.agent.exportMessages()));
  plugin.app.metadataCache = { getFirstLinkpathDest: link => ({ path: link, name: link, extension: 'pdf', stat: { size: 10 } }) };
  let release;
  let reading = false;
  plugin.app.vault.readBinary = async () => { reading = true; return new Promise(resolve => { release = resolve; }); };
  const editing = view.editMessage(original[2].turnId, 'Read [[File.pdf]]');
  await until(() => reading);
  view.newChat();
  assert.notEqual(plugin.activeConversationId, source.id);
  release(new TextEncoder().encode('%PDF-1.7').buffer);
  await editing;
  assert.deepEqual(source.chatHistory, original);
  assert.deepEqual(source.agentMessages, messages);
  assert.equal(plugin.agent.isEmpty(), true);
  assert.equal(requests.length, 2);
});


for (const action of ['edit', 'regenerate', 'restored regenerate']) {
  test(`${action} resolves duplicate-basename links against the original note`, async () => {
    let { plugin, view, writes } = await setup('anthropic');
    let active = 'A/Source.md';
    const sources = [];
    const configure = () => {
      const app = plugin.app;
      app.workspace.getActiveFile = () => ({ path: active });
      app.metadataCache = { getFirstLinkpathDest: (link, source) => {
        sources.push(source);
        return { path: source.startsWith('A/') ? 'A/Plan.md' : 'B/Plan.md', extension: 'md' };
      }};
      const original = app.vault.getFileByPath;
      app.vault.getFileByPath = path => ['A/AGENTS.md', 'B/AGENTS.md'].includes(path) ? { path } : original(path);
      app.vault.cachedRead = async file => file.path === 'A/Plan.md' ? 'ORIGINAL-PLAN-CONTENT'
        : file.path === 'B/Plan.md' ? 'WRONG-PLAN-CONTENT'
        : file.path === 'A/AGENTS.md' ? 'ORIGINAL-FOLDER-RULE' : 'OTHER-CONTENT';
    };
    configure();
    const requests = answering('anthropic');
    await view.handleUserMessage('Read [[Plan]]', null);
    assert.equal(plugin.chatHistory[0].linkSource, 'A/Source.md');
    await plugin.saveChatHistory();
    if (action === 'restored regenerate') {
      ({ plugin, view, writes } = await setup('anthropic', JSON.parse(JSON.stringify(writes.at(-1)))));
      configure();
    }
    active = 'B/Source.md';
    if (action === 'edit') await view.editMessage(plugin.chatHistory[0].turnId, 'Summarize [[Plan]]');
    else await view.regenerate();
    assert.deepEqual(sources, ['A/Source.md', 'A/Source.md']);
    assert.match(JSON.stringify(requests.at(-1)), /ORIGINAL-PLAN-CONTENT/);
    assert.match(JSON.stringify(requests.at(-1)), /ORIGINAL-FOLDER-RULE/);
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /WRONG-PLAN-CONTENT/);
    assert.equal(plugin.chatHistory[0].linkSource, 'A/Source.md');
  });
}


test('Stopping edited linked preflight restores attachments after the original history is rendered', async () => {
  const { plugin, view, chat } = await setup('anthropic');
  const requests = answering('anthropic');
  await view.handleUserMessage('Original', null, [{ ...image }]);
  const originalHistory = [...plugin.chatHistory];
  const clear = chat.clearMessages;
  chat.clearMessages = () => { clear(); if (chat.draft) chat.draft = { ...chat.draft, selection: null, images: [], files: [] }; };
  plugin.app.metadataCache = { getFirstLinkpathDest: () => ({ path: 'Hold.md', extension: 'md' }) };
  let release;
  let reading = false;
  const read = plugin.app.vault.cachedRead;
  plugin.app.vault.cachedRead = async file => {
    if (file.path !== 'Hold.md') return read(file);
    reading = true;
    return new Promise(resolve => { release = resolve; });
  };
  const pending = view.editMessage(originalHistory[0].turnId, 'Edited [[Hold]]');
  await until(() => reading);
  view.handleStop();
  assert.equal(chat.draft.text, 'Edited [[Hold]]');
  assert.deepEqual(chat.draft.images, [{ ...image }]);
  assert.equal(plugin.chatHistory[0], originalHistory[0]);
  release('Late contents');
  await pending;
  assert.deepEqual(chat.draft.images, [{ ...image }]);
  assert.equal(requests.length, 1);
});
