// Native Svelte/view/loop/executor QA in the dedicated test vault. The
// isolated bundle replaces transport only. A temporary helper plugin gives
// it Obsidian's module loader; it never replaces the installed chat plugin,
// reads credentials, or saves the user's conversations/settings.
import { build } from 'esbuild';
import esbuildSvelte from 'esbuild-svelte';
import { sveltePreprocess } from 'svelte-preprocess';
import { readFile, writeFile, readdir, mkdir, rm, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = '/Volumes/StudioSSD/Obsidian/ob 插件测试';
const output = resolve('..');
const bundle = `${output}/native-pr-56-59.cjs`;
const volume = execFileSync('diskutil', ['info', '-plist', '/Volumes/StudioSSD'], { encoding: 'utf8' });
if (!volume.includes('<string>9D5FE511-B66C-4765-BB8F-61E5ACB3969D</string>')) throw new Error('Wrong StudioSSD volume');
for (const path of [root, process.cwd(), output]) {
  if (!(await realpath(path)).startsWith('/Volumes/StudioSSD/')) throw new Error('Path outside StudioSSD');
  await access(path, constants.W_OK);
}
const evalCode = code => execFileSync('obsidian', ['eval', 'vault=ob 插件测试', `code=${code}`], { encoding: 'utf8', timeout: 15000 });
if (!evalCode('app.vault.adapter.getBasePath()').includes(root)) throw new Error('Wrong vault');
async function hashes(dir = root, prefix = '') {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (path.startsWith('.') || path.startsWith('QA/PR-56-59-')) continue;
    if (entry.isDirectory()) Object.assign(result, await hashes(`${dir}/${entry.name}`, `${path}/`));
    else if (entry.isFile()) result[path] = createHash('sha256').update(await readFile(`${dir}/${entry.name}`)).digest('hex');
  }
  return result;
}
const before = await hashes();
await build({
  stdin: { contents: "export {default as ChatPlugin} from './src/main'; export {ObsidianChatView} from './src/ui/chat-view'; export {DEFAULT_SETTINGS} from './src/types';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022', outfile: bundle,
  external: ['obsidian', 'electron', 'http'],
  plugins: [esbuildSvelte({ compilerOptions: { css: 'injected' }, preprocess: sveltePreprocess() }), {
    name: 'native-qa-no-network', setup(builder) {
      builder.onLoad({ filter: /src\/api\/stream\.ts$/ }, async args => ({ loader: 'ts', contents: (await readFile(args.path, 'utf8'))
        .replace('return window.fetch(url, init);', 'return Promise.reject(new TypeError("Native QA: use mock requestUrl"));')
        .replace('function nodeHttps(): NodeHttps | undefined {', 'function nodeHttps(): NodeHttps | undefined { return undefined;') }));
    },
  }],
});

function probe(bundlePath, vaultRoot) {
  globalThis.__chattingPR5659QA = { status: 'running' };
  void (async () => {
    const checks = [];
    globalThis.__chattingPR5659QA.checks = checks;
    const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
    let view, host, leaf;
    try {
      const fs = require('fs'), obsidian = require('obsidian');
      check(app.vault.adapter.getBasePath() === vaultRoot, 'correct dedicated vault');
      const qa = `QA/PR-56-59-${Date.now()}`;
      globalThis.__chattingPR5659QA.stage = 'create folder';
      await app.vault.createFolder(qa);
      globalThis.__chattingPR5659QA.stage = 'create files';
      for (let i = 0; i < 4; i++) await app.vault.create(`${qa}/N${i}.md`, String(i).repeat(80000));
      const editPath = `${qa}/Edit.md`;
      await app.vault.create(editPath, 'Original');
      const requests = [];
      const transport = async request => {
        if (request.method !== 'POST') throw new Error('Unexpected network request');
        requests.push(JSON.parse(request.body));
        const i = requests.length - 1;
        const block = i < 4
          ? { type: 'tool_use', id: `read-${i}`, name: 'read_document', input: { path: `${qa}/N${i}.md` } }
          : i < 6 ? { type: 'tool_use', id: `edit-${i}`, name: 'edit_document', input: { path: editPath, operation: 'replace_all', content: `Edit ${i}` } }
          : { type: 'text', text: 'Native QA complete' };
        const tool = block.type === 'tool_use';
        const events = [
          { type: 'message_start', message: { id: `qa-${i}`, role: 'assistant', type: 'message', content: [], usage: { input_tokens: 10, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
          { type: 'message_stop' },
        ];
        return { status: 200, headers: {}, text: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') };
      };
      const loaded = { exports: {} };
      globalThis.__chattingPR5659QA.stage = 'load bundle';
      const proxy = new Proxy(obsidian, { get: (target, key) => key === 'requestUrl' ? transport : Reflect.get(target, key) });
      new Function('require', 'module', 'exports', fs.readFileSync(bundlePath, 'utf8'))(id => id === 'obsidian' ? proxy : require(id), loaded, loaded.exports);
      const { ChatPlugin, ObsidianChatView, DEFAULT_SETTINGS } = loaded.exports;
      const plugin = new ChatPlugin(app, { id: 'chatting-pr5659-qa', name: 'PR 56–59 QA', version: '0.0.0', minAppVersion: '1.8.0' });
      globalThis.__chattingPR5659QA.stage = 'mount UI';
      plugin.settings = { ...DEFAULT_SETTINGS, provider: 'anthropic', apiKey: 'synthetic-native-qa', model: 'claude-sonnet-4-6', maxIterations: 3, enableWebSearch: false, followEdits: false };
      plugin.saveChatHistory = async () => {};
      plugin.saveSettings = async () => {};
      leaf = app.workspace.getLeaf('tab');
      view = new ObsidianChatView(leaf, plugin);
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;inset:60px 24px 40px auto;width:440px;background:var(--background-primary);z-index:9999;border:1px solid var(--background-modifier-border)';
      document.body.appendChild(host); host.appendChild(view.containerEl);
      view.mountChat();
      const chat = view.chatContainer;
      globalThis.__chattingPR5659QA.stage = 'run first segment';
      const tick = () => new Promise(resolve => setTimeout(resolve, 30));
      await view.handleUserMessage('Read the four QA notes, edit Edit.md twice, then answer.', null);
      await tick();
      check(!!host.querySelector('.ochatting-continue-row'), 'Continue renders at step limit');
      check(!host.querySelector('.ochatting-steps svg[stroke-width="3"]'), 'unfinished work has no success check');
      await view.continueTurn(); await tick();
      check((await app.vault.cachedRead(app.vault.getFileByPath(editPath))) === 'Edit 5', 'continued edits execute once');
      check(!!host.querySelector('.ochatting-continue-row'), 'second pause renders Continue');
      await view.continueTurn(); await tick();
      check(requests.length === 7, 'six tool steps and one answer without replay');
      check(!host.querySelector('.ochatting-continue-row'), 'Continue disappears after final answer');
      check(host.textContent.includes('Native QA complete'), 'final answer renders');
      check(host.querySelectorAll('.ochatting-steps').length === 1, 'continued answer folds into one steps row');
      check(plugin.chatHistory.filter(row => row.type === 'changes').length === 1, 'one changes record across continuations');
      const reads = requests[6].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result' && b.tool_use_id?.startsWith('read-'));
      check(reads.length === 4 && reads.every(b => typeof b.content === 'string' && b.content.length >= 80000 && !b.content.includes('Tool text truncated')), '320k current-turn read text retained');
      const turnId = plugin.chatHistory.find(row => row.type === 'changes').turnId;
      await view.undoChanges(turnId); await tick();
      check((await app.vault.cachedRead(app.vault.getFileByPath(editPath))) === 'Original', 'one undo restores both continued edits');
      chat.setUsage({ contextTokens: 40000, contextWindow: 200000, compactAt: 160000, inputTokens: 40000, outputTokens: 0, partialCost: false, plan: true });
      await tick();
      const ring = host.querySelector('.ochatting-usage-btn');
      check(ring?.title.includes('25 %'), 'context ring uses compaction denominator');
      ring.click(); await tick();
      check(host.textContent.includes('Compacts at') && host.textContent.includes('160k (25 % reached)'), 'context details show threshold and progress');
      globalThis.__chattingPR5659QA = { status: 'succeeded', checks, scope: 'Native Obsidian Svelte/view/loop/executor; synthetic provider transport; no live-service or physical-phone claim' };
    } catch (error) {
      globalThis.__chattingPR5659QA = { status: 'failed', checks, error: error.stack };
    } finally {
      await view?.onClose(); host?.remove(); leaf?.detach();
    }
  })();
}
const helperId = `chatting-pr5659-qa-${Date.now()}`;
const helperDir = `${root}/.obsidian/plugins/${helperId}`;
const manifest = { id: helperId, name: 'PR 56–59 native QA', version: '0.0.0', minAppVersion: '1.8.0', isDesktopOnly: true, author: 'Local QA', description: 'Temporary controlled native QA', dir: `.obsidian/plugins/${helperId}` };
await mkdir(helperDir);
await writeFile(`${helperDir}/manifest.json`, JSON.stringify(manifest));
await writeFile(`${helperDir}/main.js`, `const {Plugin}=require('obsidian'); module.exports=class extends Plugin { onload() { (${probe.toString()})(${JSON.stringify(bundle)},${JSON.stringify(root)}); } };`);
let report;
try {
  evalCode(`globalThis.__chattingPR5659QA={status:'running',stage:'loading helper'}; app.plugins.manifests[${JSON.stringify(helperId)}]=${JSON.stringify(manifest)}; void app.plugins.loadPlugin(${JSON.stringify(helperId)}).catch(error=>globalThis.__chattingPR5659QA={status:'failed',error:error.stack});`);
  for (let i = 0; i < 100; i++) {
    const value = evalCode('JSON.stringify(globalThis.__chattingPR5659QA)');
    report = JSON.parse(value.slice(value.indexOf('=> ') + 3).trim());
    if (report.status !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
} finally {
  evalCode(`app.plugins.unloadPlugin(${JSON.stringify(helperId)}); delete app.plugins.manifests[${JSON.stringify(helperId)}];`);
  await rm(helperDir, { recursive: true });
}
const after = await hashes();
report.protectedFiles = Object.keys(before).length;
report.protectedFilesUnchanged = JSON.stringify(before) === JSON.stringify(after);
await writeFile(`${output}/native-qa.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'succeeded' || !report.protectedFilesUnchanged) process.exitCode = 1;
