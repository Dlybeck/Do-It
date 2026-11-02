// The five session tools against a fake `claude` CLI and a fake Agent SDK. Nothing here
// runs Claude Code or touches ~/.claude.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { OAuth } from '../src/oauth.mjs';
import { createApp } from '../src/server.mjs';
import { Driving } from '../src/driving.mjs';
import { Sessions } from '../src/sessions.mjs';

const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-tools-')));
const ALLOWED = path.join(base, 'projects');
const APP = path.join(ALLOWED, 'app');
const OUTSIDE = path.join(base, 'elsewhere');
for (const dir of [APP, OUTSIDE]) mkdirSync(dir, { recursive: true });
symlinkSync(OUTSIDE, path.join(ALLOWED, 'escape'));

const BG = 'aaaaaaaa-1111-2222-3333-444444444444'; // background session, idle
const TTY = 'bbbbbbbb-1111-2222-3333-444444444444'; // open in an interactive window
const OLD = 'cccccccc-1111-2222-3333-444444444444'; // stored, not running, never background
const FAR = 'dddddddd-1111-2222-3333-444444444444'; // outside the allowed folders
const TWIN = 'aaaaaaaa-9999-2222-3333-444444444444'; // shares BG's first 8 characters

// A fake claude CLI and SDK with a little state, recording every CLI call.
function fake({ roots = [ALLOWED], bgStatus = 'idle', extraStored = [], modes = {} } = {}) {
  const live = [
    { pid: 10, id: 'aaaaaaaa', sessionId: BG, cwd: APP, kind: 'background', status: bgStatus, name: 'bg job' },
    { pid: 11, sessionId: TTY, cwd: APP, kind: 'interactive', status: 'idle' },
    { pid: 12, sessionId: FAR, cwd: OUTSIDE, kind: 'interactive', status: 'idle' },
  ];
  const everBackground = [{ sessionId: BG, kind: 'background' }];
  const calls = [];
  const driving = new Driving({ dir: mkdtempSync(path.join(tmpdir(), 'do-it-driving-')) });
  const run = async (args, options = {}) => {
    // For each --resume call, whether that session was listed as driven when claude ran.
    const resumed = args[0] === '--bg' && args.includes('--resume') && args[args.indexOf('--resume') + 1];
    calls.push({ args, cwd: options.cwd, registered: resumed ? existsSync(driving.file(resumed)) : undefined });
    if (args[0] === 'agents') return { ok: true, stdout: JSON.stringify(args.includes('--all') ? [...live, ...everBackground] : live), stderr: '' };
    if (args[0] === 'stop') { const a = live.find(x => x.id === args[1]); if (a) delete a.pid; return { ok: true, stdout: `stopped ${args[1]}`, stderr: '' }; }
    if (args[0] === '--bg') {
      const id = resumed || 'eeeeeeee-1111-2222-3333-444444444444';
      const existing = live.find(x => x.sessionId === id);
      if (existing) existing.pid = 13;
      else live.push({ pid: 13, id: id.slice(0, 8), sessionId: id, cwd: options.cwd, kind: 'background', status: 'busy' });
      return { ok: true, stdout: `backgrounded · ${id.slice(0, 8)} · job`, stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unexpected command' };
  };
  const stored = [
    { sessionId: BG, cwd: APP, customTitle: 'bg job', lastModified: 3 },
    { sessionId: TTY, cwd: APP, summary: 'window chat', lastModified: 2 },
    { sessionId: OLD, cwd: APP, summary: 'old chat', lastModified: 1 },
    { sessionId: FAR, cwd: OUTSIDE, summary: 'private', lastModified: 4 },
    ...extraStored,
  ];
  const sdk = {
    listSessions: async () => stored,
    getSessionMessages: async () => [
      { type: 'user', message: { content: 'Plan the release.' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Draft is ready. Should I tag it?' }, { type: 'tool_use', name: 'Bash' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
    ],
  };
  const trusted = [];
  const trust = { ensure: async dir => { trusted.push(dir); return true; } };
  const sessions = new Sessions({ roots, run, sdk, trust, driving, savedMode: async id => modes[id] });
  return { sessions, calls, trusted, live, driving, cli: () => calls.filter(c => c.args[0] !== 'agents').map(c => c.args) };
}

// --- allowlist ---

test('with no allowed folders, every tool refuses with a hint', async () => {
  const { sessions, cli } = fake({ roots: [] });
  for (const call of [
    () => sessions.list(),
    () => sessions.read(BG),
    () => sessions.start({ cwd: APP, prompt: 'hi' }),
    () => sessions.send(BG, 'hi'),
    () => sessions.stop(BG),
  ]) await assert.rejects(call, /No folders are allowed yet\. Run "do-it add-folder <path>" or add absolute folders to "allowedRoots"/);
  assert.deepEqual(cli(), []);
});

test('allowedRoots entries must be absolute and not /', () => {
  assert.throws(() => new Sessions({ roots: ['relative/path'] }), /must be absolute folders/);
  assert.throws(() => new Sessions({ roots: ['/'] }), /whole drive or file system root/);
});

test('sessions outside the allowed folders are invisible and unreachable', async () => {
  const { sessions, cli } = fake();
  const ids = (await sessions.list()).map(r => r.sessionId);
  assert.ok(!ids.includes(FAR));
  await assert.rejects(sessions.read(FAR), /No session in the allowed folders matches/);
  await assert.rejects(sessions.send('dddddddd', 'hi'), /No session in the allowed folders matches/);
  await assert.rejects(sessions.stop(FAR), /No session in the allowed folders matches/);
  await assert.rejects(sessions.list({ cwd: OUTSIDE }), /outside the allowed folders/);
  assert.deepEqual(cli(), []);
});

test('start_session refuses folders outside the allowlist, including through a symlink', async () => {
  const { sessions, cli } = fake();
  await assert.rejects(sessions.start({ cwd: OUTSIDE, prompt: 'hi' }), /outside the allowed folders/);
  await assert.rejects(sessions.start({ cwd: path.join(ALLOWED, 'escape'), prompt: 'hi' }), /outside the allowed folders/);
  await assert.rejects(sessions.start({ cwd: path.join(ALLOWED, '..', 'elsewhere'), prompt: 'hi' }), /outside the allowed folders/);
  assert.deepEqual(cli(), []);
});

// --- validation ---

test('session ids must be a UUID or an 8+ character prefix, and prefixes must be unambiguous', async () => {
  const { sessions } = fake({ extraStored: [{ sessionId: TWIN, cwd: APP }] });
  for (const bad of ['', 'abc', 'zzzzzzzz', '../../etc', 'aaaaaaaa-1111-2222-3333-4444444444445', 42]) {
    await assert.rejects(sessions.read(bad), /sessionId must be a session UUID/);
  }
  await assert.rejects(sessions.read('aaaaaaaa'), /matches 2 sessions; use more characters/);
  assert.equal((await sessions.read('AAAAAAAA-1111')).sessionId, BG); // case-insensitive, longer prefix disambiguates
  await assert.rejects(sessions.read('ffffffff'), /No session in the allowed folders matches ffffffff/);
});

test('cwd, prompt, text and name are validated before anything runs', async () => {
  const { sessions, cli } = fake();
  await assert.rejects(sessions.start({ cwd: 'projects/app', prompt: 'hi' }), /cwd must be an absolute path/);
  await assert.rejects(sessions.start({ cwd: path.join(ALLOWED, 'missing'), prompt: 'hi' }), /is not an existing folder/);
  await assert.rejects(sessions.start({ cwd: APP, prompt: '   ' }), /prompt must not be empty/);
  await assert.rejects(sessions.start({ cwd: APP, prompt: 'hi', name: 'bad\nname' }), /name must be printable/);
  await assert.rejects(sessions.send(BG, ''), /text must not be empty/);
  await assert.rejects(sessions.list({ cwd: 'relative' }), /cwd must be an absolute path/);
  assert.deepEqual(cli(), []);
});

// --- interactive windows (desktop app, terminal, Remote Control) ---

test('send_message refuses a session open in an interactive window instead of forking a copy', async () => {
  const { sessions, cli } = fake();
  await assert.rejects(sessions.send(TTY, 'hello'), error => {
    assert.match(error.message, /^Session bbbbbbbb is open in an interactive window \(desktop app, terminal or Remote Control\)/);
    assert.match(error.message, /Close it there and send again, or use start_session for a new session\./);
    return true;
  });
  assert.deepEqual(cli(), []); // nothing was started or stopped
});

test('stop_session refuses interactive and not-running sessions', async () => {
  const { sessions, cli } = fake();
  await assert.rejects(sessions.stop(TTY), /open in an interactive window .*; stop it there/);
  await assert.rejects(sessions.stop(OLD), /Session cccccccc is not running/);
  assert.deepEqual(cli(), []);
});

// --- happy paths ---

test('list_sessions returns allowed sessions with status and a status line', async () => {
  const { sessions } = fake();
  const rows = await sessions.list();
  assert.deepEqual(rows.map(r => [r.sessionId, r.status]), [[BG, 'idle'], [TTY, 'idle'], [OLD, 'not running']]);
  assert.equal(rows[0].statusLine, 'Draft is ready.');
  assert.equal(rows[0].title, 'bg job');
  assert.equal((await sessions.list({ cwd: APP + '/', limit: 1 })).length, 1);
});

test('read_session returns the newest messages with content', async () => {
  const { sessions } = fake();
  const result = await sessions.read('aaaaaaaa-1111', { limit: 5 });
  assert.equal(result.sessionId, BG);
  assert.equal(result.status, 'idle');
  assert.deepEqual(result.messages, [
    { role: 'user', text: 'Plan the release.' },
    { role: 'assistant', text: 'Draft is ready. Should I tag it?\n[tool: Bash]' },
  ]);
});

test('start_session records trust, passes the prompt after --, lists the new id as driven, and returns it', async () => {
  const { sessions, cli, trusted, driving } = fake();
  const result = await sessions.start({ cwd: APP, prompt: '--looks-like-a-flag', name: ' release ' });
  assert.deepEqual(cli(), [['--bg', '--permission-mode', 'auto', '--name', 'release', '--', '--looks-like-a-flag']]);
  assert.deepEqual(trusted, [APP]);
  assert.deepEqual(result, { sessionId: 'eeeeeeee-1111-2222-3333-444444444444', backgroundId: 'eeeeeeee', cwd: APP });
  assert.equal(existsSync(driving.file('eeeeeeee')), true);
});

test('send_message to an idle background session stops it and resumes the same id without flags', async () => {
  const { sessions, cli, trusted, calls } = fake();
  const result = await sessions.send('aaaaaaaa-1111-2222', 'next step');
  assert.deepEqual(cli(), [['stop', 'aaaaaaaa'], ['--bg', '--resume', BG, '--', 'next step']]);
  assert.equal(calls.find(c => c.args[0] === '--bg').registered, true); // listed as driven before claude ran
  assert.deepEqual(trusted, [APP]);
  assert.equal(result.sessionId, BG);
  assert.equal(result.continuedFrom, BG);
  assert.equal(result.note, undefined);
  assert.equal('copy' in result, false);
});

test('send_message to a busy session needs interrupt: true', async () => {
  const { sessions, cli } = fake({ bgStatus: 'busy' });
  await assert.rejects(sessions.send(BG, 'wait'), /Session aaaaaaaa is busy\. .*interrupt: true/);
  assert.deepEqual(cli(), []);
  const result = await sessions.send(BG, 'change of plan', { interrupt: true });
  assert.equal(result.note, 'Interrupted the running turn.');
});

test('send_message resumes a stopped session in the background with the chosen permission mode', async () => {
  const { sessions, cli } = fake();
  await sessions.send(OLD, 'pick this up', { permissionMode: 'acceptEdits' });
  assert.deepEqual(cli(), [['--bg', '--resume', OLD, '--permission-mode', 'acceptEdits', '--', 'pick this up']]);
});

test('stop_session stops a running background session', async () => {
  const { sessions, cli } = fake();
  assert.deepEqual(await sessions.stop('aaaaaaaa'), { sessionId: BG, stopped: true });
  assert.deepEqual(cli(), [['stop', 'aaaaaaaa']]);
});

test('CLI failures become readable errors', async () => {
  const sessions = new Sessions({
    roots: [ALLOWED],
    run: async () => ({ ok: false, stdout: '', stderr: 'The claude CLI was not found on PATH (set DO_IT_CLAUDE_BIN).' }),
    sdk: { listSessions: async () => [], getSessionMessages: async () => [] },
    trust: { ensure: async () => false },
  });
  await assert.rejects(sessions.list(), /Couldn't list running Claude Code sessions: The claude CLI was not found/);
});

// --- over MCP ---

test('the MCP server exposes exactly the five tools and reports errors as tool errors', async () => {
  const oauth = new OAuth({
    baseUrl: 'https://do-it.test',
    github: { clientId: 'id', clientSecret: 'secret', allowedLogins: ['owner'] },
    stateFile: path.join(mkdtempSync(path.join(tmpdir(), 'do-it-state-')), 'oauth.json'),
  });
  const { sessions } = fake();
  const app = createApp({ oauth, sessions });
  const { access_token: token } = oauth.issue('client', 'owner');
  const client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('https://do-it.test/mcp'), {
    fetch: (url, init) => app.fetch(new Request(url, init)),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  try {
    const { version } = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(client.getServerVersion()?.version, version);
    const names = (await client.listTools()).tools.map(t => t.name).sort();
    assert.deepEqual(names, ['list_sessions', 'read_session', 'send_message', 'start_session', 'stop_session']);
    const listed = JSON.parse((await client.callTool({ name: 'list_sessions', arguments: {} })).content[0].text);
    assert.equal(listed.length, 3);
    const refused = await client.callTool({ name: 'send_message', arguments: { sessionId: 'bbbbbbbb', text: 'hi' } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /open in an interactive window/);
    const invalid = await client.callTool({ name: 'read_session', arguments: { sessionId: 'nope' } });
    assert.equal(invalid.isError, true);
    const outOfRange = await client.callTool({ name: 'list_sessions', arguments: { limit: 0 } });
    assert.equal(outOfRange.isError, true);
  } finally {
    await client.close();
    await app.close();
  }
});

// --- review fixes ---

test('loadConfig keeps a trustedRoots-only config working once publicUrl is set', async () => {
  const { loadConfig } = await import('../src/config.mjs');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(path.join(tmpdir(), 'do-it-config-'));
  writeFileSync(path.join(dir, 'github.json'), JSON.stringify({ clientId: 'id', clientSecret: 's', allowedLogins: ['owner'] }));
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ trustedRoots: [ALLOWED] }));
  assert.throws(() => loadConfig(dir, {}), /Set "publicUrl" in config\.json \(or DO_IT_PUBLIC_URL\)/);
  assert.deepEqual(loadConfig(dir, { DO_IT_PUBLIC_URL: 'https://host.example/' }).roots, [ALLOWED]);
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ publicUrl: 'https://host.example', trustedRoots: [ALLOWED] }));
  const loaded = loadConfig(dir, {});
  assert.equal(loaded.baseUrl, 'https://host.example');
  assert.deepEqual(loaded.roots, [ALLOWED]);
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ publicUrl: 'https://host.example', allowedRoots: [APP], trustedRoots: [ALLOWED] }));
  assert.deepEqual(loadConfig(dir, {}).roots, [APP]); // the new name wins
  assert.throws(() => loadConfig(dir, { DO_IT_PUBLIC_URL: 'http://host.example' }), /https:\/\//);
  writeFileSync(path.join(dir, 'config.json'), '{ not json');
  assert.throws(() => loadConfig(dir, {}), /Invalid .*config\.json/);
  assert.throws(() => loadConfig(mkdtempSync(path.join(tmpdir(), 'do-it-empty-')), { DO_IT_PUBLIC_URL: 'https://h.example' }), /Missing .*github\.json/);
});

test('a missing working folder is not reported as a missing claude CLI', async () => {
  const { runClaude } = await import('../src/sessions.mjs');
  const saved = process.env.DO_IT_CLAUDE_BIN;
  process.env.DO_IT_CLAUDE_BIN = '/bin/true';
  try {
    const result = await runClaude([], { cwd: path.join(base, 'deleted-folder') });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /The folder .*deleted-folder no longer exists\./);
  } finally {
    if (saved === undefined) delete process.env.DO_IT_CLAUDE_BIN; else process.env.DO_IT_CLAUDE_BIN = saved;
  }
});

test('send_message refuses a session whose folder was deleted, before writing trust or running claude', async () => {
  const GONE = 'ffffffff-1111-2222-3333-444444444444';
  const { sessions, cli, trusted } = fake({ extraStored: [{ sessionId: GONE, cwd: path.join(ALLOWED, 'deleted') }] });
  await assert.rejects(sessions.send(GONE, 'hi'), /Session ffffffff's folder .*deleted no longer exists/);
  assert.deepEqual(cli(), []);
  assert.deepEqual(trusted, []);
});

test('bypassPermissions is refused unless the config allows it', async () => {
  const off = fake();
  await assert.rejects(off.sessions.start({ cwd: APP, prompt: 'hi', permissionMode: 'bypassPermissions' }), /bypassPermissions is turned off\. Set "allowBypassPermissions": true/);
  await assert.rejects(off.sessions.send(OLD, 'hi', { permissionMode: 'bypassPermissions' }), /bypassPermissions is turned off/);
  assert.deepEqual(off.cli(), []);
  const on = fake();
  on.sessions.configure({ roots: [ALLOWED], allowBypassPermissions: true });
  await on.sessions.start({ cwd: APP, prompt: 'hi', permissionMode: 'bypassPermissions' });
  assert.deepEqual(on.cli(), [['--bg', '--permission-mode', 'bypassPermissions', '--', 'hi']]);
  const { liveSettings } = await import('../src/config.mjs');
  assert.equal(liveSettings({}).allowBypassPermissions, false);
  assert.throws(() => liveSettings({ allowBypassPermissions: 'yes' }), /must be true or false/);
});

test('a background session saved in bypassPermissions is not resumed unless bypass is allowed', async () => {
  const off = fake({ modes: { [BG]: 'bypassPermissions' } });
  await assert.rejects(off.sessions.send(BG, 'hi'), /Session aaaaaaaa runs in bypassPermissions, which is turned off/);
  assert.deepEqual(off.cli(), []); // not stopped, not resumed
  const auto = fake({ modes: { [BG]: 'auto' } });
  await auto.sessions.send(BG, 'hi');
  assert.deepEqual(auto.cli(), [['stop', 'aaaaaaaa'], ['--bg', '--resume', BG, '--', 'hi']]);
  const on = fake({ modes: { [BG]: 'bypassPermissions' } });
  on.sessions.configure({ roots: [ALLOWED], allowBypassPermissions: true });
  await on.sessions.send(BG, 'hi');
  assert.equal(on.cli().length, 2);
});

test('the saved permission mode is the newest one in the transcript', async () => {
  const { savedPermissionMode } = await import('../src/mode.mjs');
  const { writeFileSync } = await import('node:fs');
  const config = mkdtempSync(path.join(tmpdir(), 'do-it-claude-'));
  mkdirSync(path.join(config, 'projects', '-some-project'), { recursive: true });
  writeFileSync(path.join(config, 'projects', '-some-project', `${BG}.jsonl`), [
    JSON.stringify({ type: 'user', permissionMode: 'auto' }),
    JSON.stringify({ type: 'user', permissionMode: 'bypassPermissions' }),
    JSON.stringify({ type: 'assistant' }),
  ].join('\n'));
  assert.equal(savedPermissionMode(BG, { env: { CLAUDE_CONFIG_DIR: config } }), 'bypassPermissions');
  assert.equal(savedPermissionMode(OLD, { env: { CLAUDE_CONFIG_DIR: config } }), undefined);
  assert.equal(savedPermissionMode(BG, { env: { CLAUDE_CONFIG_DIR: path.join(config, 'missing') } }), undefined);
});

test('a root that is a symlink to / is refused everywhere', async () => {
  const { Trust } = await import('../src/trust.mjs');
  const { addFolder } = await import('../src/cli.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'do-it-rootlink-'));
  const link = path.join(dir, 'rootlink');
  symlinkSync('/', link);
  assert.throws(() => new Sessions({ roots: [link] }), /whole drive or file system root/);
  assert.throws(() => new Trust({ roots: [link] }), /whole drive or file system root/);
  assert.throws(() => addFolder(dir, link), /whole drive or file system root/);
});
