// The chats Do-It is driving right now, shared with hooks/role-context.mjs. Node built-ins only,
// because the hook imports it too.
//
// One empty file per driven turn in <state dir>/driving/, named by the session's short id (the
// first 8 characters of its UUID, which is also the id `claude --bg` prints). The hook claims
// the entry (deletes it) when that turn's prompt arrives, so it covers exactly one Do-It turn;
// a later prompt the owner types into the same chat gets nothing. One file per entry means no
// shared file to lock: an add is a write to a temporary name plus a rename, and a claim is an
// unlink, which only one caller can win.
//
// `claude --bg` picks a new chat's id itself and only reports it as the chat starts, so its
// first prompt can reach the hook before Do-It has listed it. While Do-It is starting a turn it
// keeps a "pending" file here; a hook that finds its chat unlisted waits briefly, but only while
// a fresh pending file exists, for the entry to appear.
//
// Leftovers (a chat that never ran the hook, or a Do-It crash) are ignored once older than
// their age limit, pruned on every add, and cleared when Do-It starts.
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_AGE_MS = 10 * 60_000; // from Do-It starting a turn to that turn's prompt hook
export const PENDING_MAX_MS = 2 * 60_000; // longer than one `claude --bg` call (60 s timeout)
export const WAIT_MS = 5_000; // how long the hook waits for its entry while a start is pending
const SESSION = /^([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;
const PENDING = 'pending-';

export function stateDir(env = process.env) {
  return env.DO_IT_STATE_DIR ?? path.join(homedir(), '.local', 'state', 'do-it');
}

const age = file => Date.now() - statSync(file).mtimeMs;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Driving {
  constructor({ dir = path.join(stateDir(), 'driving'), maxAge = MAX_AGE_MS, pendingMaxAge = PENDING_MAX_MS } = {}) {
    this.dir = dir;
    this.maxAge = maxAge;
    this.pendingMaxAge = pendingMaxAge;
  }

  // The entry file for a session UUID or short id, or undefined for anything else.
  file(sessionId) {
    const short = typeof sessionId === 'string' && sessionId.match(SESSION)?.[1];
    return short ? path.join(this.dir, short.toLowerCase()) : undefined;
  }

  add(sessionId) {
    const file = this.file(sessionId);
    if (!file) throw new Error(`Not a session id: ${sessionId}`);
    this.write(file);
    this.prune();
  }

  remove(sessionId) {
    const file = this.file(sessionId);
    if (file) unlinkQuietly(file);
  }

  // Marks a turn as starting; pass the result to endStart once the chat's id is listed.
  beginStart() {
    const file = path.join(this.dir, `${PENDING}${randomBytes(6).toString('hex')}`);
    this.write(file);
    return file;
  }

  endStart(token) {
    if (typeof token === 'string' && path.basename(token).startsWith(PENDING)) unlinkQuietly(token);
  }

  starting() {
    try {
      return readdirSync(this.dir).some(name => name.startsWith(PENDING) && !name.endsWith('.tmp') && age(path.join(this.dir, name)) <= this.pendingMaxAge);
    } catch { return false; }
  }

  // True exactly once for a fresh entry, which it deletes. Never throws.
  claim(sessionId) {
    const file = this.file(sessionId);
    if (!file) return false;
    let stats;
    try { stats = statSync(file); unlinkSync(file); } catch { return false; }
    return stats.isFile() && Date.now() - stats.mtimeMs <= this.maxAge;
  }

  // claim(), but while Do-It is starting a turn, keeps trying for up to waitMs. Never throws.
  async claimWhenListed(sessionId, { waitMs = WAIT_MS, stepMs = 100 } = {}) {
    if (!this.file(sessionId)) return false;
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (this.claim(sessionId)) return true;
      if (Date.now() >= deadline || !this.starting()) return false;
      await sleep(stepMs);
    }
  }

  // Drops entries, pending marks and stray temporary files past their age limit; `all` drops everything.
  prune({ all = false } = {}) {
    let names;
    try { names = readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const file = path.join(this.dir, name);
      const limit = name.startsWith(PENDING) && !name.endsWith('.tmp') ? this.pendingMaxAge : this.maxAge;
      try { if (all || age(file) > limit) unlinkSync(file); } catch { /* already gone */ }
    }
  }

  clear() { this.prune({ all: true }); }

  write(file) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, '', { mode: 0o600 });
    renameSync(tmp, file);
  }
}

function unlinkQuietly(file) {
  try { unlinkSync(file); } catch { /* already gone */ }
}
