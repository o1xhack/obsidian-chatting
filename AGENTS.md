# Chatting with AI

Agentic AI chat plugin for Obsidian. Simple, mobile-first, three providers (Anthropic + OpenAI + ChatGPT account sign-in).

## Architecture

```
User Input -> Agent Loop -> API Client (requestUrl) -> Anthropic/OpenAI/Codex
                 |                                         |
            Tool Executor  <---  tool_use response  <------+
                 |
         Obsidian Vault APIs (read/edit/search/create)
```

- **API clients** use `requestUrl()` (not `fetch`) because mobile WebViews enforce CORS
- **Anthropic** uses Messages API with adaptive thinking and prompt caching
- **OpenAI** uses Responses API with `previous_response_id` for multi-turn
- **ChatGPT account** uses the ChatGPT/Codex backend with Device Authorization Flow credentials in `SecretStorage`
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
    client.ts            # Dispatcher: routes to anthropic, openai, or ChatGPT OAuth adapter
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
- **Vault instructions (`AGENTS.md`)**: The user's vault, not this repo. A folder's `AGENTS.md` is appended to the first tool result of the conversation that touches a file in that folder or below (outer folders first); trusted `instructionSources` metadata records delivery in retained history, so it comes once per conversation and again after a cut. User, vault and tool text cannot forge that metadata. Initial selected text, linked files and invoked Skills include their file paths in instruction discovery.
- **Anthropic `cache_control`**: Breakpoints on system prompt and last tool definition.
- **Thinking level from the model catalog**: The setting offers the levels the catalog lists for the selected model (Codex `supported_reasoning_levels`, Anthropic `/v1/models` `capabilities.effort`); Anthropic's thinking mode comes from `capabilities.thinking.types`. Without catalog data the previous rules apply: Anthropic thinking by model name, Codex `medium` for reasoning models, and OpenAI API-key requests `medium` for reasoning models (its model list has no levels).
- **Per-provider API keys**: Stored as `chatting-with-ai-api-key-anthropic` / `chatting-with-ai-api-key-openai` in `SecretStorage`.
- **In-memory chat persistence**: `AgentLoop` and the conversations live on the plugin instance, surviving view open/close cycles. `chatHistory` is the active conversation's; the agent holds its API history, copied into its record when saving.
- **Selection scope**: Injected into user message with scoping instructions, and enforced by `executeTool` for that turn: in the selected note only `edit_document` `find_replace` inside the selection (located by its offset and in-memory editor snapshot; changes outside the range can relocate it, while changed or ambiguous selections are refused) succeeds; other changes to that note, or renaming/deleting a folder it is in, are refused. Other notes stay editable.
- **Conversations**: One `AgentLoop`, for the active conversation. New chat, switching and deleting the active conversation stop a running turn first (`chat-view.ts`); `activate()` then imports the next conversation's API history, which also clears OpenAI's chaining state, so `previous_response_id` never crosses conversations. The title is the first user message (40 characters) until renamed. Automatic title/source metadata survives persistence caps, so trimming the original turn does not rename the chat after reload or append. An empty conversation isn't listed and is dropped when left.
- **Panel layout**: The chat view turns off Obsidian's `.view-content` padding and scrolling (`styles.css`) and pads its own parts. On desktop it keeps the bottom padding, which keeps it clear of the status bar (not needed in the left sidebar). In the phone sidebar it keeps 24px for the tab menu's fade below and turns off the 48px fade over the view with the floating navigation; Obsidian doesn't shrink the sidebar for the keyboard, so `chat-view.ts` measures how much of the view the keyboard covers and lifts the chat by that (`--ochatting-lift`). The safe area is left to Obsidian's containers.
- **Selection history**: Only active turns keep the full note snapshot. UI/saved history keeps a SHA-256 fingerprint; editing/regenerating refuses scoped changes if that note has changed. Older snapshots are compacted on restore.
- **Turn IDs**: Each user turn has an ID on its `chatHistory` entry and on its first message in `AgentLoop` (`ask_user` answers have none). Editing a message or regenerating the last answer cuts both histories just before that turn (`cutBeforeTurn`; a new array, so OpenAI replays it in full) and runs the turn again with its images and selection. Rejected edit/regenerate preflight restores the original visible/API histories and pending undo notes; the cut is not saved prematurely. Chats saved before turn IDs get them in the one-time migration of `chat-state.json` (`assignLegacyTurnIds`, only while no turn has one).
- **Images in tool results**: `ToolResult.images` (`view_image`, `view_canvas`) go to the model inside the tool result (Anthropic image blocks; OpenAI and ChatGPT `function_call_output` as an `input_text` + `input_image` list). Only the agent history keeps them; the chat view and its saved `chatHistory` get the text and "[1 image prepared for the model]". Requests leave out tool images older than the last 2 user turns and cap the remaining tool images to the newest 4 fitting 10 MiB, with a note for omissions (`withoutOldToolImages`); OpenAI breaks previous_response_id chaining whenever images are omitted so server context is pruned too; the agent applies the same budget after each tool result and on restore so memory/saved state stay bounded; user attachments stay.
- **Cross-conversation attachment retention**: `attachment-history.ts` bounds attachment data across all chats to 32 MiB of conservatively counted JSON bytes before serialization and on restore. Current chat, then most recently used chats, retain their newest payloads first. Older payloads become named omission text/API blocks and metadata-only UI chips; conversation text and entry identities stay. The same budget includes legacy visible-only blobs. In-memory histories and mounted thumbnails release expired data too. An in-flight request loses its outer-array response cursor after pruning, so its eventual response cannot re-establish stale chaining.
- **Saved chat format**: `chat-state.json` has a `version` (3): `{ version, savedAt, activeConversationId, conversations: [{ id, title, customTitle, createdAt, updatedAt, chatHistory, agentMessages, notes? }] }`; a file without a version is version 1. Older formats are migrated once on load (`migrateChatState` in `src/chat-state.ts`; 2 → 3 makes the single chat the first, active conversation) and the next save writes the current one. A newer version than the plugin knows (saved by a later release, before a downgrade) isn't read: it is copied to `chat-state.v<version>-<time>.json` and the chat starts empty, so the next save doesn't overwrite it. Each conversation keeps the last 100 visible entries and 80 API messages. Image data is saved only in the API history; the visible history keeps each image's ID, name, type and size and gets the data back by ID on load (`restoreImages`). An image the API history no longer holds shows as a chip with its name and isn't sent again on edit or regenerate.
- **Follow the AI's edits**: `edit_document`, `set_properties`, `create_file` and `edit_canvas` return `ToolResult.focus`: the changed range in the note (a before/after comparison in `withChange`) or the changed canvas cards. The chat view takes it off the result before showing and saving it; it never goes to the model. With the setting on, `ui/show-in-view.ts` opens the spot through Obsidian's search-match ephemeral state, in the tab that already shows the file or one reused follow tab, without taking the focus from the chat (on a phone the note stays behind the chat). On a canvas it then selects and centers all changed cards through the canvas view's internal API, checked first; without it the match state's select-and-pan stays. The follow tab closes when the plugin unloads; its ID is kept with `saveLocalStorage`, so a tab the saved layout brought back is closed at the next start.
- **Mentions**: `@` or `[[` in the input offers vault files (`src/ui/mentions.ts`); the chosen one goes in as a link. On send, `chat-view.ts` reads the files the message links to (`mentionContext`) and `AgentLoop.run` puts them between the context prefix and the message: a note's text (20,000 characters each, 60,000 together), a canvas outline, images as image blocks, PDF and Office files as files, other text files as text; other files by name. The chat and `chatHistory` keep the typed text and original link-resolution source note; edit and regenerate read the files again relative to that source, even after switching active notes or restarting. Legacy turns without a recorded source resolve from the vault root.
- **Undo per answer**: The chat view passes a new `ChangeLog` (`src/tools/undo.ts`) per turn through `AgentCallbacks.changes` to `executeTool`. Edits record their text before and after in `withChange` (the same comparison that gives `focus`); `create_file` records the file and the folders `ensureParentFolder` made, `rename_file` the rename, `delete_file` the bytes of the file or folder before trashing it. Deletion snapshots are committed only after trash succeeds. A turn with changes ends in a `"changes"` entry in `chatHistory` (`turnId`, `files`, `undone`); its log lives only in memory, in `plugin.changeLogs`, a `WeakMap` keyed by that entry, so it belongs to that entry's conversation and goes away with it (clear, edit cut, delete). Undo snapshots coalesce adjacent edits and are bounded to 32 MiB per answer / 64 MiB across live answers; exceeding the budget expires whole logs and changes their rows to kept, never a partial undo. Undo takes the steps back last first, consumes successful steps, and stops on the first failure so retry cannot repeat a successful step; `conflicts()` names files that changed since, and `undo-confirm.ts` asks first. Undo locks sending without clearing the composer or cancelling attachment preparation; a raced submission restores its draft. The model learns of an undo through the conversation's `notes` (saved with it): the next turn takes them into the context prefix of its user message, not the system prompt, and clears them. After a restart the row shows without undo ("kept").
- **Folded steps**: when a turn ends, `ChatContainer.foldTurn` replaces its tool steps, a text that only led into a step and its changes row with one steps row right above the answer (`ui/fold-turn.ts` decides which rows, `foldPlan`); it opens into the steps and the changed files, and keeps undo. The chat view calls it at the end of a turn and for every finished turn in `renderHistory`. A single step without changes stays; an `ask_user` question stays visible. Nothing about it is saved.
- **Files**: PDF, Word, Excel, PowerPoint and text files (attached with the paperclip or by pasting, up to 4 per message and 10 MB each; mentioned; or `read_file` on a PDF or Office file) become a `FileAttachment` (`src/files/attachments.ts`): a `file` content block in the user message, or `ToolResult.files` in a tool result. Each provider gets its own form: OpenAI and ChatGPT `input_file` with inline base64 data (PDF and Office), Anthropic a PDF `document` block and, for Word, Excel and PowerPoint, a text `document` with the text read when the file was attached (`src/files/office.ts`; the ZIP container is read with `DecompressionStream("deflate-raw")` in `src/files/zip.ts`, no library); text files go as text to all. Tool results with files are left out after 2 user turns and capped to the newest 4 fitting 10 MiB (actual bytes and extracted text), in memory, saved state, and requests. The saved `chatHistory` keeps each attached file's ID, name, type and size; data and text stay in the API history and come back by ID on load (`restoreImages`), so the `chat-state.json` format (version 3) is unchanged. Office ZIP unpacking is limited to 64 MiB total and 8 MiB per XML entry, with bounded XML match counts and Word table expansion. Word/PowerPoint extraction accumulates at most 100,000 characters and stops before later slides after reaching its cap; unsafe local extraction keeps the original attachment without text.
- **Text tool history**: Tool results keep at most 100,000 characters each and a shared 200,000-character text allowance plus omission markers. Oversized prefixes are copied so they release the original backing string. This applies to new results, API restore and visible/saved tool rows; Trusted instruction suffixes are recorded separately by offset and retained complete outside the payload allowance, so clipping file text cannot remove first-touch rules or block nested-rule write retries. Legacy clipped results without a recorded suffix lose provenance so a later write discovers real rules again. Filename listings and metadata-cache enumeration report their returned/read paths through internal instructionPaths; get_links includes displayed outgoing targets and linked sources even without cached lines.
- **Request budgets and preflight**: Mixed picked/linked images and files share a 20 MiB encoded budget. Mention resolution checks metadata before loading a document that cannot fit, then counts actual encoded bytes incrementally. Stopping linked-context preflight restores the unsent draft and undo notes synchronously; late completion cannot overwrite a new draft or resurrect cleared/consumed notes. Each provider checks the final serialized UTF-8 JSON against 30 MB. Preflight failure restores the draft and selection without adding a visible-only user turn. `search_vault` returns internal `instructionPaths` for names matched or files read (including non-matches); the loop adds folder rules then strips this metadata from UI/persistence. Folder rename/delete discovers the whole affected subtree and destination scope. Excel extraction validates cell references and bounds expanded cells/text across the workbook.
- **Skills**: The user's vault, the Claude Code / Codex format: a folder per skill in the skills folder (setting `skillsFolder`, default `Skills`) with a `SKILL.md` whose properties give `name` (else the folder name) and `description` (`src/agent/skills.ts`). Each turn `AgentLoop.run` lists names and descriptions in the system prompt, after the built-in prompt and before `AGENTS.md`. `use_skill` returns a `SKILL.md` without its properties (32,768 characters) and lists the skill's other files, which the model reads with the vault tools. Both use_skill and slash invocation discover folder instructions for the skill file and all listed resources, including nested folders. `/name` in a message (at its start or after a space) makes `chat-view.ts` send the skill loaded along with it, before the linked files; typing `/` offers the skills in the mention list. The *Skills* setting lists them (a `list` definition on Obsidian 1.13+, rows in `display()` before) and *New skill* creates one from `SKILL_TEMPLATE`.
- **MCP servers through the provider**: Remote servers only, no MCP client in the plugin (`src/api/mcp.ts`). The settings keep a list (`mcpServers`: name, public https address, on/off; a `list` definition on Obsidian 1.13+, rows in `display()` before); each token only in `SecretStorage` (`chatting-with-ai-mcp-<id>`, `mcpSecretKey`; `removeMcpServer` clears it; a save writes only tokens this device has, so one that didn't load isn't overwritten), never in `data.json`. Requests with an API key name the servers that are on: Anthropic `mcp_servers` with one `mcp_toolset` each and the `mcp-client-2025-11-20` beta header, OpenAI one `mcp` tool each with `require_approval: "never"`. The provider lists and calls the tools; the adapters read the calls from the answer (`mcp_tool_use` / `mcp_tool_result` blocks, `mcp_call` items) into `UnifiedResponse.serverCalls`, and `AgentLoop` shows each as a tool step (`mcp:<server>:<tool>`, "Used create_issue on linear"), never runs it. Replay is bound to hashed server ID/endpoint/authorization identities; changed or disabled servers lose native calls and tool lists, and OpenAI also drops its cursor. Remote result text shares local tool budgets; non-text MCP results are omitted from replay with a note. Results are clipped like tool text (`withBoundedServerResults` in `withoutLargeToolText`; the step shows the clipped result too). Not for the ChatGPT account (its route doesn't offer it) or the Test buttons. New servers start disabled. Enabled tools run without asking, so the settings say to add only trusted servers; tokens go to the provider with each request.

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
| delete_file | `fileManager.trashFile()` | Respects user trash setting |
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
| view_image | `vault.readBinary()` + `createImageBitmap()` | PNG, JPEG, GIF, WebP; up to 20 MiB sources, header-first resized decoding to 2048 px / 5 MiB output (GIFs sent unchanged without decoding) |
| view_canvas | `vault.cachedRead()` + Canvas 2D | PNG of the layout (at most 1600 px) and a legend of node tags; source thumbnails over 4 MiPixels, 8192 px on one side, or 10 MiB show file cards; `focus` zooms to a group or node |
| use_skill | `vault.getFolderByPath()` + `cachedRead()` | A skill's `SKILL.md` without its properties (32,768 characters) and its other files; from the skills folder |

## Debug

Turn on **Debug log** in the settings to write each message as sent (with its context lines), the model's answers with their text and tool calls, each tool call with its input and result, and errors to `<vault-config-dir>/plugins/chatting-with-ai/debug.log` (`src/debug.ts`). It includes the user's messages, never keys or tokens. The row's Copy and Clear buttons and the "Copy debug log" command get it off a phone.
