// Claude Code refuses to start or resume a session in a folder its own trust record
// (`projects[<dir>].hasTrustDialogAccepted` in ~/.claude.json) doesn't cover. Desktop-app
// sessions don't write that record, so folders used daily can still look untrusted to the
// CLI. For folders under allowedRoots in Do-It's config, Do-It writes the same
// entry the CLI writes when the trust prompt is accepted. Nothing outside those roots is touched.
import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { allowedRoot, canonical, inside } from './paths.mjs';

export const claudeConfigFile = (env = process.env) =>
  path.join(env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');


export class Trust {
  constructor({ roots = [], configFile = claudeConfigFile() } = {}) {
    this.roots = roots.map(r => allowedRoot(r));
    this.configFile = configFile;
  }

  // Returns true when Do-It recorded trust for dir, false when nothing needed doing.
  async ensure(dir) {
    const key = canonical(dir);
    if (!this.roots.some(r => inside(r, key))) return false; // leave it to the CLI's own record
    const config = JSON.parse(await readFile(this.configFile, 'utf8'));
    if (config.projects?.[key]?.hasTrustDialogAccepted === true) return false;
    config.projects = { ...config.projects, [key]: { ...config.projects?.[key], hasTrustDialogAccepted: true } };
    const tmp = `${this.configFile}.do-it-${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(tmp, this.configFile);
    return true;
  }
}
