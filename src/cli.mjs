// `do-it setup` and `do-it add-folder`: write config.json and github.json for you.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { PUBLIC_URL, readJson, writeJson } from './config.mjs';
import { existingRoot, inside } from './paths.mjs';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const list = text => String(text ?? '').split(',').map(s => s.trim()).filter(Boolean);

// Adds a folder to allowedRoots (moving an old trustedRoots list over) and returns the new list.
export function addFolder(configDir, folder) {
  const root = existingRoot(folder);
  const config = readJson(configDir, 'config.json');
  const roots = config.allowedRoots ?? config.trustedRoots ?? [];
  if (!Array.isArray(roots)) throw new Error('"allowedRoots" in config.json must be a list of folders.');
  const next = roots.some(r => inside(r, root) && inside(root, r)) ? roots : [...roots, root];
  delete config.trustedRoots;
  writeJson(configDir, 'config.json', { ...config, allowedRoots: next });
  return next;
}

// Asks for everything Do-It needs and writes both files. `ask(question, { secret })` returns
// the answer; an empty answer keeps the value shown in brackets.
export async function runSetup({ configDir, ask, say = console.log }) {
  const config = readJson(configDir, 'config.json');
  const github = readJson(configDir, 'github.json');
  const question = async (label, current, check, options = {}) => {
    for (;;) {
      const shown = current ? (options.secret ? ' [keep current]' : ` [${current}]`) : '';
      const answer = (await ask(`${label}${shown}: `, options)).trim() || current || '';
      try { return check(answer); } catch (error) { say(`  ${error.message}`); }
    }
  };

  say(`Do-It setup. Settings go in ${configDir}.\n`);
  const roots = await question('Folders Do-It may use (absolute paths, comma-separated)',
    (config.allowedRoots ?? config.trustedRoots ?? []).join(', '),
    answer => { const r = list(answer).map(existingRoot); if (!r.length) throw new Error('Give at least one folder.'); return r; });
  const logins = await question('GitHub login(s) allowed to sign in (comma-separated)',
    (github.allowedLogins ?? []).join(', '),
    answer => { const l = list(answer); if (!l.length || !l.every(x => LOGIN.test(x))) throw new Error('Give GitHub logins like octocat.'); return l; });
  const publicUrl = await question('Public https address of this server (no path)', config.publicUrl,
    answer => { const u = answer.replace(/\/$/, ''); if (!PUBLIC_URL.test(u)) throw new Error('Use an https:// address with no path, e.g. https://your-host.example.ts.net'); return u; });

  say(`\nCreate a GitHub OAuth App at https://github.com/settings/developers ("New OAuth App"):`);
  say(`  Homepage URL:               ${publicUrl}`);
  say(`  Authorization callback URL: ${publicUrl}/oauth/github/callback`);
  say('Then generate a client secret.\n');
  const clientId = await question('OAuth app client ID', github.clientId,
    answer => { if (!/^[A-Za-z0-9._-]{4,}$/.test(answer)) throw new Error('That does not look like a client ID.'); return answer; });
  const clientSecret = await question('OAuth app client secret', github.clientSecret,
    answer => { if (!/^[A-Za-z0-9._-]{8,}$/.test(answer)) throw new Error('That does not look like a client secret.'); return answer; }, { secret: true });

  delete config.trustedRoots;
  writeJson(configDir, 'config.json', { ...config, publicUrl, allowedRoots: roots });
  writeJson(configDir, 'github.json', { ...github, clientId, clientSecret, allowedLogins: logins });
  say(`\nWrote config.json and github.json (readable only by you).`);
  say(`Connector URL for claude.ai: ${publicUrl}/mcp`);
  return { publicUrl, roots, logins };
}

// A terminal asker that hides what is typed for secrets. Lines are queued, so piped
// answers that arrive before their question are not lost.
export function terminalAsker(input = process.stdin, output = process.stdout) {
  let muted = false;
  const sink = new Writable({ write(chunk, encoding, done) { if (!muted) output.write(chunk, encoding); done(); } });
  const rl = createInterface({ input, output: sink, terminal: Boolean(input.isTTY) });
  const lines = [];
  const waiting = [];
  let closed = false;
  rl.on('line', line => (waiting.length ? waiting.shift().resolve(line) : lines.push(line)));
  rl.on('close', () => { closed = true; while (waiting.length) waiting.shift().reject(new Error('Setup stopped: no more input.')); });
  const ask = async (prompt, { secret = false } = {}) => {
    output.write(prompt);
    muted = secret;
    try {
      if (lines.length) return lines.shift();
      if (closed) throw new Error('Setup stopped: no more input.');
      return await new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    } finally { muted = false; if (secret || !input.isTTY) output.write('\n'); }
  };
  return { ask, close: () => rl.close() };
}
