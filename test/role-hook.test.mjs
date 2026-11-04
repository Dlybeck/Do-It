// The role-context hook, run as Claude Code runs it (a child process fed hook JSON on stdin),
// and the registry of driven turns (src/driving.mjs) that Do-It writes and the hook claims.
// Everything lives in temporary folders; nothing touches real settings, state or ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Driving, MAX_AGE_MS } from '../src/driving.mjs';
import { Sessions } from '../src/sessions.mjs';

const HOOK = fileURLToPath(new URL('../hooks/role-context.mjs', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../examples/role.example.md', import.meta.url));
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'do-it-role-')));
const ROLE = path.join(scratch, 'role.md');
writeFileSync(ROLE, '﻿\n  Act as the release reviewer.\n');
const EMPTY = path.join(scratch, 'empty.md');
writeFileSync(EMPTY, ' \n\t\n');
const MISSING = path.join(scratch, 'missing.md');

let n = 0;
const newId = () => `0000000${(++n).toString(16)}`.slice(-8) + '-1111-4222-8333-444444444444';
// A fresh state folder per test, as DO_IT_STATE_DIR.
function state() {
  const dir = mkdtempSync(path.join(scratch, 'state-'));
  return { dir, driving: new Driving({ dir: path.join(dir, 'driving') }) };
}
const input = sessionId => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, cwd: scratch, prompt: 'hi' });
const hookEnv = (stateDir, extra = {}) => ({ PATH: process.env.PATH, HOME: scratch, USERPROFILE: scratch, DO_IT_STATE_DIR: stateDir, DO_IT_CONFIG_DIR: path.join(scratch, 'no-config'), ...extra });

// Runs the hook like Claude Code does. Returns stdout; throws if it exits non-zero.
function hook({ stdin, stateDir, args = [ROLE], env = {} }) {
  return execFileSync(process.execPath, [HOOK, ...args], { input: stdin, env: hookEnv(stateDir, env), encoding: 'utf8' });
}
const context = out => JSON.parse(out).hookSpecificOutput;

// --- the hook ---

test('a chat that is not on the list gets nothing, even with a role file', () => {
  const { dir, driving } = state();
  assert.equal(hook({ stdin: input(newId()), stateDir: dir }), ''); // no state folder at all
  driving.add(newId());
  assert.equal(hook({ stdin: input(newId()), stateDir: dir }), ''); // a different chat is listed
});

test('a listed chat gets the role as UserPromptSubmit additionalContext, once', () => {
  const { dir, driving } = state();
  const id = newId();
  driving.add(id);
  assert.deepEqual(context(hook({ stdin: input(id), stateDir: dir })), { hookEventName: 'UserPromptSubmit', additionalContext: 'Act as the release reviewer.' });
  assert.equal(existsSync(driving.file(id)), false, 'the entry is claimed');
  assert.equal(hook({ stdin: input(id), stateDir: dir }), '', 'a later prompt in the same chat (the owner typing) gets nothing');
});

test('a listed chat with a missing or empty role file gets nothing, and the hook exits 0', () => {
  const { dir, driving } = state();
  for (const file of [MISSING, EMPTY, scratch]) {
    const id = newId();
    driving.add(id);
    assert.equal(hook({ stdin: input(id), stateDir: dir, args: [file] }), '');
  }
});

test('a missing, broken or unreadable list or hook input gives nothing, and the hook exits 0', () => {
  const { dir, driving } = state();
  const id = newId();
  driving.add(id);
  for (const stdin of ['', 'not json', '[]', '{}', JSON.stringify({ session_id: 42 }), JSON.stringify({ session_id: '../../etc/passwd' })]) {
    assert.equal(hook({ stdin, stateDir: dir }), '');
  }
  const broken = path.join(scratch, 'broken-state');
  writeFileSync(broken, 'a file where the state folder should be');
  assert.equal(hook({ stdin: input(id), stateDir: broken }), '');
  assert.equal(hook({ stdin: input(id), stateDir: path.join(scratch, 'no-such-folder') }), '');
});

test('with no path argument the hook reads role.md from the Do-It config folder', () => {
  const { dir, driving } = state();
  const configDir = path.join(scratch, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'role.md'), 'Default role.');
  const id = newId();
  driving.add(id);
  assert.equal(context(hook({ stdin: input(id), stateDir: dir, args: [], env: { DO_IT_CONFIG_DIR: configDir } })).additionalContext, 'Default role.');
});

test('the shipped example role file is generic placeholder text that the hook passes through', () => {
  const { dir, driving } = state();
  const id = newId();
  driving.add(id);
  const example = readFileSync(EXAMPLE, 'utf8').trim();
  assert.ok(example.length > 0);
  assert.equal(context(hook({ stdin: input(id), stateDir: dir, args: [EXAMPLE] })).additionalContext, example);
});

test('when hooks race for one entry, exactly one of them gets the role', async () => {
  const { dir, driving } = state();
  const id = newId();
  driving.add(id);
  const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK, ROLE], { env: hookEnv(dir) }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(input(id));
  })));
  assert.equal(outs.filter(Boolean).length, 1);
});

// --- the list ---

test('entries past the age limit are ignored, pruned on add, and cleared on startup', () => {
  const { driving } = state();
  const old = newId();
  const stale = newId();
  driving.add(old);
  driving.add(stale);
  const past = (Date.now() - MAX_AGE_MS - 60_000) / 1000;
  utimesSync(driving.file(old), past, past);
  assert.equal(driving.claim(old), false, 'too old to count, and removed');
  assert.equal(existsSync(driving.file(old)), false);
  utimesSync(driving.file(stale), past, past);
  const fresh = newId();
  driving.add(fresh);
  assert.deepEqual(readdirSync(driving.dir), [path.basename(driving.file(fresh))], 'adding prunes old entries');
  driving.clear();
  assert.deepEqual(readdirSync(driving.dir), []);
});

test('a hook that finds its chat unlisted waits for it only while Do-It is starting a chat', async () => {
  const { dir, driving } = state();
  const run = () => new Promise((resolve, reject) => {
    const id = newId();
    const t0 = Date.now();
    const child = execFile(process.execPath, [HOOK, ROLE], { env: hookEnv(dir) }, (error, stdout) => (error ? reject(error) : resolve({ id, stdout, ms: Date.now() - t0 })));
    child.stdin.end(input(id));
  });
  // Do-It is starting a chat and learns its id 400 ms after the hook fires: the hook waits for it.
  const token = driving.beginStart();
  const id = newId();
  const t0 = Date.now();
  const late = new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [HOOK, ROLE], { env: hookEnv(dir) }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(input(id));
  });
  setTimeout(() => { driving.add(id); driving.endStart(token); }, 400);
  assert.equal(context(await late).additionalContext, 'Act as the release reviewer.');
  assert.ok(Date.now() - t0 >= 400);
  // With no start in progress, an unlisted chat gets nothing straight away.
  const quick = await run();
  assert.equal(quick.stdout, '');
  assert.ok(quick.ms < 1500, `took ${quick.ms} ms`);
});

test('an unlisted chat waits at most the limit during a start, then gets nothing; stale starting marks are ignored', async () => {
  const { driving } = state();
  const token = driving.beginStart();
  const t0 = Date.now();
  assert.equal(await driving.claimWhenListed(newId(), { waitMs: 300, stepMs: 20 }), false);
  assert.ok(Date.now() - t0 >= 300);
  const past = (Date.now() - 3 * 60_000) / 1000;
  utimesSync(token, past, past);
  assert.equal(driving.starting(), false);
  driving.add(newId()); // prunes the stale mark
  assert.equal(existsSync(token), false);
});

test('the list only accepts session ids as names', () => {
  const { driving } = state();
  assert.throws(() => driving.add('../escape'), /Not a session id/);
  assert.equal(driving.file('ABCDEF01-1111-4222-8333-444444444444'), driving.file('abcdef01'), 'keyed by the short id claude --bg prints');
  assert.equal(driving.claim('../escape'), false);
  assert.equal(driving.claim(undefined), false);
  driving.remove('../escape'); // ignored
});

// --- what Do-It writes ---

function fakeCli({ fail = false } = {}) {
  const app = mkdtempSync(path.join(scratch, 'app-'));
  const OLD = 'cccccccc-1111-4222-8333-444444444444';
  const BG = 'aaaaaaaa-1111-4222-8333-444444444444';
  const live = [{ pid: 10, id: 'aaaaaaaa', sessionId: BG, cwd: app, kind: 'background', status: 'idle' }];
  const { driving } = state();
  const seen = [];
  const NEW = 'eeeeeeee-1111-4222-8333-444444444444'; // claude --bg picks a new chat's id itself
  const run = async args => {
    if (args[0] === 'agents') {
      // By the time Do-It first asks claude about a chat it started, that chat must be listed.
      for (const s of seen) s.listedBeforePolling ??= existsSync(driving.file(s.id));
      return { ok: true, stdout: JSON.stringify(live), stderr: '' };
    }
    if (args[0] === 'stop') { const a = live.find(x => x.id === args[1]); if (a) delete a.pid; return { ok: true, stdout: 'stopped', stderr: '' }; }
    const id = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : NEW;
    seen.push({ id, listedWhenRun: existsSync(driving.file(id)), startingWhenRun: driving.starting() });
    if (fail) return { ok: false, stdout: '', stderr: 'boom' };
    live.push({ pid: 13, id: id.slice(0, 8), sessionId: id, cwd: app, kind: 'background', status: 'busy' });
    return { ok: true, stdout: `backgrounded · ${id.slice(0, 8)} · job`, stderr: '' };
  };
  const sessions = new Sessions({
    roots: [app], run, driving, trust: { ensure: async () => true },
    sdk: { listSessions: async () => [{ sessionId: OLD, cwd: app }, { sessionId: BG, cwd: app }], getSessionMessages: async () => [] },
  });
  return { sessions, driving, seen, app, OLD, BG };
}

test('Do-It lists a continued chat before claude runs, and a new chat as soon as claude names it', async () => {
  const { sessions, driving, seen, app, OLD } = fakeCli();
  const started = await sessions.start({ cwd: app, prompt: 'hello' });
  await sessions.send(OLD, 'continue');
  assert.deepEqual(seen.map(({ id, listedWhenRun, startingWhenRun, listedBeforePolling }) => ({ id, listedWhenRun, startingWhenRun, listedBeforePolling })), [
    { id: started.sessionId, listedWhenRun: false, startingWhenRun: true, listedBeforePolling: true },
    { id: OLD, listedWhenRun: true, startingWhenRun: true, listedBeforePolling: true },
  ]);
  assert.equal(driving.starting(), false, 'the starting mark is cleared once claude has answered');
  // Nothing claims them here (no hook ran), so both are still listed until claimed or pruned.
  assert.equal(driving.claim(started.sessionId), true);
  assert.equal(driving.claim(OLD), true);
});

test('Do-It takes a chat off the list when it stops it, or when its turn never started', async () => {
  const { sessions, driving, BG } = fakeCli();
  driving.add(BG);
  await sessions.stop(BG);
  assert.equal(existsSync(driving.file(BG)), false);

  const failing = fakeCli({ fail: true });
  await assert.rejects(failing.sessions.start({ cwd: failing.app, prompt: 'hello' }), /did not start the session/);
  await assert.rejects(failing.sessions.send(failing.OLD, 'continue'), /did not start the session/);
  assert.equal(failing.seen[1].listedWhenRun, true);
  assert.deepEqual(readdirSync(failing.driving.dir), [], 'no entries and no starting mark are left behind');
});
