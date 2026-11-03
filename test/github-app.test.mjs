// The GitHub app flow: a real local setup page, with GitHub and the public address faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { appManifest, callbackUrl, createGithubApp, manualAppUrl } from '../src/github-app.mjs';

const PUBLIC = 'https://box.example.ts.net';

const freePort = () => new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const unescape = text => text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));

// Starts the flow and resolves once the setup page is up. `reach` is the browser's way in:
// the public address is routed to the local page, as a tunnel would do.
async function start({ conversion, ping = true, ...options } = {}) {
  const port = options.port ?? await freePort();
  const converted = [];
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.startsWith(PUBLIC)) return ping ? fetch(`http://127.0.0.1:${port}${u.slice(PUBLIC.length)}`, init) : Promise.reject(new TypeError('fetch failed'));
    if (u.startsWith('https://api.github.test/app-manifests/')) { converted.push(u); return conversion ? conversion() : Response.json({ client_id: 'Iv23liNEW', client_secret: 'newsecret123', slug: 'do-it-me', name: 'Do-It me abcd', html_url: 'https://github.test/apps/do-it-me' }, { status: 201 }); }
    throw new Error(`unexpected ${u}`);
  };
  let ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  const result = createGithubApp({ publicUrl: PUBLIC, port, login: 'octocat', fetchImpl, onReady: ready, apiBase: 'https://api.github.test', formBase: 'https://github.test', ...options });
  const outcome = result.then(value => ({ value }), error => ({ error }));
  const info = await Promise.race([readyPromise, outcome.then(o => { throw o.error ?? new Error('finished early'); })]);
  const local = path => `http://127.0.0.1:${port}${new URL(info.url).pathname}${path}`;
  return { info, port, local, outcome, converted };
}

test('the setup page sends the browser to GitHub with the app details, and the callback hands back the client ID and secret', async () => {
  const flow = await start();
  assert.match(flow.info.url, new RegExp(`^${PUBLIC}/setup/github/[A-Za-z0-9_-]{32}$`));
  assert.equal(flow.info.localUrl, `http://127.0.0.1:${flow.port}${new URL(flow.info.url).pathname}`);

  const page = await (await fetch(flow.local(''))).text();
  assert.match(page, new RegExp(`action="https://github\\.test/settings/apps/new\\?state=${flow.info.token}"`));
  const manifest = JSON.parse(unescape(page.match(/name="manifest" value="([^"]*)"/)[1]));
  assert.deepEqual(manifest, appManifest({ publicUrl: PUBLIC, login: 'octocat', token: flow.info.token, suffix: manifest.name.split(' ').at(-1) }));
  assert.equal(manifest.url, PUBLIC);
  assert.equal(manifest.redirect_url, `${PUBLIC}/setup/github/${flow.info.token}/callback`);
  assert.deepEqual(manifest.callback_urls, [`${PUBLIC}/oauth/github/callback`]);
  assert.equal(manifest.public, false);
  assert.ok(manifest.name.length <= 34 && /^Do-It octocat [0-9a-f]{4}$/.test(manifest.name));

  // A wrong state or a malformed code changes nothing; the flow keeps waiting.
  assert.equal((await fetch(flow.local('/callback?code=abc123&state=wrong'))).status, 400);
  assert.equal((await fetch(flow.local(`/callback?code=../x&state=${flow.info.token}`))).status, 400);
  assert.equal((await fetch(flow.local('/callback'))).status, 400);
  assert.deepEqual(flow.converted, []);

  const done = await fetch(flow.local(`/callback?code=abc123&state=${flow.info.token}`));
  assert.equal(done.status, 200);
  assert.match(await done.text(), /The GitHub app <b>Do-It me abcd<\/b> is created/);
  assert.deepEqual(await flow.outcome, { value: { clientId: 'Iv23liNEW', clientSecret: 'newsecret123', slug: 'do-it-me', htmlUrl: 'https://github.test/apps/do-it-me' } });
  assert.deepEqual(flow.converted, ['https://api.github.test/app-manifests/abc123/conversions']);
  await assert.rejects(fetch(flow.local('')), /fetch failed/); // the page is gone once it's done
});

test('only the random path is served, and nothing else on the port', async () => {
  const flow = await start({ timeoutMs: 400 });
  const root = `http://127.0.0.1:${flow.port}`;
  for (const p of ['/', '/mcp', '/setup/github', '/setup/github/guess', '/setup/github/guess/ping', `${new URL(flow.info.url).pathname}x`]) {
    assert.equal((await fetch(root + p)).status, 404, p);
  }
  assert.equal((await fetch(root + new URL(flow.info.url).pathname, { method: 'POST' })).status, 404);
  assert.equal(await (await fetch(flow.local('/ping'))).text(), 'ok');
  await flow.outcome;
});

test('the flow gives up with a clear reason: GitHub fails, nobody clicks, the address is not reachable, the port is taken', async () => {
  const failed = await start({ conversion: () => Response.json({ message: 'Not Found' }, { status: 404 }) });
  const response = await fetch(failed.local(`/callback?code=abc&state=${failed.info.token}`));
  assert.equal(response.status, 502);
  assert.match((await failed.outcome).error.message, /didn't hand over the new app's details \(GitHub answered 404: Not Found\)/);

  const idle = await start({ timeoutMs: 50 });
  assert.match((await idle.outcome).error.message, /Nobody finished creating the app within 10 minutes/);

  const port = await freePort();
  await assert.rejects(start({ port, ping: false }), /doesn't reach this machine on port \d+ yet/);
  // The page was shut down again, so the port is free for the service.
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`), /fetch failed/);

  const held = createServer(); // something already on the port
  await new Promise(resolve => held.listen(0, '127.0.0.1', resolve));
  await assert.rejects(start({ port: held.address().port }), /Port \d+ is in use .*setup page can't start/);
  held.close();
});

test('manual fallback URLs and manifest names stay within GitHub\'s rules', () => {
  const url = new URL(manualAppUrl(PUBLIC));
  assert.equal(url.origin + url.pathname, 'https://github.com/settings/applications/new');
  assert.equal(url.searchParams.get('oauth_application[url]'), PUBLIC);
  assert.equal(url.searchParams.get('oauth_application[callback_url]'), `${PUBLIC}/oauth/github/callback`);
  assert.equal(callbackUrl(PUBLIC), `${PUBLIC}/oauth/github/callback`);
  assert.ok(appManifest({ publicUrl: PUBLIC, login: 'a'.repeat(39), token: 't' }).name.length <= 34);
  assert.equal(appManifest({ publicUrl: PUBLIC, token: 't', suffix: 'ab12' }).name, 'Do-It ab12');
});
