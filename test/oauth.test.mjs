// OAuth flow, token checks, consent, and the CLI trust record. No Claude Code runs here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OAuth } from '../src/oauth.mjs';
import { createApp } from '../src/server.mjs';
import { Sessions, cleanEnv } from '../src/sessions.mjs';

const BASE = 'https://do-it.test';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

function fakeGithub(login) {
  return async (url, init) => {
    if (url === 'https://github.test/login/oauth/access_token') {
      assert.equal(new URLSearchParams(init.body.toString()).get('code'), 'gh-code');
      return Response.json({ access_token: 'gh-token' });
    }
    if (url === 'https://api.github.test/user') return Response.json({ login });
    throw new Error(`unexpected ${url}`);
  };
}

function setup({ login = 'owner', sessions } = {}) {
  const oauth = new OAuth({
    baseUrl: BASE,
    github: { clientId: 'gh-id', clientSecret: 'gh-secret', allowedLogins: ['owner'] },
    stateFile: path.join(mkdtempSync(path.join(tmpdir(), 'do-it-')), 'oauth.json'),
    githubBase: 'https://github.test', githubApi: 'https://api.github.test', fetchImpl: fakeGithub(login),
  });
  const app = createApp({ oauth, sessions: sessions ?? new Sessions({ run: async () => ({ ok: true, stdout: '[]', stderr: '' }) }) });
  const call = (p, init) => app.fetch(new Request(`${BASE}${p}`, init));
  return { oauth, app, call };
}

async function signIn(call, { decision = 'approve', reg } = {}) {
  reg ??= await (await call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${BASE}/mcp` });
  const toGithub = new URL((await call(`/authorize?${q}`)).headers.get('location'));
  assert.equal(toGithub.origin + toGithub.pathname, 'https://github.test/login/oauth/authorize');
  assert.equal(toGithub.searchParams.get('redirect_uri'), `${BASE}/oauth/github/callback`);
  let back = await call(`/oauth/github/callback?code=gh-code&state=${toGithub.searchParams.get('state')}`);
  let consented = false;
  if (back.status === 200) {
    const page = await back.text();
    assert.equal(back.headers.get('x-frame-options'), 'DENY');
    const id = page.match(/name="id" value="([^"]+)"/)[1];
    back = await call('/consent', tokenRequest({ id, decision }));
    consented = true;
  }
  const location = new URL(back.headers.get('location'));
  return { reg, verifier, location, consented };
}

function tokenRequest(body) { return { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }; }

test('MCP requires a bearer token and points at resource metadata', async () => {
  const { call } = setup();
  const res = await call('/mcp', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /resource_metadata="https:\/\/do-it\.test\/\.well-known\/oauth-protected-resource"/);
  const prm = await (await call('/.well-known/oauth-protected-resource')).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  assert.deepEqual(prm.authorization_servers, [BASE]);
  const as = await (await call('/.well-known/oauth-authorization-server')).json();
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${BASE}/register`);
});

test('GitHub accounts outside the allowlist are refused', async () => {
  const { call } = setup({ login: 'someone-else' });
  const { location } = await signIn(call);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('code'), null);
});

test('registration rejects non-Claude redirect URIs', async () => {
  const { call } = setup();
  const res = await call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['https://evil.example/cb'] }) });
  assert.equal(res.status, 400);
});

test('forged or wrong-audience tokens are rejected', async () => {
  const { oauth } = setup();
  const payload = Buffer.from(JSON.stringify({ sub: 'owner', aud: `${BASE}/mcp`, exp: 9e9 })).toString('base64url');
  assert.equal(oauth.verify(`Bearer ${payload}.forged`), undefined);
  const wrongAud = Buffer.from(JSON.stringify({ sub: 'owner', aud: 'https://other/mcp', exp: 9e9 })).toString('base64url');
  assert.equal(oauth.verify(`Bearer ${wrongAud}.${oauth.sign(wrongAud)}`), undefined);
  assert.equal(oauth.verify(`Bearer ${payload}.${oauth.sign(payload)}`), 'owner');
});

test('spawned claude does not inherit a parent Claude session environment', () => {
  const env = cleanEnv({ HOME: '/h', PATH: '/p', CLAUDE_CODE_SESSION_ID: 'x', CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'u', CLAUDE_CONFIG_DIR: '/c' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/p', CLAUDE_CONFIG_DIR: '/c' });
});

test('new clients need owner consent once; denial returns no code', async () => {
  const { call } = setup();
  const denied = await signIn(call, { decision: 'deny' });
  assert.ok(denied.consented);
  assert.equal(denied.location.searchParams.get('error'), 'access_denied');
  assert.equal(denied.location.searchParams.get('code'), null);
  const first = await signIn(call);
  assert.ok(first.consented && first.location.searchParams.get('code'));
  const again = await signIn(call, { reg: first.reg });
  assert.ok(!again.consented && again.location.searchParams.get('code'));
});

test('public registration floods neither evict approved clients nor block new ones', async () => {
  const { call, oauth } = setup();
  const { reg } = await signIn(call);
  let last;
  for (let i = 0; i < 60; i++) last = await call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) });
  assert.equal(last.status, 201);
  assert.ok(oauth.state.clients[reg.client_id]);
  assert.ok(Object.keys(oauth.state.clients).length <= 50);
  const odd = await call(`/authorize?client_id=__proto__&redirect_uri=${encodeURIComponent(CALLBACK)}`);
  assert.equal(odd.status, 400);
  const badPort = await call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: ['http://localhost:99999/cb'] }) });
  assert.equal(badPort.status, 400);
});

test('malformed Basic credentials and oversized bodies are rejected cleanly', async () => {
  const { call } = setup();
  const bad = await call('/token', { method: 'POST', headers: { authorization: `Basic ${Buffer.from('%zz:x').toString('base64')}` }, body: 'grant_type=refresh_token' });
  assert.equal(bad.status, 401);
  const huge = await call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [CALLBACK], pad: 'x'.repeat(100_000) }) });
  assert.equal(huge.status, 400);
});

test('authorize floods store nothing and do not block other clients', async () => {
  const { call } = setup();
  const reg = await (await call('/register', { method: 'POST', body: JSON.stringify({ redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }) })).json();
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: CALLBACK, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' });
  for (let i = 0; i < 150; i++) await call(`/authorize?${q}`);
  const { location } = await signIn(call);
  assert.ok(location.searchParams.get('code'));
  const tampered = await call('/oauth/github/callback?code=gh-code&state=e30.forged');
  assert.equal(tampered.status, 400);
});

test('trust is recorded only for folders under owner-approved roots', async () => {
  const { Trust } = await import('../src/trust.mjs');
  const { mkdirSync, readFileSync, writeFileSync, statSync } = await import('node:fs');
  const base = mkdtempSync(path.join(tmpdir(), 'do-it-trust-'));
  const projects = path.join(base, 'Projects');
  mkdirSync(path.join(projects, 'App', 'sub'), { recursive: true });
  mkdirSync(path.join(base, 'Other'));
  const configFile = path.join(base, '.claude.json');
  writeFileSync(configFile, JSON.stringify({ numStartups: 3, projects: { [path.join(projects, 'App')]: { allowedTools: ['x'] } } }));
  const trust = new Trust({ roots: [projects + '/'], configFile });

  assert.equal(await trust.ensure(path.join(projects, 'App')), true);
  let config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(config.numStartups, 3);
  assert.deepEqual(config.projects[path.join(projects, 'App')], { allowedTools: ['x'], hasTrustDialogAccepted: true });
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.equal(await trust.ensure(path.join(projects, 'App')), false); // already trusted

  assert.equal(await trust.ensure(path.join(base, 'Other')), false);
  assert.equal(await trust.ensure(path.join(projects, '..', 'Other')), false); // no escaping the root
  config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(config.projects[path.join(base, 'Other')], undefined);
  assert.throws(() => new Trust({ roots: ['/'] }), /whole drive or file system root/);
  assert.throws(() => new Trust({ roots: ['relative'] }), /must be absolute folders/);
});

