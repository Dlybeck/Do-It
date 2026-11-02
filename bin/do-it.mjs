#!/usr/bin/env node
// do-it: run the server, or set it up.
//   do-it [start]            run the server
//   do-it setup              ask for settings and write config.json and github.json
//   do-it add-folder <path>  allow another folder (a running server picks it up in seconds)
//   do-it service            print a systemd unit (Linux) or launchd plist (macOS) for this install
import { configDirFrom } from '../src/config.mjs';

const [command = 'start', ...rest] = process.argv.slice(2);
const fail = message => { console.error(message); process.exit(1); };

switch (command) {
  case 'start': {
    const { main } = await import('../src/server.mjs');
    main();
    break;
  }
  case 'setup': {
    const { runSetup, terminalAsker } = await import('../src/cli.mjs');
    const asker = terminalAsker();
    try { await runSetup({ configDir: configDirFrom(), ask: asker.ask }); }
    catch (error) { fail(error.message); }
    finally { asker.close(); }
    break;
  }
  case 'add-folder': {
    if (rest.length !== 1) fail('Usage: do-it add-folder <path>');
    const { addFolder } = await import('../src/cli.mjs');
    try { console.log(`Allowed folders: ${addFolder(configDirFrom(), rest[0]).join(', ')}`); }
    catch (error) { fail(error.message); }
    break;
  }
  case 'service': {
    const { serviceFile } = await import('../src/service.mjs');
    try { process.stdout.write(serviceFile()); } catch (error) { fail(error.message); }
    break;
  }
  default:
    fail('Usage: do-it [start | setup | add-folder <path> | service]');
}
