// do-it install / uninstall / status on Linux, macOS and Windows, with every system command,
// file write and network check faked. The real install is checked by hand on a real machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MARKER, install, instance, plan, setRetryDelay, status, uninstall } from '../src/install.mjs';

setRetryDelay(1);

const HOME = '/home/me';
const CONFIG = { 'config.json': JSON.stringify({ publicUrl: 'https://x.example', allowedRoots: ['/home/me/code'] }), 'github.json': JSON.stringify({ clientId: 'id', clientSecret: 'secret', allowedLogins: ['me'] }) };

// A fake machine: files in a map, commands recorded, answers chosen per command.
function machine({ files = {}, answers = () => ({ ok: true, stdout: '' }), portOpen = false, answering = true } = {}) {
  const fs = {
    files: { ...files },
    // Real files are visible only under the temp dir, where each test writes its config.
    exists: f => f in fs.files || (f.startsWith(tmpdir()) && existsSync(f)),
    read: f => fs.files[f],
    write: (f, content, encoding) => { fs.files[f] = content; fs.encodings[f] = encoding; },
    remove: f => { delete fs.files[f]; },
    encodings: {},
  };
  const calls = [];
  const exec = async (command, args) => { calls.push([command, ...args]); return { code: 0, stderr: '', ...answers(command, args) }; };
  return { fs, calls, exec, say: () => {}, isPortOpen: async () => portOpen, probeImpl: async () => (answering === true ? 'https://x.example/mcp' : answering || undefined), wait: 50 };
}
const withConfig = dir => Object.fromEntries(Object.entries(CONFIG).map(([f, c]) => [path.join(dir, f), c]));
const common = { home: HOME, uid: 501, user: 'me', node: '/usr/bin/node', appDir: '/opt/do-it', claude: '/home/me/.local/bin/claude', env: {} };

// loadConfig reads real files, so give it a real folder for the config check.
const realConfigDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'do-it-install-'));
  for (const [f, c] of Object.entries(CONFIG)) writeFileSync(path.join(dir, f), c);
  return dir;
};

test('instances: the default uses the usual folders; another name gets its own; bad input is refused', () => {
  assert.deepEqual(instance({ home: HOME, env: {} }), { name: 'do-it', configDir: '/home/me/.config/do-it', stateDir: '/home/me/.local/state/do-it', port: 8787 });
  assert.deepEqual(instance({ name: 'do-it-test', port: '8788', home: HOME, env: { DO_IT_CONFIG_DIR: '/ignored', DO_IT_PORT: '9999' } }),
    { name: 'do-it-test', configDir: '/home/me/.config/do-it-test', stateDir: '/home/me/.local/state/do-it-test', port: 8788 });
  assert.equal(instance({ home: HOME, env: { DO_IT_CONFIG_DIR: '/cfg', DO_IT_PORT: '9000' } }).configDir, '/cfg');
  for (const name of ['', '../evil', 'a b', 'x;rm', '-x']) assert.throws(() => instance({ name, home: HOME }), /--name must be/);
  for (const port of ['0', '70000', 'abc', '1.5']) assert.throws(() => instance({ port, home: HOME }), /--port must be/);
});

test('Linux: a marked systemd user unit with the instance settings, enabled and restarted', async () => {
  const inst = instance({ name: 'do-it-test', port: 8788, configDir: realConfigDir(), home: HOME });
  const m = machine({ answers: (c, a) => (c === 'loginctl' ? { ok: true, stdout: 'no' } : { ok: true, stdout: '' }) });
  const said = [];
  await install(inst, { ...m, ...common, platform: 'linux', say: l => said.push(l) });
  const file = '/home/me/.config/systemd/user/do-it-test.service';
  const unit = m.fs.files[file];
  assert.ok(unit.startsWith(`# ${MARKER}\n`));
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "\/opt\/do-it\/bin\/do-it\.mjs" start$/m);
  assert.match(unit, new RegExp(`^Environment="DO_IT_CONFIG_DIR=${inst.configDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.match(unit, /^Environment="DO_IT_PORT=8788"$/m);
  assert.match(unit, /^Environment="DO_IT_STATE_DIR=\/home\/me\/\.local\/state\/do-it-test"$/m);
  assert.match(unit, /^Environment="DO_IT_CLAUDE_BIN=\/home\/me\/\.local\/bin\/claude"$/m);
  assert.deepEqual(m.calls, [
    ['systemctl', '--user', 'show', 'do-it-test.service', '-p', 'LoadState', '-p', 'FragmentPath'],
    ['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', 'do-it-test.service'], ['systemctl', '--user', 'restart', 'do-it-test.service'],
    ['loginctl', 'show-user', 'me', '-p', 'Linger', '--value'],
  ]);
  assert.ok(said.some(l => l.includes('sudo loginctl enable-linger me')));
  assert.ok(!m.calls.some(c => c[0] === 'sudo'));

  // Re-running is safe: same file, same commands.
  m.calls.length = 0;
  await install(inst, { ...m, ...common, platform: 'linux' });
  assert.equal(m.fs.files[file], unit);
  assert.equal(m.calls.filter(c => c[0] === 'systemctl').length, 3);

  m.calls.length = 0;
  await uninstall(inst, { ...m, ...common, platform: 'linux' });
  assert.equal(file in m.fs.files, false);
  assert.deepEqual(m.calls, [['systemctl', '--user', 'disable', '--now', 'do-it-test.service'], ['systemctl', '--user', 'daemon-reload']]);
  m.calls.length = 0;
  assert.deepEqual(await uninstall(inst, { ...m, ...common, platform: 'linux' }), { removed: false });
  assert.deepEqual(m.calls, []);
});

test('a service definition install did not create is never overwritten or removed', async () => {
  const inst = instance({ configDir: realConfigDir(), home: HOME });
  const file = '/home/me/.config/systemd/user/do-it.service';
  const m = machine({ files: { [file]: '[Service]\nExecStart=node src/server.mjs\n' } });
  await assert.rejects(install(inst, { ...m, ...common, platform: 'linux' }), /already exists and wasn't created by do-it install/);
  await assert.rejects(uninstall(inst, { ...m, ...common, platform: 'linux' }), /wasn't created by do-it install/);
  assert.equal(m.fs.files[file], '[Service]\nExecStart=node src/server.mjs\n');
  assert.deepEqual(m.calls, []);
});

test('install refuses a busy port, missing settings, and a server that never answers', async () => {
  const inst = instance({ name: 'x', port: 8788, configDir: realConfigDir(), home: HOME });
  const busy = machine({ portOpen: true });
  await assert.rejects(install(inst, { ...busy, ...common, platform: 'linux' }), /already listening on 127\.0\.0\.1:8788/);
  assert.deepEqual(busy.calls.filter(c => c[2] !== 'show'), []); // only the read-only lookup ran
  assert.deepEqual(Object.keys(busy.fs.files).filter(f => !f.startsWith(tmpdir())), []);
  const empty = instance({ name: 'y', port: 8788, configDir: mkdtempSync(path.join(tmpdir(), 'do-it-empty-')), home: HOME });
  await assert.rejects(install(empty, { ...machine(), ...common, platform: 'linux' }), /No config\.json or github\.json .* Run "do-it setup" first/);
  let setupRan = false;
  await assert.rejects(install(empty, { ...machine(), ...common, platform: 'linux', setup: async () => { setupRan = true; } }), /Missing .*github\.json/);
  assert.equal(setupRan, true); // setup is offered first when settings are missing
  const silent = machine({ answering: false });
  await assert.rejects(install(inst, { ...silent, ...common, platform: 'linux' }), /installed but isn't answering on 127\.0\.0\.1:8788/);
});

test('macOS: a marked LaunchAgent with full paths, bootstrapped into the gui domain', async () => {
  const inst = instance({ name: 'do-it', configDir: realConfigDir(), home: HOME });
  const m = machine({ answers: (c, a) => (a[0] === 'bootout' || a[0] === 'print' ? { ok: false, code: 3, stderr: 'No such process' } : { ok: true, stdout: '' }) });
  await install(inst, { ...m, ...common, platform: 'darwin' });
  const file = '/home/me/Library/LaunchAgents/do-it.plist';
  const plist = m.fs.files[file];
  assert.ok(plist.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${MARKER} -->\n`));
  assert.match(plist, /<key>Label<\/key>\s*<string>do-it<\/string>/);
  assert.match(plist, /<key>DO_IT_CLAUDE_BIN<\/key>\s*<string>\/home\/me\/\.local\/bin\/claude<\/string>/);
  assert.match(plist, /<key>DO_IT_PORT<\/key>\s*<string>8787<\/string>/);
  assert.match(plist, /<string>\/usr\/bin\/node<\/string>\s*<string>\/opt\/do-it\/bin\/do-it\.mjs<\/string>\s*<string>start<\/string>/);
  assert.deepEqual(m.calls, [['launchctl', 'print', 'gui/501/do-it'], ['launchctl', 'bootout', 'gui/501/do-it'], ['launchctl', 'bootstrap', 'gui/501', file]]);
  m.calls.length = 0;
  await uninstall(inst, { ...m, ...common, platform: 'darwin' });
  assert.deepEqual(m.calls, [['launchctl', 'bootout', 'gui/501/do-it']]);
  assert.equal(file in m.fs.files, false);
});

test('Windows: a hidden logon task that restarts on failure and runs node with full paths, in UTF-16', async () => {
  const win = { ...common, node: 'C:\\Program Files\\nodejs\\node.exe', appDir: 'C:\\Users\\me\\do-it', claude: 'C:\\Users\\me\\.local\\bin\\claude.exe', home: 'C:\\Users\\me' };
  const inst = { name: 'do-it', configDir: realConfigDir(), stateDir: 'C:\\Users\\me\\.local\\state\\do-it', port: 8787 };
  let registered = false;
  const m = machine({
    answers: (c, a) => {
      if (a[0] === '/Query' && a.includes('/XML')) return registered ? { ok: true, stdout: `<Description>${MARKER}</Description>` } : { ok: false, code: 1, stderr: 'ERROR: The system cannot find the file specified.' };
      if (a[0] === '/Create') registered = true;
      if (a[0] === '/Delete') registered = false;
      return { ok: true, stdout: '' };
    },
  });
  await install(inst, { ...m, ...win, platform: 'win32' });
  const file = 'C:\\Users\\me\\.local\\state\\do-it\\do-it.task.xml';
  const xml = m.fs.files[file];
  assert.equal(m.fs.encodings[file], 'utf16le');
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>999<\/Count>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(xml, /<Arguments>&quot;C:\\Users\\me\\do-it\\bin\\do-it\.mjs&quot; start --config-dir &quot;.*&quot; --state-dir &quot;C:\\Users\\me\\\.local\\state\\do-it&quot; --port 8787 --claude-bin &quot;C:\\Users\\me\\\.local\\bin\\claude\.exe&quot;<\/Arguments>/);
  assert.ok(xml.includes(MARKER.replace(/"/g, '&quot;')));
  assert.deepEqual(m.calls, [
    ['schtasks', '/Query', '/TN', 'do-it', '/XML'],
    ['schtasks', '/Create', '/TN', 'do-it', '/XML', file, '/F'], ['schtasks', '/End', '/TN', 'do-it'], ['schtasks', '/Run', '/TN', 'do-it'],
  ]);
  m.calls.length = 0;
  await uninstall(inst, { ...m, ...win, platform: 'win32' });
  assert.deepEqual(m.calls, [['schtasks', '/Query', '/TN', 'do-it', '/XML'], ['schtasks', '/End', '/TN', 'do-it'], ['schtasks', '/Delete', '/TN', 'do-it', '/F']]);
  assert.equal(file in m.fs.files, false);
  assert.throws(() => plan({ ...inst, configDir: 'C:\\a"b' }, { ...win, platform: 'win32' }), /quotes or line breaks/);
});

test('a Windows task of the same name that install did not create is left alone', async () => {
  const inst = { name: 'do-it', configDir: realConfigDir(), stateDir: 'C:\\s', port: 8787 };
  const m = machine({ answers: (c, a) => (a.includes('/XML') && a[0] === '/Query' ? { ok: true, stdout: '<Description>someone else</Description>' } : { ok: true }) });
  await assert.rejects(install(inst, { ...m, ...common, platform: 'win32' }), /Task "do-it" already exists and wasn't created/);
  await assert.rejects(uninstall(inst, { ...m, ...common, platform: 'win32' }), /Task "do-it" wasn't created/);
  assert.equal(m.calls.filter(c => c[1] !== '/Query').length, 0);
});

test('status reports installation, service state and whether it answers', async () => {
  const inst = instance({ name: 'do-it-test', port: 8788, home: HOME });
  const file = '/home/me/.config/systemd/user/do-it-test.service';
  const m = machine({ files: { [file]: `# ${MARKER}\n` }, answers: () => ({ ok: true, stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42' }) });
  const said = [];
  assert.deepEqual(await status(inst, { ...m, ...common, platform: 'linux', say: l => said.push(l) }), { installed: true, answering: true });
  assert.match(said.join('\n'), /installed \(systemd user unit/);
  assert.match(said.join('\n'), /MainPID=42/);
  assert.deepEqual(m.calls, [['systemctl', '--user', 'show', 'do-it-test.service', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID']]);
});

test('unsupported platforms are refused clearly', () => {
  assert.throws(() => plan(instance({ home: HOME }), { ...common, platform: 'aix' }), /doesn't support aix/);
});

test('a unit or agent of the same name loaded from another file is not replaced', async () => {
  const inst = instance({ name: 'pipewire', port: 8790, configDir: realConfigDir(), home: HOME });
  const linux = machine({ answers: (c, a) => (a[1] === 'show' ? { ok: true, stdout: 'LoadState=loaded\nFragmentPath=/usr/lib/systemd/user/pipewire.service' } : { ok: true }) });
  await assert.rejects(install(inst, { ...linux, ...common, platform: 'linux' }), /already loaded from \/usr\/lib\/systemd\/user\/pipewire\.service/);
  assert.deepEqual(Object.keys(linux.fs.files), []);
  assert.equal(linux.calls.length, 1);
  const mac = machine({ answers: (c, a) => (a[0] === 'print' ? { ok: true, stdout: 'gui/501/pipewire = {\n\tpath = /Library/LaunchAgents/other.plist\n}' } : { ok: true }) });
  await assert.rejects(install(inst, { ...mac, ...common, platform: 'darwin' }), /already loaded from \/Library\/LaunchAgents\/other\.plist/);
  assert.ok(!mac.calls.some(c => c[1] === 'bootout'));
});

test('install and status recognise this instance by its public URL, not just anything on the port', async () => {
  const inst = instance({ name: 'do-it-test', port: 8787, configDir: realConfigDir(), home: HOME });
  const other = machine({ answering: 'https://someone-else.example/mcp' });
  await assert.rejects(install(inst, { ...other, ...common, platform: 'linux' }), /answers as https:\/\/someone-else\.example\/mcp, which is another Do-It/);
  const said = [];
  const m = machine({ answering: 'https://someone-else.example/mcp', answers: () => ({ ok: true, stdout: 'ActiveState=inactive' }) });
  assert.deepEqual(await status(inst, { ...m, ...common, platform: 'linux', say: l => said.push(l) }), { installed: false, answering: false });
  assert.match(said.join('\n'), /a different Do-It; is --port right\?/);
});

test('macOS re-install retries bootstrap while launchd finishes the bootout', async () => {
  const inst = instance({ configDir: realConfigDir(), home: HOME });
  const file = '/home/me/Library/LaunchAgents/do-it.plist';
  let failures = 2;
  const m = machine({
    files: { [file]: `<?xml version="1.0"?>\n<!-- ${MARKER} -->\n` },
    answers: (c, a) => (a[0] === 'bootstrap' && failures-- > 0 ? { ok: false, code: 5, stderr: 'Bootstrap failed: 5: Input/output error' } : { ok: true, stdout: '' }),
  });
  await install(inst, { ...m, ...common, platform: 'darwin' });
  assert.equal(m.calls.filter(c => c[1] === 'bootstrap').length, 3);
});

test('do-it service keeps the default unit unchanged and names a custom instance', async () => {
  const { serviceFile } = await import('../src/service.mjs');
  const plain = serviceFile({ platform: 'linux', node: '/n', appDir: '/a', home: '/h', claude: '/c' });
  assert.match(plain, /^Description=Do-It MCP server for remote Claude Code control$/m);
  assert.doesNotMatch(plain, /DO_IT_PORT|\{\{/);
  const named = serviceFile({ platform: 'linux', node: '/n', appDir: '/a', home: '/h', claude: '/c', label: 'do-it-test', extraEnv: { DO_IT_PORT: '8788' } });
  assert.match(named, /^Description=Do-It MCP server for remote Claude Code control \(do-it-test\)$/m);
  assert.match(named, /^Environment="DO_IT_PORT=8788"$/m);
});
