// Folder rules for the allowlist, in one place so every check agrees.
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

// macOS and Windows file systems ignore case by default; Linux doesn't.
export const foldsCase = (platform = process.platform) => platform === 'darwin' || platform === 'win32';

// The one realpath every check uses. Paths that don't exist (an old session's folder)
// are only normalised.
export function canonical(dir) {
  try { return realpathSync.native(dir); } catch { return path.resolve(dir); }
}

// Whether dir is root or a folder below it, comparing case-insensitively where the file system does.
export function inside(root, dir, { platform = process.platform, impl = path } = {}) {
  const key = p => (foldsCase(platform) ? p.toLowerCase() : p);
  const r = key(root);
  const d = key(dir);
  return d === r || d.startsWith(r.endsWith(impl.sep) ? r : r + impl.sep);
}

// Throws unless value can be an allowed root: absolute and not a file system root (/ or C:\).
export function checkRoot(value, { impl = path } = {}) {
  if (typeof value !== 'string' || !impl.isAbsolute(value)) throw new Error(`allowedRoots entries must be absolute folders: ${value}`);
  const resolved = impl.resolve(value);
  if (impl.parse(resolved).root === resolved) throw new Error(`allowedRoots can't include a whole drive or file system root: ${value}`);
  return resolved;
}

// An allowed root in the canonical form every check uses. The root check runs again after
// resolving, so a symlink or junction to / or a drive root is refused too.
export function allowedRoot(value, options) {
  return checkRoot(canonical(checkRoot(value, options)), options);
}

// For setup and add-folder: an existing folder, returned in canonical form.
export function existingRoot(value) {
  const resolved = checkRoot(path.resolve(String(value ?? '').trim()));
  let info;
  try { info = statSync(resolved); } catch { throw new Error(`${resolved} doesn't exist.`); }
  if (!info.isDirectory()) throw new Error(`${resolved} is not a folder.`);
  return allowedRoot(resolved);
}
