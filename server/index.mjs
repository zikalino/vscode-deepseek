// CLI entry point: environment variables in, listening server out.
//
// The HTTP contract and accounting live in `app.mjs`; see `README.md` for the variables and the
// request/response shapes.

import { createQuotaServer } from './app.mjs';

const PORT = Number(process.env.PORT || 8787);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';

const server = createQuotaServer({
  deepseekApiKey: DEEPSEEK_API_KEY,
  deepseekUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  sponsorLogin: process.env.SPONSOR_LOGIN || 'zikalino',
  freeTokens: numberFromEnv('FREE_TOKENS', 100_000),
  sponsorTokens: numberFromEnv('SPONSOR_TOKENS', 5_000_000),
  minAccountAgeDays: numberFromEnv('MIN_ACCOUNT_AGE_DAYS', 0),
  sessionTtlMs: Math.max(1, numberFromEnv('SESSION_TTL_MINUTES', 60)) * 60_000,
  maxBodyBytes: numberFromEnv('MAX_BODY_BYTES', 8 * 1024 * 1024),
});

server.listen(PORT, () => {
  console.log(`[quota-proxy] listening on http://localhost:${PORT}`);
  if (DEEPSEEK_API_KEY.length === 0) {
    console.warn('[quota-proxy] DEEPSEEK_API_KEY is not set; chat requests will fail upstream.');
  }
});

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
