# 0.12.0 — Continue longer tasks

- Pause at the tool-step limit and continue when you are ready. Resume paused work after saving and reopening a chat while preserving its selection scope.
- Keep the current turn’s tool results available while bounding older history, with recovery for oversized requests and long conversations.
- Send a stable conversation cache key for ChatGPT account requests, and show context usage relative to the compaction point.
- Keep undo grouped across continued segments, and protect it when files change between segments, including folder renames and Obsidian’s automatic link updates.

Thanks to @thomas0schierl for #56, #57, #58, and #59.
