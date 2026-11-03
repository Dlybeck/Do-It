// `do-it install | uninstall | status`: run Do-It as a background service for this user.
//   Linux:   a systemd --user unit in ~/.config/systemd/user/<name>.service
//   macOS:   a launchd agent in ~/Library/LaunchAgents/<name>.plist
//   Windows: a Task Scheduler task <name> that runs at logon, hidden, restarting on failure
// Everything install creates carries a marker, and install and uninstall refuse to touch a
// service definition without it, so a hand-made service of the same name is left alone.
// System commands run through `exec` (no shell), so tests can check them on any OS.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { findClaude } from './claude.mjs';
import { loadConfig } from './config.mjs';
import { APP_DIR, escapes, serviceFile } from './service.mjs';

// No quotes or markup, so it reads back the same from every format (XML exports escape quotes).
export const MARKER = 'Installed by do-it install; do-it uninstall removes it.';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const DEFAULT_PORT = 8787;

export function run(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: 60_000, windowsHide: true, shell: false }, (error, stdout, stderr) =>
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim() }));
  });
}

// Which instance: its name, folders and port. The default instance is "do-it" with the usual
// folders; any other name gets its own config and state folders, so it can run alongside.
export function instance({ name = 'do-it', port, configDir, stateDir, env = process.env, home = homedir() } = {}) {
  if (!NAME.test(name)) throw new Error('--name must be letters, digits, dot, dash or underscore (up to 63 characters).');
  const own = name === 'do-it';
  const resolved = {
    name,
    configDir: path.resolve(configDir ?? (own ? env.DO_IT_CONFIG_DIR : undefined) ?? path.join(home, '.config', name)),
    stateDir: path.resolve(stateDir ?? (own ? env.DO_IT_STATE_DIR : undefined) ?? path.join(home, '.local', 'state', name)),
    port: Number(port ?? (own ? env.DO_IT_PORT : undefined) ?? DEFAULT_PORT),
  };
  if (!Number.isInteger(resolved.port) || resolved.port < 1 || resolved.port > 65535) throw new Error('--port must be a number from 1 to 65535.');
  return resolved;
}

// The service definition and the commands that install, remove and inspect it.
export function plan(inst, { platform = process.platform, home = homedir(), uid = userInfo().uid, user = userInfo().username, node = process.execPath, appDir = APP_DIR, claude, env = process.env } = {}) {
  const claudeBin = claude ?? findClaude({ env, platform });
  if (!claudeBin) throw new Error('Could not find the claude CLI on PATH. Install it, or pass --claude-bin with its full path.');
  const instanceEnv = { DO_IT_CONFIG_DIR: inst.configDir, DO_IT_STATE_DIR: inst.stateDir, DO_IT_PORT: String(inst.port) };
  if (platform === 'linux') {
    const unit = `${inst.name}.service`;
    const content = `# ${MARKER}\n` + serviceFile({ platform, env, node, appDir, home, claude: claudeBin, label: inst.name, extraEnv: instanceEnv });
    return {
      kind: 'systemd user unit', file: path.join(home, '.config', 'systemd', 'user', unit), content,
      install: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', unit]], ['systemctl', ['--user', 'restart', unit]]],
      uninstall: [['systemctl', ['--user', 'disable', '--now', unit]]],
      afterRemove: [['systemctl', ['--user', 'daemon-reload']]],
      status: ['systemctl', ['--user', 'show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID']],
      // A unit of this name loaded from another file (a vendor or hand-made unit) isn't ours to replace.
      loadedFrom: async exec => { const r = await exec('systemctl', ['--user', 'show', unit, '-p', 'LoadState', '-p', 'FragmentPath']); const loaded = /LoadState=loaded/.test(r.stdout); return loaded ? (r.stdout.match(/FragmentPath=(.*)/)?.[1] || undefined) : undefined; },
      linger: ['loginctl', ['show-user', user, '-p', 'Linger', '--value']],
    };
  }
  if (platform === 'darwin') {
    const target = `gui/${uid}/${inst.name}`;
    const file = path.join(home, 'Library', 'LaunchAgents', `${inst.name}.plist`);
    const body = serviceFile({ platform, env, node, appDir, home, claude: claudeBin, label: inst.name, extraEnv: instanceEnv });
    const content = body.replace(/^(<\?xml[^\n]*\n)/, `$1<!-- ${MARKER} -->\n`);
    return {
      kind: 'launchd agent', file, content,
      // bootout first (allowed to fail when not loaded) so a re-run picks up the new file.
      // launchd can still be tearing the old job down right after bootout, so bootstrap retries briefly.
      install: [['launchctl', ['bootout', target], { mayFail: true }], ['launchctl', ['bootstrap', `gui/${uid}`, file], { retries: 10 }]],
      uninstall: [['launchctl', ['bootout', target], { mayFail: true }]],
      afterRemove: [],
      status: ['launchctl', ['print', target]],
      loadedFrom: async exec => { const r = await exec('launchctl', ['print', target]); return r.ok ? (r.stdout.match(/^\s*path = (.*)$/m)?.[1] ?? 'an unknown file') : undefined; },
    };
  }
  if (platform === 'win32') {
    const file = path.win32.join(inst.stateDir, `${inst.name}.task.xml`);
    return {
      kind: 'Task Scheduler task', file, content: taskXml(inst, { node, appDir, claude: claudeBin, user }), encoding: 'utf16le',
      install: [['schtasks', ['/Create', '/TN', inst.name, '/XML', file, '/F']], ['schtasks', ['/End', '/TN', inst.name], { mayFail: true }], ['schtasks', ['/Run', '/TN', inst.name]]],
      uninstall: [['schtasks', ['/End', '/TN', inst.name], { mayFail: true }], ['schtasks', ['/Delete', '/TN', inst.name, '/F']]],
      afterRemove: [],
      status: ['schtasks', ['/Query', '/TN', inst.name, '/FO', 'LIST', '/V']],
      registered: ['schtasks', ['/Query', '/TN', inst.name, '/XML']],
    };
  }
  throw new Error(`do-it install doesn't support ${platform}.`);
}

// Task Scheduler XML: at logon, hidden, restarts on failure, no time limit, runs node directly
// with the instance's settings as arguments (tasks can't set environment variables).
// RestartOnFailure covers a task that fails to start; Task Scheduler doesn't restart one whose
// process exits later (README, Platforms).
export function taskXml(inst, { node, appDir, claude, user }) {
  const quote = value => {
    if (/["\r\n]/.test(value)) throw new Error(`Can't put a path containing quotes or line breaks in a Windows task: ${value}`);
    return `"${value}"`;
  };
  const args = [quote(path.win32.join(appDir, 'bin', 'do-it.mjs')), 'start', '--config-dir', quote(inst.configDir), '--state-dir', quote(inst.stateDir), '--port', String(inst.port), '--claude-bin', quote(claude)].join(' ');
  const x = escapes.darwin; // XML escaping
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Do-It MCP server (${x(inst.name)}). ${x(MARKER)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${x(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${x(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${x(node)}</Command>
      <Arguments>${x(args)}</Arguments>
      <WorkingDirectory>${x(appDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

const portOpen = (port, host = '127.0.0.1') => new Promise(resolve => {
  const socket = createConnection({ port, host });
  socket.setTimeout(1000);
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('timeout', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(false));
});

export async function probe(port, { fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`, { signal: AbortSignal.timeout(2000) });
    return response.ok ? (await response.json()).resource : undefined;
  } catch { return undefined; }
}

// Whether the service definition exists, and whether install made it.
function owned(p, { exec, fs }) {
  if (p.registered) {
    return exec(...p.registered).then(r => ({ exists: r.ok, ours: r.ok && r.stdout.includes(MARKER) }));
  }
  const exists = fs.exists(p.file);
  return Promise.resolve({ exists, ours: exists && fs.read(p.file).includes(MARKER) });
}

let retryDelay = 500;
export const setRetryDelay = ms => { retryDelay = ms; };

async function runAll(commands, exec, say) {
  for (const [command, args, { mayFail = false, retries = 0 } = {}] of commands) {
    let result = await exec(command, args);
    for (let attempt = 0; !result.ok && attempt < retries; attempt++) {
      await new Promise(r => setTimeout(r, retryDelay));
      result = await exec(command, args);
    }
    if (!result.ok && !mayFail) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    if (result.ok) say(`  ran: ${command} ${args.join(' ')}`);
  }
}

const realFs = {
  exists: existsSync,
  read: file => readFileSync(file, 'utf8'),
  write: (file, content, encoding) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, encoding === 'utf16le' ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]) : content, { mode: 0o644 });
  },
  remove: file => rmSync(file, { force: true }),
};

// Installs (or updates) and starts the service. `setup` runs when the instance has no
// config yet. Safe to run again: it rewrites its own file and restarts the service.
export async function install(inst, { exec = run, fs = realFs, say = console.log, setup, wait = 15_000, isPortOpen = portOpen, probeImpl = probe, ...options } = {}) {
  const missing = ['config.json', 'github.json'].filter(f => !fs.exists(path.join(inst.configDir, f)));
  if (missing.length) {
    if (!setup) throw new Error(`No ${missing.join(' or ')} in ${inst.configDir}. Run "do-it setup" first.`);
    say(`No settings in ${inst.configDir} yet; starting setup.`);
    await setup(inst.configDir);
  }
  // The service won't see this shell's environment, so check the files alone.
  const expected = `${loadConfig(inst.configDir, {}).baseUrl}/mcp`;
  const p = plan(inst, options);
  const state = await owned(p, { exec, fs });
  if (!state.exists && p.loadedFrom) {
    const other = await p.loadedFrom(exec);
    if (other && other !== p.file) throw new Error(`A service named ${inst.name} is already loaded from ${other}. Install under another --name.`);
  }
  const what = p.registered ? `Task "${inst.name}"` : p.file;
  if (state.exists && !state.ours) throw new Error(`${what} already exists and wasn't created by do-it install. Remove it yourself, or install under another --name.`);
  if (!state.exists && (await isPortOpen(inst.port))) throw new Error(`Something is already listening on 127.0.0.1:${inst.port}. Pick another --port.`);
  fs.write(p.file, p.content, p.encoding);
  say(`${state.exists ? 'Updated' : 'Wrote'} ${p.kind}: ${p.file}`);
  await runAll(p.install, exec, say);
  if (p.linger) {
    const linger = await exec(...p.linger);
    if (linger.ok && linger.stdout === 'no') say(`Note: to keep ${inst.name} running while you're logged out, run: sudo loginctl enable-linger ${p.linger[1][1]}`);
  }
  // Wait for this instance, recognised by its own public URL, not just anything on the port.
  let resource;
  for (const started = Date.now(); resource !== expected && Date.now() - started < wait;) {
    resource = await probeImpl(inst.port);
    if (resource !== expected) await new Promise(r => setTimeout(r, 500));
  }
  if (resource !== expected) {
    throw new Error(resource
      ? `Port ${inst.port} answers as ${resource}, which is another Do-It, not ${inst.name} (${expected}). Pick another --port.`
      : `${inst.name} was installed but isn't answering on 127.0.0.1:${inst.port}. Check its logs (do-it status --name ${inst.name} --port ${inst.port}).`);
  }
  say(`${inst.name} is running on 127.0.0.1:${inst.port}; connector URL ${resource}`);
  return { file: p.file, resource };
}

// Stops the service and removes what install created. Settings and sign-in state stay.
export async function uninstall(inst, { exec = run, fs = realFs, say = console.log, ...options } = {}) {
  const p = plan(inst, options);
  const state = await owned(p, { exec, fs });
  if (!state.exists) { say(`${inst.name} isn't installed; nothing to remove.`); return { removed: false }; }
  if (!state.ours) throw new Error(`${p.registered ? `Task "${inst.name}"` : p.file} wasn't created by do-it install, so uninstall leaves it alone.`);
  await runAll(p.uninstall, exec, say);
  if (fs.exists(p.file)) { fs.remove(p.file); say(`Removed ${p.file}`); }
  await runAll(p.afterRemove, exec, say);
  say(`Settings in ${inst.configDir} and state in ${inst.stateDir} were kept; delete them yourself if you no longer need them.`);
  return { removed: true };
}

export async function status(inst, { exec = run, fs = realFs, say = console.log, probeImpl = probe, ...options } = {}) {
  const p = plan(inst, options);
  const state = await owned(p, { exec, fs });
  const service = await exec(...p.status);
  const resource = await probeImpl(inst.port);
  let expected;
  try { expected = `${loadConfig(inst.configDir, {}).baseUrl}/mcp`; } catch { /* no usable config: can't tell whose server it is */ }
  const ours = Boolean(resource) && (!expected || resource === expected);
  say(`${inst.name}: ${state.exists ? (state.ours ? `installed (${p.kind}, ${p.file})` : `present but not installed by do-it (${p.file})`) : 'not installed'}`);
  if (service.ok) say(service.stdout.split('\n').filter(l => /State|PID|Status|state =|pid =|Last Result|Next Run/i.test(l)).map(l => `  ${l.trim()}`).join('\n'));
  say(`  127.0.0.1:${inst.port}: ${!resource ? 'not answering' : ours ? `answering (${resource})` : `answering as ${resource}, a different Do-It; is --port right?`}`);
  return { installed: state.exists && state.ours, answering: ours };
}
