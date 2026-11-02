// Claude Code session control through the owner's own `claude` CLI (background
// sessions) plus the Agent SDK's read-only transcript helpers. Every tool is scoped
// to the folders in the allowlist; with no allowlist, nothing is reachable.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { claudeCommand } from './claude.mjs';
import { Driving } from './driving.mjs';
import { allowedRoot, canonical, inside } from './paths.mjs';
import { savedPermissionMode } from './mode.mjs';
import { Trust } from './trust.mjs';

export const PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'plan', 'default'];
// A full session UUID, or the first 8+ characters of one (background ids are the first 8).
export const SESSION_ID = /^[0-9a-f]{8}(?:[0-9a-f-]{0,28})$/i;
export class UserError extends Error {}

// Spawned sessions must use the CLI's own login, not a parent Claude process's
// host-provided auth, so drop inherited Claude session variables.
export function cleanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) =>
    k === 'CLAUDE_CONFIG_DIR' || !/^(CLAUDE|ANTHROPIC_BASE_URL$|AI_AGENT$)/.test(k)));
}

export function runClaude(args, { cwd = process.env.HOME, timeout = 60_000 } = {}) {
  let command;
  try { command = claudeCommand({ bin: process.env.DO_IT_CLAUDE_BIN }); }
  catch (error) { return Promise.resolve({ ok: false, stdout: '', stderr: error.message }); }
  return new Promise(resolve => {
    // No shell: arguments, including prompt text, reach claude exactly as given.
    execFile(command.file, [...command.prefix, ...args], { cwd, env: cleanEnv(), timeout, maxBuffer: 4 << 20, shell: false },
      (error, stdout, stderr) => {
        // execFile reports a missing working folder and a missing binary the same way.
        const missing = error?.code !== 'ENOENT' ? '' : existsSync(cwd) ? 'The claude CLI was not found on PATH (set DO_IT_CLAUDE_BIN).' : `The folder ${cwd} no longer exists.`;
        resolve({ ok: !error, stdout: String(stdout ?? '').trim(), stderr: missing || String(stderr ?? '').trim() });
      });
  });
}

const iso = ms => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more chars]` : text);
const short = id => String(id).slice(0, 8);

export class Sessions {
  // `driving` records the turns Do-It starts, for hooks/role-context.mjs (see src/driving.mjs).
  constructor({ roots = [], allowBypassPermissions = false, run = runClaude, sdk = { listSessions, getSessionMessages }, trust, savedMode = savedPermissionMode, driving = new Driving() } = {}) {
    this.run = run;
    this.savedMode = savedMode;
    this.sdk = sdk;
    this.ownTrust = !trust;
    this.trust = trust;
    this.driving = driving;
    this.lines = new Map();
    this.configure({ roots, allowBypassPermissions });
  }

  // Applies the settings that may change while running (config.json is re-read on change).
  configure({ roots = [], allowBypassPermissions = false } = {}) {
    const checked = roots.map(r => allowedRoot(r));
    this.roots = checked;
    this.allowBypassPermissions = allowBypassPermissions === true;
    if (this.ownTrust) this.trust = new Trust({ roots: checked });
  }

  allowed(dir) {
    return typeof dir === 'string' && path.isAbsolute(dir) && this.roots.some(r => inside(r, canonical(dir)));
  }

  requireRoots() {
    if (!this.roots.length) throw new UserError('No folders are allowed yet. Run "do-it add-folder <path>" or add absolute folders to "allowedRoots" in Do-It\'s config.json.');
  }

  // Running interactive and background sessions (those with a live process), keyed by full session id.
  async live() {
    const { ok, stdout, stderr } = await this.run(['agents', '--json']);
    if (!ok) throw new UserError(`Couldn't list running Claude Code sessions: ${stderr || stdout || 'claude agents failed'}`);
    let list;
    try { list = JSON.parse(stdout || '[]'); } catch { throw new UserError("Couldn't read the output of claude agents --json."); }
    // Entries without a sessionId (a process still starting) can't be addressed; background
    // entries without a job id can't be stopped, so treat them as interactive.
    return new Map(list.filter(a => a?.pid && typeof a.sessionId === 'string')
      .map(a => [a.sessionId, a.kind === 'background' && !a.id ? { ...a, kind: 'interactive' } : a]));
  }

  async list({ cwd, limit = 20 } = {}) {
    this.requireRoots();
    if (cwd !== undefined) {
      if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new UserError('cwd must be an absolute path.');
      if (!this.allowed(cwd)) throw new UserError(`${cwd} is outside the allowed folders.`);
      cwd = canonical(cwd);
    }
    const wanted = dir => this.allowed(dir) && (!cwd || inside(cwd, canonical(dir)));
    const [live, all] = await Promise.all([this.live(), this.sdk.listSessions({})]);
    const rows = all.filter(s => wanted(s.cwd)).map(s => {
      const a = live.get(s.sessionId);
      return {
        sessionId: s.sessionId,
        title: s.customTitle ?? s.summary,
        cwd: s.cwd,
        status: a ? a.status : 'not running',
        waitingFor: a?.waitingFor,
        kind: a?.kind,
        lastActivity: iso(s.lastModified),
        modified: s.lastModified,
      };
    });
    // Live sessions that have not written a transcript yet.
    for (const a of live.values()) {
      if (rows.some(r => r.sessionId === a.sessionId) || !wanted(a.cwd)) continue;
      rows.unshift({ sessionId: a.sessionId, title: a.name, cwd: a.cwd, status: a.status, kind: a.kind, lastActivity: iso(a.startedAt) });
    }
    const page = rows.slice(0, limit);
    await mapLimit(page, 4, async r => {
      const line = await this.latestLine(r.sessionId, r.cwd, r.modified);
      r.statusLine = [r.waitingFor && `[waiting: ${r.waitingFor}]`, line].filter(Boolean).join(' ') || undefined;
      delete r.modified;
    });
    return page;
  }

  // Opening sentence of the session's newest assistant text, cached until the transcript changes.
  async latestLine(sessionId, cwd, modified) {
    const cached = this.lines.get(sessionId);
    if (cached && modified !== undefined && cached.modified === modified) return cached.line;
    let line;
    try {
      const messages = await this.sdk.getSessionMessages(sessionId, cwd ? { dir: cwd } : {});
      for (let i = messages.length - 1; i >= 0 && !line; i--) {
        if (messages[i].type === 'assistant') line = openingSentence(renderMessage(messages[i]).replace(/\[tool: [^\]]+\]/g, ''));
      }
    } catch { /* unreadable transcript: no status line */ }
    if (modified !== undefined) this.lines.set(sessionId, { modified, line });
    return line;
  }

  // Finds exactly one session in the allowed folders for a full id or prefix.
  async resolve(id) {
    this.requireRoots();
    if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new UserError('sessionId must be a session UUID from list_sessions, or at least its first 8 characters.');
    const prefix = id.toLowerCase();
    const live = await this.live();
    const found = new Map();
    for (const a of live.values()) if (a.sessionId.toLowerCase().startsWith(prefix)) found.set(a.sessionId, a.cwd);
    for (const s of await this.sdk.listSessions({})) if (s.sessionId.toLowerCase().startsWith(prefix)) found.set(s.sessionId, s.cwd);
    const matches = [...found].filter(([, cwd]) => this.allowed(cwd));
    if (matches.length === 0) throw new UserError(`No session in the allowed folders matches ${id}.`);
    if (matches.length > 1) throw new UserError(`${id} matches ${matches.length} sessions; use more characters of the session id.`);
    const [sessionId, cwd] = matches[0];
    return { sessionId, cwd, live: live.get(sessionId) };
  }

  async read(id, { limit = 10, maxChars = 12_000 } = {}) {
    const { sessionId, cwd, live } = await this.resolve(id);
    const messages = await this.sdk.getSessionMessages(sessionId, cwd ? { dir: cwd } : {});
    const rendered = [];
    let budget = maxChars;
    // Walk back from the newest entry, skipping tool-result-only entries, until `limit` messages are collected.
    for (let i = messages.length - 1; i >= 0 && rendered.length < limit; i--) {
      const m = messages[i];
      const text = renderMessage(m);
      if (!text) continue;
      const piece = clip(text, Math.max(200, Math.min(budget, 4000)));
      rendered.unshift({ role: m.type, text: piece });
      budget -= piece.length;
      if (budget <= 0) break;
    }
    return { sessionId, cwd, status: live ? live.status : 'not running', totalMessages: messages.length, messages: rendered };
  }

  // bypassPermissions skips every permission check, so it needs an explicit opt-in.
  checkMode(permissionMode) {
    if (permissionMode === 'bypassPermissions' && !this.allowBypassPermissions) {
      throw new UserError('bypassPermissions is turned off. Set "allowBypassPermissions": true in Do-It\'s config.json to allow it, or use auto.');
    }
  }

  async start({ cwd, prompt, name, permissionMode = 'auto' }) {
    this.requireRoots();
    this.checkMode(permissionMode);
    const dir = await this.allowedDirectory(cwd);
    prompt = requireText(prompt, 'prompt');
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || /[\x00-\x1f\x7f]/.test(name))) throw new UserError('name must be printable text.');
    await this.trust.ensure(dir);
    const args = ['--bg', '--permission-mode', permissionMode];
    if (name) args.push('--name', name.trim());
    args.push('--', prompt);
    return this.driven(undefined, onId => this.background(args, dir, onId));
  }

  // Lists the turn about to run as driven, for hooks/role-context.mjs. A continued session's id
  // is known up front; a new one's (`claude --bg` ignores --session-id) only once claude prints
  // it, so the turn is also marked as starting until then, which lets the hook wait for it.
  // Entries for a turn that never started are dropped again.
  async driven(knownId, startTurn) {
    const listed = new Set();
    const list = id => { if (id && !listed.has(id)) { this.driving.add(id); listed.add(id); } };
    const starting = this.driving.beginStart();
    try {
      list(knownId);
      return await startTurn(list);
    } catch (error) {
      for (const id of listed) this.driving.remove(id);
      throw error;
    } finally {
      this.driving.endStart(starting);
    }
  }

  // The CLI cannot inject a message into a running session. A background session keeps its
  // saved options and continues under the same id only when resumed without flags after its
  // process has exited, so it is stopped first (a busy one only on request). A session open
  // in an interactive window (desktop app, terminal, Remote Control) cannot be stopped from
  // here, so Do-It refuses rather than continuing a copy.
  async send(id, text, { permissionMode = 'auto', interrupt = false } = {}) {
    text = requireText(text, 'text');
    this.checkMode(permissionMode);
    const { sessionId, cwd, live } = await this.resolve(id);
    if (!cwd || !(await stat(cwd).then(s => s.isDirectory(), () => false))) throw new UserError(`Session ${short(sessionId)}'s folder ${cwd ?? '(unknown)'} no longer exists, so it can't be continued. Use start_session in an existing folder.`);
    if (live && live.kind !== 'background') {
      throw new UserError(`Session ${short(sessionId)} is open in an interactive window (desktop app, terminal or Remote Control), so Do-It can't send to it without forking a copy. Close it there and send again, or use start_session for a new session.`);
    }
    // A background session resumes with its saved options, including its permission mode.
    const keepsSavedMode = Boolean(live) || (await this.wasBackground(sessionId));
    if (keepsSavedMode && !this.allowBypassPermissions && (await this.savedMode(sessionId)) === 'bypassPermissions') {
      throw new UserError(`Session ${short(sessionId)} runs in bypassPermissions, which is turned off. Set "allowBypassPermissions": true in Do-It's config.json to continue it, or use start_session for a new session.`);
    }
    let note;
    if (live) {
      if (live.status === 'busy' && !interrupt) throw new UserError(`Session ${short(sessionId)} is busy. Wait for it to go idle, or send again with interrupt: true to stop its current turn first.`);
      const stopped = await this.run(['stop', live.id]);
      if (!stopped.ok) throw new UserError(`Couldn't stop session ${short(sessionId)} before sending: ${stopped.stderr || stopped.stdout || 'claude stop failed'}`);
      await this.waitForExit(sessionId);
      if (live.status === 'busy') note = 'Interrupted the running turn.';
    }
    await this.trust.ensure(cwd);
    const flags = keepsSavedMode ? [] : ['--permission-mode', permissionMode];
    const result = await this.driven(sessionId, onId => this.background(['--bg', '--resume', sessionId, ...flags, '--', text], cwd, onId));
    if (result.backgroundId && !sessionId.startsWith(result.backgroundId)) {
      this.driving.remove(sessionId); // the turn runs in the copy, which is listed under its own id
      note = [note, `Claude Code continued this as a new session ${result.sessionId}.`].filter(Boolean).join(' ');
    }
    return { ...result, continuedFrom: sessionId, note };
  }

  async waitForExit(sessionId) {
    for (let attempt = 0; attempt < 25; attempt++) {
      if (!(await this.live()).has(sessionId)) return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new UserError(`Session ${short(sessionId)} did not stop in time; try again.`);
  }

  async wasBackground(sessionId) {
    const { ok, stdout } = await this.run(['agents', '--json', '--all']);
    try { return ok && JSON.parse(stdout || '[]').some(a => a?.sessionId === sessionId && a.kind === 'background'); } catch { return false; }
  }

  async stop(id) {
    const { sessionId, live } = await this.resolve(id);
    this.driving.remove(sessionId);
    if (!live) throw new UserError(`Session ${short(sessionId)} is not running.`);
    if (live.kind !== 'background') throw new UserError(`Session ${short(sessionId)} is open in an interactive window (desktop app, terminal or Remote Control); stop it there.`);
    const { ok, stdout, stderr } = await this.run(['stop', live.id]);
    if (!ok) throw new UserError(`Couldn't stop session ${short(sessionId)}: ${stderr || stdout || 'claude stop failed'}`);
    return { sessionId, stopped: true };
  }

  async allowedDirectory(cwd) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new UserError('cwd must be an absolute path.');
    const dir = canonical(cwd);
    if (!(await stat(dir).then(s => s.isDirectory(), () => false))) throw new UserError(`${cwd} is not an existing folder.`);
    if (!this.roots.some(r => inside(r, dir))) throw new UserError(`${cwd} is outside the allowed folders.`);
    return dir;
  }

  // `onId` gets the id claude reports, before anything else waits on the new session.
  async background(args, cwd, onId = () => {}) {
    const { ok, stdout, stderr } = await this.run(args, { cwd });
    const output = [stdout, stderr].filter(Boolean).join('\n');
    if (!ok || !/backgrounded/.test(output)) throw new UserError(`Claude Code did not start the session: ${output || 'no output'}`);
    const backgroundId = output.match(/backgrounded\s*·\s*([0-9a-f]{8})/)?.[1];
    onId(backgroundId);
    // A new session can take a moment to appear in `claude agents`.
    let live;
    for (let attempt = 0; backgroundId && !live && attempt < 10; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 300));
      live = [...(await this.live()).values()].find(a => a.id === backgroundId);
    }
    // The background id is the session id's first 8 characters, which every tool accepts.
    return { sessionId: live?.sessionId ?? backgroundId, backgroundId, cwd };
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new UserError(`${field} must not be empty.`);
  return value;
}

export function openingSentence(text, max = 160) {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>|]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim();
  if (!plain) return undefined;
  const sentence = plain.match(/^(.+?[.!?])(?=\s|$)/)?.[1] ?? plain;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

async function mapLimit(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export function renderMessage(m) {
  const content = m.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool_use') return `[tool: ${block.name}]`;
    return '';
  }).filter(Boolean).join('\n').trim();
}
