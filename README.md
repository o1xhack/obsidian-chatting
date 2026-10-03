# Chatting with AI

[![Latest release](https://img.shields.io/github/v/release/o1xhack/obsidian-chatting?include_prereleases&label=release&color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![Total downloads](https://img.shields.io/github/downloads/o1xhack/obsidian-chatting/total?color=7c3aed)](https://github.com/o1xhack/obsidian-chatting/releases)
[![License](https://img.shields.io/github/license/o1xhack/obsidian-chatting?color=7c3aed)](LICENSE)
[![Obsidian](https://img.shields.io/badge/obsidian-1.11.4%2B-7c3aed)](https://obsidian.md)
<br>
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-o1xhack-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/o1xhack)

**An agentic AI assistant that lives in your Obsidian vault — same experience on phone, tablet, and desktop.**

> 🌐 **English** · [简体中文](docs/i18n/README.zh-CN.md) · [繁體中文](docs/i18n/README.zh-TW.md) · [日本語](docs/i18n/README.ja.md)

<p align="center">
  <img src="assets/screenshot-settings.png" alt="Provider settings on iPhone" width="260">
  <img src="assets/screenshot-chat-cn.png" alt="Web search powered answer in Chinese" width="260">
  <img src="assets/screenshot-chat-en.png" alt="Clean answer in English with bullet list" width="260">
</p>

---

## ✨ Why?

- **Three providers, your choice** — Anthropic API, OpenAI API, or sign in with your ChatGPT account. No marketplace of half-broken providers.
- **14 vault-native tools** — read, edit, search, create, rename, frontmatter, backlinks. The agent goes from idea to changed files without leaving the chat.
- **Mobile-parity, by design** — no streaming, no Node-only modules, no localhost callbacks. iOS and Android behave the same as desktop.
- **Selection scope** — highlight text in any note, send it to chat, the assistant edits only inside the selection.
- **Secrets in the OS keychain** — never in `data.json`, never synced across devices.

## 🎬 One conversation, many tools

Ask once, the agent figures out which tools to call:

```
You: Find every note in /Books that's missing a `rating` property and add `rating: ?`.

Assistant
  → search_vault("/Books")               → 12 files
  → get_properties("Books/Sapiens.md")   → has rating
  → get_properties("Books/Hail Mary.md") → no rating
  → set_properties("Books/Hail Mary.md", { rating: "?" })
  → ... (5 more)

  Done — added `rating: ?` to 6 notes:
  - Books/Hail Mary.md
  - Books/Klara and the Sun.md
  - ...
```

The agent reads before it edits, prefers small surgical changes over rewrites, and doesn't re-ask once you confirm.

## 🎯 Selection scope

Highlight text in any note, right-click, choose **Send selection to Chat**. The selection becomes a pill above the input and the assistant edits only inside the selected range — leaving the rest of the document byte-identical.

```
[ pill: "...the introduction was a bit dry, and..."  ✕ ]

You: tighten this — keep my voice
```

The agent uses find-and-replace scoped to the selection text. Everything outside the highlight stays untouched.

## 🛠️ 14 vault-native tools

| Group | Tools | What they do |
|---|---|---|
| **Read** | `read_document`, `read_file`, `search_vault`, `list_files`, `get_backlinks`, `get_properties`, `get_current_datetime` | Open notes/files, search by name and content, browse the tree, find backlinks, read frontmatter, fetch the current time in your locale. |
| **Write** | `edit_document`, `create_file`, `set_properties` | Surgical find-and-replace / insert / full replace; create new notes (parent folders auto-created); safe YAML frontmatter merge or remove. |
| **Manage** | `rename_file`, `delete_file`, `open_document`, `ask_user` | Rename or move (links auto-update); move to trash (respects your trash setting); open a file in the editor; pause and ask you when something is ambiguous. |

## ⚙️ Providers

| Provider | Auth | Default model | Notes |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | Adaptive thinking, web search, prompt caching. |
| **OpenAI** | API key | GPT-6.1 Sol | Responses API, reasoning, web search. |
| **ChatGPT account** | Sign in with ChatGPT | GPT-5.5 | Uses your ChatGPT plan instead of an OpenAI API key. |

Attach up to four images to a message, including by pasting an image from the clipboard. Images are sent with that message to the selected provider; large photos are resized before sending.

> **About ChatGPT account login.** This provider signs you in with your ChatGPT account and routes requests through the ChatGPT/Codex backend (not `api.openai.com`). It requires an active ChatGPT plan with Codex access. The model picker fetches the Codex catalog for your account; account permissions still determine whether a model can be used.

### Model list updates

All three providers load their authenticated model catalogs in settings. Lists are cached for 24 hours and survive restarts. Settings show the last list immediately, then refresh it in the background when expired. No daily timer or request on every settings visit is scheduled. The refresh button checks immediately. Failed requests retain the last list and selected model; account/API-key changes use a separate cache.

ChatGPT OAuth discovers the latest stable client version from OpenAI's official GitHub release metadata and keeps the last known version or bundled fallback if discovery fails. Reasoning effort, reasoning summaries and parallel-tool options follow catalog metadata where provided. New model IDs normally require no plugin update, but upstream protocol changes can still require one. Custom model IDs survive reload. Catalog data contains no credentials.

## 🚀 Quick start

1. Open **Settings → Community plugins → Browse**.
2. Search for **Chatting with AI**.
3. Click **Install**, then **Enable**.
4. **Settings → Chatting with AI** → pick a provider, paste an API key (or click **Connect ChatGPT**).
5. Open the chat from the ribbon icon or the command palette.

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

## 🧭 Design principles

| Principle | What it means |
|---|---|
| **Mobile is not an afterthought** | Every change is validated on iOS and Android. No streaming, no Node-only modules, no localhost callbacks. |
| **Three sane providers** | Anthropic + OpenAI for stability, ChatGPT account for users who'd rather not manage an API key. |
| **Secrets in the keychain** | API keys and OAuth credentials go through Obsidian SecretStorage. They never land in `data.json`, so they never sync to other devices. |
| **No vault indexing** | Linear search, capped. Predictable, no background work, no memory pressure on phones. |
| **Conversation persists** | Chat history survives Obsidian restarts. Stored locally in `chat-state.json`, never synced. |
| **Right sidebar on mobile** | Slides in from the edge — your document stays visible underneath. |

## 🗺️ Roadmap

- [x] Three providers (Anthropic, OpenAI, ChatGPT account)
- [x] 14 vault-native tools
- [x] iOS / Android parity
- [x] Selection scope
- [x] Official Obsidian Community Plugins listing
- [ ] Multi-conversation history with archive / search
- [x] Image attachments where the provider supports them
- [x] Dynamic provider catalogs with automatic refresh when the 24-hour cache expires

Have a request? Open an issue.

## ❓ FAQ

<details>
<summary><b>Will my notes be uploaded somewhere?</b></summary>

Only what the agent needs for the current turn. When you ask a question, the agent decides which tools to call — `read_document`, `search_vault`, etc. — and the contents fetched by those calls (plus the active note context) are sent to your chosen provider. Images you attach are sent with that message and retained in local chat history until you clear the conversation. Nothing is uploaded in the background. There is no vault index.

</details>

<details>
<summary><b>Does it really work on mobile?</b></summary>

Yes — that's the design constraint everything else is built around. Requests go through Obsidian's `requestUrl()` (mobile WebViews enforce CORS), there's no streaming, no Node-only modules, no localhost callback for OAuth. iOS and Android run the same code path as desktop.

</details>

<details>
<summary><b>Is the ChatGPT account login free?</b></summary>

It uses your existing ChatGPT plan (Plus, Pro, Team, Enterprise) — there's no separate billing. You need an active plan with Codex access. The plugin doesn't talk to `api.openai.com`; it talks to the same backend the Codex CLI uses.

</details>

<details>
<summary><b>Can you add provider X?</b></summary>

Probably not — keeping the provider list small is a deliberate choice. Two API providers cover the major ecosystems, and ChatGPT account login covers the "I just have a ChatGPT plan" case. Adding more would mean more permutations to validate on mobile.

</details>

<details>
<summary><b>Where is chat history stored? Will it sync?</b></summary>

Locally in `<vault>/.obsidian/plugins/chatting-with-ai/chat-state.json`. It is **not** synced by Obsidian Sync (plugin data files are excluded by default). API keys live in the OS keychain via SecretStorage and are also not synced. Attached image data is retained in this local chat history until you clear the conversation.

</details>

## 🤝 Contributing

Issues and PRs welcome. Before opening a PR:

- Run `npx tsc --noEmit` and `npm run svelte-check`
- Test on at least one mobile platform (iOS or Android) — the mobile-parity rule is real
- For larger changes, open an issue first to align on direction

## 🙏 Acknowledgements

Originally derived from [omarshahine/obsidian-chat](https://github.com/omarshahine/obsidian-chat) (MIT). The original copyright is preserved in `LICENSE`. Chatting with AI is now an independent project with its own roadmap — major rewrites include the agent loop, mobile-parity work, the ChatGPT account provider, and the selection-scope feature.

## 📄 License

[MIT](./LICENSE).

---

Author: [Yuxiao (o1xhack)](https://github.com/o1xhack) · [app.o1xhack.com](https://app.o1xhack.com)
