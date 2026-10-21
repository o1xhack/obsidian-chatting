# Chatting with AI

[![Latest release](https://img.shields.io/github/v/release/o1xhack/obsidian-chatting?include_prereleases&label=release&color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![Total downloads](https://img.shields.io/github/downloads/o1xhack/obsidian-chatting/total?color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![License](https://img.shields.io/github/license/o1xhack/obsidian-chatting?color=7c3aed)](LICENSE)
[![Obsidian](https://img.shields.io/badge/obsidian-1.11.4%2B-7c3aed)](https://obsidian.md)
<br>
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-o1xhack-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/o1xhack)

**A mobile-first AI assistant that reads, edits and organizes your Obsidian vault through conversation.**

> 🌐 **English** · [简体中文](docs/i18n/README.zh-CN.md) · [繁體中文](docs/i18n/README.zh-TW.md) · [日本語](docs/i18n/README.ja.md)

<p align="center">
  <img src="assets/screenshot-settings.png" alt="Provider settings on iPhone" width="260">
  <img src="assets/screenshot-chat-cn.png" alt="Web search powered answer in Chinese" width="260">
  <img src="assets/screenshot-chat-en.png" alt="Clean answer in English with bullet list" width="260">
</p>

---

## ✨ Work with your vault through conversation

Chatting with AI turns conversation into work in Obsidian: find related notes, improve a draft, organize a project or update a Canvas, then keep the task moving across chats and longer conversations. It brings together seven core capabilities:

- 📱 **Mobile-first, interactive chat** — read answers as they arrive and add a follow-up while the assistant works, on phone, tablet or desktop. No vault index or separate backend to set up.
- 🧰 **Vault actions and connected tools** — use 22 built-in tools for notes, files, properties, links, Canvas and web pages; optionally connect remote MCP tools with an Anthropic or OpenAI API key.
- 📎 **The context you choose** — work from the active note, constrain an edit to selected text, mention files with `@` or `[[`, and bring images, PDFs and Office documents into the conversation.
- 🧩 **Your repeatable workflows** — teach the assistant your vault conventions with `AGENTS.md` and reusable Skills, or invoke a skill directly with `/name`.
- 👀 **Changes you can follow and undo** — jump to edited passages and Canvas cards, inspect the steps and undo an answer's changes while its snapshots are available in the current session.
- 💬 **Conversations you can steer and revisit** — keep named chats for different tasks, switch while answers continue, and return to saved conversations after a restart.
- 🧠 **Long chats with visible usage** — see context use and token totals, check API cost estimates where pricing is available, and summarize earlier context to keep a conversation going.

Connect through **Anthropic API**, **OpenAI API**, or **your ChatGPT account**. Choose the provider that fits how you already use AI.

## 🎬 What you can do

### Work across notes, files and Canvas

Ask in ordinary language. The assistant chooses the tools, reads the relevant material and makes changes in your vault.

> Find the notes in Books that are missing a rating, and add `rating: ?`.
>
> Compare these meeting notes and turn the decisions into a project plan.
>
> Group the ideas on this Canvas and connect the related cards.

Search by content, tags or properties; inspect incoming, outgoing and unlinked mentions; read and edit Canvas cards and connections; inspect vault images and load web pages as text.

With an **Anthropic or OpenAI API key**, add public HTTPS MCP servers to bring tools from other services into the conversation. The provider connects to enabled servers; their calls and results appear alongside vault-tool steps. Remote MCP is not available through this plugin's ChatGPT account connection, and local or stdio servers are not supported.

### Give each task the right context

Start with the active note, or type `@` / `[[` to include specific vault files. Attach images, PDFs, Word, Excel, PowerPoint and text files from the composer or clipboard. Canvas files can be shared as an outline or inspected visually by the assistant.

For a focused rewrite, select a passage and choose **Send selection to chat**. The tools restrict direct edits to that selection in the selected note. Other notes remain editable, and Obsidian can still update links when another file is renamed.

### Teach it how you work

A root `AGENTS.md` supplies vault-wide instructions; a folder's `AGENTS.md` adds rules when the assistant first works in that folder during a conversation. Keep reusable tasks in the vault's `Skills` folder, each with a `SKILL.md`, templates and examples. The assistant can load a matching skill, or you can pick one with `/`.

Skills use the Claude Code / Codex folder format. Their instructions and supporting files can be read; bundled scripts are not executed.

### Talk to it

Press the voice button and say what you want: the assistant answers aloud, you can interrupt it or add to a running task, and the work is done by the chat model you selected, with its steps in the chat. Voice uses your ChatGPT account sign-in (Codex's voice service; availability depends on the account). See [Voice](docs/user-guide.md#-voice).

### Review changes and undo vault work

**Follow the AI's edits** opens changed passages or Canvas cards without taking focus from chat. Finished tool steps fold into a compact row you can expand. Per-answer **Undo** restores recorded edits, creations, renames and deletions; it asks before overwriting files that changed afterward. Snapshots are bounded and kept in memory, so undo is unavailable after a restart or when its snapshots expire.

### Keep conversations moving

Create, switch, rename and delete separate chats. Each has its own provider conversation, and switching chats leaves an already-sent answer running in its own chat. The list shows *Answering…*; questions wait in that chat until you return. You can type and send more while it works: text joins the next step or becomes the next turn, while new attachments and selections wait for the next turn.

If switching apps or locking a phone interrupts a request, the plugin can resume eligible transient failures when you return. After a restart, **Continue** is offered for eligible pending turns. This is recovery when Obsidian returns, not a guarantee that a phone keeps running in the background. If a remote MCP action may already have run, check the external service before retrying; uncertain remote requests are not automatically repeated.

Answers stream where the connection supports it; otherwise they arrive together. Stop keeps text already shown. Markdown, tables, wiki links and math render in the chat, and reading earlier messages does not pull you to the bottom. Copy answers, edit messages still in the model's retained history, or regenerate the last answer; editing and regenerating do not undo file changes.

### Keep long chats useful

The header's context ring shows how much of the model's window the conversation uses. Open it for token totals, **estimated API cost when pricing is available**, and **Compact now**. ChatGPT account chats link to plan usage instead of estimating subscription charges.

Set **Compaction point** to choose when earlier model context is summarized, or compact manually. The full visible conversation stays readable as earlier turns load when you scroll up, while the model continues from the summary and recent context. Summaries can lose detail; messages covered by the last compaction can no longer be edited or regenerated.

Chats are saved as individual local files and loaded when opened; settings show total saved-chat size, and larger chats show their own size in the list. Existing chats migrate with a backup of the old history file. Local history storage is separate from the model's context window and does not make that window unlimited.

## ⚙️ Three ways to connect

| Connection | What you need | How it works | Remote MCP |
|---|---|---|---|
| **Anthropic** | Anthropic API key | Claude models, with model-dependent thinking and web search. | Supported |
| **OpenAI** | OpenAI API key | OpenAI models through the Responses API, with model-dependent reasoning and web search. | Supported |
| **ChatGPT account** | A ChatGPT plan with Codex access | Sign in with your account and use its available Codex models. | Not available in this connection |

Model lists are fetched from your provider or account and cached for 24 hours. Refresh them manually at any time; supported thinking levels follow the catalog where available. Available models and access depend on your provider and account.

Desktop ChatGPT sign-in opens your browser and returns automatically. Device-code sign-in is available on desktop and is the current mobile method. Credentials are stored per device; syncing your vault does not sign in another device.

## 🚀 Quick start

Requires **Obsidian 1.11.4 or later**, on desktop, iOS or Android.

1. Open **Settings → Community plugins → Browse**.
2. Search for **Chatting with AI**, then **Install** and **Enable**.
3. Open **Settings → Chatting with AI** and choose a provider.
4. Add its API key or connect your ChatGPT account.
5. Open chat from the ribbon or command palette and ask about a note.

## 📦 Install

### Community Plugins (recommended)

This is the default install path now that Chatting with AI is in the official Obsidian Community Plugins directory.

1. In Obsidian, open **Settings → Community plugins**.
2. If prompted, turn off Restricted Mode / turn on community plugins.
3. Click **Browse** and search for **Chatting with AI**.
4. Click **Install**, then **Enable**.

### Migrating from BRAT

If you previously installed the beta through BRAT, move to the community version once it appears in the plugin browser:

1. In **Settings → Community plugins → Installed plugins**, disable **Chatting with AI**.
2. Open **BRAT** settings and remove `o1xhack/obsidian-chatting` from the beta plugin list.
3. Return to **Settings → Community plugins → Browse** and search for **Chatting with AI**.
4. If Obsidian shows it as **Installed**, open its entry and click **Enable**. If it shows **Install**, click **Install**, then **Enable**.
5. Open **Settings → Chatting with AI** and confirm your provider settings are still present.

The plugin migrates data from the old `obsidian-chatting` folder to `chatting-with-ai` on first load. If you used a very old beta and the community browser does not recognize it as installed, installing the community version is still safe; the migration runs when the new plugin starts.

<details>
<summary><b>Manual release install</b></summary>

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/o1xhack/obsidian-chatting/releases/latest)
2. Place them in `<vault>/.obsidian/plugins/chatting-with-ai/`
3. Reload Obsidian and enable **Chatting with AI** in Community Plugins

</details>

<details>
<summary><b>Build from source</b></summary>

```bash
git clone https://github.com/o1xhack/obsidian-chatting.git
cd obsidian-chatting
npm install
npm run build
```

Symlink into a test vault:

```bash
ln -s "$(pwd)" /path/to/vault/.obsidian/plugins/chatting-with-ai
```

</details>

## 🔐 Privacy and control

- **No background vault upload or index.** Messages, active-note context, linked or attached files, loaded instructions and material read by tools go to your selected provider as needed for the conversation. This is a cloud-model assistant, not an on-device model.
- **Credentials use Obsidian SecretStorage.** API keys and ChatGPT sign-in credentials are kept out of the plugin's `data.json`; connect each device separately.
- **Chat history stays in your vault's plugin folder.** Named conversations are listed in `chat-state.json`, each chat in its own file in the `chats` folder. The plugin has no chat-sync service; whether these files travel to another device depends on your sync setup. Attachment data is bounded, and older attachments can remain as name-only chips.
- **Changes happen in your vault.** Selection restrictions apply to direct edits of the selected note. Undo needs live snapshots; use your normal backups or version history for longer-term recovery.
- **MCP servers start off; enabled servers act without asking for each call.** The provider can share conversation context and the configured token with their tools. Add only servers you trust; tokens are stored in this device's SecretStorage. Stop cannot recall a remote request, and vault Undo does not undo external MCP changes.
- **Web pages and attachments are external input.** Web-page reading uses your device's network, including addresses it can reach locally. Treat instructions hidden in pages or files as untrusted. Large attachments and requests are limited to protect device memory and request size.

For attachment limits, provider-specific PDF/Office handling, the complete tool list, settings and recovery details, see the **[user guide](docs/user-guide.md)**. Recorded validation scope is in the [desktop and iPhone QA notes](docs/phase1-review.md).

## 🗺️ What's next

Vault and Canvas work, chosen context, Skills, review/undo, streaming, conversation steering, long-chat compaction and usage tracking are available today. Remote MCP is optional for Anthropic/OpenAI API-key connections. **Archiving and searching past conversations remain on the roadmap.** See [releases](https://github.com/o1xhack/obsidian-chatting/releases) for version-by-version changes, or [open an issue](https://github.com/o1xhack/obsidian-chatting/issues) with feedback.

## 🤝 Contributing

Issues and PRs are welcome. Run `npm test`, `npx tsc --noEmit`, `npm run svelte-check` and `npm run build` for code changes, and test on at least one mobile platform for changes that affect the app. For larger changes, open an issue first.

## 🙏 Acknowledgements

Originally derived from [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat) (MIT); the original copyright is preserved in `LICENSE`. Chatting with AI is now an independent project with its own agent loop, mobile support, ChatGPT account provider and vault workflows.

Thanks to [Thomas Schierl](https://github.com/thomas0schierl) for contributions to chat persistence, rendering, vault tools and the regression-test harness.

## 📄 License

[MIT](./LICENSE).

---

Author: [Yuxiao (o1xhack)](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
