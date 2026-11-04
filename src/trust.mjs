// Claude Code refuses to start or resume a session in a folder its own trust record
// (`projects[<dir>].hasTrustDialogAccepted` in ~/.claude.json) doesn't cover. Desktop-app
// sessions don't write that record, so folders used daily can still look untrusted to the
// CLI. For folders under allowedRoots in Do-It's config, Do-It writes the same
// entry the CLI writes when the trust prompt is accepted. Nothing outside those roots is touched.
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { UserError } from './errors.mjs';
import { allowedRoot, canonical, inside } from './paths.mjs';

export const claudeConfigFile = (env = process.env) =>
  path.join(env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');

const ATTEMPTS = 5;

export class Trust {
  // `beforeReplace` is a test hook that runs between writing the new file and the final check.
  constructor({ roots = [], configFile = claudeConfigFile(), beforeReplace = async () => {} } = {}) {
    this.roots = roots.map(r => allowedRoot(r));
    this.configFile = configFile;
    this.beforeReplace = beforeReplace;
  }

  // Returns true when Do-It recorded trust for dir, false when nothing needed doing.
  // Running Claude Code processes rewrite the same file, so the file is read again just before
  // it is replaced, and the change is redone on top of theirs if it changed in between.
  async ensure(dir) {
    const key = canonical(dir);
    if (!this.roots.some(r => inside(r, key))) return false; // leave it to the CLI's own record
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const text = await this.read();
      const config = this.parse(text);
      if (config.projects?.[key]?.hasTrustDialogAccepted === true) return false;
      config.projects = { ...config.projects, [key]: { ...config.projects?.[key], hasTrustDialogAccepted: true } };
      const tmp = `${this.configFile}.do-it-${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
      try {
        await this.beforeReplace();
        if ((await this.read()) !== text) continue; // someone else wrote it: start over from theirs
        await rename(tmp, this.configFile);
        return true;
      } finally {
        await unlink(tmp).catch(() => {}); // gone after a successful rename
      }
    }
    throw new UserError(`${this.configFile} kept changing while Do-It tried to mark ${key} as trusted; try again.`);
  }

  async read() {
    try { return await readFile(this.configFile, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') throw new UserError(`Claude Code's settings file ${this.configFile} doesn't exist yet, so Do-It can't mark folders as trusted. Run claude once in a terminal so it creates the file, then try again.`);
      throw new UserError(`Couldn't read ${this.configFile} to mark the folder as trusted: ${error.message}`);
    }
  }

  parse(text) {
    let config;
    try { config = JSON.parse(text); } catch { /* reported below */ }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new UserError(`${this.configFile} isn't a valid Claude Code settings file, so Do-It can't mark folders as trusted.`);
    return config;
  }
}
