# PRs #56–#59 integration candidate

Candidate branch: `codex/pr-56-59-integration`, based on `fd30449` (0.11.3).
All five contributor commits remain ancestors through four merge commits.
No version bump, main merge, new PR or release is included.

## Scope

| PR | Change | Integration |
| --- | --- | --- |
| #56 | Pause at the step limit and offer Continue | Merged with current main |
| #57 | Retain local reads during the current turn | Run-boundary pruning retained inside main's foreground history lock |
| #58 | Stable ChatGPT prompt cache/session key per chat | Added alongside, rather than replacing, main's background-history callback and account identity guard |
| #59 | Context ring full at compaction | Preserved main's background-summary documentation and usage accounting |

The original four PR checks are successful. Their prior green runs do not
validate this combined candidate against current main.

## Findings repaired during integration

1. **Undo across continuations:** each Continue made a new log and another
   changes row with the same turn ID. Undo found the first log, while the
   latest segment could be hidden or left applied. Continued segments now
   share one log/row, unfold while running and fold once at completion.
   After restart or eviction the whole answer stays kept; no partial undo
   is offered. Undo dismisses Continue so it cannot trust reverted receipts.
2. **Provider pause:** Anthropic `pause_turn` can leave an assistant message
   last. The earlier `owesAnswer` check accepted only user-ending histories,
   so the step-limit note offered no functioning Continue. A validated,
   persisted `awaitingContinuation` flag retains this successful pause.
3. **Scoped editing:** after a scoped edit the next Continue reused the
   original selection fingerprint and refused its own updated text.
   `pendingTurn.selection` now holds the current compact fingerprint;
   edit/regenerate still use the original user's selection. Tests cover
   immediate/reloaded continuation and refusal after an outside edit.
4. **Visible MCP text:** provider-run tool rows retain the shared allowance
   even when they belong to the newest turn, matching the API-history rule.

New regression fixtures failed against the uncorrected integration and pass
with the repairs (the original cases lacked these scenarios).

## Validation

- 995 automated tests passed, zero failed.
- TypeScript passed; Svelte check: zero errors and warnings; production build passed.
- Native Obsidian: 20 real Svelte/view/loop/vault checks with synthetic provider
  transport. Multiple pauses/continues executed six tools once, retained
  320,000 characters of reads, produced one changes/steps row and undid both
  edits together. Context-ring and detail text use the compaction threshold.
  Additional native checks verify Obsidian's real automatic link rewrites,
  continued Undo, original-note restoration and restoration of its link preference.
- 1,810 existing non-QA test-vault files had identical SHA-256 hashes afterward.
- The temporary native helper was unloaded and removed. The installed chat
  plugin, its settings and saved conversations were not replaced.
- Structured results and the production-source fingerprint:
  [pr-56-59-qa.json](pr-56-59-qa.json). Reproduce native QA with
  `node test/native-pr-56-59.mjs` from this branch on the authorized Mac.

## Code Review follow-up

The first independent `codex review --base fd30449` completed for `f6a2b20`
with three actionable findings: P1 loss of manual changes between paused
segments, P2 Continue racing an asynchronous Undo, and P2 paused-turn identity
lost when compaction trims the original user message. All were reproduced
before correction and repaired with focused regressions.

Undo now detects discontinuous snapshots, including edit, delete,
rename-then-delete and recreation, and keeps the entire answer without
partial Undo. Continue is hidden and guarded throughout Undo. Native
compaction markers retain a validated originating `continuationTurnId`;
the same boundary protects current-turn reads after retention and restart.
A second review of `8257092` found P2 folder-descendant state not following
folder renames and P2 loss of emergency request-size recovery for very large
current-turn text. Regression tests reproduced both. Expected states now
follow descendant moves and own folder creation/deletion. Emergency handling
of a locally unsent request exceeding 30 MB explicitly bounds current-turn
text too; ordinary requests retain the larger current-turn allowance.
All three providers recover from a 110-result CJK batch without repeating
those read tools, and legitimate folder path reuse stays undoable.

A third review of `eea830c` found three P2 recovery gaps. Explicit context
overflow now permits a bounded summary of completed current-turn work when
earlier-turn compaction is insufficient, retaining its turn identity and
leaving history unchanged if summarization fails. Emergency byte-size
recovery also runs for the first request of Continue, while first-send
preflight still restores the unsent draft. An explicitly empty restored
changed-file list now marks the whole answer kept, covering empty-folder
deletion followed by further edits after restart.

A fourth review of `7af7cfe` found P2 edit/regenerate deleting an overflow
summary and P2 rename-owned automatic link changes expiring safe undo.
Portable summaries now have synthetic IDs for edit eligibility and a separate
validated continuation identity. Native and automated regression checks verify
rename link rewrites, manual edits before rename, failed reads/renames, safe
post-rename failure, and Undo restoring the original notes. Link snapshots are
limited to previously tracked notes and count toward the existing undo budget.

The final current-head re-review outcome is recorded separately in the task
handoff so recording that outcome does not change the commit being reviewed.

## Remaining gates

A clean independent review must match the final candidate commit. Candidate
remote CI and official Community Preview have not been requested or accepted. This is a tested
integration candidate, not an assertion that those merge gates passed.
Live-provider cache-hit rates, physical-phone interaction and background
suspension were not measured in this run. No merge or release was performed.
