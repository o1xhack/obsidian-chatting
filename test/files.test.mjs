// Files: the ZIP reader and the text of Word, Excel and PowerPoint files;
// what a file becomes; how each provider gets it (in a message and in a
// tool result); read_file on a PDF; attached files in the chat, saved
// without their data and sent again on edit.
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { api, settings, callbacks, transport, response, text, call, vaultApp } from './harness.mjs';

beforeEach(() => {
  api.clearOpenAIState();
  globalThis.__notices = [];
  api.setChatGPTOAuthService({ getUsableCredential: async () => ({ accessToken: 'fake-token', accountId: 'fake-account' }) });
});

/** A ZIP archive (entries deflated unless `stored`), as Office writes them. */
function zip(entries, { stored = [] } = {}) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const store = stored.includes(name);
    const data = store ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...parts, dir, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}

const W = body => `<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`;
const para = (value, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${value}</w:t></w:r></w:p>`;
const DOCX = zip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': W([
    para('Project &amp; plan', 'Heading1'),
    para('Ziele', 'berschrift2'),
    '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>First point</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>Cost</w:t></w:r><w:r><w:tab/><w:t>12 &lt; 20</w:t></w:r></w:p>',
    '<w:p/>',
    '<w:tbl><w:tr><w:tc>' + para('Name') + '</w:tc><w:tc>' + para('Role') + '</w:tc></w:tr><w:tr><w:tc>' + para('Ana') + '</w:tc><w:tc>' + para('Lead|PM') + '</w:tc></w:tr></w:tbl>',
  ].join('')),
}, { stored: ['[Content_Types].xml'] });

const XLSX = zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><r><t>Cost</t></r><r><t xml:space="preserve"> (EUR)</t></r></si><si><t>Tiles, grey</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row><row r="3"><c r="A3" s="1"/></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="B1" t="inlineStr"><is><t>Say "hi"</t></is></c><c r="C1" t="b"><v>1</v></c></row></sheetData></worksheet>',
});

const PPTX = zip({
  'ppt/slides/slide10.xml': '<p:sld><a:p><a:r><a:t>Last</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second</a:t></a:r><a:r><a:t> slide</a:t></a:r></a:p><a:p><a:r><a:t>Point</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p></p:sld>',
});

const PDF = new TextEncoder().encode('%PDF-1.7 fake').buffer;
const b64 = buffer => Buffer.from(buffer).toString('base64');
const utf8 = value => new TextEncoder().encode(value).buffer;

test('Combined attachment budget counts base64, images and JSON-escaped Unicode text rather than declared source sizes', () => {
  const file = { id: 'large', fileName: 'Large.pdf', mediaType: 'application/pdf', sizeBytes: 10 * 1024 * 1024, data: 'A'.repeat(4 * Math.ceil(10 * 1024 * 1024 / 3)) };
  assert.equal(api.files.attachmentBudgetError([], [file]), null);
  assert.match(api.files.attachmentBudgetError([], [file, file]), /combined images and files/);
  const image = { id: 'image', fileName: 'Image.png', mediaType: 'image/png', sizeBytes: 1, data: 'A'.repeat(8 * 1024 * 1024) };
  assert.match(api.files.attachmentBudgetError([image], [file]), /combined/);
  assert.match(api.files.attachmentBudgetError([], [{ ...file, data: '', text: '中'.repeat(8 * 1024 * 1024) }]), /combined/);
});

test('Attachments and linked files share the turn budget; rejected input never enters agent history or reaches transport', async () => {
  const { app } = vaultApp();
  const loop = new api.AgentLoop(app, settings('anthropic'));
  const file = { id: 'large', fileName: 'Large.pdf', mediaType: 'application/pdf', sizeBytes: 9 * 1024 * 1024, data: 'A'.repeat(12 * 1024 * 1024) };
  const requests = transport(() => response('anthropic', [text('ok')]));
  const cb = callbacks();
  await loop.run('Read both files', cb, null, [], 'over-budget', { text: 'Linked PDF', images: [], files: [{ ...file, id: 'linked' }] }, [], [file]);
  assert.equal(requests.length, 0);
  assert.equal(loop.exportMessages().length, 0);
  assert.match(cb.errors[0], /20 MB encoded attachment limit/);
});

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: final encoded request budget includes history, tool files, images and system text before transport`, async () => {
    const send = provider === 'anthropic' ? api.sendAnthropicMessage : provider === 'openai' ? api.sendOpenAIMessage : api.sendChatGPTOAuthMessage;
    const file = { id: 'pdf', fileName: 'Big.pdf', mediaType: 'application/pdf', sizeBytes: 10 * 1024 * 1024, data: 'A'.repeat(14_000_000) };
    const image = { id: 'img', fileName: 'Big.png', mediaType: 'image/png', sizeBytes: 5 * 1024 * 1024, data: 'A'.repeat(7_000_000) };
    const messages = [
      { role: 'user', content: [{ type: 'file', file }, { type: 'image', image }, { type: 'text', text: 'Read' }] },
      { role: 'assistant', content: [call('read', 'read_file', { path: 'Other.pdf' })] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Loaded', files: [{ ...file, data: 'A'.repeat(8_000_000), sizeBytes: 6_000_000 }] }] },
    ];
    const requests = transport(() => response(provider, [text('ok')]));
    await assert.rejects(send(settings(provider), messages, [], '中'.repeat(1_000_000)), /30 MB chat limit/);
    assert.equal(requests.length, 0);
    await send(settings(provider), [{ role: 'user', content: 'A small retry' }], [], 'System');
    assert.equal(requests.length, 1);
  });
}

test('Word: headings (also German styles), lists, tabs, entities, tables as Markdown', async () => {
  const file = await api.files.fileAttachment('Plan.docx', DOCX);
  assert.equal(file.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(file.data, b64(DOCX));
  assert.equal(file.text, [
    '# Project & plan',
    '## Ziele',
    '- First point',
    'Cost\t12 < 20',
    '| Name | Role |\n| --- | --- |\n| Ana | Lead\\|PM |',
  ].join('\n\n'));
});

test('An Office file that unpacks to more than 64 MB is attached without its text (a zip bomb is not unpacked)', async () => {
  // 65 MB of spaces compress to about 64 KB.
  const bomb = zip({ 'word/document.xml': `<w:document><w:body>${' '.repeat(65 * 1024 * 1024)}</w:body></w:document>` });
  assert.ok(bomb.byteLength < 1024 * 1024);
  const file = await api.files.fileAttachment('Bomb.docx', bomb);
  assert.equal(file.mediaType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(file.text, undefined);
  // A normal file still has its text.
  assert.ok((await api.files.fileAttachment('Plan.docx', DOCX)).text);
});

test('Excel: each sheet as CSV with shared, rich and inline strings, numbers, booleans and gaps', async () => {
  const file = await api.files.fileAttachment('Budget.xlsx', XLSX);
  assert.equal(file.text, '## Sheet: Budget\nItem,Cost (EUR)\n"Tiles, grey",,12.5\n\n## Sheet: Notes & more\n,"Say ""hi""",TRUE');
});

function sparseWorkbook(rows, shared = '') {
  return zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Sparse" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': shared,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${rows}</sheetData></worksheet>`,
  });
}

test('Excel rejects out-of-range or malformed references before sparse row allocation; XFD remains supported', async () => {
  for (const reference of ['XFE1', 'ZZZZZ1', 'A1048577', 'A0', 'ABC', '1A', 'A'.repeat(10000) + '1']) {
    const bytes = sparseWorkbook(`<row><c r="${reference}"><v>17</v></c></row>`);
    const file = await api.files.fileAttachment('Invalid.xlsx', bytes);
    assert.equal(file.text, undefined, reference);
    assert.equal(file.data, b64(bytes)); // Kept as a file; unsafe local extraction is refused.
  }
  const edge = await api.files.fileAttachment('Edge.xlsx', sparseWorkbook('<row><c r="XFD1048576"><v>17</v></c></row>'));
  assert.equal(edge.text, '## Sheet: Sparse\n' + ','.repeat(16383) + '17');
});

test('Excel bounds total expansion even when sparse columns and repeated shared strings are individually valid', async () => {
  const rows = Array.from({ length: 7 }, (_, i) => `<row><c r="XFD${i + 1}"><v>17</v></c></row>`).join('');
  assert.equal((await api.files.fileAttachment('Wide.xlsx', sparseWorkbook(rows))).text, undefined);
  const shared = '<sst><si><t>' + 'x'.repeat(600000) + '</t></si></sst>';
  const repeated = '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>0</v></c></row>';
  assert.equal((await api.files.fileAttachment('Repeated.xlsx', sparseWorkbook(repeated, shared))).text, undefined);
  assert.match((await api.files.fileAttachment('Small.xlsx', XLSX)).text, /Tiles, grey/);
});

test('PowerPoint: slides in their order (2 before 10)', async () => {
  const file = await api.files.fileAttachment('Talk.pptx', PPTX);
  assert.equal(file.text, '## Slide 1\nTitle\n\n## Slide 2\nSecond slide\nPoint\n\n## Slide 10\nLast');
});

test('What a file becomes: PDF as data, text files as text, damaged Office files without text; binaries and large files refused', async () => {
  const pdf = await api.files.fileAttachment('Scan.pdf', PDF);
  assert.deepEqual({ ...pdf, id: '' }, { id: '', fileName: 'Scan.pdf', mediaType: 'application/pdf', data: b64(PDF), sizeBytes: PDF.byteLength });

  const csv = await api.files.fileAttachment('data.csv', utf8('a,b\n1,2'));
  assert.deepEqual([csv.mediaType, csv.data, csv.text], ['text/plain', '', 'a,b\n1,2']);
  const code = await api.files.fileAttachment('Dockerfile', utf8('FROM node'));
  assert.equal(code.text, 'FROM node');

  const broken = await api.files.fileAttachment('Broken.docx', utf8('not a zip'));
  assert.equal(broken.text, undefined);
  assert.ok(broken.data);

  assert.match(await api.files.fileAttachment('song.mp3', new Uint8Array([0, 1, 2, 0]).buffer), /only PDF, Word, Excel, PowerPoint and text files/);
  assert.match(await api.files.fileAttachment('Big.pdf', new ArrayBuffer(api.files.MAX_FILE_BYTES + 1)), /files can be up to 10 MB/);
});

/** The request of a turn with `files` attached. */
async function sentWith(provider, files) {
  const requests = transport((body, index) => response(provider, [text('ok')], 'end_turn', index));
  const { app } = vaultApp();
  await new api.AgentLoop(app, settings(provider)).run('Summarise', callbacks(), null, [], undefined, null, [], files);
  return requests[0];
}

test('Anthropic: a PDF as a document, Office and text files as text documents, a legacy file named only', async () => {
  const files = await Promise.all([
    api.files.fileAttachment('Scan.pdf', PDF),
    api.files.fileAttachment('Plan.docx', DOCX),
    api.files.fileAttachment('data.csv', utf8('a,b')),
    api.files.fileAttachment('Old.doc', new Uint8Array([0xd0, 0xcf, 0, 1]).buffer),
  ]);
  const body = await sentWith('anthropic', files);
  const content = body.messages.at(-1).content;
  assert.deepEqual(content[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(PDF) }, title: 'Scan.pdf' });
  assert.equal(content[1].type, 'document');
  assert.equal(content[1].source.type, 'text');
  assert.match(content[1].source.data, /^# Project & plan/);
  assert.deepEqual(content[2], { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'a,b' }, title: 'data.csv' });
  assert.match(content[3].text, /Old\.doc: Claude can't read this file type/);
  assert.match(content.at(-1).text, /Summarise$/);
});

for (const provider of ['openai', 'chatgpt-oauth']) {
  test(`${provider}: PDF and Office files as input_file with their data, text files as text`, async () => {
    const files = await Promise.all([
      api.files.fileAttachment('Scan.pdf', PDF),
      api.files.fileAttachment('Plan.docx', DOCX),
      api.files.fileAttachment('data.csv', utf8('a,b')),
    ]);
    const body = await sentWith(provider, files);
    const content = body.input.at(-1).content;
    assert.deepEqual(content[0], { type: 'input_file', filename: 'Scan.pdf', file_data: `data:application/pdf;base64,${b64(PDF)}` });
    assert.equal(content[1].type, 'input_file');
    assert.match(content[1].file_data, /^data:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document;base64,/);
    assert.deepEqual(content[2], { type: 'input_text', text: '<file name="data.csv">\na,b\n</file>' });
  });
}

/** A vault with a PDF, for read_file. */
function pdfVault() {
  const setup = vaultApp();
  const getFileByPath = setup.app.vault.getFileByPath;
  setup.app.vault.getFileByPath = path => path === 'Docs/Scan.pdf' ? { path, name: 'Scan.pdf', extension: 'pdf' } : getFileByPath(path);
  setup.app.vault.readBinary = async () => PDF;
  return setup;
}

for (const provider of ['anthropic', 'openai', 'chatgpt-oauth']) {
  test(`${provider}: read_file on a PDF sends it in the tool result; older ones are left out later`, async () => {
    const { app } = pdfVault();
    const requests = transport((body, index) => index === 0
      ? response(provider, [call('r1', 'read_file', { path: 'Docs/Scan.pdf' })], 'tool_use', index)
      : response(provider, [text(`A${index}`)], 'end_turn', index));
    const agent = new api.AgentLoop(app, settings(provider));
    const cb = callbacks({ onToolResult: (name, result) => { cb.shown = result.result; } });
    await agent.run('Read the scan', cb);
    assert.match(cb.shown, /^Docs\/Scan\.pdf \(.*\) is attached\.\n\n\[1 file prepared for the model\]$/);
    if (provider === 'anthropic') {
      const result = requests[1].messages.at(-1).content[0];
      assert.equal(result.content[1].type, 'document');
      assert.equal(result.content[1].source.data, b64(PDF));
    } else {
      const output = requests[1].input.find(item => item.type === 'function_call_output').output;
      assert.deepEqual(output[1], { type: 'input_file', filename: 'Scan.pdf', file_data: `data:application/pdf;base64,${b64(PDF)}` });
    }
    // Two turns later the file isn't sent again (the AI can read it again);
    // OpenAI chains to its stored response instead of sending the history.
    for (const question of ['Q2', 'Q3', 'Q4']) await agent.run(question, callbacks());
    const last = JSON.stringify(requests.at(-1));
    assert.doesNotMatch(last, new RegExp(b64(PDF).slice(0, 12)));
    if (provider !== 'openai') assert.match(last, /file from read_file omitted to save context/);
  });
}

test('read_file: PDF and Office files attached, too large ones refused; read_document points to read_file', async () => {
  const { app } = pdfVault();
  const pdf = await api.executeTool(app, 'read_file', { path: 'Docs/Scan.pdf' }, async () => '');
  assert.equal(pdf.isError, false);
  assert.match(pdf.result, /^Docs\/Scan\.pdf \(.*\) is attached\.$/);
  assert.deepEqual(pdf.files.map(f => [f.fileName, f.mediaType, f.data]), [['Scan.pdf', 'application/pdf', b64(PDF)]]);

  app.vault.readBinary = async () => new ArrayBuffer(api.files.MAX_FILE_BYTES + 1);
  const big = await api.executeTool(app, 'read_file', { path: 'Docs/Scan.pdf' }, async () => '');
  assert.equal(big.isError, true);
  assert.match(big.result, /files can be up to 10 MB/);

  const doc = await api.executeTool(app, 'read_document', { path: 'Docs/Scan.pdf' }, async () => '');
  assert.equal(doc.isError, true);
  assert.match(doc.result, /PDF or Office file; read_document reads text only\. Use read_file/);
});

test('Tool files: one note for images and files left out together', () => {
  const picture = { id: 'p', fileName: 'p.png', mediaType: 'image/png', data: 'x', sizeBytes: 1 };
  const file = { id: 'f', fileName: 'a.pdf', mediaType: 'application/pdf', data: 'y', sizeBytes: 1 };
  const history = [
    { role: 'user', content: 'One', turnId: 't1' },
    { role: 'assistant', content: [call('c1', 'read_file', { path: 'a.pdf' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'a.pdf', images: [picture], files: [file, file] }] },
    { role: 'assistant', content: [text('A1')] },
    { role: 'user', content: 'Two', turnId: 't2' },
    { role: 'assistant', content: [text('A2')] },
    { role: 'user', content: 'Three', turnId: 't3' },
  ];
  assert.deepEqual(api.withoutOldToolImages(history)[2].content, [
    { type: 'tool_result', tool_use_id: 'c1', content: 'a.pdf\n\n[image and 2 files from read_file omitted to save context]' },
  ]);
});

test('read_file refuses an oversized document before reading its binary data', async () => {
  const { app } = pdfVault();
  const original = app.vault.getFileByPath;
  app.vault.getFileByPath = path => ({ ...original(path), stat: { size: api.files.MAX_FILE_BYTES + 1 } });
  app.vault.readBinary = async () => assert.fail('oversized source must not be allocated');
  const result = await api.executeTool(app, 'read_file', { path: 'Docs/Scan.pdf' }, async () => '');
  assert.equal(result.isError, true);
  assert.match(result.result, /10 MB file limit/);
});

test('Tool file history is bounded by actual payloads and leaves user attachments intact', () => {
  const file = { id: 'f', fileName: 'a.pdf', mediaType: 'application/pdf', data: 'eA==', sizeBytes: 0 };
  const history = [
    { role: 'user', content: [{ type: 'file', file }, text('Question')] },
    { role: 'assistant', content: [call('read', 'read_file', { path: 'a.pdf' })] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'Files', files: Array.from({ length: 8 }, (_, i) => ({ ...file, id: `tool-${i}` })) }] },
  ];
  const prepared = api.withoutOldToolImages(history);
  assert.equal(prepared[0], history[0]);
  assert.deepEqual(prepared[2].content[0].files.map(file => file.id), ['tool-4', 'tool-5', 'tool-6', 'tool-7']);
  assert.equal(history[2].content[0].files.length, 8);
  const enormous = { ...file, data: 'x'.repeat(14 * 1024 * 1024) };
  const oversized = api.withoutOldToolImages([history[0], { role: 'user', content: [{ type: 'tool_result', content: 'Huge', files: [enormous] }] }]);
  assert.equal(oversized[1].content[0].files, undefined);
});

// Records what the view shows, in place of ChatContainer.svelte.
function fakeChat() {
  let nextId = 0;
  const chat = {
    shown: [],
    addUserMessage(value, images = [], turnId, selection, files = []) { chat.shown.push({ id: nextId++, type: 'user', text: value, images, turnId, selection, files }); },
    addAssistantMessage(value) { chat.shown.push({ id: nextId, type: 'assistant', text: value }); return nextId++; },
    updateAssistantMessage(id, value) { const msg = chat.shown.find(m => m.id === id); if (msg) msg.text = value; },
    removeMessage(id) { chat.shown = chat.shown.filter(m => m.id !== id); },
    cutMessages(turnId) { const index = chat.shown.findIndex(m => m.type === 'user' && m.turnId === turnId); if (index >= 0) chat.shown.splice(index); },
    addToolCall(name) { chat.shown.push({ id: nextId, type: 'tool-call', toolName: name }); return nextId++; },
    updateToolResult() {},
    addError(value) { chat.shown.push({ id: nextId++, type: 'error', text: value }); },
    showThinking() {}, hideThinking() {}, setInputEnabled() {}, setBusy() {}, foldTurn() {}, updateConversations() {}, setContinue() {}, setQueued() {},
    clearMessages() { chat.shown = []; }, focus() {}, setModel() {}, setTitle() {}, setSelection() {}, getSelection: () => null,
  };
  return chat;
}

// A plugin that loads `saved` as its chat-state.json (none when undefined),
// records what it writes there, and has a chat view with a fake component.
async function setup(saved) {
  const { app } = vaultApp();
  const writes = [];
  app.vault.adapter = {
    append: async () => {},
    read: async path => { if (!saved || !path.endsWith('/chat-state.json')) throw new Error('ENOENT'); return JSON.stringify(saved); },
    exists: async () => !!saved,
    write: async (path, data) => { if (path.endsWith('/chat-state.json')) writes.push(JSON.parse(data)); },
  };
  const plugin = new api.ChatPlugin();
  plugin.app = app;
  plugin.agent = new api.AgentLoop(app, settings('anthropic'));
  await plugin.loadChatHistory();
  const view = new api.ObsidianChatView({}, plugin);
  view.chatContainer = fakeChat();
  return { plugin, view, writes };
}

test('Attached files in the chat: saved once without data and text, back from the API history, sent again on edit', async () => {
  const { plugin, view, writes } = await setup();
  const requests = transport((body, index) => response('anthropic', [text(`A${index}`)]));
  const pdf = await api.files.fileAttachment('Scan.pdf', PDF);
  const csv = await api.files.fileAttachment('data.csv', utf8('a,b'));
  await view.handleUserMessage('Look', null, [], [pdf, csv]);
  assert.deepEqual(view.chatContainer.shown[0].files.map(f => f.fileName), ['Scan.pdf', 'data.csv']);
  assert.deepEqual(plugin.chatHistory[0].attachedFiles.map(f => f.fileName), ['Scan.pdf', 'data.csv']);
  assert.deepEqual(requests[0].messages.at(-1).content.slice(0, 2).map(b => b.type), ['document', 'document']);

  const saved = writes.at(-1);
  assert.equal(saved.version, api.chatState.CHAT_STATE_VERSION);
  const json = JSON.stringify(saved);
  assert.equal(json.split(b64(PDF)).length - 1, 1);
  assert.deepEqual(saved.conversations[0].chatHistory[0].attachedFiles.map(({ data, text: t, fileName }) => [fileName, data, t]), [['Scan.pdf', '', undefined], ['data.csv', '', undefined]]);

  const restored = await setup(saved);
  assert.equal(restored.plugin.chatHistory[0].attachedFiles[0].data, b64(PDF));
  assert.equal(restored.plugin.chatHistory[0].attachedFiles[1].text, 'a,b');

  const again = transport((body, index) => response('anthropic', [text(`B${index}`)]));
  await restored.view.editMessage(restored.plugin.chatHistory[0].turnId, 'Look again');
  assert.deepEqual(again[0].messages.at(-1).content.slice(0, 2).map(b => b.type), ['document', 'document']);
  assert.match(again[0].messages.at(-1).content.at(-1).text, /Look again$/);
});

test('A file the API history no longer holds stays a name; its turn can\'t be edited', async () => {
  const saved = {
    version: api.chatState.CHAT_STATE_VERSION,
    activeConversationId: 'c1',
    conversations: [{
      id: 'c1', title: 'Old.pdf', customTitle: false, createdAt: 1, updatedAt: 1,
      chatHistory: [
        { type: 'user', text: '', turnId: 't1', attachedFiles: [{ id: 'gone', fileName: 'Old.pdf', mediaType: 'application/pdf', sizeBytes: 3, data: '' }] },
        { type: 'assistant', text: 'Old answer' },
      ],
      agentMessages: [],
    }],
  };
  const { plugin, view } = await setup(saved);
  // Without text the title is the file's name.
  assert.equal(plugin.activeConversation.title, 'Old.pdf');
  assert.deepEqual(plugin.chatHistory[0].attachedFiles.map(f => [f.fileName, f.data]), [['Old.pdf', '']]);
  // The model no longer has that turn: an edit does nothing, nothing is sent.
  const requests = transport(() => response('anthropic', [text('ok')]));
  await view.editMessage('t1', 'Again');
  assert.equal(requests.length, 0);
  assert.equal(plugin.chatHistory.length, 2);
});

for (const provider of ['anthropic', 'chatgpt-oauth']) {
  test(`${provider}: an oversized tool follow-up omits only tool attachments and continues without losing work`, async () => {
    const { app, files } = vaultApp();
    files.set('Other.pdf', 'PDF');
    app.vault.readBinary = async () => new ArrayBuffer(8 * 1024 * 1024);
    const loop = new api.AgentLoop(app, { ...settings(provider), maxIterations: 2 });
    const file = { id: 'previous', fileName: 'Previous.pdf', mediaType: 'application/pdf', sizeBytes: 10 * 1024 * 1024, data: 'A'.repeat(4 * Math.ceil(10 * 1024 * 1024 / 3)) };
    loop.importMessages([
      { role: 'user', content: [{ type: 'file', file }, text('First PDF')], turnId: 'old1' },
      { role: 'assistant', content: [text('Read')] },
      { role: 'user', content: [{ type: 'file', file: { ...file, id: 'second' } }, text('Second PDF')], turnId: 'old2' },
      { role: 'assistant', content: [text('Read')] },
    ]);
    const requests = transport((body, index) => index === 0
      ? response(provider, [call('read-more', 'read_file', { path: 'Other.pdf' })], 'tool_use')
      : response(provider, [text('Please provide a smaller extract.')], 'end_turn', index));
    const cb = callbacks();
    await loop.run('Read another document', cb);
    assert.deepEqual(cb.errors, []);
    assert.deepEqual(cb.texts, ['Please provide a smaller extract.']);
    assert.equal(requests.length, 2);
    const history = loop.exportMessages();
    const blocks = history.flatMap(message => typeof message.content === 'string' ? [] : message.content);
    assert.equal(blocks.filter(block => block.type === 'file').length, 2);
    const result = blocks.find(block => block.type === 'tool_result');
    assert.equal(result.files, undefined);
    assert.equal(result.is_error, true);
    assert.match(result.content, /omitted because the request exceeded/);
    await loop.run('Continue with text', callbacks());
    assert.equal(requests.length, 3);
    assert.equal(blocks.find(block => block.type === 'file').file.data, file.data);
  });
}

test('PowerPoint stops text extraction within slides and never reads later oversized slide XML after its cap', async () => {
  const bytes = zip({
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>' + 'X'.repeat(120000) + '</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide2.xml': '<p:sld>' + ' '.repeat(9 * 1024 * 1024) + '</p:sld>',
  });
  const file = await api.files.fileAttachment('Large.pptx', bytes);
  assert.ok(file.text.length <= api.files.FILE_TEXT_CHARS);
  assert.match(file.text, /^## Slide 1/);
  assert.match(file.text, /extraction limit reached/);
  assert.doesNotMatch(file.text, /Slide 2/);
  assert.equal(file.data, b64(bytes));
});

test('PowerPoint accumulates only capped slide text; oversized XML and Word table expansion refuse local extraction', async () => {
  const slides = {};
  for (let i = 1; i <= 20; i++) slides[`ppt/slides/slide${i}.xml`] = '<a:p><a:r><a:t>' + 'Y'.repeat(20000) + '</a:t></a:r></a:p>';
  const file = await api.files.fileAttachment('Many.pptx', zip(slides));
  assert.ok(file.text.length <= api.files.FILE_TEXT_CHARS);
  assert.doesNotMatch(file.text, /Slide 20/);
  const big = zip({ 'ppt/slides/slide1.xml': '<p:sld>' + ' '.repeat(9 * 1024 * 1024) + '</p:sld>' });
  assert.equal((await api.files.fileAttachment('HugeXml.pptx', big)).text, undefined);
  const table = '<w:tbl><w:tr>' + '<w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc>'.repeat(1000) + '</w:tr>' + '<w:tr><w:tc><w:p/></w:tc></w:tr>'.repeat(1000) + '</w:tbl>';
  const doc = zip({ 'word/document.xml': '<w:document><w:body>' + table + '</w:body></w:document>' });
  assert.equal((await api.files.fileAttachment('Wide.docx', doc)).text, undefined);
  assert.ok((await api.files.fileAttachment('Normal.docx', DOCX)).text);
});
