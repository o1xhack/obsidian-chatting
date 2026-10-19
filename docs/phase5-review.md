# Phase 5: streaming and background conversations (0.9.0)

Scope: PR #40 `920f42f`, #41 `bbb566e`, #42 `673cc5a`, #43 `adff3c2`, merged individually with author ancestry preserved onto 0.8.0 (`e089e1f`). PR #44–46 are excluded. Saved chat format remains version 3, with optional pending-turn and queued-message fields.

## Behavior and review fixes

- Responses stream through runtime Node HTTPS on desktop and fetch on mobile, with buffered Obsidian requestUrl fallback where needed. Stop keeps partial text. OpenAI and ChatGPT share event collection while retaining their endpoint/authentication differences.
- Text sent during a run joins its next tool step or becomes a subsequent turn. Queues, questions, streamed text, undo and errors belong to their conversation. Switching chats leaves sent requests running; deleting a chat stops its run.
- Mobile lifecycle hints trigger bounded recovery of transient failures, with one shared two-resend allowance per turn and separate streamed/buffered stall windows. Continue after restart sends saved tool results without executing those completed tools again.
- An MCP-capable POST with a lost response is not re-posted through a fallback transport, because the server may already have acted even before response headers arrived. Pending MCP-capable requests carry uncertainty through restart; Continue is unavailable until a new user message, with a warning to check the external service first.
- Preserve all 0.8.0 MCP identity, revocation, cursor and history-budget protections. Stream failures retain completed MCP receipts; cut streams, overload events and background failures after remote work cannot automatically repeat external operations. Started operations with unknown outcomes get a portable warning rather than a success claim.
- Continue retains the original selection restriction and fingerprint. A changed selected note remains protected. MCP configuration is re-read on each continued request and rate-limit retry. Plan/quota failures are excluded from background recovery.

## Validation

624 automated tests passed, including streamed MCP failure/background/drop regressions, selection enforcement on Continue and quota failures. TypeScript, Svelte (zero errors/warnings) and production build passed. Native desktop Obsidian passed 27 checks against the production bundle, including actual mounted Svelte controls and conversation isolation. All 1,809 existing visible vault files remained hash-unchanged; original settings, login and chats were preserved. The real ChatGPT subscription (gpt-6.1-sol) streamed a reply that completed after switching chats; a separate foreground reply succeeded with no cross-chat output or tool calls. Evidence: [phase5-qa.json](phase5-qa.json). Final current-head external reviews remain release gates.

Native QA uses only the isolated Mac vault. The connected ChatGPT subscription is used for real streaming smoke tests. Anthropic/OpenAI API-key services have no configured keys, so their transport and lifecycle tests are simulated. iPhone Air is not operated; mobile lifecycle tests do not establish physical-device suspension behavior.

References: [OpenAI streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events), [OpenAI remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).
