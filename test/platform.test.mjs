// Folder matching per platform, service files, and finding the claude CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findClaude } from '../src/claude.mjs';
import { checkRoot, foldsCase, inside } from '../src/paths.mjs';
import { serviceFile } from '../src/service.mjs';
import { Sessions } from '../src/sessions.mjs';

test('folder matching ignores case on macOS and Windows and is exact on Linux', () => {
  assert.equal(inside('/Users/Me/Code', '/users/me/code/app', { platform: 'darwin' }), true);
  assert.equal(inside('/home/me/Code', '/home/me/code/app', { platform: 'linux' }), false);
  assert.equal(inside('/home/me/code', '/home/me/code/app', { platform: 'linux' }), true);
  assert.equal(inside('C:\\Users\\Me\\Code', 'c:\\users\\me\\code\\app', { platform: 'win32', impl: path.win32 }), true);
  // a sibling whose name starts with the root's name is still outside, on every platform
  assert.equal(inside('/Users/me/code', '/Users/me/CODEBASE', { platform: 'darwin' }), false);
  assert.equal(inside('C:\\code', 'C:\\Code-old', { platform: 'win32', impl: path.win32 }), false);
});

test('roots must be absolute and not a whole drive or file system root', () => {
  for (const bad of ['C:\\', 'C:/', 'D:\\', '\\\\server\\share\\']) assert.throws(() => checkRoot(bad, { impl: path.win32 }), /whole drive or file system root/, bad);
  assert.throws(() => checkRoot('C:', { impl: path.win32 }), /must be absolute/);
  assert.throws(() => checkRoot('code', { impl: path.win32 }), /must be absolute/);
  assert.equal(checkRoot('C:\\Users\\me\\code\\', { impl: path.win32 }), 'C:\\Users\\me\\code');
  assert.throws(() => checkRoot('/', { impl: path.posix }), /whole drive or file system root/);
  assert.equal(checkRoot('/home/me/code', { impl: path.posix }), '/home/me/code');
});

test('on a case-insensitive file system a differently cased folder still matches', { skip: !foldsCase() && 'Linux matches case exactly' }, async () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-case-')));
  const app = path.join(base, 'Code', 'App');
  mkdirSync(app, { recursive: true });
  const sessions = new Sessions({ roots: [path.join(base, 'Code')], run: async () => ({ ok: true, stdout: '[]', stderr: '' }), sdk: { listSessions: async () => [], getSessionMessages: async () => [] }, trust: { ensure: async () => false } });
  assert.equal(sessions.allowed(path.join(base, 'code', 'app')), true);
  assert.ok(await sessions.allowedDirectory(path.join(base, 'CODE', 'app')));
});

test('the systemd unit and launchd plist get absolute paths, escaped for each format', () => {
  const unit = serviceFile({ platform: 'linux', node: '/opt/node/bin/node', appDir: process.cwd(), home: '/home/me', claude: '/home/me/100%/claude' });
  assert.match(unit, /^ExecStart="\/opt\/node\/bin\/node" ".*\/bin\/do-it\.mjs" start$/m);
  assert.match(unit, /^Environment="DO_IT_CLAUDE_BIN=\/home\/me\/100%%\/claude"$/m);
  assert.doesNotMatch(unit, /\{\{/);
  const plist = serviceFile({ platform: 'darwin', node: '/opt/homebrew/bin/node', appDir: process.cwd(), home: '/Users/me', claude: '/Users/me/R&D/claude' });
  assert.match(plist, /<key>DO_IT_CLAUDE_BIN<\/key>\s*<string>\/Users\/me\/R&amp;D\/claude<\/string>/);
  assert.match(plist, /<string>\/Users\/me\/Library\/Logs\/do-it\.log<\/string>/);
  assert.match(plist, /\/opt\/homebrew\/bin/);
  assert.doesNotMatch(plist, /\{\{/);
  assert.throws(() => serviceFile({ platform: 'linux', env: { PATH: '/nowhere' } }), /Could not find the claude CLI/);
  assert.throws(() => serviceFile({ platform: 'win32' }), /No service template for win32/);
});

test('findClaude prefers DO_IT_CLAUDE_BIN, then the first claude on PATH', () => {
  const has = files => file => files.includes(file);
  assert.equal(findClaude({ env: { DO_IT_CLAUDE_BIN: '/x/claude', PATH: '/a' }, platform: 'linux', exists: has([]) }), '/x/claude');
  assert.equal(findClaude({ env: { PATH: '/a:/b:/c' }, platform: 'linux', exists: has(['/b/claude', '/c/claude']) }), '/b/claude');
  assert.equal(findClaude({ env: { PATH: '/a' }, platform: 'linux', exists: has([]) }), undefined);
});

test('claude.cmd shims run the script or .exe they wrap, never through a shell', async () => {
  const { claudeCommand } = await import('../src/claude.mjs');
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
  const js = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const npmShim = '@ECHO off\r\nSETLOCAL\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n';
  const base = { platform: 'win32', node: 'C:\\node\\node.exe' };
  assert.deepEqual(claudeCommand({ ...base, bin: shim, readFile: () => npmShim, exists: f => f === js }), { file: 'C:\\node\\node.exe', prefix: [js] });
  const exe = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
  assert.deepEqual(claudeCommand({ ...base, bin: shim, readFile: () => '"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*', exists: f => f === exe }), { file: exe, prefix: [] });
  assert.throws(() => claudeCommand({ ...base, bin: shim, readFile: () => 'cmd /c something', exists: () => true }), /Can't run .*claude\.cmd without a shell\. Set DO_IT_CLAUDE_BIN/);
  assert.throws(() => claudeCommand({ ...base, bin: shim, readFile: () => { throw new Error('nope'); } }), /Could not read/);
  assert.deepEqual(claudeCommand({ ...base, bin: 'C:\\tools\\claude.exe' }), { file: 'C:\\tools\\claude.exe', prefix: [] });
  assert.deepEqual(claudeCommand({ platform: 'linux', node: '/n', bin: '/x/claude' }), { file: '/x/claude', prefix: [] });
  assert.deepEqual(claudeCommand({ platform: 'linux', node: '/n', bin: '/x/cli.js' }), { file: '/n', prefix: ['/x/cli.js'] });
});

test('arguments with shell characters reach claude unchanged', async () => {
  const { writeFileSync } = await import('node:fs');
  const { runClaude } = await import('../src/sessions.mjs');
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-argv-')));
  const fakeCli = path.join(dir, 'echo-args.mjs');
  writeFileSync(fakeCli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  const saved = process.env.DO_IT_CLAUDE_BIN;
  process.env.DO_IT_CLAUDE_BIN = fakeCli;
  try {
    const tricky = ['--', 'a & b | c; $(touch pwned) `id` "quoted" %PATH% ^& > out.txt'];
    const result = await runClaude(tricky, { cwd: dir });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.stdout), tricky);
    assert.equal((await import('node:fs')).existsSync(path.join(dir, 'pwned')), false);
    assert.equal((await import('node:fs')).existsSync(path.join(dir, 'out.txt')), false);
  } finally {
    if (saved === undefined) delete process.env.DO_IT_CLAUDE_BIN; else process.env.DO_IT_CLAUDE_BIN = saved;
  }
});

test("npm's real claude.cmd shim runs cli.js, not node.exe", async () => {
  const { claudeCommand } = await import('../src/claude.mjs');
  const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd';
  const cli = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const nodeNext = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node.exe';
  const realShim = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n');
  for (const present of [[cli], [cli, nodeNext]]) {
    assert.deepEqual(claudeCommand({ platform: 'win32', node: 'C:\\node\\node.exe', bin: shim, readFile: () => realShim, exists: f => present.includes(f) }),
      { file: 'C:\\node\\node.exe', prefix: [cli] });
  }
});
