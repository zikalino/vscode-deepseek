# Quota proxy (reference implementation)

A dependency-free Node service that hands out a monthly token allowance and proxies chat requests
to DeepSeek. It is the backend half of the `deepseek.account.*` settings in the extension.

The extension cannot enforce an allowance by itself: a counter in the extension (or a DeepSeek key
shipped in the `.vsix`) can be edited or extracted. So the real key stays here, and every request is
metered by the caller's GitHub account.

## Requirements

- Node.js 18 or newer (`fetch`, `node:test`).
- A DeepSeek API key that the proxy spends.
- (For the extension) a GitHub OAuth app with **Device Flow** enabled, for sign-in.

## Run

```bash
export DEEPSEEK_API_KEY=sk-...
node server/index.mjs
```

Windows PowerShell:

```powershell
$env:DEEPSEEK_API_KEY = 'sk-...'
node .\server\index.mjs
```

Then point the extension at it:

| Setting | Value |
|---|---|
| `deepseek.account.proxyUrl` | `http://localhost:8787` |
| `deepseek.account.githubClientId` | the OAuth app's client ID |

Run `DeepSeek: Sign In for Free Tokens` from the Command Palette. The proxy must be reachable from
the extension host (the same machine when using `localhost`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listen port. |
| `DEEPSEEK_API_KEY` | *(required)* | Server-side key used for upstream calls. |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | Upstream base URL (point at a mock for tests). |
| `SPONSOR_LOGIN` | `zikalino` | GitHub account whose Sponsors list decides the sponsor tier. |
| `FREE_TOKENS` | `100000` | Monthly allowance for any signed-in account. |
| `SPONSOR_TOKENS` | `5000000` | Monthly allowance for an active sponsor. |
| `MIN_ACCOUNT_AGE_DAYS` | `0` | Reject accounts younger than this (`0` disables the gate). |
| `SESSION_TTL_MINUTES` | `60` | Session lifetime; sponsorship is re-checked on renewal. |
| `MAX_BODY_BYTES` | `8388608` | Largest accepted request body. |

## Contract

### `POST /v1/session`

Request:

```json
{ "githubToken": "gho_..." }
```

The proxy calls `GET https://api.github.com/user` to resolve the identity (never trusting anything
the client asserts), checks `viewerIsSponsoring` against `SPONSOR_LOGIN`, and returns:

```json
{
  "token": "<opaque session token>",
  "expiresAt": "2026-11-22T23:00:00.000Z",
  "user": { "id": "1234567", "login": "octocat" },
  "tier": "sponsor",
  "quota": { "limit": 5000000, "used": 0, "remaining": 5000000, "resetsAt": "2026-12-22T22:00:00.000Z" }
}
```

`401` means the GitHub token is invalid; `403` with `code: "account_too_new"` means the age gate
rejected it.

### `GET /v1/usage`

`Authorization: Bearer <session token>` → the same `user`, `tier` and `quota` shape.

### `POST /v1/chat/completions`

`Authorization: Bearer <session token>`, body is the usual OpenAI-compatible chat request. The proxy:

- rejects with `402 insufficient_quota` once the allowance is spent,
- adds `stream_options.include_usage = true` to streamed requests,
- forwards the upstream response (SSE included) unchanged,
- charges the reported `usage.total_tokens` to the caller's GitHub id,
- returns `X-Quota-Remaining` on the response.

The upstream key never reaches the client.

### `GET /health`

Unversioned status without secrets: limits, sponsor login, and session TTL.

## GitHub OAuth app setup (for the extension)

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Any name and homepage URL; the callback URL is unused by the device flow but the field is
   required.
3. Enable **Device Flow** in the app settings.
4. Copy the **Client ID** into `deepseek.account.githubClientId`.

No client secret is used or shipped.

## What this reference is not

- **Not persistent.** Two in-memory `Map`s hold accounts and sessions; a restart resets every
  allowance and signs everyone out. Swap in a database (key on the GitHub numeric id) before
  running it for real.
- **Not rate-limited.** Add per-account and per-IP limits before exposing it publicly; one abusive
  account can spend the whole monthly budget.
- **Not multi-tenant.** One DeepSeek key, one sponsor login.
- **No audit trail.** Deliberately: prompts and responses are streamed through, never stored.

## Testing

```bash
node --test server/usage.test.mjs server/app.test.mjs
```

The tests cover the usage meter (SSE framing, chunk splits, malformed frames) and the full
session → stream → charge → `402` path against a local mock upstream.
