# Phase 7: voice integration (PR #46)

Scope: the contributor's voice commit `bafa36e559a78a39135c4b82154e4b6b6c0549ad`, merged with 0.10.0 main `2fc7b57` while preserving ancestry. This stage prepares the existing PR for merge; it does not merge, tag or publish a release. Plugin identity, minimum Obsidian version and saved chat format remain unchanged.

## Behavior and integration fixes

Voice uses the existing ChatGPT sign-in to create a Codex WebRTC call. A conversational frontend delegates work to the selected chat provider; vault actions and their results remain ordinary chat turns. This backend is distinct from OpenAI's documented API-key Live service. Account access and limits are not inferred from public API pricing.

The integration retains main's MCP checkpoint/replay protections, portable compaction, per-chat storage, draft preservation and selection fingerprints. Voice requests use the selection displayed in the composer. Refusal before dispatch reports failure to the voice controller without replacing the unsent typed composer or clipping earlier user rows. Manual compaction is never stopped merely because voice requested work.

Delegation IDs dispatch at most once per call, including events delivered after a completed turn. Similar but longer requests are not treated as duplicates of already-steered words. A spoken ask_user ends at its question; later tools in the same batch retain cancellation results until the user answers. Stop reports stopped rather than reading an intermediate response as a final success. Preflight failures and thrown errors cannot claim the requested work succeeded.

Hold mode is muted before SDP exchange. Ending a call disables the microphone and pauses output immediately, ignores late delegation events and prevents re-enabling tracks. A data-channel send failure during closing still releases all media resources. Startup permission and call-creation waits are bounded and cancel promptly; a microphone granted after timeout/cancellation is released. Hold-to-talk also releases on element/window blur and lost pointer capture. Signing out ends an active call.

Completed user transcript events now enter steering even when the voice frontend acknowledges without delegating. Consumed original utterances do not reappear after a paraphrased delegation. Speech/progress chunks retain exact separators. Capability diagnostics bound fetch, streaming readers and model-list waits, abort/cancel stalled probes and continue to later checks. Eight regression tests cover these three Codex P2 findings, including both terminal-event orders and ignored-abort WebViews.

Automatic reconnection now keeps the running controller and turn hooks until delegated work (including late additions) finishes. Its transport closes immediately; the replacement call is seeded with the saved result and a request to report it without rerunning work. A lost background connection no longer marks the task owner ended. Open user transcript fragments are drained at task completion, with late terminal events deduplicated. A data channel closed before opening releases startup resources immediately. Seven additional regressions cover healthy/lost mobile reconnection, completion ordering both pre-open close timings, and failed/stopped outcome handoff without substituting an older answer.

## Validation

775 automated tests, TypeScript, Svelte (zero errors/warnings) and production build pass. Regressions cover duplicate dispatch, held microphone negotiation, late events, sign-out, scoped writes, compaction refusal, clarification batches, stopped tasks, pending permission cancellation and hung call creation without retries.

The production bundle passed 111 native Mac regression checks and 25 mounted voice-UI checks, including actual hold-key/blur behavior, delegated answer rendering, duplicate suppression, ending and a 375px layout. All 1,809 protected existing vault files retained their hashes. These checks use synthetic microphone/WebRTC/provider transport, and do not establish physical-device acceptance. See phase7-qa.json for candidate hashes and later verification.

A synthetic spoken request passed through the real ChatGPT/Codex WebRTC service, triggered delegation, ran one read_document tool on the real selected chat backend, and returned the test note text to chat and the spoken response. No vault write tool ran. A second real-service scenario held the backend completion boundary during reconnection: the original controller remained until the read finished, a replacement WebRTC call connected, and only one read_document call was retained. Real account call creation and WebRTC connectivity were established with a synthetic audio track. Physical microphone sampling is not accepted: this Mac enumerated only Splashtop Remote Sound (Virtual), whose getUserMedia request did not return. Physical iOS/Android and Bluetooth are not accepted by the maintainer in this run; the contributor's earlier Android report is attributed separately.

Current-head CI, Codex review, unresolved threads and the official Community Preview must all finish successfully before this PR is described as merge-ready. Pending scans are not accepted results.

References: [OpenAI Live architecture](https://developers.openai.com/api/docs/guides/live), [Live prompting and permission checks](https://developers.openai.com/api/docs/guides/live-prompting). Those document the public API, not the ChatGPT-account endpoint used here.

## Dependency assessment

The lockfile is unchanged from main. The full development-tree npm audit reports five affected packages; the production dependency audit reports zero. The high-severity devalue findings are in Svelte's server-only serialization imports, which this client-mounted plugin does not use. The Svelte advisories require SSR/hydratable, attacker-controlled form/name spreading, or svelte:element tag validation; none is used by this component. See [the form-spreading advisory](https://github.com/sveltejs/svelte/security/advisories/GHSA-rcqx-6q8c-2c42) and [the hydratable advisory](https://github.com/sveltejs/svelte/security/advisories/GHSA-f3cj-j4f6-wq85).

The esbuild advisory concerns its development server; the build uses rebuild/watch and never serves it. The moment finding comes through the external Obsidian development API package, not a bundled moment import; this plugin does not call locale with user input. These pre-existing build/unused-path findings are assessed separately from the official production-dependency scan; they are not presented as an all-dependencies-clean result.
