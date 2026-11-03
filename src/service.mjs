// Fills in deploy/do-it.service (Linux) or deploy/do-it.plist (macOS) for this install.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './claude.mjs';

export const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const escapes = {
  // systemd: % starts a specifier and " ends a quoted value.
  linux: v => String(v).replace(/%/g, '%%').replace(/["\\]/g, c => `\\${c}`),
  darwin: v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]),
};

// Extra environment lines in each template's own syntax.
const envLines = {
  linux: (key, value, escape) => `Environment="${key}=${escape(value)}"\n`,
  darwin: (key, value, escape) => `    <key>${key}</key>\n    <string>${escape(value)}</string>\n`,
};

export function serviceFile({ platform = process.platform, env = process.env, node = process.execPath, appDir = APP_DIR, home = homedir(), claude, label = 'do-it', extraEnv = {} } = {}) {
  const escape = escapes[platform];
  if (!escape) throw new Error(`No service template for ${platform}; Do-It supports Linux (systemd) and macOS (launchd).`);
  const claudeBin = claude ?? findClaude({ env, platform });
  if (!claudeBin) throw new Error('Could not find the claude CLI on PATH. Install it, or set DO_IT_CLAUDE_BIN to its full path, then run this again.');
  const dirs = [path.dirname(node), path.dirname(claudeBin), ...(platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin', '/usr/bin', '/bin'];
  const values = { NODE: node, APP_DIR: appDir, CLAUDE_BIN: claudeBin, HOME: home, LABEL: label, PATH: [...new Set(dirs)].join(':') };
  const extra = Object.entries(extraEnv).map(([key, value]) => envLines[platform](key, value, escape)).join('');
  const template = readFileSync(path.join(APP_DIR, 'deploy', platform === 'darwin' ? 'do-it.plist' : 'do-it.service'), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => (key === 'EXTRA_ENV' ? extra : escape(values[key])));
}
