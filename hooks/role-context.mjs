#!/usr/bin/env node
// role-context: a Claude Code UserPromptSubmit hook that adds standing context (a role, or
// any text you choose) to the prompts Do-It sends, and to nothing else. Do-It registers each turn
// it starts or continues in its state folder (src/driving.mjs); this hook adds the role only
// when the prompt's session_id is registered, and claims the entry so it applies once. A chat
// you open or type into yourself is never registered, so there the hook does nothing.
//
// Plain Node with no dependencies, so the same command works on Linux, macOS and Windows.
// It never fails a prompt: on any problem it prints nothing and exits 0. It only ever pauses
// a prompt (at most a few seconds) while Do-It is in the middle of starting a chat.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Driving } from '../src/driving.mjs';

// Where the role text is read from: a path given after the script in the hook command, else
// role.md in Do-It's config folder (DO_IT_CONFIG_DIR, default ~/.config/do-it).
export function roleFile(argv, env = process.env) {
  if (argv[0]) return path.resolve(argv[0]);
  return path.join(env.DO_IT_CONFIG_DIR ?? path.join(homedir(), '.config', 'do-it'), 'role.md');
}

// The hook's stdout for one prompt: the JSON to print, or '' to add nothing.
export async function roleContext({ input, file, driving = new Driving(), wait }) {
  let sessionId;
  try { sessionId = JSON.parse(input)?.session_id; } catch { return ''; }
  if (!(await driving.claimWhenListed(sessionId, wait))) return '';
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return ''; }
  text = text.replace(/^\uFEFF/, '').trim();
  if (!text) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } });
}

function readStdin(timeoutMs = 2000, max = 1 << 20) {
  return new Promise(resolve => {
    let data = '';
    const done = () => { clearTimeout(timer); resolve(data); };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; if (data.length > max) { data = ''; done(); } });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main() {
  let out = '';
  try { out = await roleContext({ input: await readStdin(), file: roleFile(process.argv.slice(2)) }); } catch { out = ''; }
  if (out) process.stdout.write(out + '\n', () => process.exit(0));
  else process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => process.exit(0));
}
