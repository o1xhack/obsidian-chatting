# User guide

[← Project overview](../README.md)

Detailed workflows, tool reference, settings, installation and privacy notes.

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

## 🎤 Voice

Talk with the assistant in the current chat and hear the answer. Voice needs the **ChatGPT account** sign-in (the same as the ChatGPT provider; connect it there or under **Settings → Chatting with AI → Voice**), whichever provider you chat with. It uses Codex's voice service with that account; access and limits depend on the account. The chat model uses your selected provider as usual. Like the ChatGPT provider's Codex route, OpenAI doesn't document it for other apps, so it may change or stop working.

Voice working in the regular ChatGPT app does not guarantee access to Codex voice. A generic **HTTP 404 / Not Found** when starting a call can mean this service is unavailable for the account; it does not identify the cause by itself. Check [Codex voice availability](https://learn.chatgpt.com/docs/features/voice), including plan, rollout and workspace access. The plugin keeps the service error and request ID when provided and does not block an account based on its plan.

- **Start:** the voice button (a circle with sound-wave bars) sits where Send is. It shows while the input is empty, nothing is attached, no answer is running and the AI isn't waiting for your answer to a question.
- **During a call** the voice bar replaces the input row: the microphone button (tap to mute) or, with *Hold to talk*, the button you hold while speaking; a line showing your current words, or else whether the assistant is listening, working or speaking; and a red **✕** to end.
- **In the chat:** your requests and the answers appear as chat messages, tool steps included, and the voice reads the answer out in short. Small talk the voice handles itself is only heard.
- **Say more while it works:** what you add is passed to the running task instead of starting over. If the AI asks you a question, answer it by voice.
- **Editing or regenerating a voice request:** retains the preceding voice dialogue, also after restarting Obsidian, so references such as “do that” keep their context.
- **If voice stops and asks you to restart:** it could not safely tell whether your words were a new request. The accepted task continues in chat; unsent voice additions are discarded. Check its result, then start voice again before making another request.
- **Ending:** the **✕**, switching or starting a chat, Clear, or closing the chat panel. On a phone the microphone goes off while Obsidian is in the background; the call reconnects when you come back and ends after a minute away. If delegated work is still running, reconnection waits for its result, then includes that result in the new call without rerunning the task. A pending clarification is kept, so your reply after returning can continue that request. The voice bar shows a task-ended notice or the pending question after reconnecting. Automatic spoken recovery can stay quiet; the result is in chat, and you can ask the voice to read it.
- **Settings:** **ChatGPT account for voice** (connected or not), **Voice** (how it sounds) and **Microphone** (*Hands-free* or *Hold to talk*).

The contributor reports desktop and Android testing, including a Bluetooth headset. Maintainer verification for this candidate is recorded in [the voice review](phase7-review.md); physical iOS support has not been verified. The phone asks for microphone access the first time. **Check device capabilities (voice, streaming)** in the command palette shows what the device supports (microphone, live audio, streaming) in a window you can copy; with your keys it sends short test requests (which cost a little), and with the ChatGPT account it starts a voice call for a moment.

## 🎯 Selection scope

Highlight text in any note, right-click, choose **Send selection to chat**. The selection becomes a pill above the input, and the tools restrict direct edits of that note to the selected range.

```
[ pill: "...the introduction was a bit dry, and..."  ✕ ]

You: tighten this — keep my voice
```

Once sent, the message shows the selection it worked on above it, like a quote.

The agent uses find-and-replace scoped to the selection text, and the tools enforce it for that turn: in that note, only the highlighted copy of the text can change; rewriting the whole note, inserting, setting properties, or renaming or deleting it (or a folder it's in) is refused. The editor snapshot keeps the selected copy anchored when text is added above it. If the selected text changed or its identity is ambiguous, the tools ask you to select it again. Other notes stay editable, and renaming one of them still updates links to it in this note.

## 🔗 Mention notes

Type `@` (at the start or after a space) or `[[` in the input and pick a file: recent files come first, and typing narrows the list. The file goes into your message as a link (`[[Plan]]`). When you send it, the current content of each file the message links to goes along, so the AI doesn't have to look it up first: a note's text (up to 20,000 characters per note, 60,000 per message), a canvas as its outline, an image as an image, a PDF, Word, Excel or PowerPoint file as a file (see Providers below), other text files as text. Other files go by name only. The chat shows only what you typed.

## ✏️ Edit, copy, regenerate

Click the pencil under a message you sent to change it: the chat continues from there with the same images, files and selection, and what came after it is dropped. Changes the AI already made to notes stay. Messages from before the chat was last summarized have no pencil: the summary covers what came after them too. Every answer has **Copy** (its Markdown source); the last one also has **Regenerate**. With a mouse the buttons appear on hover; on touch screens they are always shown.

## 💬 Chats

The chat header shows the current chat's title, taken from your first message. **New chat** (the pen icon) starts a new one; so do the *New chat* command and the ribbon icon's right-click menu, and *Chat about this note* and *Send selection to chat* always start a new chat. The clock icon opens your chats, most recent first: open one to go on with it, rename it with the pencil, or delete it (you confirm first). **Clear** (the trash icon) empties only the current chat. The chat you had open is open again after a restart. An answer keeps running when you start a new chat or switch to another: the list shows *Answering…*, a notice says when it is ready or has a question for you, and going back shows it as far as it got. A message still reading its linked files, or an edit not yet answered, goes back to the input instead. Deleting a chat stops its answer. Each chat sends only its own messages to the provider.

### Read and steer an answer as it runs

Answers stream where the provider and connection allow it; the buffered fallback delivers them together. Stop keeps the text already shown. The input remains usable: send more text to add it at the next step, or to start the next turn if the current answer is finishing. It appears as *Queued* until taken in. New attachments and a selection wait for the next turn. Stop or Clear drops queued text; switching chats keeps it with its running task.

### Return to interrupted work

Switching to another chat does not stop an already-sent answer. Switching apps or locking the phone can interrupt the network: eligible transient failures can retry when Obsidian returns, with at most two recovery attempts per turn. This does not guarantee continued execution while a phone suspends the app.

A task that needs more steps than **Settings → Max tool iterations** allows (20 by default) pauses with a note; **Continue** goes on with as many steps again, and a new message instead starts a new turn. After an app restart, **Continue** can likewise finish an eligible saved pending turn, using the original user turn and the completed tool results without rerunning those tools. Selection fingerprints follow the answer's own edits across a pause; changes made outside that answer can still prevent scoped edits. Continued work shares one Undo while its snapshots remain available. Undoing a paused answer dismisses Continue. Continue is unavailable while Undo runs. If manual changes break the answer's undo snapshots between pauses, the complete answer is kept rather than offering an unsafe partial Undo. Continue is an explicit action, not an automatic restart.

Remote tools need a different recovery rule. If an MCP-capable request loses its response, it is not automatically sent again through a different transport: external operations may already have happened. After restart, an uncertain remote request shows a warning instead of Continue. Inspect the remote service before deciding whether to repeat an operation. Vault Undo does not reverse remote MCP changes.

## 🧠 Long conversations and usage

The context ring in the chat header shows the last request's context use: it is full when the chat reaches its compaction point (or the model's window, where no compaction point is known). Open it to see the chat's token totals, estimated API cost when model prices are available, and **Compact now**. ChatGPT account chats show a link to plan usage rather than a subscription-cost estimate. Estimates use recorded model token usage and available prices; they are not a final bill or a total of external tool charges.

**Settings → Compaction point** controls when earlier model context is summarized. The default follows the catalog where provided, otherwise a model-window-based threshold; you can adjust the share or token count. If the provider cannot compact that conversation, the plugin can summarize with the same model. **Compact now** runs this manually. Summarization itself uses model tokens and may lose detail; it does not expand the model's context window.

The visible conversation and the model's context are separate. Earlier messages stay readable in the saved chat, loaded as you scroll up, while future requests use the summary and recent context. Messages covered by the last compaction cannot be edited or regenerated; a summary is not a verbatim memory of every attachment or detail. Full visible history also does not mean every old attachment payload remains available (see the storage FAQ).

Chats are stored in individual files and loaded when opened. **Saved chats** in settings shows their total size; chats over 5 MiB show their size in the list. Upgrading the old single-file history creates the per-chat files only after preserving a backup; a failed backup prevents migration and saving for that session. For file names, interrupted-save recovery and downgrade behavior, see [Where is chat history stored?](#-faq).

## 👀 Follow the AI's edits

When the AI changes a note or canvas, it opens next to the chat at the changed spot: changed text is highlighted, changed canvas cards are selected and centered. It opens in the tab that already shows the note, else in one reused tab that closes with Obsidian, so your own tab stays as it is, and the chat input keeps the focus. On a phone the note waits behind the chat until you close it. On by default; switch it with the eye button in the chat header or in the settings. Ask "show me …" and the AI opens a note at a passage or a canvas at a card for you.

## ↩️ Undo an answer's changes

While an answer runs you see each step; once it's done, its steps fold into one line above the answer ("Changed Plan · 3 steps", or "3 steps" when nothing changed). Click it for the steps and the changed files, and click a file to open it. The undo button next to it puts them back as they were before that answer, last change first: edited notes and canvases get their text back, created files and the folders made for them go to the trash (a folder only while it is empty), renamed files get their name back (links follow), and deleted files and folders return. If a file changed after the answer (by you or a later answer), the files are named and you're asked first. The AI is told with your next message in that chat, so it doesn't rely on the old content. If undo fails, it stops before older changes and can be retried. Deletion snapshots are limited to 1000 files / 32 MiB; larger deletions are refused. Undo works while its snapshots remain available in the current session. Snapshots are bounded to 32 MiB per answer and 64 MiB across live answers; a whole undo log expires when it cannot fit. They are kept in memory only, so after a restart the row is still there, without the button. Editing a message drops the rows of the answers after it, together with their undo.

## 📋 Your instructions in AGENTS.md

Put standing instructions for the AI (writing style, where new notes go, how you structure things) in an `AGENTS.md` note at the root of your vault; every chat follows them. A folder can have its own `AGENTS.md` for the notes in it: the AI gets it the first time in a chat that it reads or changes a file there, and it adds to the vault-wide one. The file follows the [agents.md](https://agents.md) convention, so other AI tools that read `AGENTS.md` use the same instructions. **Settings → Vault instructions** opens the file, or creates it with a short comment.

This is your vault's `AGENTS.md`, not the one in this plugin's source code (that one is a guide for its developers). Up to 32,768 characters of each file are used.

## 🧩 Skills

Skills are instructions for particular tasks ("meeting notes from a transcript", "weekly review"): a folder each in your vault's `Skills` folder, with a `SKILL.md` note whose properties give the skill's `name` and `description` and whose text says how to do the task. Other files in the folder (templates, examples) belong to the skill; the AI reads them when the instructions call for them. It's the skills format of Claude Code and Codex, so a skill made for them works once its folder is copied into `Skills` (scripts in it don't run).

Every chat knows the names and descriptions of your skills; when a task matches a description, the AI loads that skill and follows it. To pick one yourself, type `/` in the input and choose it: `/meeting-notes` sends the skill's instructions along with your message. Up to 32,768 characters of each `SKILL.md` are used.

**Settings → Skills** sets the folder, lists your skills (each opens its `SKILL.md`) and starts a new one from a template with **New skill**. A skill without a description is listed, but the AI can't tell when to use it.

## 🔌 MCP servers

With an Anthropic or OpenAI API key, the assistant can use the tools of remote MCP servers (Linear, GitHub and others that offer one). Add a server under **Settings → MCP servers**: a name (letters, digits, `-`, `_`), its public https address and, if it needs one, a token. The provider connects to the servers that are on and calls their tools as the assistant decides; each call shows as a step ("Used create_issue on linear").

New servers start off. Configure the address and optional token, then switch on only servers you trust: their tools run without asking for each call. The assistant can send context from your conversation to those tools. Tokens are kept in SecretStorage on this device, never in `data.json`, and go to the provider with each request. Use the token field for credentials, not the address. Local servers aren't supported because the provider has to reach them. This plugin's ChatGPT account integration does not implement remote MCP yet; this does not mean subscription accounts cannot use MCP in other clients.

Switching a server off, removing it, or changing its address or authorization removes its native calls and cached tool lists from subsequent requests. Your conversation text remains. A request already sent to the provider may finish its remote tools even after Stop; the chat's Undo covers vault changes only, not changes made by MCP tools. If an answer is cut short, check reported remote results before retrying a write.

Remote tool text shares the chat's existing result-size budget. Non-text MCP results are omitted from saved/replayed history with a note; this release does not add MCP image or file attachment support.

## 🛠️ 22 vault-native tools

| Group | Tools | What they do |
|---|---|---|
| **Read** | `read_document`, `read_file`, `search_vault`, `list_files`, `get_links`, `get_properties`, `get_current_datetime` | Open notes/files (PDF, Word, Excel and PowerPoint files go to the model as files), search by name and content, browse the tree, find a note's links as the Backlinks and Outgoing links panes show them (linked mentions with their lines, unlinked mentions, outgoing links), read frontmatter, fetch the current time in your locale. |
| **Write** | `edit_document`, `create_file`, `set_properties` | Surgical find-and-replace / insert / full replace; create new notes (parent folders auto-created); safe YAML frontmatter merge or remove. |
| **Manage** | `rename_file`, `delete_file`, `open_document`, `ask_user` | Rename or move (links auto-update); move to trash (respects your trash setting); show you a note at a passage or a canvas at a card when you ask; pause and ask you when something is ambiguous. |
| **Query** | `query_notes`, `list_metadata` | Find notes by tags (nested tags too, all or any) and properties (a value or just set), in a folder, sorted by path, last change or a property ("my #project notes that are active, by due date"); list the tags and properties the vault uses. From Obsidian's metadata cache, without reading the notes. |
| **Canvas** | `read_canvas`, `edit_canvas` | Read a canvas as an outline of groups, cards and connections; add, change, move or remove cards and connections in one all-or-nothing step, with new cards placed so they don't overlap. `search_vault` also finds text on canvas cards and labels. |
| **Web** | `read_web_page` | Read a web page (a link you give, or one web search found) as Markdown, without navigation and scripts; long pages in parts. |
| **Images** | `view_image`, `view_canvas` | Look at an image in the vault (PNG, JPEG, GIF or WebP; large ones scaled down), or at a canvas as a picture of its layout with a legend of its cards, the whole canvas or zoomed to one group or card. |
| **Skills** | `use_skill` | Load one of your [skills](#-skills): its instructions and the list of its other files. |

## ⚙️ Providers

| Provider | Auth | Default model | Notes |
|---|---|---|---|
| **Anthropic** | API key | Claude Sonnet 4.6 | Adaptive thinking, web search, prompt caching. |
| **OpenAI** | API key | GPT-6.1 Sol | Responses API, reasoning, web search. |
| **ChatGPT account** | Sign in with ChatGPT | GPT-5.5 | Uses your ChatGPT plan instead of an OpenAI API key. |

Attach up to four images to a message, including by pasting an image from the clipboard. Images are sent with that message to the selected provider; large photos are resized before sending.

Attach up to four PDF, Word, Excel, PowerPoint or text files to a message as well (paperclip or paste, 10 MB each), mention them with `@`, or let the agent read them from your vault (`read_file`). Images and files together, including linked files, must fit a 20 MiB encoded attachment budget per message; base64 makes binary files about a third larger. The plugin also checks the full encoded request, including history, against a 30 MB limit before sending. If it is too large, remove some attachments or start a new chat. OpenAI and the ChatGPT account read PDF and Office files themselves; Anthropic reads PDFs, and for Anthropic the plugin reads the text of Word, Excel and PowerPoint files itself (without their images and charts; older `.doc`, `.xls` and `.ppt` files only by name). Text files go as text to all. A PDF is read with its page images, at the provider's token cost.

> **About ChatGPT account login.** This provider signs you in with your ChatGPT account and routes requests through the ChatGPT/Codex backend (not `api.openai.com`). It requires an active ChatGPT plan with Codex access. The model picker fetches the Codex catalog for your account; account permissions still determine whether a model can be used.

Desktop ChatGPT login opens your browser and returns automatically through a local callback. Device-code login remains available on desktop and is the current mobile login method. Sign-in credentials are stored per device; syncing a vault does not sign in another device.

### Model list updates

All three providers load their authenticated model catalogs in settings. Lists are cached for 24 hours and survive restarts. Settings show the last list immediately, then refresh it in the background when expired. No daily timer or request on every settings visit is scheduled. The refresh button checks immediately. Failed requests retain the last list and selected model; account/API-key changes use a separate cache. An expired list is also loaded once when Obsidian starts, since the context ring needs each model's window.

The lists give each model's context window (for a ChatGPT account, the Codex catalog's window and compaction point). Anthropic's model prices come from Anthropic's public pricing page, read with the list. OpenAI's model list has neither, so with an OpenAI API key the selected model's window and prices come from its public documentation page on `developers.openai.com`, read at most once a day. Nothing about you is sent to either page.

ChatGPT OAuth discovers the latest stable client version from OpenAI's official GitHub release metadata and keeps the last known version or bundled fallback if discovery fails. Reasoning effort, reasoning summaries and parallel-tool options follow catalog metadata where provided. New model IDs normally require no plugin update, but upstream protocol changes can still require one. Custom model IDs survive reload. Catalog data contains no credentials.

### Thinking level

Below **Model**, **Thinking level** offers *Default* plus the levels the model list gives for the selected model: the Codex catalog's reasoning levels for a ChatGPT account, and the effort levels from Anthropic's `/v1/models`. The row is hidden when the model has none (OpenAI's API-key model list gives none). *Default* keeps the model's own default. A saved level the selected model doesn't offer stays saved and is marked "(not available)"; requests then use the default. The chat header shows the model and its level, e.g. `GPT-5.5 · high`. Anthropic's thinking mode (adaptive or a thinking budget) follows the same list; models it has no data on keep the mode chosen by model name.

### Other settings

- **Enter sends message** — on by default (Shift+Enter starts a new line). Turn it off to make Enter start a new line; then send with the send button or Ctrl+Enter (Cmd+Enter on a Mac). Editing a sent message follows the same keys.
- **Follow the AI's edits** — on by default (see [Follow the AI's edits](#-follow-the-ais-edits)); the eye button in the chat header switches it too.
- **Vault instructions** — opens the vault's `AGENTS.md`, or creates it (see [Your instructions in AGENTS.md](#-your-instructions-in-agentsmd)).
- **Skills** — the folder with your skills (`Skills` by default), the skills in it and **New skill** (see [Skills](#-skills)).
- **MCP servers** — remote MCP servers for Anthropic and OpenAI: a name, a public https address, an optional token and on/off each (see [MCP servers](#-mcp-servers)).
- **Compaction point** — when a long chat is summarized: a share of the selected model's context (80 % by default, 50k tokens at least), set with a slider or as a number of tokens; for a model whose context size is unknown, a number of tokens (empty: only when a request is too long). Earlier saves cost and time per answer; the model then keeps fewer details.
- **Saved chats** — how many chats are saved and their size. A chat over 5 MB shows its size in the chats list, so you can delete it if you no longer need it.
- **Voice** — the ChatGPT account voice uses, the voice and the microphone mode (see [Voice](#-voice)).
- **Debug log** — off by default. For troubleshooting it writes what is needed to follow a problem to `debug.log` in the plugin folder: your messages as sent (with their context), the model's answers and tool calls, tool results and errors, and in voice every event and what was said on both sides (never keys). **Copy** (or the *Copy debug log* command) puts it on the clipboard; **Clear** deletes it.

While an answer is being generated or a voice call runs, the screen doesn't go to sleep (where the device allows it). Stopping before any of the answer is shown leaves a quiet *Stopped.* note in the chat.

## 🚀 Quick start

1. Open **Settings → Community plugins → Browse**.
2. Search for **Chatting with AI**.
3. Click **Install**, then **Enable**.
4. **Settings → Chatting with AI** → pick a provider, paste an API key (or choose **Sign in with ChatGPT** on desktop / **Connect ChatGPT** on mobile).
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
| **Mobile is not an afterthought** | Chat and vault tools support mobile without Node modules. See the recorded desktop and physical iPhone QA coverage in [the recorded QA coverage](phase1-review.md). |
| **Three sane providers** | Anthropic + OpenAI for stability, ChatGPT account for users who'd rather not manage an API key. |
| **Credentials in SecretStorage** | API keys and OAuth credentials go through Obsidian SecretStorage rather than plugin `data.json`. Connect each device separately. |
| **No vault indexing** | Linear search, capped. Predictable, no background work, no memory pressure on phones. |
| **Conversations persist** | Your chats survive Obsidian restarts in `chat-state.json` and a file per chat. The plugin has no chat-sync service; file syncing depends on your setup. |
| **Right sidebar on mobile** | Slides in from the edge — your document stays visible underneath. |

## 🗺️ Roadmap

- [x] Three providers (Anthropic, OpenAI, ChatGPT account)
- [x] 22 vault-native tools
- [x] iOS / Android parity
- [x] Selection scope
- [x] Official Obsidian Community Plugins listing
- [x] Multi-conversation history: new chat, switch, rename, delete
- [ ] Archive and search of past conversations
- [x] Image attachments where the provider supports them
- [x] PDF, Word, Excel, PowerPoint and text file attachments
- [x] Dynamic provider catalogs with automatic refresh when the 24-hour cache expires

Have a request? Open an issue.

## ❓ FAQ

<details>
<summary><b>Will my notes be uploaded somewhere?</b></summary>

Only what the agent needs for the current turn. When you ask a question, the agent decides which tools to call — `read_document`, `search_vault`, etc. — and the contents fetched by those calls (plus the active note context) are sent to your chosen provider. Images and files you attach are sent with that message and kept in the local chat history until you clear or delete the chat or the message is older than the part of the chat the plugin keeps for the provider; so are images the agent looks at (`view_image`, `view_canvas`) and files it reads (`read_file` on a PDF or Office file). So do the names and descriptions of your skills; a skill's `SKILL.md` goes when the AI uses the skill or you name it with `/`. Nothing is uploaded in the background. There is no vault index. Your vault's root `AGENTS.md`, if there is one, goes with every message; a folder's `AGENTS.md` goes with the first tool result in that folder. When the agent reads a web page (`read_web_page`), your device loads that address, as a browser would, and the page's text goes to your provider like a note's.

</details>

<details>
<summary><b>Does it really work on mobile?</b></summary>

Yes — that's the design constraint everything else is built around. Requests go through Obsidian's `requestUrl()` (mobile WebViews enforce CORS), except the chat answers, which stream: on desktop through Node's `https`, on mobile through `fetch` where the provider allows it, else through `requestUrl()` all at once. On desktop, ChatGPT sign-in opens your browser and returns through a local callback. On iOS and Android, choose **Copy code and open login page**, paste the one-time code on the official page, approve, then return to Obsidian. Mobile uses device authorization and never loads the desktop callback server. If device-code login is unavailable, enable it in ChatGPT security settings or ask your workspace admin.

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

Locally, in `<vault>/.obsidian/plugins/chatting-with-ai/`: the list of chats in `chat-state.json`, and each chat in its own file in the `chats` folder, read when you open the chat. Each file has a second copy (`.next.json`) to recover from an interrupted save. If neither copy can be read, existing files are kept as `chat-state.corrupt-<time>.json` or `chat-state.next.corrupt-<time>.json` (a chat's as `chats/<id>.corrupt-<time>.json`) instead of being overwritten, and the chats in the `chats` folder stay in the list; chats saved by a newer version of the plugin are kept as `chat-state.v<version>-<time>.json` when you go back to an older one. Chats saved by a version before the `chats` folder are moved into it once; the old file is kept as `chat-state.v<version>-<time>.json`. If a backup cannot be made, saving is disabled for that session and a notice explains why. The plugin has no chat-sync service; whether chat-state files are copied to another device depends on your sync setup. API keys and sign-in credentials use Obsidian SecretStorage rather than this file; connect each device separately. Attached images and files are saved once, with the messages kept for the provider (those since the chat was last summarized), until you clear or delete the chat; in older messages the chat shows just the name. Tool-returned images and files are kept for the last two user turns, capped separately to the newest four fitting 10 MiB; older results keep their text and an omission marker. Across the chats in memory (the open one and those opened since the start), a shared 32 MiB attachment-history budget favors the current and recently used chats; older attachment payloads become name-only chips and omission text while the conversation remains. Text tool history is bounded too. Files of up to 10 MB each can make the file large.

</details>

<details>
<summary><b>Is it safe to let the agent read web pages?</b></summary>

Mind one risk: `read_web_page` loads pages from your device, so it can also reach addresses only your device reaches (`localhost`, your home or company network). Text that hides instructions — on a web page, in a note, in a file — could get the agent to read such an address, or to put vault content into an address it loads, which sends that content to the site. Each page comes marked as information, not instructions, but that isn't a guarantee. Each step shows the address it reads; don't ask the agent to read pages while you work with content you don't trust.

</details>

<details>
<summary><b>Is it safe to attach Office files from unknown sources?</b></summary>

Yes. Word, Excel and PowerPoint files are ZIP archives, and the plugin unpacks them on your device to read their text (for Anthropic). A file is unpacked to at most 64 MB: a crafted file that unpacks to more (a "zip bomb") is attached without its text instead of freezing Obsidian. Excel text extraction also validates cell references and limits sparse rows and repeated shared strings; a workbook exceeding these bounds is attached without locally extracted text.

</details>
