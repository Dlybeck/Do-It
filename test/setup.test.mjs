// do-it setup, add-folder, and picking up config.json changes while running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addFolder, runSetup } from '../src/cli.mjs';
import { watchConfig } from '../src/config.mjs';
import { Sessions } from '../src/sessions.mjs';

const fresh = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-setup-')));
const json = (dir, file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
const mode = file => statSync(file).mode & 0o777;
const scripted = answers => {
  const asked = [];
  return { asked, ask: async (q, options = {}) => { asked.push([q, options.secret === true]); return answers.shift() ?? ''; } };
};

test('setup writes both files with owner-only modes, re-asking after bad answers', async () => {
  const base = fresh();
  const code = path.join(base, 'code');
  mkdirSync(code);
  const configDir = path.join(base, 'config');
  const { ask, asked } = scripted([
    '/', 'relative', code,                        // folders: two bad answers first
    'bad login!', 'octocat, hubot',               // logins
    'http://insecure.example', 'https://your-host.example.ts.net/', // url (trailing slash is trimmed)
    'Iv1.abcdef123', 'secret-value-123',          // OAuth app
  ]);
  const said = [];
  await runSetup({ configDir, ask, say: line => said.push(line) });
  assert.deepEqual(json(configDir, 'config.json'), { publicUrl: 'https://your-host.example.ts.net', allowedRoots: [code] });
  assert.deepEqual(json(configDir, 'github.json'), { clientId: 'Iv1.abcdef123', clientSecret: 'secret-value-123', allowedLogins: ['octocat', 'hubot'] });
  assert.equal(mode(configDir), 0o700);
  assert.equal(mode(path.join(configDir, 'config.json')), 0o600);
  assert.equal(mode(path.join(configDir, 'github.json')), 0o600);
  assert.ok(said.some(l => l.includes('https://your-host.example.ts.net/oauth/github/callback')));
  assert.ok(said.some(l => /whole drive or file system root/.test(l)));
  assert.deepEqual(asked.at(-1), ['OAuth app client secret: ', true]); // the secret prompt hides input
  assert.ok(!said.join('\n').includes('secret-value-123'));
});

test('re-running setup keeps current values on empty answers and moves trustedRoots over', async () => {
  const configDir = fresh();
  const code = path.join(configDir, 'code');
  mkdirSync(code);
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ trustedRoots: [code], publicUrl: 'https://old.example', allowBypassPermissions: true }));
  writeFileSync(path.join(configDir, 'github.json'), JSON.stringify({ clientId: 'Iv1.keepme', clientSecret: 'keep-this-secret', allowedLogins: ['octocat'] }));
  const { ask, asked } = scripted(['', '', 'https://new.example', '', '']);
  await runSetup({ configDir, ask, say: () => {} });
  assert.deepEqual(json(configDir, 'config.json'), { publicUrl: 'https://new.example', allowBypassPermissions: true, allowedRoots: [code] });
  assert.equal(json(configDir, 'github.json').clientSecret, 'keep-this-secret');
  assert.match(asked.at(-1)[0], /\[keep current\]/); // the secret itself is never shown
});

test('add-folder adds existing folders once and refuses bad ones', () => {
  const configDir = fresh();
  const a = path.join(configDir, 'a');
  const b = path.join(configDir, 'b');
  mkdirSync(a); mkdirSync(b);
  writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ publicUrl: 'https://x.example', trustedRoots: [a] }));
  assert.deepEqual(addFolder(configDir, b), [a, b]);
  assert.deepEqual(addFolder(configDir, b + '/'), [a, b]);
  assert.deepEqual(json(configDir, 'config.json'), { publicUrl: 'https://x.example', allowedRoots: [a, b] });
  assert.throws(() => addFolder(configDir, path.join(configDir, 'missing')), /doesn't exist/);
  writeFileSync(path.join(configDir, 'file.txt'), 'x');
  assert.throws(() => addFolder(configDir, path.join(configDir, 'file.txt')), /is not a folder/);
  assert.throws(() => addFolder(configDir, '/'), /whole drive or file system root/);
});

test('config.json changes reach a running server without a restart; broken edits are ignored', async () => {
  const configDir = fresh();
  const code = path.join(configDir, 'code');
  mkdirSync(code);
  const file = path.join(configDir, 'config.json');
  writeFileSync(file, JSON.stringify({ allowedRoots: [] }));
  const sessions = new Sessions({ roots: [], run: async () => ({ ok: true, stdout: '[]', stderr: '' }), sdk: { listSessions: async () => [], getSessionMessages: async () => [] }, trust: { ensure: async () => false } });
  const errors = [];
  const changes = [];
  const stop = watchConfig(configDir, live => { changes.push(live); sessions.configure(live); }, { interval: 20, log: { error: m => errors.push(m) } });
  try {
    const waitFor = async check => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(check()); };
    await new Promise(r => setTimeout(r, 60));
    writeFileSync(file, JSON.stringify({ allowedRoots: [code], allowBypassPermissions: true }));
    await waitFor(() => changes.length === 1);
    assert.deepEqual(sessions.roots, [code]);
    assert.equal(sessions.allowBypassPermissions, true);
    assert.deepEqual(await sessions.list(), []); // no longer refused
    writeFileSync(file, '{ broken');
    await waitFor(() => errors.length === 1);
    assert.match(errors[0], /keeping the previous settings/);
    assert.deepEqual(sessions.roots, [code]);
  } finally { stop(); }
});
