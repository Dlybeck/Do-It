// The guided setup and install: scripted answers, with gh, Tailscale, claude, GitHub and the
// service manager all faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultFolder, guidedInstall, runSetup } from '../src/guided.mjs';
import { MARKER, instance } from '../src/install.mjs';
import { detectTailscale, funnelCommand } from '../src/tailscale.mjs';

const CLAUDE = '/home/me/.local/bin/claude';
const DNS = 'box.tail1234.ts.net';
const json = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
const fresh = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-guided-')));

const tailscaleStatus = ({ state = 'Running', caps = { https: [], funnel: [] } } = {}) => JSON.stringify({ BackendState: state, Self: { DNSName: `${DNS}.`, CapMap: caps } });
const serving = busy => (busy ? JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: {} } }) : '{}');

// A machine with gh and Tailscale, unless a test removes them. Records every command run.
function machine({ gh = 'octocat', tailscale = tailscaleStatus(), busy = false, funnel = { ok: true, stdout: 'Available on the internet' } } = {}) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    const answer = (ok, stdout = '', stderr = '') => ({ ok, code: ok ? 0 : 1, stdout, stderr });
    if (command === 'gh') return gh ? answer(true, gh) : answer(false, '', 'gh: command not found');
    if (command === 'tailscale' && args[0] === 'status') return tailscale ? answer(true, tailscale) : answer(false, '', 'not found');
    if (command === 'tailscale' && args[0] === 'serve') return answer(true, serving(busy));
    if (command === 'tailscale' && args[0] === 'funnel') return { code: funnel.ok ? 0 : 1, stderr: '', ...funnel };
    return answer(false, '', 'unexpected');
  };
  return { calls, exec };
}

function scripted(answers) {
  const asked = [];
  return { asked, ask: async (question, options = {}) => { asked.push([question, options.secret === true]); return answers.shift() ?? ''; } };
}
const newApp = async options => { options.onReady({ url: `https://${DNS}/setup/github/tok`, localUrl: 'http://127.0.0.1:8787/setup/github/tok' }); return { clientId: 'Iv23liAUTO', clientSecret: 'auto-secret-1234', htmlUrl: 'https://github.com/apps/do-it-x' }; };

function home() {
  const dir = fresh();
  mkdirSync(path.join(dir, 'Projects'));
  return dir;
}

test('the happy path asks for almost nothing: folder and login are guessed, Funnel and the GitHub app are one yes each', async () => {
  const dir = home();
  const configDir = path.join(dir, 'config');
  const m = machine();
  const { ask, asked } = scripted(['', '', '', '']); // folder, login, funnel, create the app
  const said = [];
  const result = await runSetup({ configDir, ask, exec: m.exec, createApp: newApp, home: dir, say: l => said.push(l) });
  assert.deepEqual(json(configDir, 'config.json'), { publicUrl: `https://${DNS}`, allowedRoots: [path.join(dir, 'Projects')] });
  assert.deepEqual(json(configDir, 'github.json'), { clientId: 'Iv23liAUTO', clientSecret: 'auto-secret-1234', allowedLogins: ['octocat'] });
  assert.equal(result.github, 'manifest');
  assert.deepEqual(m.calls.filter(c => c[0] === 'tailscale' && c[1] === 'funnel'), [['tailscale', 'funnel', '--bg', '--https=443', 'http://127.0.0.1:8787']]);
  assert.ok(!m.calls.some(c => c[0] === 'sudo'));
  assert.equal(asked.length, 4);
  assert.match(asked[0][0], new RegExp(`Folders Do-It may use .*\\[${path.join(dir, 'Projects')}\\]`));
  assert.match(asked[1][0], /GitHub login\(s\).*\[octocat\]/);
  assert.match(asked[2][0], new RegExp(`Make Do-It public at https://${DNS} with Tailscale Funnel \\(tailscale funnel --bg --https=443 http://127\\.0\\.0\\.1:8787\\)\\? \\[Y/n\\]`));
  assert.match(said.join('\n'), /Found your GitHub login through gh: octocat/);
  assert.match(said.join('\n'), new RegExp(`https://${DNS}/setup/github/tok`));
  assert.ok(!said.join('\n').includes('auto-secret-1234'));
  assert.equal(asked.some(([, secret]) => secret), false); // nothing secret was typed
});

test('Tailscale is never switched on when it would replace something, or when the tailnet does not allow it', async () => {
  for (const [label, options, message] of [
    ['busy', { busy: true }, /already serves something on this machine.*won't/],
    ['funnel not allowed', { tailscale: tailscaleStatus({ caps: { https: [] } }) }, /Funnel isn't enabled for this machine in your tailnet/],
    ['https not allowed', { tailscale: tailscaleStatus({ caps: {} }) }, /HTTPS isn't enabled for this machine/],
  ]) {
    const dir = home();
    const m = machine(options);
    const { ask, asked } = scripted(['', '', 'https://other.example.net', 'n', 'Iv1.manual1', 'manual-secret-1']);
    const said = [];
    await runSetup({ configDir: path.join(dir, 'config'), ask, exec: m.exec, home: dir, say: l => said.push(l) });
    assert.match(said.join('\n'), message, label);
    assert.equal(m.calls.filter(c => c[0] === 'tailscale' && c[1] === 'funnel').length, 0, label);
    assert.equal(json(path.join(dir, 'config'), 'config.json').publicUrl, 'https://other.example.net');
    assert.equal(asked.some(([q]) => /Funnel/.test(q)), false, label); // it never even offers
  }
});

test('declining Funnel, or Funnel failing, falls back to asking for the address', async () => {
  const declined = home();
  const a = machine();
  await runSetup({ configDir: path.join(declined, 'config'), ask: scripted(['', '', 'n', 'https://mine.example.net', 'n', 'Iv1.manual1', 'manual-secret-1']).ask, exec: a.exec, home: declined, say: () => {} });
  assert.equal(a.calls.filter(c => c[0] === 'tailscale' && c[1] === 'funnel').length, 0);
  assert.equal(json(path.join(declined, 'config'), 'config.json').publicUrl, 'https://mine.example.net');

  const broken = home();
  const b = machine({ funnel: { ok: false, stdout: '', stderr: 'Funnel not available; visit https://login.tailscale.com/f/funnel' } });
  const said = [];
  await runSetup({ configDir: path.join(broken, 'config'), ask: scripted(['', '', '', 'https://mine.example.net', 'n', 'Iv1.manual1', 'manual-secret-1']).ask, exec: b.exec, home: broken, say: l => said.push(l) });
  assert.match(said.join('\n'), /Funnel didn't start:\n\s+Funnel not available; visit https:\/\/login\.tailscale\.com\/f\/funnel/);
  assert.equal(json(path.join(broken, 'config'), 'config.json').publicUrl, 'https://mine.example.net');
});

test('without Tailscale or gh it asks for the address and login, and mentions the other tunnels', async () => {
  const dir = home();
  const m = machine({ gh: null, tailscale: null });
  const said = [];
  const answers = scripted(['', 'octocat', 'https://tunnel.example.net', 'n', 'Iv1.manual1', 'manual-secret-1']);
  await runSetup({ configDir: path.join(dir, 'config'), ask: answers.ask, exec: m.exec, home: dir, say: l => said.push(l) });
  assert.match(said.join('\n'), /Cloudflare Tunnel, ngrok or Caddy.*127\.0\.0\.1:8787/);
  assert.match(answers.asked[1][0], /^GitHub login\(s\) \(comma-separated\): $/); // no guess to offer
  assert.deepEqual(json(path.join(dir, 'config'), 'github.json'), { clientId: 'Iv1.manual1', clientSecret: 'manual-secret-1', allowedLogins: ['octocat'] });
  assert.deepEqual(answers.asked.at(-1), ['OAuth app client secret: ', true]);
});

test('if the one-click GitHub app fails, setup says why and continues with the prefilled manual form', async () => {
  const dir = home();
  const m = machine();
  const said = [];
  const failing = async () => { throw new Error("https://box.tail1234.ts.net doesn't reach this machine on port 8787 yet, so GitHub can't send the browser back."); };
  const result = await runSetup({ configDir: path.join(dir, 'config'), ask: scripted(['', '', '', '', 'Iv1.manual1', 'manual-secret-1']).ask, exec: m.exec, createApp: failing, home: dir, say: l => said.push(l) });
  const out = said.join('\n');
  assert.match(out, /That didn't work: .*doesn't reach this machine on port 8787 yet.*\n\s+Doing it by hand instead\./);
  assert.match(out, /open\n\s+https:\/\/github\.com\/settings\/applications\/new\?oauth_application/);
  assert.match(out, new RegExp(`Authorization callback URL: https://${DNS}/oauth/github/callback`));
  assert.equal(result.github, 'manual');
  assert.equal(json(path.join(dir, 'config'), 'github.json').clientId, 'Iv1.manual1');
});

test('--manual-github never tries the one-click flow, and a re-run keeps an existing GitHub app', async () => {
  const dir = home();
  const m = machine();
  let tried = 0;
  const counting = async options => { tried++; return newApp(options); };
  const configDir = path.join(dir, 'config');
  const { asked } = await (async () => { const s = scripted(['', '', '', 'Iv1.manual1', 'manual-secret-1']); await runSetup({ configDir, ask: s.ask, exec: m.exec, createApp: counting, home: dir, manualGithub: true, say: () => {} }); return s; })();
  assert.equal(tried, 0);
  assert.equal(asked.some(([q]) => /Create the GitHub app now/.test(q)), false);

  const again = scripted(['', '', '', '']); // folder, login and address kept; keep the GitHub app
  const result = await runSetup({ configDir, ask: again.ask, exec: m.exec, createApp: counting, home: dir, say: () => {} });
  assert.equal(result.github, 'kept');
  assert.equal(tried, 0);
  assert.equal(json(configDir, 'github.json').clientSecret, 'manual-secret-1');
  assert.match(again.asked.at(-1)[0], /Keep the GitHub app already set up \(client ID Iv1\.manual1\)/);
});

test('Tailscale detection reads the machine name, the tailnet permissions and whether anything is already served', async () => {
  assert.deepEqual(await detectTailscale(machine().exec), { dnsName: DNS, httpsAllowed: true, funnelAllowed: true, busy: false });
  assert.equal((await detectTailscale(machine({ busy: true }).exec)).busy, true);
  assert.equal(await detectTailscale(machine({ tailscale: null }).exec), undefined);
  assert.equal(await detectTailscale(machine({ tailscale: tailscaleStatus({ state: 'Stopped' }) }).exec), undefined);
  assert.equal(await detectTailscale(machine({ tailscale: 'not json' }).exec), undefined);
  assert.equal(funnelCommand(8788), 'tailscale funnel --bg --https=443 http://127.0.0.1:8788');
});

test('the default folder is the first usual projects folder in the home folder, never the home folder itself', () => {
  const dir = fresh();
  assert.equal(defaultFolder(dir), undefined);
  mkdirSync(path.join(dir, 'code'));
  assert.equal(defaultFolder(dir), path.join(dir, 'code'));
  mkdirSync(path.join(dir, 'Projects'));
  assert.equal(defaultFolder(dir), path.join(dir, 'Projects'));
});

// --- do-it install, end to end with fakes ---

function installMachine({ claudeOk = true, loggedIn = true } = {}) {
  const base = fresh();
  mkdirSync(path.join(base, 'Projects'));
  const configDir = path.join(base, 'config');
  const inst = { ...instance({ name: 'do-it-t', port: 8799, configDir, home: base }), configDir };
  const m = machine();
  const files = {};
  const unit = `${base}/.config/systemd/user/do-it-t.service`;
  const exec = async (command, args) => {
    if (command === CLAUDE) {
      if (!claudeOk) return { ok: false, code: 1, stdout: '', stderr: 'not found' };
      if (args[0] === '--version') return { ok: true, code: 0, stdout: '2.1.317 (Claude Code)', stderr: '' };
      if (args[0] === 'auth') return { ok: true, code: 0, stdout: JSON.stringify({ loggedIn }), stderr: '' };
      if (args[0] === 'agents') return { ok: true, code: 0, stdout: '[]', stderr: '' };
    }
    if (command === 'systemctl') { m.calls.push([command, ...args]); return { ok: true, code: 0, stdout: files[unit] ? 'LoadState=loaded\nActiveState=active' : 'LoadState=not-found', stderr: '' }; }
    if (command === 'loginctl') { m.calls.push([command, ...args]); return { ok: true, code: 0, stdout: 'no', stderr: '' }; }
    return m.exec(command, args);
  };
  const fs = { exists: f => f in files || (f.startsWith(tmpdir()) && existsSync(f)), read: f => files[f], write: (f, c) => { files[f] = c; }, remove: f => { delete files[f]; } };
  const fetchImpl = async url => {
    const u = String(url);
    if (u.endsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `https://${DNS}/mcp` });
    if (u.includes('/oauth/github/callback')) return new Response('Sign-in expired. Start again.', { status: 400 });
    if (u.startsWith('https://github.com/login/oauth/access_token')) return Response.json({ error: 'bad_verification_code' });
    throw new Error(`unexpected ${u}`);
  };
  const said = [];
  return { inst, base, m, files, unit, said, deps: { exec, fs, fetchImpl, say: l => said.push(l), claude: CLAUDE, home: base, uid: 501, user: 'me', node: '/usr/bin/node', appDir: '/opt/do-it', env: {}, platform: 'linux', nodeVersion: '22.23.0', isPortOpen: async () => false, probeImpl: async () => `https://${DNS}/mcp`, wait: 50, createApp: newApp } };
}

test('do-it install: checks, guided setup, service, then doctor, in that order, and never runs sudo', async () => {
  const t = installMachine();
  const report = await guidedInstall(t.inst, { ...t.deps, ask: scripted(['', '', '', '']).ask });
  assert.equal(report.ok, true);
  const out = t.said.join('\n');
  const order = ['Checking this machine', 'claude is signed in', 'Settings go in', '1/4  Folders', '4/4  GitHub sign-in', 'Wrote config.json', 'Wrote systemd user unit', 'sudo loginctl enable-linger me', `Checking do-it-t`, 'All set'].map(s => out.indexOf(s));
  assert.ok(order.every(i => i >= 0), JSON.stringify(order));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(out, new RegExp(`enter:\\n  https://${DNS}/mcp`));
  assert.ok(t.files[t.unit].includes(MARKER));
  assert.ok(!t.m.calls.some(c => c[0] === 'sudo'));
  assert.deepEqual(json(t.inst.configDir, 'config.json').allowedRoots, [path.join(t.base, 'Projects')]);
});

test('do-it install stops before asking anything when claude is missing or signed out', async () => {
  for (const [options, message] of [[{ claudeOk: false }, /claude CLI was not found/], [{ loggedIn: false }, /Fix: Run: claude auth login/]]) {
    const t = installMachine(options);
    const { ask, asked } = scripted([]);
    await assert.rejects(guidedInstall(t.inst, { ...t.deps, ask }), /Fix the problems above, then run do-it install again/);
    assert.match(t.said.join('\n'), message);
    assert.equal(asked.length, 0);
    assert.deepEqual(Object.keys(t.files), []); // no service file written
    assert.equal(existsSync(path.join(t.inst.configDir, 'config.json')), false);
  }
});

test('do-it install on an already set-up instance skips the prompts and just reinstalls and checks', async () => {
  const t = installMachine();
  await guidedInstall(t.inst, { ...t.deps, ask: scripted(['', '', '', '']).ask });
  const { ask, asked } = scripted([]);
  t.said.length = 0;
  const report = await guidedInstall(t.inst, { ...t.deps, ask });
  assert.equal(report.ok, true);
  assert.equal(asked.length, 0);
  assert.doesNotMatch(t.said.join('\n'), /1\/4  Folders/);
  assert.match(t.said.join('\n'), /Updated systemd user unit/);
});
