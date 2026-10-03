# OAuth live validation

Validated at 2026-10-03T21:12:26.734Z using the production catalog module and OAuth adapter.

Credential source: the owner-authorized local Codex OAuth session. No credentials or account identifiers are included here. The plugin Device Flow and physical iPhone were not exercised.

Stable Codex client version discovery returned `0.160.0`. The authenticated catalog returned the eight visible model IDs below; hidden entries were excluded.

| Model | Real inference |
|---|---|
| `gpt-6.1-sol` | HTTP 200, completed |
| `gpt-6-astra` | HTTP 200, completed |
| `gpt-6-sol` | HTTP 200, completed |
| `gpt-6-luna` | HTTP 200, completed |
| `gpt-5.6-sol` | HTTP 200, completed |
| `gpt-5.6-terra` | HTTP 200, completed |
| `gpt-5.6-luna` | HTTP 200, completed |
| `gpt-5.5` | HTTP 200, completed |

Production read-template → create-copy round trips passed with both `gpt-5.5` and `gpt-6.1-sol`. Both replayed assistant text alongside tool calls and copied the exact synthetic content. Web search was enabled in the request. Tools ran in memory; actual vault writes: zero.

No native encrypted reasoning items were emitted in these short live cases, so this evidence does not establish live encrypted-reasoning replay. Regression fixtures cover replay. Anthropic Opus 5.5 has parameter/history regression coverage but was not tested against the live Anthropic service.

Catalog presence alone does not prove account eligibility. The successful inference requests above establish availability only for the tested account at this time. Upstream changes can still require a plugin update.
