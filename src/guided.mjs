// The guided setup behind `do-it install` and `do-it setup`: it asks as little as it can,
// fills in what it can find out (your GitHub login from gh, your Tailscale address) and
// writes config.json and github.json. Everything outside the process (gh, tailscale, GitHub)
// is injected, so tests run it with scripted answers.
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { PUBLIC_URL, readJson, writeJson } from './config.mjs';
import { commandFor, doctor, machineChecks } from './doctor.mjs';
import { createGithubApp, manualAppUrl, callbackUrl } from './github-app.mjs';
import { install, run } from './install.mjs';
import { existingRoot } from './paths.mjs';
import { detectTailscale, enableFunnel, funnelCommand } from './tailscale.mjs';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const list = text => String(text ?? '').split(',').map(s => s.trim()).filter(Boolean);
const FOLDER_GUESSES = ['Projects', 'projects', 'code', 'Code', 'src', 'dev', 'Developer', 'workspace'];

// The first usual projects folder that exists in the home folder.
export function defaultFolder(home = homedir()) {
  return FOLDER_GUESSES.map(name => path.join(home, name)).find(dir => { try { return statSync(dir).isDirectory(); } catch { return false; } });
}

// Asks for everything Do-It needs and writes both files. `ask(question, { secret })` returns the
// answer; an empty answer keeps the value shown in brackets.
export async function runSetup({ configDir, ask, say = console.log, port = 8787, exec = run, fetchImpl = fetch, createApp = createGithubApp, home = homedir(), manualGithub = false }) {
  const config = readJson(configDir, 'config.json');
  const github = readJson(configDir, 'github.json');
  const question = async (label, current, check, options = {}) => {
    for (;;) {
      const shown = current ? (options.secret ? ' [keep current]' : ` [${current}]`) : '';
      const answer = (await ask(`${label}${shown}: `, options)).trim() || current || '';
      try { return check(answer); } catch (error) { say(`  ${error.message}`); }
    }
  };
  const yes = async (label, fallback = true) => {
    for (;;) {
      const answer = (await ask(`${label} [${fallback ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
      if (!answer) return fallback;
      if (/^y(es)?$/.test(answer)) return true;
      if (/^no?$/.test(answer)) return false;
      say('  Please answer y or n.');
    }
  };

  say(`Settings go in ${configDir}.\n`);

  // Folders: the only thing Do-It can reach.
  say('1/4  Folders. Do-It can only see and start sessions inside the folders you list (and their subfolders).');
  const currentRoots = (config.allowedRoots ?? config.trustedRoots ?? []).join(', ');
  const roots = await question('Folders Do-It may use (comma-separated)', currentRoots || defaultFolder(home),
    answer => { const r = list(answer).map(existingRoot); if (!r.length) throw new Error('Give at least one folder, for example your projects folder.'); return r; });

  // Who may sign in.
  say('\n2/4  Who may sign in. Only these GitHub accounts get access.');
  let guess = (github.allowedLogins ?? []).join(', ');
  if (!guess) {
    const who = await exec('gh', ['api', 'user', '--jq', '.login']);
    if (who.ok && LOGIN.test(who.stdout)) { guess = who.stdout; say(`  Found your GitHub login through gh: ${guess}`); }
  }
  const logins = await question('GitHub login(s) (comma-separated)', guess,
    answer => { const l = list(answer); if (!l.length || !l.every(x => LOGIN.test(x))) throw new Error('Give GitHub logins like octocat.'); return l; });

  // The public https address.
  say('\n3/4  Public address. claude.ai reaches Do-It over https on port 443.');
  const askAddress = (current) => question('Public https address of this server (no path)', current,
    answer => { const u = answer.replace(/\/$/, ''); if (!PUBLIC_URL.test(u)) throw new Error('Use an https:// address with no path, e.g. https://your-host.example.ts.net'); return u; });
  let publicUrl = config.publicUrl;
  if (publicUrl) publicUrl = await askAddress(publicUrl);
  else {
    const ts = await detectTailscale(exec, port);
    if (ts?.own) {
      publicUrl = `https://${ts.dnsName}`;
      say(`  Tailscale Funnel already forwards https://${ts.dnsName} to Do-It on port ${port}; using it.`);
    } else if (!ts) {
      say('  Tailscale Funnel, Cloudflare Tunnel, ngrok or Caddy can provide this; point it at 127.0.0.1:' + port + '.');
    } else if (!ts.httpsAllowed || !ts.funnelAllowed) {
      say(`  Tailscale is running (${ts.dnsName}), but ${ts.httpsAllowed ? 'Funnel' : 'HTTPS'} isn't enabled for this machine in your tailnet.`);
      say('  Turn it on (https://tailscale.com/kb/1223/funnel), then run this again, or give another address below.');
    } else if (ts.busy) {
      say(`  Tailscale (${ts.dnsName}) already serves something on this machine, and turning Funnel on for Do-It would replace it, so Do-It won't.`);
      say('  Use another tunnel, or a separate Tailscale node (deploy/tailscale/serve.json), and give its address below.');
    } else if (await yes(`  Tailscale found. Make Do-It public at https://${ts.dnsName} with Tailscale Funnel (${funnelCommand(port)})?`)) {
      const funnel = await enableFunnel(exec, port);
      if (funnel.ok) { publicUrl = `https://${ts.dnsName}`; say(`  Funnel is on: ${publicUrl}`); } else say(`  Funnel didn't start:\n${funnel.output.split('\n').map(l => `    ${l}`).join('\n')}`);
    }
    publicUrl = publicUrl ?? await askAddress('');
  }

  // The GitHub app that signs you in.
  say('\n4/4  GitHub sign-in. Do-It needs a GitHub app to check who you are.');
  let { clientId, clientSecret } = github;
  let how = 'kept';
  if (clientId && clientSecret && await yes(`  Keep the GitHub app already set up (client ID ${clientId})?`)) say('  Keeping it. Its Callback URL must be ' + callbackUrl(publicUrl));
  else {
    how = undefined;
    if (!manualGithub && await yes('  Create the GitHub app now? GitHub asks you to click once in your browser.')) {
      try {
        const app = await createApp({
          publicUrl, port, login: logins[0], fetchImpl,
          onReady: ({ url, localUrl }) => {
            say(`  Open this link in a browser where you're signed in to GitHub (any device):\n    ${url}`);
            say(`  On this machine you can also use:\n    ${localUrl}`);
            say('  GitHub shows the app details; click "Create GitHub App". Waiting (up to 10 minutes)...');
          },
        });
        ({ clientId, clientSecret } = app);
        how = 'manifest';
        say(`  Created the GitHub app${app.htmlUrl ? ` (${app.htmlUrl})` : ''}.`);
      } catch (error) { say(`  That didn't work: ${error.message}\n  Doing it by hand instead.`); }
    }
    if (!how) {
      say(`\n  Create the GitHub app by hand: open\n    ${manualAppUrl(publicUrl)}`);
      say(`  The form is filled in (Homepage URL: ${publicUrl}; Authorization callback URL: ${callbackUrl(publicUrl)}).`);
      say('  Click "Register application", then "Generate a new client secret", and paste the two values here.\n');
      clientId = await question('OAuth app client ID', clientId,
        answer => { if (!/^[A-Za-z0-9._-]{4,}$/.test(answer)) throw new Error('That does not look like a client ID.'); return answer; });
      clientSecret = await question('OAuth app client secret', clientSecret,
        answer => { if (!/^[A-Za-z0-9._-]{8,}$/.test(answer)) throw new Error('That does not look like a client secret.'); return answer; }, { secret: true });
      how = 'manual';
    }
  }

  delete config.trustedRoots;
  writeJson(configDir, 'config.json', { ...config, publicUrl, allowedRoots: roots });
  writeJson(configDir, 'github.json', { ...github, clientId, clientSecret, allowedLogins: logins });
  say('\nWrote config.json and github.json (readable only by you).');
  return { publicUrl, roots, logins, github: how };
}

// `do-it install`: checks the machine, runs the setup above when there are no settings yet,
// installs and starts the service, then runs doctor. Returns doctor's report.
export async function guidedInstall(inst, { ask, say = console.log, claude, exec = run, fetchImpl = fetch, createApp, manualGithub, ...deps } = {}) {
  const command = commandFor(inst);
  if ((deps.platform ?? process.platform) === 'win32') say('Note: the Windows installer is experimental and untested on Windows (a Task Scheduler task that has never been run there), and Windows is not yet supported. Continuing anyway.\n');
  say('Checking this machine:');
  let failed = false;
  await machineChecks({ add: r => { say(`  ${{ ok: '✓', warn: '!', fail: '✗', skip: '-' }[r.level]} ${r.text}`); if (r.fix) say(`      Fix: ${r.fix}`); failed ||= r.level === 'fail'; }, command, exec, claude, nodeVersion: deps.nodeVersion, platform: deps.platform, env: deps.env });
  if (failed) throw new Error('Fix the problems above, then run do-it install again.');
  say('');
  await install(inst, { exec, say, claude, ...deps, setup: configDir => runSetup({ configDir, ask, say, port: inst.port, exec, fetchImpl, createApp, home: deps.home, manualGithub }) });
  say('');
  return doctor(inst, { exec, fetchImpl, say, claude, ...deps });
}
