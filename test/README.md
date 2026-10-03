# Test harness

## Offline regression tests

```bash
npm test
```

Bundles the production provider adapters and agent loop with an in-memory
vault and mocked `requestUrl`. No credentials or live API calls are needed.
Tests cover assistant output encoding, native thinking/reasoning/search replay,
read → create/edit flows, parallel tools, cancellation, history restoration,
Anthropic `pause_turn` and thinking configuration, and OpenAI conversation
isolation. These tests do not establish live-service or physical-iOS behavior.

Two Node scripts that exercise the ChatGPT/Codex Responses endpoint
**without** going through Obsidian, so iteration on the
`chatgpt-oauth` provider doesn't require BRAT round-trips.

## One-time setup

```bash
node test/codex-login.mjs
```

Opens the Device Code Flow:

1. Opens the verification URL on `auth.openai.com/codex/device`.
2. Prints a short user code to enter on that page.
3. After you sign in with your ChatGPT account, polls until the token
   is issued and writes it to `temp/codex-token.json`.

`temp/` is gitignored — the credential never leaves your machine.

## Smoke test

```bash
node test/codex-smoke.mjs                       # default: gpt-5.5, "Say hello in one word."
node test/codex-smoke.mjs gpt-5.4                # different model
node test/codex-smoke.mjs gpt-5.5 "ziama"        # custom message
node test/codex-smoke.mjs gpt-5.5 "echo: hi" --tools  # also pass a function tool
node test/codex-smoke.mjs gpt-5.5 "what is the weather in nyc" --web-search
```

The script:

1. Loads the credential from `temp/codex-token.json`. Refreshes it via
   `auth.openai.com/oauth/token` if expired.
2. Builds the **exact** request body and headers the plugin sends from
   `src/api/chatgpt-oauth.ts` — same `originator`, `User-Agent`,
   `ChatGPT-Account-Id`, `store`, `parallel_tool_calls`, `reasoning`,
   `include`, etc.
3. POSTs to `chatgpt.com/backend-api/codex/responses` and parses the
   SSE response.
4. Prints HTTP status, parsed event types and counts, the final
   assistant text and any tool calls. Exits 0 on success, 1 on failure.

These standalone scripts use hand-built request fixtures. A passing result
establishes only that those fixtures worked against that account's backend;
it does not validate the production history converter. Run `npm test` for
production adapter/loop regression coverage and verify iOS on a physical device.

## Why this exists

Each Codex error mode used to require: edit code → bump version →
build → tag → release → BRAT update → reproduce. That's ~5 minutes
per iteration of debugging *one error message*. With this harness
the loop is: edit code (or the script's body builder) → run script →
see the real server response in milliseconds. We only ship to
Obsidian once the smoke test is green.


Production regression tests also cover dynamic catalogs, 24-hour persistence, request deduplication, failure backoff, manual refresh, account changes during fetch, Anthropic pagination, stable Codex version discovery, GPT-6 reasoning metadata, and model/account isolation of native reasoning replay. Run `npm test`.

Live validation results and their limits are recorded in [oauth-live-validation.md](oauth-live-validation.md).
