# Test harness

## Offline regression tests

```bash
npm test
```

Runs every `test/*.test.mjs` file (`scripts/test.mjs`). `test/harness.mjs`
bundles the production modules (provider adapters, agent loop, plugin) with
a fake Obsidian API, an in-memory vault and mocked `requestUrl`; test files
import what they need from it. No credentials or live API calls are needed.
Tests cover assistant output encoding, native thinking/reasoning/search
replay, read → create/edit flows, parallel tools, cancellation, history
restoration, Anthropic `pause_turn` and thinking configuration, OpenAI
conversation isolation, and the vault tools: `edit_document` input checks
and insert positions, `set_properties` input checks, `read_file` and
`read_document` refusing binary files, the local date from
`get_current_datetime`, and quoting of a multi-line selection.
`chat-view.test.mjs` drives the chat view and the plugin's commands with a
fake Svelte component: the API history cap (80 messages saved, cut to 60
past 80) and OpenAI chaining past it, tool card inputs and `ask_user`
questions and answers after a reload, Stop and Clear while `ask_user` waits,
Copy transcript with the chat panel closed, commands waiting for the view,
and Clear during a turn. `settings-tab.test.mjs` checks that a closed
settings tab is not redrawn. Providers: rate-limit retries by HTTP status,
error code and the wait the provider names (`provider-errors.test.mjs`),
Anthropic web search in its documented response shape with the cited sources
(`anthropic-web-search.test.mjs`), and the OpenAI model list
(`model-list.test.mjs`). Settings (`settings.test.mjs`): "Custom..." in the
model dropdown (for `display()`, before Obsidian 1.13, only that it adds the
custom model row), the iteration limit loaded from `data.json`, the
provider's default model when none is saved, and the connection Test without
web search. `chatgpt-signin.test.mjs`: the ChatGPT sign-in (shared token
refreshes that keep the refresh token and respect Disconnect, one refresh
and retry after a 401, device-code polling through network errors, and the
login dialog ignoring background clicks). `selection-scope.test.mjs`: the
selection scope the tools enforce (the selected copy of repeated text,
snapshot relocation, CRLF notes, safe deletion, failed-write retries, and
refusals outside the selection). `math-markdown.test.mjs`: math delimiters
and table wiki links normalized for rendering, with code left untouched.
`tool-label.test.mjs`: the one-line labels of tool steps per state, file
names without `.md`, searches, renames and unknown tools.
`phone-layout.test.mjs`: on a phone the chat lifts itself by the part of the
view the keyboard covers. `thinking-level.test.mjs`: the thinking level
setting (levels from the model catalog, Default, a level the model doesn't
offer, the chat header, the connection Test at the lightest level) and the
thinking parameters each provider sends, with the previous rules for models
the catalog has no data on. `metadata-query.test.mjs`: `query_notes` (tags
with nested ones, all or any; property values, list items, links, set;
folder; sorting; limit) and `list_metadata` with their labels.
`links.test.mjs`: `get_links` (linked mentions with their lines, unlinked
mentions by name or alias outside links and properties, outgoing links
including unresolved ones) and the old name `get_backlinks`.
`canvas.test.mjs`: the canvas tools against the real executor: the
`read_canvas` outline, `edit_canvas` operations (Obsidian's file format,
unknown fields kept, placement without overlap, refs, all or nothing) and
canvas search in `search_vault`. `web-page.test.mjs`: `read_web_page` with a
stand-in DOM (the article without scripts and navigation, text answers,
other types and HTTP errors refused, only http(s), parts of long pages, a
page without text) and its label. `enter-sends.test.mjs`,
`debug-log.test.mjs` and `screen-awake.test.mjs`: the *Enter sends message*
setting (default, kept, passed to the chat), the *Debug log* setting
(nothing written while off; Copy and Clear; no keys in the log) and the
screen wake lock (held during a turn, re-acquired on return, released on
Stop, nothing without the API). `message-actions.test.mjs`: editing a
message and regenerating or copying an answer through the chat view, with
both histories cut at the same turn, also for chats saved before turn IDs;
a turn the API history no longer holds can't be edited.
`view-tools.test.mjs`: images in tool results (per provider, kept out of the
chat view, sent once from the saved history), `view_image` and `view_canvas`
against the real executor with fake image APIs, canvas drawing, and leaving
older tool images out of requests. `images-once.test.mjs`: each attached
image saved once, and the one-time migration of chats saved before
`chat-state.json` had a version, and a chat saved by a newer version kept
aside. `instructions.test.mjs`: the vault's `AGENTS.md`: the root file in
the system prompt (cut after 32,768 characters, gone with the file), a
folder's with the first tool result touching it (outer first, not repeated,
again after a cut, the active note counts) and the *Vault instructions*
settings row in both settings paths. `conversations.test.mjs`: the version 3
format of `chat-state.json` and its one-time migration, new chat, switching,
renaming and deleting through the chat view, OpenAI chaining and stopped
turns per conversation, and the commands that start a new chat.
`follow-edits.test.mjs`: following the AI's edits (the changed range or
cards, the reused follow tab and Obsidian's match state, canvas cards
selected and centered, the follow tab closed on unload and at the next
start, the setting in both settings paths) and `open_document` with a text
or a card. `mentions.test.mjs`: the mention at the caret (`@`, `[[`), the
files offered and the link put in, and what a sent message's linked files
add before it (notes capped, canvas outline, images, other files by name).
`undo.test.mjs`: undo per answer (edits, new files and folders, renames and
deletes taken back last first, files changed since named and asked about,
the changes row and its state after a restart, undo kept within its
conversation, and the note for the model with the next turn only).
`files.test.mjs`: files (ZIP entries stored and deflated; the text of Word
with headings, lists and tables, Excel sheets as CSV and PowerPoint in slide
order; what a file becomes; each provider's form in a message and in a tool
result such as `read_file` on a PDF, left out two turns later; attached
files saved without their data, restored, and sent again on edit).
`skills.test.mjs`: skills (finding them in the skills folder, the list in
the system prompt before `AGENTS.md`, `use_skill`, `/name` in a message and
the `/` list, and the *Skills* settings with folder, list and New skill in
both settings paths). `mcp.test.mjs`: MCP servers (Anthropic's
`mcp_servers`, toolsets and beta header, OpenAI's `mcp` tools, only servers
on and valid; the provider's calls shown as steps, failed ones too, and
replayed as sent; none for the ChatGPT account; tokens only in
SecretStorage; the *MCP servers* settings in both settings paths).
`fold-turn.test.mjs`: which rows of a finished turn
fold into one line above its answer (steps, a text that led into one, the
changes row; not an ask_user question, the answer or a single step without
changes). These tests do not establish live-service or physical-iOS
behavior.

Two Node scripts that exercise the ChatGPT/Codex Responses endpoint
**without** going through Obsidian, so iteration on the
`chatgpt-oauth` provider doesn't require BRAT round-trips.

## One-time setup

```bash
node test/codex-login.mjs
```

Opens the Device Code Flow:

1. Opens the verification URL on `auth.openai.com/codex/device`.
2. Prints a short user code to enter on that page.
3. After you sign in with your ChatGPT account, polls until the token
   is issued and writes it to `temp/codex-token.json`.

`temp/` is gitignored — the credential never leaves your machine.

## Smoke test

```bash
node test/codex-smoke.mjs                       # default: gpt-5.5, "Say hello in one word."
node test/codex-smoke.mjs gpt-5.4                # different model
node test/codex-smoke.mjs gpt-5.5 "ziama"        # custom message
node test/codex-smoke.mjs gpt-5.5 "echo: hi" --tools  # also pass a function tool
node test/codex-smoke.mjs gpt-5.5 "what is the weather in nyc" --web-search
```

The script:

1. Loads the credential from `temp/codex-token.json`. Refreshes it via
   `auth.openai.com/oauth/token` if expired.
2. Builds the **exact** request body and headers the plugin sends from
   `src/api/chatgpt-oauth.ts` — same `originator`, `User-Agent`,
   `ChatGPT-Account-Id`, `store`, `parallel_tool_calls`, `reasoning`,
   `include`, etc.
3. POSTs to `chatgpt.com/backend-api/codex/responses` and parses the
   SSE response.
4. Prints HTTP status, parsed event types and counts, the final
   assistant text and any tool calls. Exits 0 on success, 1 on failure.

These standalone scripts use hand-built request fixtures. A passing result
establishes only that those fixtures worked against that account's backend;
it does not validate the production history converter. Run `npm test` for
production adapter/loop regression coverage and verify iOS on a physical device.

## Why this exists

Each Codex error mode used to require: edit code → bump version →
build → tag → release → BRAT update → reproduce. That's ~5 minutes
per iteration of debugging *one error message*. With this harness
the loop is: edit code (or the script's body builder) → run script →
see the real server response in milliseconds. We only ship to
Obsidian once the smoke test is green.


Production regression tests also cover dynamic catalogs, 24-hour persistence, request deduplication, failure backoff, manual refresh, account changes during fetch, Anthropic pagination, the OpenAI model list (chat models only, newest first, no dated duplicates; `model-list.test.mjs`), stable Codex version discovery, GPT-6 reasoning metadata, and model/account isolation of native reasoning replay. Run `npm test`.

Live validation results and their limits are recorded in [oauth-live-validation.md](oauth-live-validation.md).
