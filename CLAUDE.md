# Chatting with AI

Agentic AI chat plugin for Obsidian. Simple, mobile-first, two providers (Anthropic + OpenAI).

## Architecture

```
User Input -> Agent Loop -> API Client (requestUrl) -> Claude/OpenAI
                 |                                         |
            Tool Executor  <---  tool_use response  <------+
                 |
         Obsidian Vault APIs (read/edit/search/create)
```

- **API clients** use `requestUrl()` (not `fetch`) because mobile WebViews enforce CORS
- **Anthropic** uses Messages API with adaptive thinking and prompt caching
- **OpenAI** uses Responses API with `previous_response_id` for multi-turn
- **Agent loop** is provider-agnostic: send -> tools -> send -> done
- **UI** is a single Svelte 5 component (`ChatContainer.svelte`) mounted in an `ItemView`

## Project Structure

```
src/
  main.ts                # Plugin entry: commands, views, settings, context menus
  types.ts               # All interfaces and defaults
  settings.ts            # PluginSettingTab with model fetching
  debug.ts               # Debug log (the "Debug log" setting)
  images.ts              # Image limits and re-encoding for view_image and view_canvas
  chat-state.ts          # Saved chats (chat-state.json): conversation records, one-time migrations
  api/
    client.ts            # Dispatcher: routes to anthropic or openai adapter
    anthropic.ts         # Messages API, adaptive thinking, cache_control
    openai.ts            # Responses API, previous_response_id chaining
    mcp.ts               # Remote MCP servers through the provider: which a request names, the calls it reports
  tools/
    registry.ts          # 22 tool definitions (JSON Schema)
    executor.ts          # Runs tools against Obsidian Vault APIs
    metadata-query.ts    # query_notes, list_metadata (metadata cache, no file read)
    links.ts             # get_links: linked and unlinked mentions, outgoing links
    canvas.ts            # JSON Canvas: outline, search texts, node/edge operations
    canvas-render.ts     # view_canvas: draws a canvas with Canvas 2D, plus a legend
    web-page.ts          # read_web_page: a page's main content as Markdown
    undo.ts              # ChangeLog: an answer's vault changes, taken back by undo
  agent/
    loop.ts              # Core agentic loop with selection scope
    context.ts           # Builds vault context (active file, selection)
    system-prompt.ts     # Static system prompt (KV cache optimized)
    instructions.ts      # The vault's AGENTS.md files (root: system prompt; folders: tool results)
    skills.ts            # Skills: the skills folder, the list in the system prompt, use_skill, /name
  ui/
    chat-view.ts         # ItemView wrapper, mounts Svelte component
    ChatContainer.svelte # All chat UI: messages, input, selection pill, chats list
    math-markdown.ts     # Render-time fix-up: math delimiters, table wiki links
    tool-label.ts        # One-line labels of tool steps ("Edited Plan")
    fold-turn.ts         # Which rows of a finished turn fold into its steps row (foldPlan)
    send-key.ts          # Which key sends (or saves an edit): "Enter sends message"
    show-in-view.ts      # Shows a spot in a note or canvas (Follow the AI's edits, open_document)
    mentions.ts          # @ and [[ in the input: the file list, and the linked files sent with a message
    undo-confirm.ts      # Asks before undoing files that changed after the answer
  platform/
    screen-awake.ts      # Keeps the screen on while an answer is generated
  files/
    attachments.ts       # PDF, Office and text files for the model: limits, what each becomes
    office.ts            # Text of docx, xlsx and pptx files (for Anthropic)
    zip.ts               # ZIP reader on DecompressionStream (no library)
```

## Key Patterns

- **KV cache optimization**: System prompt is static (never includes dynamic context). Only the vault's root `AGENTS.md` and its skills list (names and descriptions) join it (read each turn; they change only when the user edits them, so the cache holds). Dynamic context (active file, selection) goes in the user message after the cached prefix.
- **Vault instructions (`AGENTS.md`)**: The user's vault, not this repo. A folder's `AGENTS.md` is appended to the first tool result of the conversation that touches a file in that folder or below (outer folders first); the history is searched for it, so it comes once per conversation and again after a cut.
- **Anthropic `cache_control`**: Breakpoints on system prompt and last tool definition.
- **Thinking level from the model catalog**: The setting offers the levels the catalog lists for the selected model (Codex `supported_reasoning_levels`, Anthropic `/v1/models` `capabilities.effort`); Anthropic's thinking mode comes from `capabilities.thinking.types`. Without catalog data the previous rules apply: Anthropic thinking by model name, Codex `medium` for reasoning models, and OpenAI API-key requests `medium` for reasoning models (its model list has no levels).
- **Per-provider API keys**: Stored as `ochat-api-key-anthropic` / `ochat-api-key-openai` in `SecretStorage`.
- **In-memory chat persistence**: `AgentLoop` and the conversations live on the plugin instance, surviving view open/close cycles. `chatHistory` is the active conversation's; the agent holds its API history, copied into its record when saving.
- **Selection scope**: Injected into user message with scoping instructions, and enforced by `executeTool` for that turn: in the selected note only `edit_document` `find_replace` inside the selection (located by its offset and in-memory editor snapshot; changes outside the range can relocate it, while changed or ambiguous selections are refused) succeeds; other changes to that note, or renaming/deleting a folder it is in, are refused. Other notes stay editable.
- **Conversations**: One `AgentLoop`, for the active conversation. New chat, switching and deleting the active conversation stop a running turn first (`chat-view.ts`); `activate()` then imports the next conversation's API history, which also clears OpenAI's chaining state, so `previous_response_id` never crosses conversations. The title is the first user message (40 characters) until renamed. An empty conversation isn't listed and is dropped when left.
- **Panel layout**: The chat view turns off Obsidian's `.view-content` padding and scrolling (`styles.css`) and pads its own parts. On desktop it keeps the bottom padding, which keeps it clear of the status bar (not needed in the left sidebar). In the phone sidebar it keeps 24px for the tab menu's fade below and turns off the 48px fade over the view with the floating navigation; Obsidian doesn't shrink the sidebar for the keyboard, so `chat-view.ts` measures how much of the view the keyboard covers and lifts the chat by that (`--ochatting-lift`). The safe area is left to Obsidian's containers.
- **Turn IDs**: Each user turn has an ID on its `chatHistory` entry and on its first message in `AgentLoop` (`ask_user` answers have none). Editing a message or regenerating the last answer cuts both histories just before that turn (`cutBeforeTurn`; a new array, so OpenAI replays it in full) and runs the turn again with its images and selection. Chats saved before turn IDs get them in the one-time migration of `chat-state.json` (`assignLegacyTurnIds`, only while no turn has one).
- **Images in tool results**: `ToolResult.images` (`view_image`, `view_canvas`) go to the model inside the tool result (Anthropic image blocks; OpenAI and ChatGPT `function_call_output` as an `input_text` + `input_image` list). Only the agent history keeps them; the chat view and its saved `chatHistory` get the text and "[1 image sent to the model]". Requests leave out the images of tool results older than the last 2 user turns, with a note in their place (`withoutOldToolImages`); the stored history keeps them, and attached images are always sent.
- **Saved chat format**: `chat-state.json` has a `version` (3): `{ version, savedAt, activeConversationId, conversations: [{ id, title, customTitle, createdAt, updatedAt, chatHistory, agentMessages, notes? }] }`; a file without a version is version 1. Older formats are migrated once on load (`migrateChatState` in `src/chat-state.ts`; 2 → 3 makes the single chat the first, active conversation) and the next save writes the current one. A newer version than the plugin knows (saved by a later release, before a downgrade) isn't read: it is copied to `chat-state.v<version>-<time>.json` and the chat starts empty, so the next save doesn't overwrite it. Each conversation keeps the last 100 visible entries and 80 API messages. Image data is saved only in the API history; the visible history keeps each image's ID, name, type and size and gets the data back by ID on load (`restoreImages`). An image the API history no longer holds shows as a chip with its name and isn't sent again on edit or regenerate.
- **Follow the AI's edits**: `edit_document`, `set_properties`, `create_file` and `edit_canvas` return `ToolResult.focus`: the changed range in the note (a before/after comparison in `withChange`) or the changed canvas cards. The chat view takes it off the result before showing and saving it; it never goes to the model. With the setting on, `ui/show-in-view.ts` opens the spot through Obsidian's search-match ephemeral state, in the tab that already shows the file or one reused follow tab, without taking the focus from the chat (on a phone the note stays behind the chat). On a canvas it then selects and centers all changed cards through the canvas view's internal API, checked first; without it the match state's select-and-pan stays. The follow tab closes when the plugin unloads; its ID is kept with `saveLocalStorage`, so a tab the saved layout brought back is closed at the next start.
- **Mentions**: `@` or `[[` in the input offers vault files (`src/ui/mentions.ts`); the chosen one goes in as a link. On send, `chat-view.ts` reads the files the message links to (`mentionContext`) and `AgentLoop.run` puts them between the context prefix and the message: a note's text (20,000 characters each, 60,000 together), a canvas outline, images as image blocks, PDF and Office files as files, other text files as text; other files by name. The chat and `chatHistory` keep only the typed text; edit and regenerate read the files again.
- **Undo per answer**: The chat view passes a new `ChangeLog` (`src/tools/undo.ts`) per turn through `AgentCallbacks.changes` to `executeTool`. Edits record their text before and after in `withChange` (the same comparison that gives `focus`); `create_file` records the file and the folders `ensureParentFolder` made, `rename_file` the rename, `delete_file` the bytes of the file or folder before trashing it. A turn with changes ends in a `"changes"` entry in `chatHistory` (`turnId`, `files`, `undone`); its log lives only in memory, in `plugin.changeLogs`, a `WeakMap` keyed by that entry, so it belongs to that entry's conversation and goes away with it (clear, edit cut, delete). Undo takes the steps back last first; `conflicts()` names files that changed since, and `undo-confirm.ts` asks first. The model learns of an undo through the conversation's `notes` (saved with it): the next turn takes them into the context prefix of its user message, not the system prompt, and clears them. After a restart the row shows without undo ("kept").
- **Folded steps**: when a turn ends, `ChatContainer.foldTurn` replaces its tool steps, a text that only led into a step and its changes row with one steps row right above the answer (`ui/fold-turn.ts` decides which rows, `foldPlan`); it opens into the steps and the changed files, and keeps undo. The chat view calls it at the end of a turn and for every finished turn in `renderHistory`. A single step without changes stays; an `ask_user` question stays visible. Nothing about it is saved.
- **Files**: PDF, Word, Excel, PowerPoint and text files (attached with the paperclip or by pasting, up to 4 per message and 10 MB each; mentioned; or `read_file` on a PDF or Office file) become a `FileAttachment` (`src/files/attachments.ts`): a `file` content block in the user message, or `ToolResult.files` in a tool result. Each provider gets its own form: OpenAI and ChatGPT `input_file` with inline base64 data (PDF and Office), Anthropic a PDF `document` block and, for Word, Excel and PowerPoint, a text `document` with the text read when the file was attached (`src/files/office.ts`; the ZIP container is read with `DecompressionStream("deflate-raw")` in `src/files/zip.ts`, no library); text files go as text to all. Tool results with files are left out of requests after 2 user turns, like tool images. The saved `chatHistory` keeps each attached file's ID, name, type and size; data and text stay in the API history and come back by ID on load (`restoreImages`), so the `chat-state.json` format (version 3) is unchanged. The unpacked size of an Office file isn't limited (only the file's 10 MB); a crafted file can stall Obsidian while it is read (README, FAQ).
- **Skills**: The user's vault, the Claude Code / Codex format: a folder per skill in the skills folder (setting `skillsFolder`, default `Skills`) with a `SKILL.md` whose properties give `name` (else the folder name) and `description` (`src/agent/skills.ts`). Each turn `AgentLoop.run` lists names and descriptions in the system prompt, after the built-in prompt and before `AGENTS.md`. `use_skill` returns a `SKILL.md` without its properties (32,768 characters) and lists the skill's other files, which the model reads with the vault tools. `/name` in a message (at its start or after a space) makes `chat-view.ts` send the skill loaded along with it, before the linked files; typing `/` offers the skills in the mention list. The *Skills* setting lists them (a `list` definition on Obsidian 1.13+, rows in `display()` before) and *New skill* creates one from `SKILL_TEMPLATE`.
- **MCP servers through the provider**: Remote servers only, no MCP client in the plugin (`src/api/mcp.ts`). The settings keep a list (`mcpServers`: name, public https address, on/off; a `list` definition on Obsidian 1.13+, rows in `display()` before); each token only in `SecretStorage` (`chatting-with-ai-mcp-<id>`, `mcpSecretKey`; `removeMcpServer` clears it), never in `data.json`. Requests with an API key name the servers that are on: Anthropic `mcp_servers` with one `mcp_toolset` each and the `mcp-client-2025-11-20` beta header, OpenAI one `mcp` tool each with `require_approval: "never"`. The provider lists and calls the tools; the adapters read the calls from the answer (`mcp_tool_use` / `mcp_tool_result` blocks, `mcp_call` items) into `UnifiedResponse.serverCalls`, and `AgentLoop` shows each as a tool step (`mcp:<server>:<tool>`, "Used create_issue on linear"), never runs it. The blocks and items stay in the replay as sent. Not for the ChatGPT account (its route doesn't offer it) or the Test buttons. Tools run without asking, so the settings say to add only trusted servers; tokens go to the provider with each request.

## Build

```bash
npm install
npm run build          # Production
npm run dev            # Watch mode
npx tsc --noEmit       # Type check
npm run svelte-check   # Svelte check
```

## Tools

| Tool | Obsidian API | Notes |
|------|-------------|-------|
| read_document | `vault.cachedRead()` | Falls back to active file if no path |
| edit_document | `vault.process()` | Atomic read-modify-write |
| search_vault | `getMarkdownFiles()` + `.canvas` files + `cachedRead()` | Linear scan, capped; in canvases card text and labels only |
| read_file | `vault.getFileByPath()` + `cachedRead()` / `readBinary()` | Text files; PDF and Office files go to the model as files (`ToolResult.files`); images (use view_image) and other binary files refused |
| create_file | `vault.create()` | Auto-creates parent folders |
| list_files | `vault.getFiles()` | Capped at 100 results |
| rename_file | `fileManager.renameFile()` | Updates all links |
| delete_file | `vault.trash()` | Respects user trash setting |
| open_document | `ui/show-in-view.ts` (`openFile()` with the search-match state) | Only when the user asks; optional `text` or canvas `node_id`; the tab showing the file or the follow tab |
| get_properties | `metadataCache.getFileCache()` | Reads YAML frontmatter |
| set_properties | `fileManager.processFrontMatter()` | Safe YAML merge/remove |
| get_links | `metadataCache.resolvedLinks` / `unresolvedLinks` + `cachedRead()` | Linked and unlinked mentions, outgoing links; the old name `get_backlinks` still runs |
| get_current_datetime | `Date` | User's locale and timezone |
| ask_user | UI callback | Pauses agent loop |
| query_notes | `metadataCache.getFileCache()` + `getAllTags()` | Tags (nested too), properties, folder; sorted; capped at 200 |
| list_metadata | `metadataCache.getFileCache()` + `getAllTags()` | Tags and properties with counts |
| read_canvas | `vault.cachedRead()` | Outline: groups, nodes, edges with IDs and positions |
| edit_canvas | `vault.process()` | Node/edge operations, all or nothing; keeps unknown fields |
| read_web_page | `requestUrl()` + `htmlToMarkdown()` | http(s) only; article/main content, 40,000 characters per call; loaded from the user's device |
| view_image | `vault.readBinary()` + `createImageBitmap()` | PNG, JPEG, GIF, WebP; over 2048 px or 5 MB scaled down (GIFs never re-encoded) |
| view_canvas | `vault.cachedRead()` + Canvas 2D | PNG of the layout (at most 1600 px) and a legend of node tags; `focus` zooms to a group or node |
| use_skill | `vault.getFolderByPath()` + `cachedRead()` | A skill's `SKILL.md` without its properties (32,768 characters) and its other files; from the skills folder |

## Debug

Turn on **Debug log** in the settings to write each message as sent (with its context lines), the model's answers with their text and tool calls, each tool call with its input and result, and errors to `.obsidian/plugins/chatting-with-ai/debug.log` (`src/debug.ts`). It includes the user's messages, never keys or tokens. The row's Copy and Clear buttons and the "Copy debug log" command get it off a phone.
