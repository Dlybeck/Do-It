// do-it doctor: every check, with the machine, the service and the network faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { doctor } from '../src/doctor.mjs';
import { MARKER, instance } from '../src/install.mjs';

const CLAUDE = '/home/me/.local/bin/claude';
const PUBLIC = 'https://box.example.ts.net';

// A working setup unless a test breaks one part of it.
function scenario({ publicUrl = PUBLIC, port = 8787, name = 'do-it', node = '22.23.0', claude = {}, config, github, folders = ['ok'], service = 'running', linger = 'yes', answering = `${PUBLIC}/mcp`, net = {}, creds = 'bad_verification_code' } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-doctor-')));
  const roots = folders.map(f => path.join(base, f));
  if (folders.includes('ok')) mkdirSync(path.join(base, 'ok'));
  const configDir = path.join(base, 'config');
  mkdirSync(configDir);
  if (config !== null) writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config ?? { publicUrl, allowedRoots: roots }));
  if (github !== null) writeFileSync(path.join(configDir, 'github.json'), JSON.stringify(github ?? { clientId: 'Iv1.abc123', clientSecret: 'secret-secret', allowedLogins: ['me'] }));
  const inst = { ...instance({ name, port, configDir, home: '/home/me' }), configDir };
  const unit = `/home/me/.config/systemd/user/${name}.service`;
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    const answer = (...a) => ({ code: 0, stderr: '', ...(typeof a[0] === 'object' ? a[0] : { ok: a[0], stdout: a[1] ?? '' }) });
    if (command === CLAUDE && args[0] === '--version') return claude.version ?? answer(true, '2.1.317 (Claude Code)');
    if (command === CLAUDE && args[0] === 'auth') return claude.auth ?? answer(true, JSON.stringify({ loggedIn: true }));
    if (command === CLAUDE && args[0] === 'agents') return claude.agents ?? answer(true, '[]');
    if (command === 'systemctl') return answer(true, `LoadState=loaded\nActiveState=${service === 'running' ? 'active' : 'inactive'}\nMainPID=1`);
    if (command === 'loginctl') return answer(true, linger);
    return answer(false, '');
  };
  const fs = { exists: f => service !== 'missing' && f === unit, read: () => `# ${MARKER}\n[Service]\n`, write() {}, remove() {} };
  const responses = {
    [`${PUBLIC}/.well-known/oauth-protected-resource`]: () => Response.json({ resource: `${PUBLIC}/mcp` }),
    [`${PUBLIC}/oauth/github/callback?state=doctor`]: () => new Response('Sign-in expired. Start again from Claude.', { status: 400 }),
    'https://github.com/login/oauth/access_token': () => Response.json({ error: creds }),
    ...net,
  };
  const fetchImpl = async (url) => {
    const handler = responses[String(url)];
    if (!handler) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    return typeof handler === 'function' ? handler() : handler;
  };
  const said = [];
  const run = () => doctor(inst, { exec, fs, fetchImpl, say: l => said.push(l), env: { PATH: '/home/me/.local/bin' }, platform: 'linux', nodeVersion: node, claude: CLAUDE, home: '/home/me', uid: 501, user: 'me', node: '/usr/bin/node', appDir: '/opt/do-it', probeImpl: async () => answering || undefined });
  return { run, said, calls, text: () => said.join('\n') };
}

test('a working setup passes every check and ends with the connector URL', async () => {
  const s = scenario();
  const report = await s.run();
  assert.equal(report.ok, true);
  assert.deepEqual(report.results.map(r => r.level).filter(l => l !== 'ok'), []);
  assert.match(s.text(), /Node\.js 22\.23\.0/);
  assert.match(s.text(), /claude is signed in/);
  assert.match(s.text(), /supports background sessions/);
  assert.match(s.text(), /Service do-it is installed and running/);
  assert.match(s.text(), /box\.example\.ts\.net reaches this Do-It over https/);
  assert.match(s.text(), /GitHub accepts the app's client ID and secret/);
  assert.match(s.text(), new RegExp(`enter:\\n  ${PUBLIC}/mcp`));
  assert.match(s.text(), new RegExp(`Callback URL must be exactly:\\n  ${PUBLIC}/oauth/github/callback`));
  assert.ok(!s.text().includes('Fix:'));
  assert.ok(!s.calls.some(c => c[0] === 'sudo'));
});

// Each broken part reports a failure whose fix names the exact command or file to change.
const BROKEN = [
  ['an old Node.js', { node: '20.1.0' }, /Node\.js 20\.1\.0 is too old[\s\S]*Install Node\.js 22\+/],
  ['no claude CLI', { claude: { version: { ok: false, stdout: '' } } }, /claude CLI was not found[\s\S]*--claude-bin/],
  ['claude signed out', { claude: { auth: { ok: true, stdout: JSON.stringify({ loggedIn: false }) } } }, /claude is not signed in[\s\S]*Fix: Run: claude auth login/],
  ['no background sessions', { claude: { agents: { ok: false, stdout: '' } } }, /does not support background sessions[\s\S]*claude update/],
  ['no settings files', { config: null, github: null }, /Settings are incomplete: Missing .*config\.json[\s\S]*Fix: Run: do-it setup/],
  ['half a GitHub config', { github: { clientId: 'x' } }, /github\.json needs clientId, clientSecret and allowedLogins/],
  ['a missing folder', { folders: ['ok', 'gone'] }, /Folder .*gone doesn't exist[\s\S]*do-it setup/],
  ['no folders at all', { config: { publicUrl: PUBLIC, allowedRoots: [] }, folders: [] }, /No folders are allowed[\s\S]*do-it add-folder <folder>/],
  ['no service', { service: 'missing', answering: '' }, /Service do-it is not installed[\s\S]*Fix: Run: do-it install/],
  ['a stopped service', { service: 'stopped', answering: '' }, /installed but not running[\s\S]*journalctl --user -u do-it -e/],
  ['nothing on the port', { answering: '' }, /Nothing answers on 127\.0\.0\.1:8787[\s\S]*do-it install/],
  ['another Do-It on the port', { answering: 'https://other.example/mcp' }, /answers as https:\/\/other\.example\/mcp, a different Do-It[\s\S]*another --port/],
  ['an unreachable address', { net: { [`${PUBLIC}/.well-known/oauth-protected-resource`]: undefined } }, /box\.example\.ts\.net is not reachable \(ENOTFOUND\)[\s\S]*tailscale funnel --bg --https=443 http:\/\/127\.0\.0\.1:8787/],
  ['an address that isn\'t Do-It', { net: { [`${PUBLIC}/.well-known/oauth-protected-resource`]: () => Response.json({ resource: 'https://else.example/mcp' }) } }, /answers, but as https:\/\/else\.example\/mcp/],
  ['an address with an error status', { net: { [`${PUBLIC}/.well-known/oauth-protected-resource`]: () => new Response('bad gateway', { status: 502 }) } }, /answered HTTP 502[\s\S]*isn't forwarding/],
  ['a tunnel that only forwards /mcp', { net: { [`${PUBLIC}/oauth/github/callback?state=doctor`]: () => new Response('nope', { status: 404 }) } }, /oauth\/github\/callback doesn't reach Do-It[\s\S]*every path/],
  ['an unknown GitHub client ID', { net: { 'https://github.com/login/oauth/access_token': () => Response.json({ error: 'Not Found' }, { status: 404 }) } }, /GitHub doesn't recognise the client ID[\s\S]*client ID from your GitHub app's settings/],
  ['a wrong GitHub secret', { creds: 'incorrect_client_credentials' }, /GitHub rejects the client ID or secret[\s\S]*new client secret is fine/],
];
for (const [label, options, expected] of BROKEN) {
  test(`doctor reports ${label} with the fix`, async () => {
    // A handler set to undefined removes the default response, so the fetch fails like a dead address.
    const s = scenario(options);
    const report = await s.run();
    assert.equal(report.ok, false);
    assert.match(s.text(), expected);
    assert.match(s.text(), /\d problems? to fix\. Run do-it doctor again/);
    assert.ok(!s.text().includes('Callback URL must be exactly')); // no success summary
  });
}

test('doctor: a service that only runs by hand and a missing linger are notes, not failures', async () => {
  const manual = scenario({ service: 'missing' });
  const report = await manual.run();
  assert.equal(report.ok, true);
  assert.match(manual.text(), /! Do-It is running on port 8787, but not as a service/);
  const loggedOut = scenario({ linger: 'no' });
  assert.equal((await loggedOut.run()).ok, true);
  assert.match(loggedOut.text(), /! do-it stops when you log out\n\s+Note: Run: sudo loginctl enable-linger me/);
  assert.match(loggedOut.text(), /All set \(1 note above\)/);
  assert.ok(!loggedOut.calls.some(c => c[0] === 'sudo')); // it prints the sudo line and never runs it
});

test('doctor: a second instance gets fixes that name it, and GitHub being unreachable is only a note', async () => {
  const s = scenario({ name: 'do-it-test', port: 8788, service: 'missing', answering: '' });
  await s.run();
  assert.match(s.text(), /Fix: Run: do-it install --name do-it-test --port 8788/);
  const offline = scenario({ net: { 'https://github.com/login/oauth/access_token': undefined } });
  const report = await offline.run();
  assert.equal(report.ok, true);
  assert.match(offline.text(), /! Couldn't reach github\.com/);
  const odd = scenario({ creds: 'something_new' });
  assert.match((await odd.run(), odd.text()), /! Couldn't confirm the client ID and secret with GitHub \(something_new\)/);
});
