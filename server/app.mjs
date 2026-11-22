// The quota proxy as a factory, so tests can inject identity verification and an upstream URL.
//
// `index.mjs` is the CLI that wires environment variables to this; the HTTP contract and the
// accounting live here. State is per-server-instance and in memory (see README).

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

import { UsageMeter, usageTotal } from './usage.mjs';

const PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
const SPONSOR_CACHE_MS = 10 * 60 * 1000;

/**
 * @param {object} [options]
 * @param {string} [options.deepseekApiKey] Server-side upstream key.
 * @param {string} [options.deepseekUrl] Upstream base URL.
 * @param {string} [options.sponsorLogin] Account whose sponsorship decides the tier.
 * @param {number} [options.freeTokens] Monthly free allowance.
 * @param {number} [options.sponsorTokens] Monthly sponsor allowance.
 * @param {number} [options.minAccountAgeDays] Reject newer accounts when > 0.
 * @param {number} [options.sessionTtlMs] Session lifetime.
 * @param {number} [options.maxBodyBytes] Request body cap.
 * @param {(token: string) => Promise<{id: string, login: string, createdAt?: string} | undefined>} [options.verifyIdentity]
 * @param {(token: string, login: string) => Promise<boolean>} [options.isSponsor]
 */
export function createQuotaServer(options = {}) {
  const config = {
    deepseekApiKey: options.deepseekApiKey ?? '',
    deepseekUrl: (options.deepseekUrl ?? 'https://api.deepseek.com').replace(/\/+$/, ''),
    sponsorLogin: (options.sponsorLogin ?? '').trim(),
    freeTokens: nonNegative(options.freeTokens, 100_000),
    sponsorTokens: nonNegative(options.sponsorTokens, 5_000_000),
    minAccountAgeDays: nonNegative(options.minAccountAgeDays, 0),
    sessionTtlMs: Math.max(1, nonNegative(options.sessionTtlMs, 60 * 60 * 1000)),
    maxBodyBytes: Math.max(1024, nonNegative(options.maxBodyBytes, 8 * 1024 * 1024)),
    verifyIdentity: options.verifyIdentity ?? githubUser,
    isSponsor:
      options.isSponsor ?? ((token) => githubIsSponsor(token, config.sponsorLogin)),
  };

  /** @type {Map<string, {id: string, login: string, used: number, periodStart: number, tier: string, limit: number, sponsorCheckedAt: number}>} */
  const accounts = new Map();
  /** @type {Map<string, {githubId: string, expiresAt: number}>} */
  const sessions = new Map();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          freeTokens: config.freeTokens,
          sponsorTokens: config.sponsorTokens,
          sponsorLogin: config.sponsorLogin,
          minAccountAgeDays: config.minAccountAgeDays,
          sessionTtlMinutes: Math.round(config.sessionTtlMs / 60_000),
        });
      }
      if (req.method === 'POST' && url.pathname === '/v1/session') {
        return await createSession(req, res);
      }
      if (req.method === 'GET' && url.pathname === '/v1/usage') {
        return getUsage(req, res);
      }
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
        return await chatCompletions(req, res);
      }
      sendError(res, 404, 'Not found.', 'invalid_request_error');
    } catch (error) {
      console.error('[quota-proxy]', error);
      if (!res.headersSent) {
        sendError(res, 500, 'Internal error.', 'api_error');
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  async function createSession(req, res) {
    let body;
    try {
      body = JSON.parse((await readBody(req, 64 * 1024)) || '{}');
    } catch {
      return sendError(res, 400, 'Invalid JSON body.', 'invalid_request_error');
    }
    const githubToken = typeof body.githubToken === 'string' ? body.githubToken.trim() : '';
    if (githubToken.length === 0) {
      return sendError(res, 401, 'A GitHub token is required.', 'authentication_error');
    }

    let identity;
    try {
      identity = await config.verifyIdentity(githubToken);
    } catch {
      return sendError(res, 502, 'Could not reach GitHub.', 'api_error');
    }
    if (identity === undefined) {
      return sendError(res, 401, 'The GitHub token is invalid or expired.', 'authentication_error');
    }

    if (config.minAccountAgeDays > 0 && typeof identity.createdAt === 'string') {
      const ageDays = (Date.now() - Date.parse(identity.createdAt)) / 86_400_000;
      if (!(ageDays >= config.minAccountAgeDays)) {
        return sendError(
          res,
          403,
          `GitHub accounts younger than ${config.minAccountAgeDays} days are not eligible yet.`,
          'permission_error',
          'account_too_new',
        );
      }
    }

    const account = accountFor(String(identity.id), String(identity.login));
    if (Date.now() - account.sponsorCheckedAt >= SPONSOR_CACHE_MS) {
      try {
        applyTier(account, await config.isSponsor(githubToken, config.sponsorLogin));
      } catch {
        // A GraphQL hiccup must not downgrade a sponsor; keep the last known tier.
      }
      account.sponsorCheckedAt = Date.now();
    }

    pruneSessions();
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + config.sessionTtlMs;
    sessions.set(token, { githubId: account.id, expiresAt });
    return sendJson(res, 200, {
      token,
      expiresAt: new Date(expiresAt).toISOString(),
      user: { id: account.id, login: account.login },
      tier: account.tier,
      quota: quotaOf(account),
    });
  }

  function getUsage(req, res) {
    const account = accountForSession(req);
    if (account === undefined) {
      return sendError(res, 401, 'Sign in again to continue.', 'authentication_error');
    }
    return sendJson(res, 200, {
      user: { id: account.id, login: account.login },
      tier: account.tier,
      quota: quotaOf(account),
    });
  }

  async function chatCompletions(req, res) {
    const account = accountForSession(req);
    if (account === undefined) {
      return sendError(res, 401, 'Sign in again to continue.', 'authentication_error');
    }
    if (account.used >= account.limit) {
      return sendError(
        res,
        402,
        `Monthly token allowance exhausted (${account.used} of ${account.limit}).`,
        'insufficient_quota',
        'quota_exhausted',
      );
    }

    let body;
    try {
      body = JSON.parse(await readBody(req, config.maxBodyBytes));
    } catch {
      return sendError(res, 400, 'Invalid JSON body.', 'invalid_request_error');
    }

    const stream = body.stream === true;
    if (stream) {
      // The usage frame is the only reliable way to charge a streamed response.
      body.stream_options = { ...(body.stream_options || {}), include_usage: true };
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    let upstream;
    try {
      upstream = await fetch(`${config.deepseekUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.deepseekApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        return undefined;
      }
      return sendError(res, 502, 'Could not reach the model provider.', 'api_error');
    }

    const remaining = Math.max(0, account.limit - account.used);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'X-Quota-Remaining': String(remaining),
      });
      return res.end(text);
    }

    if (!stream) {
      const text = await upstream.text();
      let used = 0;
      try {
        used = usageTotal(JSON.parse(text).usage);
      } catch {
        // A body that is not JSON was not billable; pass it through unchanged.
      }
      charge(account, used);
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'X-Quota-Remaining': String(Math.max(0, account.limit - account.used)),
      });
      return res.end(text);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Quota-Remaining': String(remaining),
    });

    const meter = new UsageMeter();
    const decoder = new TextDecoder();
    try {
      for await (const chunk of upstream.body) {
        const bytes = Buffer.from(chunk);
        meter.push(decoder.decode(bytes, { stream: true }));
        if (!(await writeChunk(res, bytes))) {
          break;
        }
      }
      meter.push(decoder.decode());
    } catch {
      // A client abort lands here; whatever usage was reported so far is still charged below.
    } finally {
      charge(account, meter.flush());
      if (!res.writableEnded) {
        res.end();
      }
    }
    return undefined;
  }

  function accountFor(id, login) {
    let account = accounts.get(id);
    if (account === undefined) {
      account = {
        id,
        login,
        used: 0,
        periodStart: Date.now(),
        tier: 'free',
        limit: config.freeTokens,
        sponsorCheckedAt: 0,
      };
      accounts.set(id, account);
    } else {
      account.login = login;
    }
    if (Date.now() - account.periodStart >= PERIOD_MS) {
      account.used = 0;
      account.periodStart = Date.now();
    }
    return account;
  }

  function applyTier(account, sponsor) {
    account.tier = sponsor ? 'sponsor' : 'free';
    account.limit = sponsor ? config.sponsorTokens : config.freeTokens;
  }

  function quotaOf(account) {
    return {
      limit: account.limit,
      used: account.used,
      remaining: Math.max(0, account.limit - account.used),
      resetsAt: new Date(account.periodStart + PERIOD_MS).toISOString(),
    };
  }

  function charge(account, tokens) {
    if (Number.isFinite(tokens) && tokens > 0) {
      account.used += tokens;
    }
  }

  function accountForSession(req) {
    const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (match === null) {
      return undefined;
    }
    const token = match[1].trim();
    const entry = sessions.get(token);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      sessions.delete(token);
      return undefined;
    }
    return accounts.get(entry.githubId);
  }

  function pruneSessions() {
    const now = Date.now();
    for (const [token, entry] of sessions) {
      if (entry.expiresAt <= now) {
        sessions.delete(token);
      }
    }
  }

  return server;
}

/** Resolves false when the client went away before the chunk could be written. */
function writeChunk(res, bytes) {
  if (res.write(bytes)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve(!res.destroyed);
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  if (res.headersSent) {
    return res.end();
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
  return undefined;
}

function sendError(res, status, message, type, code) {
  return sendJson(res, status, {
    error: { message, type, ...(code === undefined ? {} : { code }) },
  });
}

function nonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Resolve a GitHub identity from a user token; undefined means the token is invalid. */
export async function githubUser(token) {
  const response = await fetch('https://api.github.com/user', { headers: githubHeaders(token) });
  if (response.status === 401) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`github user: ${response.status}`);
  }
  const user = await response.json();
  return { id: String(user.id), login: String(user.login), createdAt: user.created_at };
}

/** Whether `token`'s account currently sponsors `login`. */
export async function githubIsSponsor(token, login) {
  if (login.length === 0) {
    return false;
  }
  const query =
    'query($login: String!) {' +
    ' user(login: $login) { viewerIsSponsoring }' +
    ' organization(login: $login) { viewerIsSponsoring }' +
    ' }';
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { ...githubHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!response.ok) {
    throw new Error(`github graphql: ${response.status}`);
  }
  const payload = await response.json();
  return Boolean(
    payload?.data?.user?.viewerIsSponsoring || payload?.data?.organization?.viewerIsSponsoring,
  );
}

function githubHeaders(token) {
  return {
    Authorization: `bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'deepseek-quota-proxy',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
