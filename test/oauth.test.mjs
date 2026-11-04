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
  oauth.state.clients.c1 = { redirect_uris: [], method: 'none', created: 0 };
  const payload = Buffer.from(JSON.stringify({ sub: 'owner', cid: 'c1', aud: `${BASE}/mcp`, exp: 9e9 })).toString('base64url');
  assert.equal(oauth.verify(`Bearer ${payload}.forged`), undefined);
  const wrongAud = Buffer.from(JSON.stringify({ sub: 'owner', aud: 'https://other/mcp', exp: 9e9 })).toString('base64url');
  assert.equal(oauth.verify(`Bearer ${wrongAud}.${oauth.sign(wrongAud)}`), undefined);
  assert.equal(oauth.verify(`Bearer ${payload}.${oauth.sign(payload)}`), 'owner');
});

test('spawned claude does not inherit a parent Claude session environment', () => {
  const env = cleanEnv({ HOME: '/h', PATH: '/p', CLAUDE_CODE_SESSION_ID: 'x', CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'u', CLAUDE_CONFIG_DIR: '/c' });
  assert.deepEqual(env, { HOME: '/h', PATH: '/p', CLAUDE_CONFIG_DIR: '/c' });
});

test("without a parent Claude session, the owner's own Claude settings reach claude", () => {
  const owner = { HOME: '/h', PATH: '/p', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'https://proxy', CLAUDE_CONFIG_DIR: '/c' };
  assert.deepEqual(cleanEnv(owner), owner);
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
  const { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, statSync } = await import('node:fs');
  // Claude Code keys trust by a session's physical working folder (process.cwd()), so Do-It
  // records the resolved path. Resolve the temp folder too: on macOS it sits behind the
  // /var -> /private/var symlink.
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-trust-')));
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

  // A folder reached through a symlink is recorded under its real path, where Claude Code looks.
  mkdirSync(path.join(projects, 'Real'));
  symlinkSync(path.join(projects, 'Real'), path.join(base, 'shortcut'));
  assert.equal(await trust.ensure(path.join(base, 'shortcut')), true);
  config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(config.projects[path.join(projects, 'Real')].hasTrustDialogAccepted, true);
  assert.equal(config.projects[path.join(base, 'shortcut')], undefined);

  assert.equal(await trust.ensure(path.join(base, 'Other')), false);
  assert.equal(await trust.ensure(path.join(projects, '..', 'Other')), false); // no escaping the root
  config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(config.projects[path.join(base, 'Other')], undefined);
  assert.throws(() => new Trust({ roots: ['/'] }), /whole drive or file system root/);
  assert.throws(() => new Trust({ roots: ['relative'] }), /must be absolute folders/);
});


// --- PR #1 review fixes ---

test('tokens stop working when their client is gone or their login is removed from github.json', async () => {
  const { call, oauth } = setup();
  const { reg, verifier, location } = await signIn(call);
  const tokens = await (await call('/token', tokenRequest({ grant_type: 'authorization_code', code: location.searchParams.get('code'), redirect_uri: CALLBACK, code_verifier: verifier, client_id: reg.client_id }))).json();
  const bearer = `Bearer ${tokens.access_token}`;
  assert.equal(oauth.verify(bearer), 'owner');

  oauth.configureGithub({ clientId: 'gh-id', clientSecret: 'gh-secret', allowedLogins: ['someone-else'] });
  assert.equal(oauth.verify(bearer), undefined);
  const refused = await call('/token', tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id }));
  assert.equal(refused.status, 400);
  assert.match((await refused.json()).error_description, /no longer allowed/);

  oauth.configureGithub({ clientId: 'gh-id', clientSecret: 'gh-secret', allowedLogins: ['Owner'] });
  assert.equal(oauth.verify(bearer), 'owner');
  delete oauth.state.clients[reg.client_id];
  assert.equal(oauth.verify(bearer), undefined);
  assert.throws(() => oauth.configureGithub({ clientId: 'gh-id', clientSecret: 'gh-secret', allowedLogins: [] }), /needs clientId, clientSecret and allowedLogins/);
});

test('github.json changes are picked up while running; a broken edit keeps the old settings', async () => {
  const { watchGithub } = await import('../src/config.mjs');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'do-it-gh-'));
  writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ clientId: 'a', clientSecret: 'b', allowedLogins: ['one'] }));
  const seen = [], errors = [];
  const stop = watchGithub(dir, github => seen.push(github.allowedLogins), { interval: 20, log: { error: m => errors.push(m) } });
  try {
    await new Promise(r => setTimeout(r, 60));
    writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ clientId: 'a', clientSecret: 'b', allowedLogins: ['two', 'three'] }));
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(seen, [['two', 'three']]);
    writeFileSync(path.join(dir, 'github.json'), '{ broken');
    for (let i = 0; i < 100 && !errors.length; i++) await new Promise(r => setTimeout(r, 20));
    assert.match(errors[0], /Ignoring github.json change/);
  } finally { stop(); }
});

test('a damaged oauth.json is reported, not replaced; a missing one is created', async () => {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'do-it-state-'));
  const stateFile = path.join(dir, 'oauth.json');
  const make = () => new OAuth({ baseUrl: BASE, github: { clientId: 'i', clientSecret: 's', allowedLogins: ['owner'] }, stateFile });
  make();
  assert.ok(existsSync(stateFile));
  const key = JSON.parse(readFileSync(stateFile, 'utf8')).key;
  assert.equal(make().state.key, key); // reused, not regenerated
  for (const damaged of ['{ not json', JSON.stringify({ key, clients: {} }), JSON.stringify({ key: '', clients: {}, refresh: {} }), '[]']) {
    writeFileSync(stateFile, damaged);
    assert.throws(make, /oauth\.json is damaged, so Do-It won't start rather than replace it/);
    assert.equal(readFileSync(stateFile, 'utf8'), damaged);
  }
});

test("trust redoes its change on top of a write Claude Code made meanwhile, and explains a missing file", async () => {
  const { Trust } = await import('../src/trust.mjs');
  const { UserError } = await import('../src/errors.mjs');
  const { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } = await import('node:fs');
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-trust-')));
  mkdirSync(path.join(base, 'Projects', 'App'), { recursive: true });
  const configFile = path.join(base, '.claude.json');
  writeFileSync(configFile, JSON.stringify({ numStartups: 1 }));
  let writes = 0;
  const trust = new Trust({ roots: [path.join(base, 'Projects')], configFile, beforeReplace: async () => {
    if (writes++ === 0) writeFileSync(configFile, JSON.stringify({ numStartups: 2, tipsHistory: { x: 1 } }));
  } });
  assert.equal(await trust.ensure(path.join(base, 'Projects', 'App')), true);
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  assert.equal(config.numStartups, 2);
  assert.deepEqual(config.tipsHistory, { x: 1 });
  assert.equal(config.projects[path.join(base, 'Projects', 'App')].hasTrustDialogAccepted, true);
  assert.equal(writes, 2);
  assert.deepEqual(readdirSync(base).filter(f => f.endsWith('.tmp')), []);

  const busy = new Trust({ roots: [path.join(base, 'Projects')], configFile: path.join(base, 'busy.json'), beforeReplace: async () => writeFileSync(path.join(base, 'busy.json'), `{"n":${writes++}}`) });
  writeFileSync(path.join(base, 'busy.json'), '{}');
  await assert.rejects(busy.ensure(path.join(base, 'Projects', 'App')), /kept changing/);
  assert.deepEqual(readdirSync(base).filter(f => f.endsWith('.tmp')), []);

  const missing = new Trust({ roots: [path.join(base, 'Projects')], configFile: path.join(base, 'nope.json') });
  await assert.rejects(missing.ensure(path.join(base, 'Projects', 'App')), error => error instanceof UserError && /doesn't exist yet.*Run claude once/.test(error.message));
  writeFileSync(path.join(base, 'bad.json'), '[1]');
  const bad = new Trust({ roots: [path.join(base, 'Projects')], configFile: path.join(base, 'bad.json') });
  await assert.rejects(bad.ensure(path.join(base, 'Projects', 'App')), error => error instanceof UserError && /isn't a valid Claude Code settings file/.test(error.message));
});

test('a failing response stream does not crash the server, and close() ends open streams', async () => {
  const { listen } = await import('../src/server.mjs');
  const errors = [];
  const original = console.error;
  console.error = m => errors.push(String(m));
  const app = {
    close: async () => {},
    fetch: async request => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/fail') {
        return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: 1\n\n')); setTimeout(() => c.error(new Error('stream broke')), 20); } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (pathname === '/open') return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: hi\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
      return new Response('ok');
    },
  };
  const server = listen(app, { port: 0 });
  try {
    await new Promise(r => server.http.once('listening', r));
    const url = p => `http://127.0.0.1:${server.http.address().port}${p}`;
    const failed = await fetch(url('/fail'));
    await failed.text().catch(() => {}); // the client sees the stream cut off
    assert.equal(await (await fetch(url('/ok'))).text(), 'ok'); // the server is still up
    assert.ok(errors.some(m => /Response stream error: stream broke/.test(m)));
    const open = await fetch(url('/open'));
    const reader = open.body.getReader();
    await reader.read(); // the SSE stream is open and stays open
    const closed = await Promise.race([server.close().then(() => 'closed'), new Promise(r => setTimeout(() => r('hung'), 2000))]);
    assert.equal(closed, 'closed');
    await reader.read().catch(() => {});
  } finally {
    console.error = original;
    await server.close().catch(() => {});
  }
});
