# #61 follow-up: background portable summaries

The reporter confirmed that 0.11.1 bounds encrypted-compaction history, but measured about ten extra seconds while a portable summary ran synchronously after native compaction. That is their measurement, not a general latency guarantee.

## Change

Portable retention now runs one background summary per conversation. Its request owns a separate abort controller and an account identity; it cannot replace the normal answer's controller or retry its transcript with another ChatGPT account. No tools, web search or MCP servers are sent by the summary.

The old prefix remains until every summary chunk succeeds. Installation checks the original prefix and provider/model/key settings and happens between requests or when the foreground operation has ended. Stop, Clear, editing, restore, attachment pruning, deletion, unload and manual compaction invalidate pending work. Switching away from a conversation retains its pending worker. Failed work keeps raw history and retains the existing retry cooldown. Background work can temporarily retain more than two windows; preserving context takes priority over a hard size cap.

A summary finishing after the last answer save triggers persistence. Changes made during a turn share one notification after that turn, rather than adding a save before each step. Background usage contributes to totals without replacing the latest answer's context, provider/model or turn cost.

## Related bounded optimizations

- Find compaction/turn boundaries by scanning backward, avoiding full-history boolean arrays and stopping at the needed boundary.
- Skip the transcript's redundant token-count pass when the full transcript is required for ordered chunking. Chunk token estimates and Unicode boundaries are unchanged.
- Detach only the summarized conversation's history array. Other conversations retain their OpenAI response cursors.

## Validation

Regression coverage includes delayed summaries with an unblocked foreground answer, single-flight execution, in-flight-response installation, failed/empty/stopped summaries, stale snapshots, provider/model/key/account changes, independent cancellation, persistence and restore, chat switching/deletion/unload, manual compaction, usage accounting, and other-chat response cursors. Existing multi-window facts, external-action receipts and handoff regressions remain enabled.

Native Obsidian/Electron QA uses a controlled 1,000 ms summary, without calling an external provider or editing vault notes. On the installed 0.11.2 baseline, a warm run returned after 1,374.8 ms and waited for that summary. The final candidate returned after 12.5 ms, before summary completion and subsequently requested persistence. This checks removal of the serial wait; it is not a live-service or phone latency measurement.

A synthetic CPU benchmark (median of seven runs) retained identical outputs: finding a readable boundary at the end of 100,000 messages changed from about 0.920 ms to 0.0003 ms. For a 9,000,006-character transcript, removing the redundant pass saved about 24.4 ms in transcript construction; chunking still performs its required linear scan. These stress cases do not claim a comparable total-chat speedup.

Local evidence: `temp/issue-61-perf/` (ignored). The dedicated native test vault runs the unmodified production candidate; no debug hook is added to the bundle.
