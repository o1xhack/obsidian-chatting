/**
 * One live voice connection: microphone, WebRTC peer connection, the
 * remote audio, and the `oai-events` data channel. The route creates the
 * call (an HTTP request through `requestUrl()`); everything after that is
 * WebRTC, which isn't HTTP and works on mobile too.
 */
import type { VoiceItem } from "./protocol";
import { CLOSE_EVENT } from "./protocol";

/** What a route sends to create the call: our offer and the session setup. */
export interface VoiceConnectRequest {
  sdp: string;
  instructions: string;
  items: VoiceItem[];
}

/** A way to create a voice call (`voice/codex.ts`). */
export interface VoiceRoute {
  /** For logs. */
  name: string;
  /** Start what the call needs and doesn't depend on the offer (e.g. a token refresh), while the offer is prepared. */
  prepare?(): void;
  connect(request: VoiceConnectRequest): Promise<{ sdp: string; callId?: string }>;
}

export interface VoiceSessionHandlers {
  onMessage(message: Record<string, unknown>): void;
  /** Called once, when the session has ended for any reason; `error` if it failed. */
  onEnded(error?: string): void;
  /** The remote audio couldn't start on its own (autoplay blocked). */
  onAudioBlocked(): void;
  log(label: string, data: unknown): void;
}

/** Timeouts in ms; tests shorten them. */
export const SESSION_TIMING = {
  /** Use the ICE candidates gathered so far after this long… */
  iceWait: 2000,
  /** …or this long after the first one. */
  iceSettle: 500,
  /** Give up when the data channel hasn't opened by then. */
  startWait: 15000,
  /** After `session.close`, wait this long for `session.closed`. */
  closeWait: 5000,
  /** Log once if no data-channel event has arrived by then (for spikes). */
  quietLog: 10000,
};

/** Thrown by `start()` when the session was ended while connecting. */
export class VoiceCancelled extends Error {
  constructor() {
    super("Voice session ended while connecting.");
    this.name = "VoiceCancelled";
  }
}

export class VoiceSession {
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private mic?: MediaStream;
  private audio?: HTMLAudioElement;
  private ended = false;
  /** `onEnded` was called, or `start()` failed (its caller got the error). */
  private endNotified = false;
  private started = false;
  private startWaiter?: { resolve: () => void; reject: (error: Error) => void };
  private onClosed?: () => void;
  private quietTimer?: number;
  private messageCount = 0;

  constructor(private readonly route: VoiceRoute, private readonly handlers: VoiceSessionHandlers) {}

  /** Connect; resolves when the session has started. Throws on failure. */
  async start(instructions: string, items: VoiceItem[]): Promise<{ callId?: string }> {
    // How long each step took (debug log): where a slow start comes from.
    const timing: Record<string, number> = {};
    let stepStart = Date.now();
    const step = (name: string) => {
      timing[name] = Date.now() - stepStart;
      stepStart = Date.now();
    };
    this.route.prepare?.();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This device offers no microphone access.");
      if (typeof RTCPeerConnection === "undefined") throw new Error("This device doesn't support live audio (WebRTC).");
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).catch((error: unknown) => {
        throw new Error(isDenied(error) ? "Microphone access was denied." : `Couldn't use the microphone: ${message(error)}`);
      });
      step("microphoneMs");
      this.checkEnded();

      const pc = this.pc = new RTCPeerConnection();
      pc.ontrack = (event) => this.playRemote(event.streams[0] ?? new MediaStream([event.track]));
      pc.onconnectionstatechange = () => {
        this.handlers.log("VOICE_CONNECTION", { state: pc.connectionState });
        if (pc.connectionState === "failed") this.finish("The voice connection was lost.");
      };
      for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic);

      const channel = this.channel = pc.createDataChannel("oai-events");
      channel.onopen = () => {
        this.handlers.log("VOICE_CHANNEL", { state: "open" });
        this.quietTimer = window.setTimeout(() => {
          if (!this.messageCount) this.handlers.log("VOICE_NO_EVENTS", { route: this.route.name, afterMs: SESSION_TIMING.quietLog });
        }, SESSION_TIMING.quietLog);
        // The session counts as started once the channel is open: the
        // voice service may send no event before the user speaks.
        this.markStarted();
      };
      channel.onmessage = (event: MessageEvent) => this.receive(event.data);
      channel.onclose = () => {
        this.handlers.log("VOICE_CHANNEL", { state: "closed" });
        this.onClosed?.();
        if (this.started && !this.ended) this.finish("The voice connection was closed.");
      };

      await pc.setLocalDescription(await pc.createOffer());
      await iceGathered(pc, SESSION_TIMING.iceWait, SESSION_TIMING.iceSettle);
      step("offerMs");
      this.checkEnded();

      // What the voice model starts with: our instructions and the recent chat.
      this.handlers.log("VOICE_START", { route: this.route.name, instructions, items });
      const answer = await this.route.connect({ sdp: pc.localDescription?.sdp ?? "", instructions, items });
      step("callMs");
      this.handlers.log("VOICE_CALL", { route: this.route.name, callId: answer.callId ?? null });
      this.checkEnded();
      await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      await this.waitForStart();
      step("startMs");
      this.handlers.log("VOICE_TIMING", { route: this.route.name, ...timing });
      return { callId: answer.callId };
    } catch (error) {
      this.endNotified = true;
      this.cleanUp();
      throw error;
    }
  }

  /** Send a client event over the data channel (dropped when it isn't open). */
  send(event: Record<string, unknown>): void {
    const open = this.channel?.readyState === "open";
    this.handlers.log("VOICE_SEND", { ...event, sent: open });
    if (open) this.channel!.send(JSON.stringify(event));
  }

  /** The peer connection is up and the data channel open. */
  isConnected(): boolean {
    return this.pc?.connectionState === "connected" && this.channel?.readyState === "open";
  }

  /** Microphone on or off (mute, hold to talk): the track sends silence when off. */
  setMicEnabled(enabled: boolean): void {
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = enabled;
  }

  /** Start the remote audio after a tap, when autoplay was blocked. */
  resumeAudio(): Promise<void> {
    return this.audio?.play() ?? Promise.resolve();
  }

  /**
   * End the session: ask the server to close, wait briefly for
   * `session.closed`, then release the connection and the microphone.
   */
  async end(): Promise<void> {
    if (this.ended) return;
    if (this.started && this.channel?.readyState === "open") {
      let timer = 0;
      const closed = new Promise<void>((resolve) => {
        this.onClosed = resolve;
        timer = window.setTimeout(resolve, SESSION_TIMING.closeWait);
      });
      this.send(CLOSE_EVENT);
      await closed;
      window.clearTimeout(timer);
    }
    this.finish();
  }

  private receive(data: unknown): void {
    this.messageCount++;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      this.handlers.log("VOICE_EVENT_UNREADABLE", { data: String(data).slice(0, 500) });
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const event = parsed as Record<string, unknown>;
    // Every event as it arrives (transcripts, delegations, errors); no audio comes this way.
    this.handlers.log("VOICE_EVENT", event);
    if (event.type === "session.closed") this.onClosed?.();
    this.handlers.onMessage(event);
    if (event.type === "session.closed") this.finish();
  }

  private markStarted(): void {
    if (this.started) return;
    this.started = true;
    this.startWaiter?.resolve();
  }

  private waitForStart(): Promise<void> {
    if (this.started) return Promise.resolve();
    let timer = 0;
    return new Promise<void>((resolve, reject) => {
      this.startWaiter = { resolve, reject };
      timer = window.setTimeout(() => reject(new Error("The voice session didn't start. Try again.")), SESSION_TIMING.startWait);
    }).finally(() => {
      window.clearTimeout(timer);
      this.startWaiter = undefined;
    });
  }

  private playRemote(stream: MediaStream): void {
    const audio = this.audio ??= createEl("audio");
    audio.autoplay = true;
    audio.srcObject = stream;
    audio.play().catch(() => this.handlers.onAudioBlocked());
  }

  private checkEnded(): void {
    if (this.ended) throw new VoiceCancelled();
  }

  /** Release everything; tell the handlers once. */
  private finish(error?: string): void {
    this.cleanUp();
    if (this.endNotified) return;
    this.endNotified = true;
    this.handlers.onEnded(error);
  }

  private cleanUp(): void {
    this.ended = true;
    window.clearTimeout(this.quietTimer);
    // A start still waiting for the data channel gives up now.
    this.startWaiter?.reject(new VoiceCancelled());
    this.channel?.close();
    this.pc?.close();
    for (const track of this.mic?.getTracks() ?? []) track.stop();
    if (this.audio) {
      this.audio.pause();
      this.audio.srcObject = null;
    }
  }
}

/**
 * Resolves when ICE gathering is complete, or a short while after the first
 * candidate (`settleMs`), or after `timeoutMs`, with what was gathered.
 * Without STUN or TURN servers the usable (host) candidates come at once;
 * phones may report "complete" only after probing every network interface.
 */
function iceGathered(pc: RTCPeerConnection, timeoutMs: number, settleMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let settle = 0;
    const done = () => {
      window.clearTimeout(timer);
      window.clearTimeout(settle);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    pc.onicecandidate = (event) => {
      if (event.candidate && !settle) settle = window.setTimeout(done, settleMs);
    };
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
  });
}

function isDenied(error: unknown): boolean {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "SecurityError");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
