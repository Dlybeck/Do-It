// Where Do-It keeps its settings, and how they are read and written.
//   config.json  publicUrl, allowedRoots, allowBypassPermissions (re-read while running)
//   github.json  clientId, clientSecret, allowedLogins (read at start)
import { chmodSync, mkdirSync, readFileSync, renameSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const configDirFrom = (env = process.env) => env.DO_IT_CONFIG_DIR ?? path.join(homedir(), '.config', 'do-it');
export const stateDirFrom = (env = process.env) => env.DO_IT_STATE_DIR ?? path.join(homedir(), '.local', 'state', 'do-it');

export const PUBLIC_URL = /^https:\/\/[^/\s?#]+$/;

export function readJson(dir, file, { required = false } = {}) {
  try { return JSON.parse(readFileSync(path.join(dir, file), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && !required) return {};
    throw new Error(`${error.code === 'ENOENT' ? 'Missing' : 'Invalid'} ${path.join(dir, file)}; run "do-it setup" or see README.`);
  }
}

// Owner-only folder and file, written via a temporary file so readers never see half a file.
export function writeJson(dir, file, value) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const target = path.join(dir, file);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
}

// The settings that can change while Do-It runs. "trustedRoots" is the earlier name of "allowedRoots".
export function liveSettings(config) {
  const roots = config.allowedRoots ?? config.trustedRoots ?? [];
  if (!Array.isArray(roots)) throw new Error('"allowedRoots" in config.json must be a list of absolute folders.');
  const bypass = config.allowBypassPermissions ?? false;
  if (typeof bypass !== 'boolean') throw new Error('"allowBypassPermissions" in config.json must be true or false.');
  return { roots, allowBypassPermissions: bypass };
}

// Reads config.json (optional) and github.json (required). Throws with a message saying what to fix.
export function loadConfig(dir, env = process.env) {
  const config = readJson(dir, 'config.json');
  const github = readJson(dir, 'github.json', { required: true });
  const baseUrl = String(env.DO_IT_PUBLIC_URL ?? config.publicUrl ?? '').replace(/\/$/, '');
  if (!PUBLIC_URL.test(baseUrl)) throw new Error('Set "publicUrl" in config.json (or DO_IT_PUBLIC_URL) to the https:// address the server is reached at, with no path.');
  return { baseUrl, github, ...liveSettings(config) };
}

// Re-reads config.json when it changes and hands the live settings to onChange. A broken
// file is reported and the previous settings stay in force. Returns a function that stops watching.
export function watchConfig(dir, onChange, { interval = 2000, log = console } = {}) {
  const file = path.join(dir, 'config.json');
  const listener = (now, before) => {
    if (now.mtimeMs === before.mtimeMs && now.size === before.size) return;
    try { onChange(liveSettings(readJson(dir, 'config.json'))); }
    catch (error) { log.error(`Ignoring config.json change, keeping the previous settings: ${error.message}`); }
  };
  watchFile(file, { interval, persistent: false }, listener);
  return () => unwatchFile(file, listener);
}
