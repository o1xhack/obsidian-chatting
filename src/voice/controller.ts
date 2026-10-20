/**
 * Runs a live voice conversation with client delegation: the voice model
 * talks; when it delegates, the request runs as a normal chat turn through
 * the chat view (any provider), and the answer goes back for the voice to
 * speak.
 */
import type { ChatHistoryEntry, VoiceTurn } from "../types";
import {
  VOICE_INSTRUCTIONS,
  openFileNote,
  parseVoiceEvent,
  progressEvents,
  seedItems,
  speakEvents,
  spokenAnswer,
  type OpenFile,
} from "./protocol";
import { VoiceCancelled, VoiceSession, type VoiceRoute } from "./session";

export type VoiceStatus = "connecting" | "reconnecting" | "listening" | "thinking" | "speaking";

/** What the voice bar shows. */
export interface VoiceViewState {
  status: VoiceStatus;
  /** The user's current words (live caption); cleared once the voice answers. */
  you: string;
  /** The voice's latest words. */
  assistant: string;
  micOn: boolean;
  holdToTalk: boolean;
  /** Autoplay was blocked: show "Tap to play audio". */
  audioBlocked: boolean;
}

/** Calls from the chat view's turn function into the voice conversation. */
export interface VoiceTurnHooks {
  onToolCall(name: string): void;
  /** Answer text the loop delivered (text before tool calls, then the final answer). */
  onText(text: string): void;
  onError(message: string): void;
  onStopped?(): void;
  /** The conversation still runs: it takes the turn's leftovers itself (else the view runs them). */
  active(): boolean;
}

/** What the controller needs from the chat view. */
export interface VoiceHost {
  /**
   * Run `text` as a chat turn, like a typed message; resolves when it has
   * ended. `context`: what was said in the voice conversation before it.
   */
  runTurn(text: string, hooks: VoiceTurnHooks, context?: VoiceTurn[]): Promise<void>;
  /** Add a request to the running turn (steering); false when none is running. */
  steerTurn(text: string, context?: VoiceTurn[]): boolean;
  /** Steered requests the finished turn didn't get to. */
  takeSteered(): string[];
  /** Stop the running turn, like Stop. */
  stopTurn(): void;
  turnRunning(): boolean;
  history(): ChatHistoryEntry[];
  /** The note or canvas the user has open, if any. */
  openFile(): OpenFile | null;
  showError(message: string): void;
  /** Show the voice bar; null when the conversation has ended. */
  render(state: VoiceViewState | null): void;
  log(label: string, data: unknown): void;
}

/** Delays in ms; tests shorten them. */
export const VOICE_TIMING = {
  /** "Speaking" ends when no words of the voice arrived for this long. */
  speaking: 1500,
  /** User words this soon after the user's last ones go on the same sentence, across a short "Okay," of the voice. */
  continuation: 1500,
  /** Mobile: back after longer than this in the background, the call is replaced… */
  reconnectAfter: 20_000,
  /** …and after this long in the background it ends. */
  endAfter: 60_000,
};

/** Told to the voice model when an addition went to the running task: not done yet. */
export const ADDED_TO_TASK = "Note for you only: the addition was passed to the running task. It is not done yet; wait for the result.";

/** Told to the voice model when the task starts a step: a note, not something to say. */
export function stepNote(tool: string): string {
  return `Note for you only: the task started a step (${tool.replace(/_/g, " ")}); it is still running.`;
}

/** Told to the voice model when a task's result comes back. */
export const TASK_DONE = "This task is finished; nothing is running now. Any further request, also an addition to this one, needs a new delegation.";

/**
 * What the chat shows of what was said before a request: the exchanges in
 * which the voice asked a question (they belong to the request: "Write that
 * down" – "Where?" – "In Plan"), and what the user said right before it
 * without an answer in between. What the voice answered itself
 * ("Anything unclear?" – "No.") isn't shown; the agent still gets it all.
 */
export function requestContext(turns: VoiceTurn[]): VoiceTurn[] {
  const kept: VoiceTurn[] = [];
  let user: VoiceTurn[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      user.push(turn);
      continue;
    }
    if (turn.text.trim().endsWith("?")) kept.push(...user, turn);
    user = [];
  }
  return [...kept, ...user];
}

export class VoiceController {
  private readonly session: VoiceSession;
  private state: VoiceViewState;
  private ended = false;
  /** The user's words since the last delegation took them. */
  private pendingInput = "";
  /**
   * What was said since the last delegation, user and voice: the voice
   * hands over only the sentence that asked for work, so the agent gets
   * this as context (it may have asked a question first).
   */
  private spoken: VoiceTurn[] = [];
  /** The turn being spoken now, from transcript pieces. */
  private openTurn: VoiceTurn | null = null;
  /** The request the last delegation took: its late "turn done" isn't kept again. */
  private lastRequest = "";
  /** The consumed user transcript, when the delegation rephrased it. */
  private lastRequestTranscript = "";
  private lastSpeaker: "user" | "assistant" | null = null;
  private voiceTurnRunning = false;
  /** The newest delegation in the running voice turn: progress and the answer go to it. */
  private answerTo = "";
  /** A delegation ID can never dispatch vault work twice in this call. */
  private readonly delegations = new Set<string>();
  private speakingTimer?: number;
  /** Obsidian is in the background (mobile): microphone off, a lost call not reported. */
  private background = false;
  /** What the user said during the running task, passed to it without a delegation (`queueSteer`). */
  private steeredSpoken: string[] = [];
  /** User turns said during the running task, waiting for the user to be quiet (`queueSteer`). */
  private pendingSteer: VoiceTurn[] = [];
  private steerTimer?: number;
  private task?: Promise<void>;
  private taskResult = "";
  private reconnecting = false;
  /** When each turn's first and last words arrived (ms). */
  private readonly turnTimes = new WeakMap<VoiceTurn, { first: number; last: number }>();

  /**
   * `reconnecting`: this replaces a call lost in the background, shown as
   * "Reconnecting…"; `micOn`: hands-free, the old call's microphone state.
   */
  constructor(private readonly host: VoiceHost, route: VoiceRoute, holdToTalk: boolean,
    { reconnecting = false, micOn = true }: { reconnecting?: boolean; micOn?: boolean } = {}) {
    this.state = {
      status: reconnecting ? "reconnecting" : "connecting",
      you: "", assistant: "", micOn: !holdToTalk && micOn, holdToTalk, audioBlocked: false,
    };
    this.session = new VoiceSession(route, {
      onMessage: (message) => this.receive(message),
      onEnded: (error) => this.onEnded(error),
      onAudioBlocked: () => this.update({ audioBlocked: true }),
      log: (label, data) => host.log(label, data),
    });
  }

  /** Connect and start listening. Errors are shown in the chat. */
  async start(): Promise<void> {
    this.render();
    try {
      this.session.setMicEnabled(this.state.micOn && !this.background);
      await this.session.start(`${VOICE_INSTRUCTIONS}\n\n${openFileNote(this.host.openFile())}`, seedItems(this.host.history()));
      if (this.ended) return;
      this.session.setMicEnabled(this.state.micOn && !this.background);
      this.update({ status: "listening" });
    } catch (error) {
      if (error instanceof VoiceCancelled || this.ended) return;
      this.ended = true;
      this.host.render(null);
      this.host.showError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Keep delegated work and its hooks alive before replacing its call.
   * Delegation IDs belong to that call, so finish the task first and seed
   * the replacement with its saved result instead of replaying its tools.
   */
  async prepareReconnect(): Promise<string | undefined> {
    this.reconnecting = true;
    this.session.setMicEnabled(false);
    this.update({ status: "reconnecting" });
    void this.session.end();
    const task = this.task;
    if (task) await task;
    return task ? this.taskResult : undefined;
  }

  /** End the conversation. A running turn finishes in the chat but isn't spoken. */
  async end(): Promise<void> {
    if (this.ended) return;
    // The last words said go to the debug log too.
    this.closeTurn();
    this.ended = true;
    window.clearTimeout(this.speakingTimer);
    window.clearTimeout(this.steerTimer);
    this.host.render(null);
    await this.session.end();
  }

  /** Hands-free: mute or unmute the microphone. */
  toggleMute(): void {
    this.setMic(!this.state.micOn);
  }

  /** Hold to talk: the microphone is on while the button is pressed. */
  setTalking(pressed: boolean): void {
    if (this.state.holdToTalk) this.setMic(pressed);
  }

  resumeAudio(): void {
    this.update({ audioBlocked: false });
    this.session.resumeAudio().catch(() => this.update({ audioBlocked: true }));
  }

  /** The microphone is on in the voice bar (hands-free and not muted, or held). */
  isMicOn(): boolean {
    return this.state.micOn;
  }

  /**
   * Mobile: Obsidian went to the background, where the microphone records
   * only silence. It is turned off, and a call that drops now isn't
   * reported: the view decides on the return.
   */
  enterBackground(): void {
    this.background = true;
    this.session.setMicEnabled(false);
  }

  /**
   * Back after `hiddenMs` in the background: true when the call still
   * works (the microphone as it was; off for hold to talk, whose press
   * ended), false when it must be replaced (lost, or away longer than
   * `reconnectAfter`).
   */
  leaveBackground(hiddenMs: number): boolean {
    this.background = false;
    if (this.ended || hiddenMs > VOICE_TIMING.reconnectAfter || !this.session.isConnected()) return false;
    this.setMic(this.state.micOn && !this.state.holdToTalk);
    return true;
  }

  private setMic(on: boolean): void {
    this.session.setMicEnabled(on);
    this.update({ micOn: on });
  }

  private receive(message: Record<string, unknown>): void {
    if (this.ended) return;
    const event = parseVoiceEvent(message);
    switch (event.kind) {
      case "input":
        // Still speaking: words waiting to be added to the task wait for the rest.
        if (this.pendingSteer.length) this.restartSteerTimer();
        this.pendingInput += event.text;
        this.addSpoken("user", event.text);
        this.caption("user", event.text);
        break;
      case "output":
        this.addSpoken("assistant", event.text);
        this.caption("assistant", event.text);
        break;
      case "turn-done":
        // A user turn reported after the voice already answered doesn't bring the old words back.
        if (event.role === "user") {
          if (this.lastSpeaker !== "assistant") this.update({ you: event.text });
        } else this.update({ assistant: event.text });
        this.finishTurn(event.role, event.text);
        break;
      case "delegation":
        if (this.delegations.has(event.id)) break;
        // End rather than forget old IDs and risk repeating an external action.
        if (this.delegations.size >= 1024) {
          this.host.showError("Please restart voice to continue this long call.");
          void this.end();
          break;
        }
        this.delegations.add(event.id);
        void this.delegate(event.id, event.text).catch((error: unknown) => {
          if (!this.ended) this.host.showError(error instanceof Error ? error.message : String(error));
        });
        break;
      case "error":
        this.host.showError(`Voice: ${event.message}`);
        break;
      case "closed":
        // The session ends after this event; say why unless we asked for it.
        // In the background the call is replaced on the return instead.
        if (event.reason && event.reason !== "close_requested" && !this.background) this.host.showError(`The voice conversation ended (${event.reason.replace(/_/g, " ")}).`);
        break;
    }
  }

  /** Append words to the caption; a new speaker starts a new line. */
  private caption(speaker: "user" | "assistant", text: string): void {
    const key = speaker === "user" ? "you" : "assistant";
    const current = this.lastSpeaker === speaker ? this.state[key] : "";
    this.lastSpeaker = speaker;
    if (speaker === "user") {
      this.update({ you: current + text, status: this.voiceTurnRunning ? "thinking" : "listening" });
      return;
    }
    // `you` is the user's current words only: they go once the voice answers.
    this.update({ assistant: current + text, you: "", status: "speaking" });
    window.clearTimeout(this.speakingTimer);
    this.speakingTimer = window.setTimeout(() => {
      if (!this.ended) this.update({ status: this.voiceTurnRunning ? "thinking" : "listening" });
    }, VOICE_TIMING.speaking);
  }

  /** Add transcript words to the turn being spoken; another speaker starts a new turn. */
  private addSpoken(role: VoiceTurn["role"], text: string): void {
    const now = Date.now();
    if (this.openTurn?.role === role) {
      this.openTurn.text += text;
      const times = this.turnTimes.get(this.openTurn);
      if (times) times.last = now;
    } else {
      const kept = this.closeTurn();
      if (kept?.role === "user" && this.voiceTurnRunning) this.queueSteer(kept);
      this.openTurn = { role, text };
      this.turnTimes.set(this.openTurn, { first: now, last: now });
    }
  }

  /**
   * The user spoke while a task runs and the voice answered without
   * delegating (the voice model often doesn't for an addition, then claims it's
   * "on the way"): once the user has been quiet for `continuation` ms, the
   * words (fragments around a short "Okay," of the voice joined) go to the
   * running task as one addition, as typed ones would, and the agent
   * decides whether they ask for work. A delegation of the same words
   * later isn't run again.
   */
  private queueSteer(turn: VoiceTurn): void {
    this.pendingSteer.push(turn);
    this.restartSteerTimer();
  }

  private restartSteerTimer(): void {
    window.clearTimeout(this.steerTimer);
    this.steerTimer = window.setTimeout(() => this.flushSteer(), VOICE_TIMING.continuation);
  }

  private flushSteer(): void {
    if (!this.voiceTurnRunning || this.ended) return;
    const text = this.takePendingSteer();
    if (text && !this.host.steerTurn(text)) this.steeredSpoken.pop();
  }

  /** The queued words as one text, taken out of the transcript (no context for the next request). */
  private takePendingSteer(): string {
    window.clearTimeout(this.steerTimer);
    const turns = this.pendingSteer.splice(0);
    if (!turns.length) return "";
    this.spoken = this.spoken.filter((turn) => !turns.includes(turn));
    const text = turns.map((turn) => turn.text).join(" ");
    this.steeredSpoken.push(text);
    this.host.log("VOICE_STEER_SPOKEN", { text });
    return text;
  }

  /** A turn is complete (Codex sends its whole text): keep it. */
  private finishTurn(role: VoiceTurn["role"], text: string): void {
    const consumed = [this.lastRequest, this.lastRequestTranscript].some(request => request && sameWords(text, request));
    if (role === "user" && (consumed || this.steeredSpoken.some(request => normalizedWords(request) === normalizedWords(text)))) {
      // The request a delegation already took, reported late.
      if (this.openTurn?.role === "user" && sameWords(this.openTurn.text, text)) this.openTurn = null;
      if (consumed) {
        this.lastRequest = "";
        this.lastRequestTranscript = "";
      }
      return;
    }
    if (this.openTurn?.role !== role) {
      // Reported after the other speaker started (the voice often answers
      // first): the turn is already kept from its pieces.
      const kept = [...this.spoken].reverse().find((turn) => turn.role === role);
      if (kept && sameWords(kept.text, text)) {
        kept.text = text.trim();
        return;
      }
      const closed = this.closeTurn();
      if (closed?.role === "user" && this.voiceTurnRunning) this.queueSteer(closed);
    }
    const times = this.openTurn ? this.turnTimes.get(this.openTurn) : undefined;
    this.openTurn = { role, text };
    if (times) this.turnTimes.set(this.openTurn, times);
    const kept = this.closeTurn();
    if (kept?.role === "user" && this.voiceTurnRunning) this.queueSteer(kept);
  }

  /** Keep the open turn in the transcript; returns it as kept. */
  private closeTurn(): VoiceTurn | null {
    const turn = this.openTurn;
    this.openTurn = null;
    if (!turn?.text.trim()) return null;
    const kept = { role: turn.role, text: turn.text.trim() };
    const times = this.turnTimes.get(turn);
    if (times) this.turnTimes.set(kept, times);
    this.spoken.push(kept);
    // What was said, for the debug log: the voice's own words are written nowhere else.
    this.host.log("VOICE_TURN", { role: turn.role, text: turn.text.trim() });
    return kept;
  }

  /**
   * The request and what was said before it; the transcript starts over.
   * The request's own sentence is the user's last turn, which the
   * delegation usually brings as its text.
   */
  private takeRequest(text: string): { request: string; context: VoiceTurn[] } {
    this.closeTurn();
    // Words waiting to be added to the running task go with this request instead.
    window.clearTimeout(this.steerTimer);
    this.pendingSteer = [];
    const turns = this.spoken.splice(0);
    let request = text.trim();
    let last = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "user") {
        last = i;
        break;
      }
    }
    this.lastRequestTranscript = last >= 0 ? turns[last].text : "";
    if (last >= 0 && (!request || sameWords(turns[last].text, request))) {
      const taken = !request;
      let first = this.turnTimes.get(turns[last])?.first ?? 0;
      request ||= turns[last].text;
      turns.splice(last, 1);
      // A short "Okay," of the voice while the user goes on speaking splits
      // one sentence into two user turns ("remove the one on the" – "Okay,"
      // – "left"): taken from the transcript, the request is the whole
      // sentence. After a pause the earlier words were their own turn.
      while (taken && last >= 2 && turns[last - 1].role === "assistant" && isBackchannel(turns[last - 1].text) && turns[last - 2].role === "user") {
        const before = this.turnTimes.get(turns[last - 2]);
        if (!before || first - before.last > VOICE_TIMING.continuation) break;
        request = `${turns[last - 2].text} ${request}`;
        first = before.first;
        turns.splice(last - 2, 2);
        last -= 2;
      }
    }
    request ||= this.pendingInput.trim();
    this.pendingInput = "";
    this.lastRequest = request;
    // The agent gets all of it: a request the voice only took up late
    // ("Then do it") needs what was asked before. The chat shows less (`requestContext`).
    return { request, context: turns };
  }

  /** A delegation: run the request as a chat turn and send the answer back to speak. */
  private async delegate(id: string, text: string): Promise<void> {
    // As Codex does: the request plus what was said since the last one.
    const { request, context } = this.takeRequest(text);
    this.host.log("VOICE_REQUEST", { delegation: id, request, context });
    if (!request) {
      this.sendAll(speakEvents(id, "I didn't catch the request. Ask the user to say it again."));
      return;
    }
    // While the voice's turn runs, a new request steers it, as in the chat
    // apps: the agent takes it in after its current step, nothing is
    // stopped, and the answer goes to this newest delegation.
    // Already passed to the task as the user said it (`queueSteer`): not twice.
    if (this.steeredSpoken.some((said) => normalizedWords(said) === normalizedWords(request))) {
      if (this.voiceTurnRunning) {
        this.answerTo = id;
        this.sendAll(progressEvents(id, ADDED_TO_TASK));
      } else {
        this.sendAll(speakEvents(id, "That was part of the last task; the result is in the chat."));
      }
      return;
    }
    if (this.voiceTurnRunning && this.host.steerTurn(request, context)) {
      this.answerTo = id;
      this.sendAll(progressEvents(id, ADDED_TO_TASK));
      return;
    }
    // A typed turn is stopped, as Stop does.
    if (this.host.turnRunning()) this.host.stopTurn();
    // A new task: what was added to the last one no longer counts as taken.
    this.steeredSpoken = [];
    const task = this.runVoiceTurn(id, request, context);
    this.task = task;
    try { await task; }
    finally { if (this.task === task) this.task = undefined; }
  }

  /** Run `request` as a chat turn and send the answer back to speak; then what was added too late. */
  private async runVoiceTurn(id: string, request: string, context: VoiceTurn[] = []): Promise<void> {
    this.answerTo = id;
    let answer = "";
    let failed = "";
    let stopped = false;
    const progress = (value: string) => {
      if (!this.ended) this.sendAll(progressEvents(this.answerTo, value));
    };
    this.voiceTurnRunning = true;
    this.update({ status: "thinking" });
    try {
      await this.host.runTurn(request, {
        onToolCall: (name) => {
          if (answer) progress(answer);
          answer = "";
          progress(stepNote(name));
        },
        onText: (value) => { answer = value; },
        onError: (message) => { failed = message; },
        onStopped: () => { stopped = true; },
        active: () => !this.ended,
      }, context);
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
      if (!this.ended) this.host.showError(failed);
    } finally {
      // A final transcript fragment may arrive before the task resolves,
      // while its terminal/assistant event is still on the wire.
      if (!stopped && !this.ended && this.openTurn?.role === "user") {
        const kept = this.closeTurn();
        if (kept) this.queueSteer(kept);
      }
      this.voiceTurnRunning = false;
    }
    // Ended meanwhile: the view ran what was added (as typed turns).
    if (this.ended) return;
    if (stopped) {
      this.taskResult = "The task was stopped. Any changes already made are shown in the chat.";
      this.sendAll(speakEvents(this.answerTo, this.taskResult));
      this.update({ status: "listening" });
      return;
    }
    // Added after the turn's last step: it needs a turn of its own.
    // Words still waiting to be added when the task ended run as the next turn.
    const pending = this.takePendingSteer();
    const later = [...this.host.takeSteered(), ...(pending ? [pending] : [])];
    this.taskResult = failed ? `The task failed: ${failed}. Do not claim it succeeded.` : answer ? spokenAnswer(answer) : "The task ended without a final answer; check the chat for details.";
    // Said first, so a request the user makes while the result is spoken
    // isn't taken for part of this task (the voice then claimed it was "on the way").
    if (!later.length) this.sendAll(progressEvents(this.answerTo, failed ? "The request failed. Do not claim the requested work succeeded." : TASK_DONE));
    if (failed) this.sendAll(speakEvents(this.answerTo, "That didn't work; the error is shown in the chat."));
    else if (answer) this.sendAll(speakEvents(this.answerTo, spokenAnswer(answer)));
    if (later.length) {
      await this.runVoiceTurn(this.answerTo, later.join("\n"));
      return;
    }
    if (this.state.status === "thinking") this.update({ status: "listening" });
  }

  private sendAll(events: Record<string, unknown>[]): void {
    if (this.reconnecting) return;
    for (const event of events) this.session.send(event);
  }

  private onEnded(error?: string): void {
    window.clearTimeout(this.speakingTimer);
    const wasEnded = this.ended;
    // Lost in the background: the bar stays, the view reconnects on the return.
    if ((this.background || this.reconnecting) && !wasEnded) return;
    this.ended = true;
    this.host.render(null);
    if (error && !wasEnded) this.host.showError(error);
  }

  private update(changes: Partial<VoiceViewState>): void {
    this.state = { ...this.state, ...changes };
    this.render();
  }

  private render(): void {
    if (!this.ended) this.host.render({ ...this.state, ...(this.reconnecting ? { status: "reconnecting" as const } : {}) });
  }
}

function normalizedWords(text: string): string {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(" ");
}

/** A short interjection of the voice while the user speaks ("Okay,", "Mhm."), not an answer or a question. */
function isBackchannel(text: string): boolean {
  const trimmed = text.trim();
  return !trimmed.endsWith("?") && trimmed.split(/\s+/).filter(Boolean).length <= 3;
}

/**
 * The same words, ignoring case and punctuation; or, for three words or
 * more, one starting with the other (a transcript cut short).
 */
function sameWords(a: string, b: string): boolean {
  const words = (value: string) => value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const [shorter, longer] = [words(a), words(b)].sort((x, y) => x.length - y.length);
  if (!shorter.length) return false;
  const starts = shorter.every((word, i) => word === longer[i]);
  return starts && (shorter.length === longer.length || shorter.length >= 3);
}
