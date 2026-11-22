import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, before, test } from 'node:test';

import { createQuotaServer } from './app.mjs';

let upstream;
let upstreamUrl;
let proxy;
let proxyUrl;

before(async () => {
  upstream = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (body.stream === true) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [], usage: { total_tokens: 4 } }));
  });
  const upstreamPort = await listen(upstream);
  upstreamUrl = `http://127.0.0.1:${upstreamPort}`;

  proxy = createQuotaServer({
    deepseekApiKey: 'sk-test',
    deepseekUrl: upstreamUrl,
    sponsorLogin: 'maintainer',
    freeTokens: 4,
    sponsorTokens: 100,
    verifyIdentity: async (token) => {
      const identities = {
        good: { id: '42', login: 'octocat' },
        sponsor: { id: '43', login: 'backer' },
        second: { id: '44', login: 'octocat-2' },
        third: { id: '45', login: 'octocat-3' },
      };
      return identities[token];
    },
    isSponsor: async (token) => token === 'sponsor',
  });
  const proxyPort = await listen(proxy);
  proxyUrl = `http://127.0.0.1:${proxyPort}`;
});

after(async () => {
  await close(proxy);
  await close(upstream);
});

test('issues a free session and reports the allowance', async () => {
  const session = await postJson('/v1/session', { githubToken: 'good' });
  assert.equal(session.status, 200);
  const body = await session.json();
  assert.equal(body.user.login, 'octocat');
  assert.equal(body.tier, 'free');
  assert.equal(body.quota.limit, 4);
  assert.equal(body.quota.used, 0);
  assert.ok(body.token.length > 20);

  const usage = await fetch(`${proxyUrl}/v1/usage`, {
    headers: { Authorization: `Bearer ${body.token}` },
  });
  assert.equal(usage.status, 200);
  assert.equal((await usage.json()).quota.remaining, 4);
});

test('rejects an unknown GitHub token', async () => {
  const response = await postJson('/v1/session', { githubToken: 'nope' });
  assert.equal(response.status, 401);
});

test('grants the sponsor allowance to a sponsor', async () => {
  const response = await postJson('/v1/session', { githubToken: 'sponsor' });
  const body = await response.json();
  assert.equal(body.tier, 'sponsor');
  assert.equal(body.quota.limit, 100);
});

test('streams through and charges the reported usage', async () => {
  const token = await sessionFor('second');
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true, messages: [] }),
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /"content":"hi"/);
  assert.match(text, /\[DONE\]/);
  assert.match(text, /"total_tokens":10/);

  const usage = await usageFor(token);
  assert.equal(usage.quota.used, 10);
  assert.equal(usage.quota.remaining, 0);
});

test('rejects a request once the allowance is spent', async () => {
  const token = await sessionFor('third');
  const first = await chat(token, { stream: false });
  assert.equal(first.status, 200);
  const second = await chat(token, { stream: false });
  assert.equal(second.status, 402);
  const body = await second.json();
  assert.equal(body.error.code, 'quota_exhausted');
});

test('requires a session token', async () => {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(response.status, 401);
});

async function sessionFor(githubToken) {
  const response = await postJson('/v1/session', { githubToken });
  return (await response.json()).token;
}

async function usageFor(token) {
  const response = await fetch(`${proxyUrl}/v1/usage`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.json();
}

function chat(token, body) {
  return fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [], ...body }),
  });
}

function postJson(path, body) {
  return fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
