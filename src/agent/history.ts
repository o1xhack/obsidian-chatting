import type { ChatHistoryEntry, ContentBlock, UnifiedMessage } from "../types";

function startsUserTurn(message: UnifiedMessage): boolean {
  return message.role === "user" && (typeof message.content === "string" ||
    message.content.some(block => block.type === "text" || block.type === "image" || block.type === "file"));
}

/**
 * API messages kept per conversation: sent, saved and restored. Trimming
 * keeps whole user turns, so a long turn can keep a few more.
 */
export const MAX_CONVERSATION_LENGTH = 80;

/** Keep whole user turns so pruning/persistence cannot orphan tool results. */
export function trimHistory(messages: UnifiedMessage[], limit: number): UnifiedMessage[] {
  const firstTurn = messages.findIndex(startsUserTurn);
  if (firstTurn < 0) return [];
  let start = firstTurn;
  const cutoff = Math.max(0, messages.length - limit);
  for (let index = firstTurn; index <= cutoff; index++) {
    if (startsUserTurn(messages[index])) start = index;
  }
  return start === 0 ? messages : messages.slice(start);
}

/** Tool results of the last 2 user turns keep their images and files when sent. */
export const TOOL_IMAGE_TURNS = 2;
export const MAX_TOOL_IMAGES = 4;
export const MAX_TOOL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOOL_FILES = 4;
export const MAX_TOOL_FILE_BYTES = 10 * 1024 * 1024;

export const MAX_TOOL_TEXT_CHARS = 100000;
const TOTAL_TOOL_TEXT_CHARS = 200000;

const TOOL_TEXT_OMISSION = "\n[Tool text truncated to keep chat history within its size limit. Use search or a smaller focused extract for omitted content.]";

export function boundedToolText(text: string, limit = MAX_TOOL_TEXT_CHARS): string {
  if (text.length <= limit) return text;
  const notice = TOOL_TEXT_OMISSION;
  let end = Math.max(0, limit - notice.length);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  const prefix = new TextDecoder().decode(new TextEncoder().encode(text.slice(0, end)));
  return prefix + notice;
}

/** Bound text as well as binary tool payloads. A copied prefix releases the
 * original large string's backing store. Clipped rules lose their delivery
 * provenance, so a later write must discover the real instructions again.
 * A loader-recorded instruction suffix is kept complete outside the payload
 * allowance, including when multiple nested rules exceed the per-result cap. */
export function withoutLargeToolText(messages: UnifiedMessage[]): UnifiedMessage[] {
  let room = TOTAL_TOOL_TEXT_CHARS;
  const replacement = new Map<ContentBlock, ContentBlock>();
  const replays = new Map<UnifiedMessage, NonNullable<UnifiedMessage["replay"]>>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.replay) {
      const bounded = withBoundedServerResults(message.replay.items, room);
      room = bounded.room;
      if (bounded.items !== message.replay.items) replays.set(message, { ...message.replay, items: bounded.items });
    }
    const content = message.content;
    if (typeof content === "string") continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j];
      if (block.type !== "tool_result") continue;
      const text = block.content ?? "";
      const offset = block.instructionOffset;
      const hasRules = !!block.instructionSources?.length && Number.isInteger(offset) && offset! >= 0 && offset! <= text.length;
      const payload = hasRules ? text.slice(0, offset) : text;
      const limit = Math.min(MAX_TOOL_TEXT_CHARS, room);
      if (payload.length <= limit) { room -= payload.length; continue; }
      const clipped = boundedToolText(payload, limit);
      if (clipped === payload) continue;
      if (hasRules) {
        replacement.set(block, { ...block, content: clipped + text.slice(offset), instructionOffset: clipped.length });
      } else {
        const { instructionSources: _sources, instructionOffset: _offset, ...rest } = block;
        replacement.set(block, { ...rest, content: clipped });
      }
      room = Math.max(0, room - clipped.length);
    }
  }
  if (!replacement.size && !replays.size) return messages;
  return messages.map(message => {
    const replay = replays.get(message);
    const withReplay = replay ? { ...message, replay } : message;
    return typeof withReplay.content === "string" || !replacement.size ? withReplay : {
      ...withReplay, content: withReplay.content.map(block => replacement.get(block) ?? block),
    };
  });
}

/** Remote results share the local tools' text allowance, newest first. Binary
 * MCP results are not attachments managed by our image budget: omit them from
 * replay with a text marker instead of retaining unbounded base64 payloads. */
function withBoundedServerResults(items: Record<string, unknown>[], room: number): { items: Record<string, unknown>[]; room: number } {
  const bounded = [...items];
  let changed = false;
  const take = (text: string, limit = MAX_TOOL_TEXT_CHARS) => {
    const short = boundedToolText(text, Math.min(limit, room));
    room = Math.max(0, room - short.length);
    return short;
  };
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "mcp_call") {
      // Errors can contain the same arbitrary server payload as output. Both
      // fields share one call's allowance, including structured execution errors.
      let allowance = MAX_TOOL_TEXT_CHARS;
      const callText = (text: string) => {
        const short = take(text, allowance);
        allowance = Math.max(0, allowance - short.length);
        return short;
      };
      const next = { ...item };
      if (typeof item.output === "string") next.output = callText(item.output);
      if (typeof item.error === "string") next.error = callText(item.error);
      else if (item.error && typeof item.error === "object") {
        const error = item.error as Record<string, unknown>;
        const short = { ...error };
        if (typeof error.message === "string") short.message = callText(error.message);
        if (error.content !== undefined) {
          const content = error.content;
          // A clipped payload has this small, schema-valid object form. Read
          // its text directly so repeated saves do not re-encode and shrink it.
          const summary = content && typeof content === "object" && !Array.isArray(content)
            && Object.keys(content).length === 1 && typeof (content as { text?: unknown }).text === "string"
            ? (content as { text: string }).text : JSON.stringify(content);
          const text = callText(summary);
          if (text !== summary) short.content = { text };
        }
        if (short.message !== error.message || short.content !== error.content) next.error = short;
      }
      if (next.output !== item.output || next.error !== item.error) { bounded[i] = next; changed = true; }
    }
    if (item.type === "mcp_tool_result") {
      if (typeof item.content === "string") {
        const content = take(item.content);
        if (content !== item.content) { bounded[i] = { ...item, content }; changed = true; }
      } else if (Array.isArray(item.content)) {
        const limit = Math.min(MAX_TOOL_TEXT_CHARS, room);
        let remaining = limit;
        const content: Record<string, unknown>[] = [];
        let clipped = false, truncated = false;
        const source = item.content as unknown[];
        for (let index = 0; index < source.length; index++) {
          // One omission per result, even with thousands of blocks after the
          // shared allowance is exhausted. Also bound empty block overhead.
          if (remaining <= 0 || index >= 128) { clipped = truncated = true; break; }
          const part = source[index];
          const block = typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"
            ? part as { type: string; text: string }
            : { type: "text", text: "[Non-text MCP result omitted from chat history.]" };
          clipped ||= block !== part;
          if (block.text.length > remaining) {
            content.push({ type: "text", text: block.text.slice(0, remaining) });
            clipped = truncated = true;
            break;
          }
          content.push(block);
          remaining -= block.text.length;
        }
        if (truncated) {
          // Reserve room in the retained prefix even when a block consumed
          // the limit exactly. A missing tail must never look complete.
          const prefix = content.map(part => part.text as string).join("\n");
          let end = Math.max(0, limit - TOOL_TEXT_OMISSION.length);
          if (end > 0 && /[\uD800-\uDBFF]/.test(prefix[end - 1])) end--;
          const text = new TextDecoder().decode(new TextEncoder().encode(prefix.slice(0, end))) + TOOL_TEXT_OMISSION;
          content.splice(0, content.length, { type: "text", text });
        }
        if (clipped) {
          const old = source.length === 1 ? source[0] as { type?: string; text?: string } | null : null;
          // Stable omission markers do not keep replacing their message.
          if (source.length !== content.length || content.some((part, index) => part !== source[index] &&
            !(index === 0 && source.length === 1 && old?.type === "text" && old.text === part.text))) {
            bounded[i] = { ...item, content }; changed = true;
          }
        }
        room = Math.max(0, room - content.reduce((total, part) => total + (part.text as string).length, 0));
      }
    }
  }
  return { items: changed ? bounded : items, room };
}

/** Last-resort payload preflight recovery. Keep text, tool pairing and all
 * user attachments; explicitly tell the model why tool pixels/files left.
 */
export function withoutToolAttachments(messages: UnifiedMessage[]): UnifiedMessage[] {
  let changed = false;
  const next = messages.map(message => {
    if (typeof message.content === "string") return message;
    let replaced = false;
    const content = message.content.map(block => {
      if (block.type !== "tool_result" || (!block.images?.length && !block.files?.length)) return block;
      replaced = changed = true;
      const { images: _images, files: _files, ...rest } = block;
      return { ...rest, is_error: true, content: `${rest.content ?? ""}\n[Tool images/files omitted because the request exceeded its size limit. Ask for a smaller file or a focused extract instead of reading the same attachment again unchanged.]` };
    });
    return replaced ? { ...message, content } : message;
  });
  return changed ? next : messages;
}

/**
 * The history as sent to a provider: tool results older than the last
 * `turns` user turns lose their images (`view_image`, `view_canvas`) and
 * say so in their text, so a full replay doesn't send every image again.
 * Within those turns only the newest 4 tool images fitting 10 MiB are sent.
 * Images the user attached stay. Nothing is changed in place; unchanged
 * messages are the same objects.
 */
export function withoutOldToolImages(messages: UnifiedMessage[], turns = TOOL_IMAGE_TURNS): UnifiedMessage[] {
  let cutoff = -1;
  for (let index = messages.length - 1, seen = 0; index >= 0; index--) {
    if (startsUserTurn(messages[index]) && ++seen === turns) {
      cutoff = index;
      break;
    }
  }
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id && block.name) toolNames.set(block.id, block.name);
    }
  }
  let count = 0;
  let bytes = 0;
  // Walk newest first. Track positions rather than image IDs: saved or provider
  // data may repeat IDs, and each transmitted occurrence consumes the budget.
  const kept = new Map<ContentBlock, number[]>();
  for (let index = messages.length - 1; index >= Math.max(0, cutoff); index--) {
    const content = messages[index].content;
    if (typeof content === "string") continue;
    for (let b = content.length - 1; b >= 0; b--) {
      const block = content[b];
      if (block.type !== "tool_result" || !block.images?.length) continue;
      const positions: number[] = [];
      for (let i = block.images.length - 1; i >= 0; i--) {
        // Do not trust the persisted sizeBytes metadata for request limits.
        const size = Math.ceil(block.images[i].data.length * 3 / 4);
        if (count >= MAX_TOOL_IMAGES || bytes + size > MAX_TOOL_IMAGE_BYTES) continue;
        count++; bytes += size;
        positions.unshift(i);
      }
      kept.set(block, positions);
    }
  }
  const keptFilePositions = new Map<ContentBlock, number[]>();
  let fileCount = 0;
  let fileBytes = 0;
  for (let index = messages.length - 1; index >= Math.max(0, cutoff); index--) {
    const content = messages[index].content;
    if (typeof content === "string") continue;
    for (let b = content.length - 1; b >= 0; b--) {
      const block = content[b];
      if (block.type !== "tool_result" || !block.files?.length) continue;
      const positions: number[] = [];
      for (let i = block.files.length - 1; i >= 0; i--) {
        const file = block.files[i];
        const size = Math.ceil(file.data.length * 3 / 4) + (file.text?.length ?? 0) * 2;
        if (fileCount >= MAX_TOOL_FILES || fileBytes + size > MAX_TOOL_FILE_BYTES) continue;
        fileCount++; fileBytes += size;
        positions.unshift(i);
      }
      keptFilePositions.set(block, positions);
    }
  }
  return messages.map(message => {
    if (typeof message.content === "string") return message;
    let changed = false;
    const content = message.content.map((block): ContentBlock => {
      if (block.type !== "tool_result") return block;
      const images = block.images ?? [];
      const files = block.files ?? [];
      const positions = kept.get(block) ?? [];
      const keptFiles = (keptFilePositions.get(block) ?? []).map(i => files[i]);
      if (positions.length === images.length && keptFiles.length === files.length) return block;
      changed = true;
      const { images: _images, files: _files, ...rest } = block;
      const omitted = images.length - positions.length;
      const omittedFiles = files.length - keptFiles.length;
      const what = [
        ...(omitted ? [omitted === 1 ? "image" : `${omitted} images`] : []),
        ...(omittedFiles ? [omittedFiles === 1 ? "file" : `${omittedFiles} files`] : []),
      ].join(" and ");
      const tool = toolNames.get(block.tool_use_id ?? "") ?? "a tool";
      const note = `[${what} from ${tool} omitted to save context]`;
      return { ...rest, content: rest.content ? `${rest.content}\n\n${note}` : note,
        ...(positions.length ? { images: positions.map(i => images[i]) } : {}),
        ...(keptFiles.length ? { files: keptFiles } : {}) };

    });
    return changed ? { ...message, content } : message;
  });
}

let turnCount = 0;

/** A new ID for a user turn. */
export function newTurnId(): string {
  return `turn-${Date.now().toString(36)}-${(turnCount++).toString(36)}`;
}

/**
 * The agent history up to just before the turn `turnId`, as a new array
 * (so the OpenAI adapter can't chain to a response from the cut-off part).
 * A turn that isn't there was trimmed away, since every turn goes into both
 * histories: all of the history comes after it, and nothing is kept.
 */
export function cutBeforeTurn(messages: UnifiedMessage[], turnId: string): UnifiedMessage[] {
  const index = messages.findIndex(message => message.turnId === turnId && startsUserTurn(message));
  return index < 0 ? messages : messages.slice(0, index);
}

/**
 * Turn `turnId` can be edited or answered again: the API history still
 * holds it. A turn cut off by the history's limit can't: cutting there
 * would leave the model without the whole chat.
 */
export function editableTurn(messages: UnifiedMessage[], turnId: string): boolean {
  return messages.some(message => message.turnId === turnId && startsUserTurn(message));
}

/** The text a user turn was sent with: context first, the user's text last. */
function sentText(message: UnifiedMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map(block => block.type === "text" ? block.text ?? "" : "").join("");
}

/**
 * Gives a chat saved before turn IDs existed matching IDs in both
 * histories, in place; a chat that has any turn ID is left as it is. Each
 * turn added one user entry to the view's history and one turn start to
 * the agent's, so they are paired from the end. A user entry whose text
 * doesn't end the turn start's text is an `ask_user` answer, no turn of its
 * own: it gets no ID. Ordered ask_user call/result events distinguish answers
 * even when their text matches a prompt. Entries older than the (trimmed) agent history get
 * IDs of their own. Only IDs are added; nothing else changes.
 */
export function assignLegacyTurnIds(entries: ChatHistoryEntry[], messages: UnifiedMessage[]): void {
  if (entries.some(entry => entry.turnId) || messages.some(message => message.turnId)) return;
  type Event = { kind: "start"; message: UnifiedMessage }
    | { kind: "answer"; question: string; answer: string };
  const events: Event[] = [];
  const questions = new Map<string, string>();
  for (const message of messages) {
    if (startsUserTurn(message)) events.push({ kind: "start", message });
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (message.role === "assistant" && block.type === "tool_use" && block.name === "ask_user" && block.id
        && typeof block.input?.question === "string") questions.set(block.id, block.input.question.trim());
      if (message.role === "user" && block.type === "tool_result" && block.tool_use_id && block.content && !block.is_error) {
        const question = questions.get(block.tool_use_id);
        if (question) events.push({ kind: "answer", question, answer: block.content });
      }
    }
  }
  let next = events.length - 1;
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "user") continue;
    let isAnswer = false;
    // The callback stores the question immediately before its UI answer.
    // Consume these events in API order, not as a global set of answer texts.
    while (next >= 0 && events[next].kind === "answer") {
      const event = events[next--] as Extract<Event, { kind: "answer" }>;
      if (entry.text === event.answer && entries[index - 1]?.type === "assistant"
        && entries[index - 1].text === event.question) { isAnswer = true; break; }
    }
    if (isAnswer) continue;
    if (next < 0) {
      entry.turnId = `legacy-${++count}`;
      continue;
    }
    const event = events[next] as Extract<Event, { kind: "start" }>;
    const sent = sentText(event.message);
    const text = entry.text ?? "";
    if (sent !== text && !sent.endsWith(`\n\n${text}`)) continue;
    entry.turnId = event.message.turnId = `legacy-${++count}`;
    next--;
  }
}
