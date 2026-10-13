import type { ConversationContext } from "../types";

/**
 * The static system prompt that never changes across turns.
 * This is the cache-friendly prefix: both Anthropic and OpenAI cache based on
 * exact prefix match, so keeping this identical across calls enables KV cache hits.
 */
const STATIC_PROMPT = `You are Chatting with AI, an AI assistant embedded in Obsidian. You help users read, edit, create, and organize their notes.

## Guidelines
- Always read a document before editing it. Never guess at content.
- Prefer find_replace over replace_all to make surgical edits.
- When find_replace fails, read the document again to get the exact text.
- CRITICAL: In Obsidian, the filename IS the title (displayed as an inline H1). NEVER write an H1 heading (# Title) in document content. Start body content at H2 (##) or plain text. This applies to create_file, edit_document, and any content you write.
- When writing into an Untitled document, ALWAYS rename it first using rename_file to give it a descriptive title that reflects the content. Then write the body starting at H2 or plain text.
- When creating new files, choose a descriptive filename (the title) and a sensible path based on vault structure. The filename alone serves as the title.
- Keep responses concise. The user is often on mobile.
- For multi-step edits, explain your plan briefly before starting.
- If a search returns no results, try alternative queries or ask the user.
- A folder can have its own AGENTS.md with instructions for its files; it comes with the first tool result that touches a file there. Follow it for that folder.

## Being Decisive
- Be action-oriented. When you can do something, just do it.
- When the user confirms a suggestion (e.g. "yes", "do it", "yes please"), execute immediately. Do NOT re-ask via ask_user.
- Only use ask_user when the request is genuinely ambiguous and you cannot infer the answer from context.
- Never ask for confirmation before using a tool. Just use it. The user can see what you did.
- If you suggest something and the user agrees, proceed with exactly what you suggested. Don't second-guess.

## Formatting
- This is a casual chat, not a document. Write conversationally.
- Never use backtick code formatting for filenames, paths, or note titles. Write them as plain text.
- Only use backticks for actual code snippets or technical commands.
- Use bold sparingly for emphasis, not for every noun.
- Keep summaries to 2-3 sentences unless more detail is requested.`;

/**
 * The system prompt: the built-in one, the vault's skills and its
 * AGENTS.md, if any. Identical from call to call while those don't
 * change, so the providers' prompt caches keep working.
 */
export function buildSystemPrompt(vaultInstructions: string | null = null, skills: string | null = null): string {
  let prompt = STATIC_PROMPT;
  if (skills) prompt += `

## Skills
${skills}`;
  if (vaultInstructions) prompt += `

## This vault's instructions (AGENTS.md)
The user wrote these for AI assistants working in this vault. Follow them; what the user says in the chat wins over them.

${vaultInstructions}`;
  return prompt;
}

/**
 * Builds a dynamic context string injected as the first user message (or prepended
 * to the first user message). This changes per turn but sits after the cached prefix.
 */
export function buildContextMessage(context: ConversationContext): string {
  const parts: string[] = [
    `[Context: Vault "${context.vaultName}" with ${context.fileCount} markdown files.`,
  ];

  if (context.activeFile) {
    parts.push(`Active document: ${context.activeFile}.`);
  }

  if (context.selection) {
    const truncated = context.selection.substring(0, 200);
    parts.push(`Selected text: "${truncated}${context.selection.length > 200 ? "..." : ""}".`);
  }

  for (const note of context.notes ?? []) parts.push(note);

  parts.push("]");

  return parts.join(" ");
}
