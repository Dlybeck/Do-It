// `do-it doctor`: checks everything a working setup needs and prints the exact fix for each
// thing that's wrong. Nothing here changes anything.
import { statSync } from 'node:fs';
import path from 'node:path';
import { findClaude } from './claude.mjs';
import { liveSettings, readJson } from './config.mjs';
import { callbackUrl } from './github-app.mjs';
import { owned, plan, probe, realFs, run } from './install.mjs';

const MIN_NODE = 22;
export const CLAUDE_INSTALL_PAGE = 'https://code.claude.com/docs/en/setup';
export const CLAUDE_INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash';
const ok = text => ({ level: 'ok', text });
const warn = (text, fix) => ({ level: 'warn', text, fix });
const fail = (text, fix) => ({ level: 'fail', text, fix });
const skip = text => ({ level: 'skip', text });
const MARK = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

// Node, the claude CLI, its login and its background-session support. `add` records each result.
export async function machineChecks({ add, command, exec = run, env = process.env, platform = process.platform, nodeVersion = process.versions.node, claude }) {
  const major = Number(String(nodeVersion).split('.')[0]);
  add(major >= MIN_NODE ? ok(`Node.js ${nodeVersion}`) : fail(`Node.js ${nodeVersion} is too old (Do-It needs ${MIN_NODE} or newer)`, `Install Node.js ${MIN_NODE}+ from https://nodejs.org/en/download, then run ${command('doctor')} again.`));

  const claudeBin = claude ?? findClaude({ env, platform });
  const version = claudeBin ? await exec(claudeBin, ['--version']) : undefined;
  if (!version?.ok) {
    add(fail('The claude CLI was not found', `Install Claude Code (${CLAUDE_INSTALL_PAGE}; on macOS or Linux: ${CLAUDE_INSTALL_COMMAND}), then run: claude auth login. If it is installed somewhere unusual, pass --claude-bin <full path> to this command.`));
  } else {
    add(ok(`claude CLI: ${version.stdout.split('\n')[0]} (${claudeBin})`));
    const auth = await exec(claudeBin, ['auth', 'status']);
    let loggedIn = auth.ok;
    try { loggedIn = auth.ok && JSON.parse(auth.stdout).loggedIn !== false; } catch { /* plain text: the exit code decides */ }
    add(loggedIn ? ok('claude is signed in') : fail('claude is not signed in', 'Run: claude auth login'));
    const agents = await exec(claudeBin, ['agents', '--json']);
    add(agents.ok ? ok('claude supports background sessions (claude --bg, agents, stop)') : fail('claude does not support background sessions', 'Update Claude Code: run "claude update", or reinstall it from https://claude.com/product/claude-code.'));
  }

  return { claudeBin };
}

// The `do-it <sub>` command for an instance, with the options that select it.
export const commandFor = inst => sub => `do-it ${sub}${inst.name === 'do-it' ? '' : ` --name ${inst.name}${inst.port === 8787 ? '' : ` --port ${inst.port}`}`}`;

export async function doctor(inst, { exec = run, fs = realFs, fetchImpl = fetch, say = console.log, env = process.env, platform = process.platform, nodeVersion = process.versions.node, probeImpl = probe, claude, ...options } = {}) {
  const command = commandFor(inst);
  const results = [];
  const add = result => { results.push(result); say(`  ${MARK[result.level]} ${result.text}`); if (result.fix) say(`      ${result.level === 'fail' ? 'Fix' : 'Note'}: ${result.fix}`); return result; };
  say(`Checking ${inst.name} (settings in ${inst.configDir}, port ${inst.port}):`);

  const { claudeBin } = await machineChecks({ add, command, exec, env, platform, nodeVersion, claude });

  // --- Settings ---
  let config, github, publicUrl;
  try {
    config = readJson(inst.configDir, 'config.json', { required: true });
    github = readJson(inst.configDir, 'github.json', { required: true });
    publicUrl = String(config.publicUrl ?? '').replace(/\/$/, '');
    if (!/^https:\/\/[^/\s?#]+$/.test(publicUrl)) throw new Error('"publicUrl" in config.json must be an https:// address with no path.');
    if (!github.clientId || !github.clientSecret || !Array.isArray(github.allowedLogins) || !github.allowedLogins.length) throw new Error('github.json needs clientId, clientSecret and allowedLogins.');
    add(ok(`Settings: ${publicUrl}, GitHub login(s) ${github.allowedLogins.join(', ')}`));
  } catch (error) {
    add(fail(`Settings are incomplete: ${error.message}`, `Run: ${command('setup')}`));
  }

  if (config) {
    let roots = [];
    try { roots = liveSettings(config).roots; } catch (error) { add(fail(error.message, `Run: ${command('setup')}`)); }
    if (!roots.length) add(fail('No folders are allowed, so every tool refuses', `Run: ${command('add-folder <folder>')}`));
    for (const root of roots) {
      const isDir = (() => { try { return statSync(root).isDirectory(); } catch { return false; } })();
      add(isDir ? ok(`Folder ${root}`) : fail(`Folder ${root} doesn't exist`, `Create it, or run ${command('setup')} to choose another.`));
    }
  }

  // --- The service ---
  let p;
  try { p = plan(inst, { claude: claudeBin ?? 'claude', env, platform, ...options }); } catch (error) { add(fail(error.message, 'See the line above.')); }
  const expected = publicUrl ? `${publicUrl}/mcp` : undefined;
  const resource = await probeImpl(inst.port);
  if (p && platform !== 'win32') {
    const state = await owned(p, { exec, fs });
    const service = await exec(...p.status);
    // launchctl prints a loaded job even when it isn't running; systemctl is unusable without a user session.
    const running = platform === 'linux' ? /ActiveState=active/.test(service.stdout) : service.ok && /^\s*(state = running|pid = \d+)/m.test(service.stdout);
    if (state.exists && state.ours && platform === 'linux' && !service.ok) add(warn(`Couldn't ask systemd about ${inst.name} (${service.stderr || 'no answer'})`, 'Over ssh, run: export XDG_RUNTIME_DIR=/run/user/$(id -u) and try again. The check below shows whether it answers.'));
    else if (state.exists && state.ours && running) add(ok(`Service ${inst.name} is installed and running`));
    else if (state.exists && state.ours) add(fail(`Service ${inst.name} is installed but not running`, `Run: ${command('install')} (it restarts the service), then ${platform === 'linux' ? `journalctl --user -u ${inst.name} -e` : 'check ~/Library/Logs/do-it.log'} for the error.`));
    else if (resource) add(warn(`Do-It is running on port ${inst.port}, but not as a service, so it stops when this terminal closes`, `Run: ${command('install')}`));
    else add(fail(`Service ${inst.name} is not installed`, `Run: ${command('install')}`));
    if (p.linger) {
      const linger = await exec(...p.linger);
      if (linger.ok && linger.stdout === 'no') add(warn(`${inst.name} stops when you log out`, `Run: sudo loginctl enable-linger ${p.linger[1][1]}`));
    }
  }
  if (expected) {
    add(resource === expected ? ok(`Answering on 127.0.0.1:${inst.port}`)
      : resource ? fail(`127.0.0.1:${inst.port} answers as ${resource}, a different Do-It`, `Use another --port, or stop that one. This one should answer as ${expected}.`)
        : fail(`Nothing answers on 127.0.0.1:${inst.port}`, `Run: ${command('install')}, then ${platform === 'linux' ? `journalctl --user -u ${inst.name} -e` : 'check ~/Library/Logs/do-it.log'} for errors.`));
  }

  // --- The public address ---
  let reachable = false;
  if (publicUrl) {
    const get = (url, init) => fetchImpl(url, { signal: AbortSignal.timeout(10_000), ...init });
    try {
      const response = await get(`${publicUrl}/.well-known/oauth-protected-resource`);
      const body = response.ok ? await response.json().catch(() => ({})) : {};
      if (body.resource === expected) { reachable = true; add(ok(`${publicUrl} reaches this Do-It over https`)); }
      else if (response.ok) add(fail(`${publicUrl} answers, but as ${body.resource ?? 'something other than Do-It'}`, `Another server or Do-It instance owns that address. Point your tunnel at 127.0.0.1:${inst.port}, or fix publicUrl in config.json.`));
      else add(fail(`${publicUrl} answered HTTP ${response.status}`, `The tunnel isn't forwarding to Do-It. For Tailscale: tailscale funnel --bg --https=443 http://127.0.0.1:${inst.port}`));
    } catch (error) {
      const code = error.cause?.code ?? error.code ?? error.name;
      add(fail(`${publicUrl} is not reachable (${code})`, `Start your https tunnel and point it at 127.0.0.1:${inst.port}. For Tailscale: tailscale funnel --bg --https=443 http://127.0.0.1:${inst.port} (Funnel must be allowed in your tailnet policy). Then check that publicUrl in config.json is the address it prints.`));
    }
    if (reachable) {
      try {
        const response = await get(`${callbackUrl(publicUrl)}?state=doctor`);
        add(response.status === 400 && /Sign-in expired/.test(await response.text()) ? ok('GitHub sign-in callback path reaches Do-It') : fail(`${callbackUrl(publicUrl)} doesn't reach Do-It`, 'Your tunnel must forward every path, not just /mcp.'));
      } catch (error) { add(fail(`${callbackUrl(publicUrl)} is not reachable (${error.cause?.code ?? error.name})`, 'Your tunnel must forward every path, not just /mcp.')); }
    } else add(skip('GitHub sign-in callback path (not checked: address unreachable)'));

    // A wrong secret is reported by GitHub as incorrect_client_credentials; with a right one a made-up code is just a bad code.
    if (github?.clientId && github?.clientSecret) {
      try {
        const response = await get('https://github.com/login/oauth/access_token', {
          method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: github.clientId, client_secret: github.clientSecret, code: 'do-it-doctor-check' }),
        });
        const { error } = await response.json().catch(() => ({}));
        if (response.status === 404) add(fail("GitHub doesn't recognise the client ID in github.json", `Copy the client ID from your GitHub app's settings page, then run ${command('setup')}.`));
        else if (error === 'bad_verification_code') add(ok('GitHub accepts the app\'s client ID and secret'));
        else if (error === 'incorrect_client_credentials') add(fail('GitHub rejects the client ID or secret in github.json', `Copy them again from your GitHub app's settings (a new client secret is fine), then run ${command('setup')}.`));
        else add(warn(`Couldn't confirm the client ID and secret with GitHub (${error ?? 'no answer'})`));
      } catch { add(warn("Couldn't reach github.com to confirm the client ID and secret")); }
    }
  }

  const failed = results.filter(r => r.level === 'fail').length;
  const warned = results.filter(r => r.level === 'warn').length;
  if (!failed && publicUrl) {
    say(`\nAll set${warned ? ` (${warned} note${warned === 1 ? '' : 's'} above)` : ''}. In claude.ai, go to Settings → Connectors → Add custom connector and enter:\n  ${expected}`);
    say(`Then sign in with GitHub. The GitHub app's Callback URL must be exactly:\n  ${callbackUrl(publicUrl)}`);
  } else say(`\n${failed} problem${failed === 1 ? '' : 's'} to fix. Run ${command('doctor')} again afterwards.`);
  return { ok: failed === 0, results };
}
