// Finding the claude CLI to run, without a shell.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The first existing file named one of names in env.PATH.
export function findOnPath(names, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) for (const name of names) {
    const candidate = impl.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

// The claude executable: DO_IT_CLAUDE_BIN if set, else the first claude on PATH.
export function findClaude(options = {}) {
  const { env = process.env, platform = process.platform } = options;
  if (env.DO_IT_CLAUDE_BIN) return env.DO_IT_CLAUDE_BIN;
  return findOnPath(platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'], options);
}

// How to run claude without a shell. Node can't run a .cmd/.bat without one, and a shell would
// let prompt text be interpreted, so an npm claude.cmd shim is read to find the script (or
// .exe) it wraps, which is then run directly. Returns { file, prefix } or throws.
export function claudeCommand({ bin, node = process.execPath, platform = process.platform, readFile = f => readFileSync(f, 'utf8'), exists = existsSync, ...options } = {}) {
  const target = bin ?? findClaude({ platform, exists, ...options }) ?? 'claude';
  if (/\.(?:c|m)?js$/i.test(target)) return { file: node, prefix: [target] };
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(target)) return { file: target, prefix: [] };
  let shim;
  try { shim = readFile(target); } catch { throw new Error(`Could not read ${target}. Set DO_IT_CLAUDE_BIN to claude.exe or to the CLI's .js file.`); }
  // npm's shim first checks for "%dp0%\node.exe" (the interpreter), then runs the CLI script;
  // take the last referenced file that isn't node.exe.
  const wrapped = [...shim.matchAll(/"%~?dp0%?\\([^"%]+\.(?:c?js|mjs|exe))"/gi)].map(m => m[1]).filter(f => !/(^|\\)node\.exe$/i.test(f)).at(-1);
  const resolved = wrapped && path.win32.join(path.win32.dirname(target), wrapped);
  if (!resolved || !exists(resolved)) throw new Error(`Can't run ${target} without a shell. Set DO_IT_CLAUDE_BIN to claude.exe or to the CLI's .js file.`);
  return /\.exe$/i.test(resolved) ? { file: resolved, prefix: [] } : { file: node, prefix: [resolved] };
}
