# cursor-codex-gateway

OpenAI **and** Codex **and** Claude Code, backed by your [Cursor](https://cursor.com) subscription.

This is a clean fork of [pwnapplehat/Cursor-OpenAI](https://github.com/pwnapplehat/Cursor-OpenAI) (MIT). Upstream speaks Chat Completions. This repo adds the two protocol gaps that coding agents actually need:

| Client | Protocol | This repo |
| --- | --- | --- |
| OpenAI SDK, ChatBox, Continue | `POST /v1/chat/completions` | kept from upstream |
| Codex (2026, `wire_api = "responses"`) | `POST /v1/responses` | **added** |
| Claude Code (`ANTHROPIC_BASE_URL`) | `POST /v1/messages` | **added** |

```
Codex                         Claude Code                      OpenAI clients
POST /v1/responses            POST /v1/messages                POST /v1/chat/completions
        │                              │                                │
        └──────────────┬───────────────┴────────────────────────────────┘
                       ▼
              Cursor Agent SDK  (your CURSOR_API_KEY)
```

Dashboard, CLI, Docker, sessions, and tool calling from upstream are unchanged.

## Quick start

Requires Node.js 22.13+. Get a Cursor API key from [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api).

```bash
git clone https://github.com/mxy906/cursor-codex-gateway.git
cd cursor-codex-gateway
cp .env.example .env
# set CURSOR_API_KEY=crsr_your_key_here
# set AUTH_KEY=change-me
npm install
npm run build
npm start
```

Docker:

```bash
docker compose up --build
```

Point clients at `http://127.0.0.1:8787` (or `/v1` for OpenAI-style base URLs). Send `Authorization: Bearer <AUTH_KEY>` or `x-api-key: <AUTH_KEY>`.

## Codex

`~/.codex/config.toml`:

```toml
model_provider = "cursor-gw"
model = "gpt-5.5"

[model_providers.cursor-gw]
name = "cursor-codex-gateway"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
```

Put the gateway `AUTH_KEY` in Codex auth the same way you would an OpenAI key.

## Claude Code

Do this in a **throwaway shell**. Do not put these in your login profile if you want to keep the stock Claude Code install untouched.

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_AUTH_TOKEN="change-me"   # gateway AUTH_KEY
export ANTHROPIC_MODEL="claude-sonnet-5"
claude
```

Claude Code speaks Anthropic Messages. This gateway accepts the fields it actually sends (`system` blocks, `tools` / `tool_use` / `tool_result`, images, `thinking`, `cache_control`, `anthropic-beta`, `x-api-key`) instead of 400ing on them.

Isolated protocol test (HTTP only, does **not** launch or reconfigure Claude Code):

```bash
AUTH_KEY=change-me npm run smoke:messages
```

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/v1/chat/completions` | OpenAI Chat Completions |
| POST | `/v1/responses` | OpenAI Responses (Codex) |
| POST | `/v1/messages` | Anthropic Messages (Claude Code). `?beta=true` is ignored |
| POST | `/v1/messages/count_tokens` | local estimate; Claude Code uses this when present |
| GET | `/v1/models` | OpenAI list, or Anthropic list when `anthropic-version` is set |
| HEAD | `/api/hello` | Claude Code warmup probe |
| GET | `/health` | liveness |

## What this is not

- Not the Cursor IDE. No repo index, no Cursor rules, no cloud agent workspace.
- Not native OpenAI Responses or native Anthropic. Both extra endpoints are **translation layers** onto Cursor Agent SDK.
- Each call still runs as a Cursor agent, so input token counts are large even for a one-word reply.
- `cache_control` is accepted and ignored (no Anthropic prompt-cache billing).
- Bedrock / Vertex dialects are not implemented.
- Use **your own** Cursor API key. Relaying a shared plan may violate Cursor's terms.

## Tests

```bash
npm test                 # unit tests, no Cursor account needed
npm run smoke:messages   # against a running gateway; costs Cursor usage
```

## Contact

Issues: [GitHub Issues](https://github.com/mxy906/cursor-codex-gateway/issues). WeChat: **mxy0544**.

## Credits

Based on [pwnapplehat/Cursor-OpenAI](https://github.com/pwnapplehat/Cursor-OpenAI). Original dashboard, CLI, session manager, and Agent SDK integration are theirs. Codex `/v1/responses` and Claude Code `/v1/messages` were added in this repository.

MIT — see [LICENSE](LICENSE).
