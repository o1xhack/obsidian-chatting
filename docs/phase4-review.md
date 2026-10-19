# Phase 4: PR #39 — remote MCP (0.8.0)

Scope: author commit `5be1624d1493435bf08b3778e5ab4c80acd8ac67`, merged with ancestry preserved on `codex/phase-4-mcp-080`, based on main `c2c87fb`. PRs #40–46 are excluded. Chat persistence remains version 3.

## Review fixes

- Empty token input now explicitly clears SecretStorage; an unavailable/unloaded token is still left alone. Duplicate/unsafe server IDs are rejected on load. New servers have distinct random IDs and start disabled. URL userinfo/fragments are refused so credentials belong in the token field.
- Native replay is bound to a hash of the server ID, endpoint and authorization. No token is saved in that metadata. OpenAI cursor reuse also requires the same MCP configuration; disabling a server works in a live conversation, without importing history first.
- Remote result text shares the 200,000-character local tool allowance, with a 100,000-character per-result limit. Multi-part results cannot multiply that limit. Non-text Anthropic MCP result payloads are omitted with text markers instead of bypassing attachment budgets.
- Pending server calls are not reported as successfully completed. Anthropic pause-turn continuations can match a result with a call in retained history.
- Truncated responses retain completed remote receipts while dropping partial local calls. Failed Responses containing MCP calls are not automatically retried, and the user is told external changes may already have happened.
- Server changes take effect on the next request of a running turn; already-sent remote calls cannot be recalled. The guide explains context sharing, device-local tokens, automatic execution and the scope of vault Undo.

## Validation

516 automated tests passed, including 27 MCP regressions. TypeScript, Svelte checks (zero errors/warnings), and production build passed. Native/device evidence and clean rebuild verification remain release gates. Transport-mocked regression tests are not live-provider or physical-device proof.

Schema references: [OpenAI remote MCP](https://developers.openai.com/api/docs/guides/tools-connectors-mcp), [Anthropic MCP connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector), [Anthropic server-tool continuation](https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools).
