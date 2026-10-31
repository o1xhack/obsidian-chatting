# 0.12.0 — Continue longer tasks

- Pause at the tool-step limit and continue when you are ready. Continued work keeps its selection scope and one undo action for the whole answer, including after saving and reopening a chat.
- Keep the current turn’s tool results available while bounding older history, with recovery for oversized requests and long conversations.
- Send a stable conversation cache key for ChatGPT account requests, and show context usage relative to the compaction point.
- Protect undo when files change between continued segments, including folder renames and Obsidian’s automatic link updates.

Thanks to @thomas0schierl for #56, #57, #58, and #59.
