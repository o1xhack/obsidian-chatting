# Phase 6: long conversations and compaction (0.10.0)

Scope: PR #44 `c5dd3c1` and #45 `5f568d5`, merged individually onto 0.9.0 (`44b6a36`) with author ancestry preserved. Voice PR #46 is excluded.

## Behavior and integration fixes

The header shows context usage, accumulated tokens and available API pricing. Subscription usage shows tokens, without claiming an API cost. Long chats compact at a configurable threshold using provider compaction where available, with a tool-free readable summary as fallback. Compact now keeps the full visible conversation while replacing the model's earlier context. Turns outside retained API context cannot be edited or regenerated. Folder instruction provenance is rediscovered from the actual post-compaction request context, independently of raw history retained for portability; linked files and selection paths receive their rules again. Summaries include completed remote MCP receipts; a context overflow after possible remote effects cannot trigger a summary and re-post.

Saved chat format is version 4: chat-state.json contains the index, and chats/<id>.json contains each conversation. Changed chats and the index use a next copy before the primary; loading takes the newer whole copy. Full visible history is retained; the view starts at the last 20 complete turns and loads earlier pages. Only user rows carrying a turn ID count as page boundaries, so ask_user answers and steering messages stay with their original question. Files are loaded lazily and unchanged chat files are not rewritten merely by opening them. When loaded attachments exceed the shared budget, exact saved snapshots of idle inactive chats are unloaded and re-read when opened again; running or unsaved records stay loaded and their payloads follow the hard shared retention budget. Existing attachment/text/request budgets remain enforced for new or changed payloads.

Per-entry title metadata revisions distinguish a newer chat file after an interrupted save from a later index-only rename, even across unrelated index saves and restarts. Custom names preserve the file's current automatic-title provenance.

Migration preserves the old whole-state file before any replacement. A backup failure blocks saves until restart. Downgrade migration preserves both raw per-chat copies before replacing them; a future-format copy is protected regardless of its timestamp. A lone next file recovers after an interrupted first save. Deletion markers carry timestamps so an interrupted deletion does not resurrect the old primary. Conversation IDs cannot collide with next/backup filenames. Asynchronous navigation discards stale open completions and a delayed active-chat deletion cannot steal focus from a newer choice.

Manual compaction belongs to its conversation, blocks edits and sends until finished, and supports Stop and Clear. Switching chats retains its busy state; stopped completion cannot replace history or clobber a later run. Account/key changes require a portable summary before reusing encrypted compaction. Across repeated opaque compactions, the raw prefix is retained until a readable summary exists so changing provider/model/account cannot silently drop the earliest context. A portable summary processes every transcript chunk in order, carrying the previous summary forward instead of clipping the beginning; failure midway leaves the original history intact. Summary chunk sizing uses the authenticated account's catalog, including before its first request. Native request replay still starts at the latest compaction, and tool-text/attachment budgets remain enforced.

MCP-capable requests require a successful durable checkpoint before the provider POST; a storage failure prevents remote dispatch.

Injected Svelte styles use a hash of their CSS content so an Obsidian plugin hot update installs the new release's styles. Native upgrade acceptance verifies the context popover's positioning, width and subscription display.

## Validation

700 automated tests cover the production modules, including migration failure/corruption/future-format recovery, interrupted deletion, lazy-open races, compaction Stop, account changes, remote receipts and failed durable MCP checkpoints. TypeScript, Svelte (zero errors/warnings) and production build pass.

Native Mac Obsidian passed 60 initial migration checks, then 73 checks against the final production bundle and mounted Svelte UI: all nine existing chats retained identical visible and API histories during v3 to v4 migration, the backup exists, paging and manual compaction work, and streaming/background/Continue/MCP protections still hold. All 1,809 existing visible vault files stayed hash-unchanged. The connected ChatGPT subscription (gpt-6.1-sol) completed a real manual summary and recalled a test fact afterward; reloading retained login, compacted context and a further successful reply. No live tools ran. Evidence: [phase6-qa.json](phase6-qa.json).

API-key provider calls and native threshold compaction responses are simulated. No physical mobile-device acceptance is claimed; iPhone Air is not operated. Exact-current-head Codex review, CI, Community preview, downloaded release assets and formal Community build verification are final release gates.

References: [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction), [Anthropic threshold compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-threshold). The ChatGPT/Codex backend is a distinct endpoint; the live manual-summary test does not prove its threshold compaction behavior.
