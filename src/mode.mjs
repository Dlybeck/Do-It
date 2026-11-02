// The permission mode a session last ran in, from its transcript. The SDK doesn't expose
// it, so this reads the newest "permissionMode" in the tail of the session's .jsonl file.
// Returns undefined when unknown.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TAIL = 1 << 20;

export function savedPermissionMode(sessionId, { env = process.env } = {}) {
  const projects = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), 'projects');
  let dirs;
  try { dirs = readdirSync(projects); } catch { return undefined; }
  for (const dir of dirs) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    let size;
    try { size = statSync(file).size; } catch { continue; }
    const fd = openSync(file, 'r');
    try {
      const length = Math.min(size, TAIL);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const modes = [...buffer.toString('utf8').matchAll(/"permissionMode":"([A-Za-z]+)"/g)];
      return modes.at(-1)?.[1];
    } finally { closeSync(fd); }
  }
  return undefined;
}
