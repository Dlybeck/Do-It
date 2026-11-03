#!/usr/bin/env node
// do-it: run the server, set it up, or install it as a background service.
//   do-it [start]            run the server in the foreground
//   do-it setup              guided: folders, login, public address, sign-in app
//   do-it add-folder <path>  allow another folder (a running server picks it up in seconds)
//   do-it install            check this machine, set up if needed, install and start the service, then doctor
//   do-it doctor             check the whole setup and print the fix for anything wrong
//   do-it uninstall          stop the service and remove what install created
//   do-it status             show whether the service is installed, running and answering
//   do-it service            print a systemd unit (Linux) or launchd plist (macOS)
// Options for any command: --name <name> (default do-it), --config-dir <dir>, --state-dir <dir>,
// --port <port>, --claude-bin <path>. --manual-github (setup, install) skips the one-click sign-in app
// creation and asks for the client ID and secret instead. A --name other than do-it gets its own folders, so a
// second instance can run next to the first on another --port.
import { parseArgs } from 'node:util';

const fail = message => { console.error(message); process.exit(1); };
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { name: { type: 'string' }, 'config-dir': { type: 'string' }, 'state-dir': { type: 'string' }, port: { type: 'string' }, 'claude-bin': { type: 'string' }, 'manual-github': { type: 'boolean' } },
  });
} catch (error) { fail(error.message); }
const { values: flags, positionals } = parsed;
const [command = 'start', ...rest] = positionals;

const { instance } = await import('../src/install.mjs');
let inst;
try { inst = instance({ name: flags.name, port: flags.port, configDir: flags['config-dir'], stateDir: flags['state-dir'] }); }
catch (error) { fail(error.message); }
// The server and setup read these; flags win over the environment.
Object.assign(process.env, { DO_IT_CONFIG_DIR: inst.configDir, DO_IT_STATE_DIR: inst.stateDir, DO_IT_PORT: String(inst.port) });
if (flags['claude-bin']) process.env.DO_IT_CLAUDE_BIN = flags['claude-bin'];
const claude = flags['claude-bin'];

const manualGithub = flags['manual-github'] === true;
async function asking(fn) {
  const { terminalAsker } = await import('../src/cli.mjs');
  const asker = terminalAsker();
  try { return await fn(asker.ask); } finally { asker.close(); }
}

try {
  switch (command) {
    case 'start': {
      const { main } = await import('../src/server.mjs');
      main();
      break;
    }
    case 'setup': {
      const { runSetup } = await import('../src/guided.mjs');
      await asking(ask => runSetup({ configDir: inst.configDir, ask, port: inst.port, manualGithub }));
      break;
    }
    case 'add-folder': {
      if (rest.length !== 1) fail('Usage: do-it add-folder <path>');
      const { addFolder } = await import('../src/cli.mjs');
      console.log(`Allowed folders: ${addFolder(inst.configDir, rest[0]).join(', ')}`);
      break;
    }
    case 'install': {
      const { guidedInstall } = await import('../src/guided.mjs');
      const report = await asking(ask => guidedInstall(inst, { ask, claude, manualGithub }));
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case 'doctor': {
      const { doctor } = await import('../src/doctor.mjs');
      const report = await doctor(inst, { claude });
      if (!report.ok) process.exitCode = 1;
      break;
    }
    case 'uninstall': {
      const { uninstall } = await import('../src/install.mjs');
      await uninstall(inst, { claude: claude ?? 'claude' });
      break;
    }
    case 'status': {
      const { status } = await import('../src/install.mjs');
      await status(inst, { claude: claude ?? 'claude' });
      break;
    }
    case 'service': {
      const { serviceFile } = await import('../src/service.mjs');
      // With no instance options this prints the plain default unit, as before.
      const custom = flags.name || flags.port || flags['config-dir'] || flags['state-dir'];
      const extraEnv = custom ? { DO_IT_CONFIG_DIR: inst.configDir, DO_IT_STATE_DIR: inst.stateDir, DO_IT_PORT: String(inst.port) } : {};
      process.stdout.write(serviceFile({ claude, label: inst.name, extraEnv }));
      break;
    }
    default:
      fail('Usage: do-it [start | setup | add-folder <path> | install | doctor | uninstall | status | service] [--name <name>] [--port <port>] [--config-dir <dir>] [--state-dir <dir>] [--claude-bin <path>] [--manual-github]');
  }
} catch (error) { fail(error.message); }
