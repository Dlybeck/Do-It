#!/usr/bin/env node
// do-it: run the server, set it up, or install it as a background service.
//   do-it [start]            run the server in the foreground
//   do-it setup              ask for settings and write config.json and github.json
//   do-it add-folder <path>  allow another folder (a running server picks it up in seconds)
//   do-it install            set up if needed, then install and start the background service
//   do-it uninstall          stop the service and remove what install created
//   do-it status             show whether the service is installed, running and answering
//   do-it service            print a systemd unit (Linux) or launchd plist (macOS)
// Options for any command: --name <name> (default do-it), --config-dir <dir>, --state-dir <dir>,
// --port <port>, --claude-bin <path>. A --name other than do-it gets its own folders, so a
// second instance can run next to the first on another --port.
import { parseArgs } from 'node:util';

const fail = message => { console.error(message); process.exit(1); };
let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { name: { type: 'string' }, 'config-dir': { type: 'string' }, 'state-dir': { type: 'string' }, port: { type: 'string' }, 'claude-bin': { type: 'string' } },
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

async function setup(configDir) {
  const { runSetup, terminalAsker } = await import('../src/cli.mjs');
  const asker = terminalAsker();
  try { await runSetup({ configDir, ask: asker.ask }); } finally { asker.close(); }
}

try {
  switch (command) {
    case 'start': {
      const { main } = await import('../src/server.mjs');
      main();
      break;
    }
    case 'setup':
      await setup(inst.configDir);
      break;
    case 'add-folder': {
      if (rest.length !== 1) fail('Usage: do-it add-folder <path>');
      const { addFolder } = await import('../src/cli.mjs');
      console.log(`Allowed folders: ${addFolder(inst.configDir, rest[0]).join(', ')}`);
      break;
    }
    case 'install': {
      const { install } = await import('../src/install.mjs');
      await install(inst, { setup, claude });
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
      process.stdout.write(serviceFile({ claude }));
      break;
    }
    default:
      fail('Usage: do-it [start | setup | add-folder <path> | install | uninstall | status | service] [--name <name>] [--port <port>] [--config-dir <dir>] [--state-dir <dir>] [--claude-bin <path>]');
  }
} catch (error) { fail(error.message); }
