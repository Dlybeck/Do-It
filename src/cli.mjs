// `do-it add-folder`, and the terminal prompt that `do-it setup` and `do-it install` ask through.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { readJson, writeJson } from './config.mjs';
import { existingRoot, inside } from './paths.mjs';

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

// A terminal asker that hides what is typed for secrets. Lines are queued, so piped
// answers that arrive before their question are not lost.
export function terminalAsker(input = process.stdin, output = process.stdout, { onInterrupt = () => process.exit(130) } = {}) {
  let muted = false;
  const sink = new Writable({ write(chunk, encoding, done) { if (!muted) output.write(chunk, encoding); done(); } });
  const rl = createInterface({ input, output: sink, terminal: Boolean(input.isTTY) });
  // In a terminal readline swallows Ctrl+C unless told otherwise, which would leave a long wait running.
  rl.on('SIGINT', () => { output.write('\n'); onInterrupt(); });
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
