// The permission mode a session last ran in, from its transcript. The SDK doesn't expose
// it, so this finds the newest "permissionMode" record in the session's .jsonl file,
// reading backwards from the end in chunks so a long tail of tool output can't hide it.
// Returns undefined when unknown.
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const CHUNK = 1 << 20;
const RECORD = /"permissionMode":"([A-Za-z]+)"/g;
// Longer than any record, so one split across two chunks is still seen whole in one of them.
const OVERLAP = 64;

export function savedPermissionMode(sessionId, { env = process.env, chunk = CHUNK } = {}) {
  const projects = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude'), 'projects');
  let dirs;
  try { dirs = readdirSync(projects); } catch { return undefined; }
  for (const dir of dirs) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    let size;
    try { size = statSync(file).size; } catch { continue; }
    return newestMode(file, size, chunk);
  }
  return undefined;
}

function newestMode(file, size, chunk) {
  const fd = openSync(file, 'r');
  try {
    for (let end = size; end > 0; end -= chunk) {
      const start = Math.max(0, end - chunk - OVERLAP);
      const buffer = Buffer.alloc(Math.min(size, end + OVERLAP) - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const found = [...buffer.toString('utf8').matchAll(RECORD)].at(-1);
      if (found) return found[1];
    }
    return undefined;
  } finally { closeSync(fd); }
}
